/**
 * Kafka Studio — 主进程（Node 沙箱）
 *
 * 架构：全部业务集中在唯一工具页（index.html）；Kafka 是有状态二进制 TCP
 * 协议，页面无法直连，故由主进程的本地代理（127.0.0.1:17933）维护会话：
 * - POST /kafka/open {cfg:{brokers, clientId, sasl}} → {sessionId}
 * - POST /kafka/call {sessionId, op, params} → 结构化结果
 * - POST /kafka/close {sessionId}
 * - POST /sr {cfg:{url, auth}, method, path} → Schema Registry HTTP 透传
 * Kafka 协议客户端为纯 Node 手写（net + Buffer），实现 Metadata/ListOffsets/
 * Fetch（含 RecordBatch v2 与旧 MessageSet 解码）/消费组/Offset 提交/ACL。
 * 沙箱 require 白名单无 zlib：压缩批次（gzip/snappy/lz4/zstd）无法解压，
 * 返回占位记录并注明 codec。SASL 仅支持 PLAIN。
 */

const http = require('http')
const https = require('https')
const net = require('net')
const { URL } = require('url')

const PROXY_PORT = 17933
const PROXY_HOST = '127.0.0.1'

/* ================= 二进制编解码 ================= */
class Writer {
  constructor() { this.chunks = []; this.len = 0 }
  push(buf) { this.chunks.push(buf); this.len += buf.length }
  i8(v) { const b = Buffer.alloc(1); b.writeInt8(v); this.push(b); return this }
  i16(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); this.push(b); return this }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); this.push(b); return this }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); this.push(b); return this }
  i64(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); this.push(b); return this }
  bool(v) { return this.i8(v ? 1 : 0) }
  str(v) { if (v === null || v === undefined) return this.i16(-1); const b = Buffer.from(String(v), 'utf8'); this.i16(b.length); this.push(b); return this }
  bytes(v) { if (v === null || v === undefined) return this.i32(-1); if (typeof v === 'string') v = Buffer.from(v, 'utf8'); this.i32(v.length); this.push(v); return this }
  varint(v) { return this.varlong(BigInt(v)) }
  varlong(v) {
    let zz = v >= 0n ? v * 2n : -v * 2n - 1n
    const out = []
    do { let b = Number(zz & 0x7fn); zz >>= 7n; if (zz > 0n) b |= 0x80; out.push(b) } while (zz > 0n)
    this.push(Buffer.from(out)); return this
  }
  array(arr, fn) { if (arr === null || arr === undefined) return this.i32(-1); this.i32(arr.length); for (const item of arr) fn(item); return this }
  build() { return Buffer.concat(this.chunks, this.len) }
}
class Reader {
  constructor(buf, off) { this.buf = buf; this.off = off || 0 }
  need(n) { if (this.off + n > this.buf.length) throw new Error('协议数据不完整（需要 ' + n + ' 字节）') }
  i8() { this.need(1); return this.buf.readInt8(this.off++) }
  bool() { return this.i8() !== 0 }
  i16() { this.need(2); const v = this.buf.readInt16BE(this.off); this.off += 2; return v }
  i32() { this.need(4); const v = this.buf.readInt32BE(this.off); this.off += 4; return v }
  u32() { this.need(4); const v = this.buf.readUInt32BE(this.off); this.off += 4; return v }
  i64() { this.need(8); const v = this.buf.readBigInt64BE(this.off); this.off += 8; return Number(v) }
  str() { const n = this.i16(); if (n < 0) return null; this.need(n); const s = this.buf.toString('utf8', this.off, this.off + n); this.off += n; return s }
  bytes() { const n = this.i32(); if (n < 0) return null; this.need(n); const b = this.buf.subarray(this.off, this.off + n); this.off += n; return b }
  varint() { return Number(this.varlong()) }
  varlong() {
    let result = 0n, shift = 0n
    for (;;) { const b = this.buf[this.off++]; result |= BigInt(b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7n; if (shift > 70n) throw new Error('varint 过长') }
    return (result >> 1n) ^ (-(result & 1n))
  }
  array(fn) { const n = this.i32(); if (n < 0) return null; const out = []; for (let i = 0; i < n; i++) out.push(fn()); return out }
  remaining() { return this.buf.length - this.off }
}

const ERRORS = {
  0: '', '-1': '未知错误', 1: 'OFFSET_OUT_OF_RANGE（偏移越界）', 2: 'CORRUPT_MESSAGE（消息损坏）', 3: 'UNKNOWN_TOPIC_OR_PARTITION（Topic 或分区不存在）',
  5: 'LEADER_NOT_AVAILABLE（Leader 不可用）', 6: 'NOT_LEADER_OR_PARTITION（目标 Broker 不是该分区的 Leader）', 7: 'REQUEST_TIMED_OUT（请求超时）',
  9: 'REPLICA_NOT_AVAILABLE（副本不可用）', 11: 'MESSAGE_TOO_LARGE（消息过大）', 15: 'COORDINATOR_NOT_AVAILABLE（消费组协调器不可用）',
  16: 'NOT_COORDINATOR（目标 Broker 不是该消费组的协调器）', 22: 'INVALID_ARGUMENTS（参数无效）', 25: 'UNKNOWN_MEMBER_ID（未知成员）',
  27: 'REBALANCE_IN_PROGRESS（消费组再平衡中）', 29: 'TOPIC_AUTHORIZATION_FAILED（Topic 无授权）', 30: 'GROUP_AUTHORIZATION_FAILED（消费组无授权）',
  31: 'CLUSTER_AUTHORIZATION_FAILED（集群操作无授权）', 35: 'UNSUPPORTED_VERSION（协议版本不支持）', 42: 'MEMBER_ID_REQUIRED（需要 memberId）',
  58: 'UNSTABLE_OFFSET_COMMIT（Offset 提交不稳定）', 71: 'UNKNOWN（协议错误）'
}
function errName(code) { return ERRORS[code] || ('错误码 ' + code) }

/* ================= 消息格式解码 ================= */
function readHeaderKV(r) {
  const kl = r.varint(); const k = kl >= 0 ? r.buf.toString('utf8', r.off, r.off + kl) : null; if (kl >= 0) r.off += kl
  const vl = r.varint(); const v = vl >= 0 ? r.buf.subarray(r.off, r.off + vl) : null; if (vl >= 0) r.off += vl
  return { key: k, value: v }
}
function parseRecordBatch(r, out, limit) {
  const baseOffset = r.i64()
  const batchLen = r.i32()
  const batchStart = r.off
  r.i32() // partitionLeaderEpoch
  const magic = r.i8()
  if (magic !== 2) throw new Error('内部错误：batch magic=' + magic)
  r.u32() // crc
  const attrs = r.i16()
  const codec = attrs & 0x7
  const timestampType = (attrs >> 3) & 1
  r.i32() // lastOffsetDelta
  const firstTs = r.i64()
  const maxTs = r.i64()
  r.i64(); r.i16(); r.i32() // producerId/epoch/baseSequence
  const count = r.i32()
  if (codec !== 0) {
    out.push({ placeholder: true, codec, count, baseOffset, note: '该批次使用压缩（codec=' + codec + '：' + ({ 1: 'gzip', 2: 'snappy', 3: 'lz4', 4: 'zstd' }[codec] || '未知') + '），插件沙箱无 zlib，无法解压' })
    r.off = batchStart + batchLen - 4
    return
  }
  for (let i = 0; i < count && out.length < limit; i++) {
    r.varint() // record length
    r.i8() // attributes
    const tsDelta = r.varlong()
    const offDelta = r.varint()
    const kl = r.varint(); const key = kl >= 0 ? r.buf.subarray(r.off, r.off + kl) : null; if (kl >= 0) r.off += kl
    const vl = r.varint(); const val = vl >= 0 ? r.buf.subarray(r.off, r.off + vl) : null; if (vl >= 0) r.off += vl
    const hCount = r.varint()
    const headers = []
    for (let j = 0; j < hCount; j++) headers.push(readHeaderKV(r))
    out.push({
      offset: baseOffset + offDelta,
      timestamp: timestampType === 1 ? maxTs : firstTs + Number(tsDelta),
      key: key ? key.toString('base64') : null,
      value: val ? val.toString('base64') : null,
      headers: headers.map((hh) => ({ key: hh.key, value: hh.value ? hh.value.toString('base64') : null }))
    })
  }
  if (r.off < batchStart + batchLen - 4) r.off = batchStart + batchLen - 4
}
function parseMessageSetMessage(r, out, limit) {
  const offset = r.i64()
  const size = r.i32()
  const msgStart = r.off
  if (size <= 0) return
  r.u32() // crc
  const magic = r.i8()
  const attrs = r.i8()
  const codec = attrs & 0x7
  let ts = 0
  if (magic === 1) ts = r.i64()
  const key = r.bytes()
  const val = r.bytes()
  if (codec !== 0) {
    out.push({ placeholder: true, codec, count: 1, baseOffset: offset, note: '压缩消息（codec=' + codec + '），插件沙箱无法解压' })
  } else out.push({ offset, timestamp: ts, key: key ? key.toString('base64') : null, value: val ? val.toString('base64') : null, headers: [] })
  r.off = msgStart + size
}
function parseRecords(buf, limit) {
  const out = []
  if (!buf || !buf.length) return out
  const r = new Reader(buf)
  while (r.remaining() >= 12 && out.length < limit) {
    const start = r.off
    try {
      const magicPos = start + 16
      if (magicPos >= buf.length) break
      const magic = buf.readInt8(magicPos)
      if (magic === 2) parseRecordBatch(r, out, limit)
      else parseMessageSetMessage(r, out, limit)
    } catch (e) { break }
  }
  return out
}

/* ================= Kafka 连接 ================= */
const API = { Fetch: 1, ListOffsets: 2, Metadata: 3, OffsetCommit: 8, OffsetFetch: 9, FindCoordinator: 10, DescribeGroups: 15, ListGroups: 16, SaslHandshake: 17, ApiVersions: 18, CreateAcls: 30, DeleteAcls: 31, DescribeAcls: 29, SaslAuthenticate: 36 }
class KafkaConnection {
  constructor(host, port, clientId, sasl) {
    this.host = host; this.port = port; this.clientId = clientId || 'newshell-kafka-studio'; this.sasl = sasl
    this.socket = null; this.buffer = Buffer.alloc(0); this.pending = new Map(); this.corrSeq = 0
    this.queue = Promise.resolve(); this.dead = null; this.authed = false
  }
  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      this.socket = socket
      const onErr = (e) => { this.dead = e; reject(new Error('连接 ' + this.host + ':' + this.port + ' 失败：' + e.message)); for (const p of this.pending.values()) p.reject(e); this.pending.clear() }
      socket.on('error', onErr)
      socket.on('close', () => { if (!this.dead) { const e = new Error('连接已关闭'); for (const p of this.pending.values()) p.reject(e); this.pending.clear() } })
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk])
        while (this.buffer.length >= 4) {
          const size = this.buffer.readInt32BE(0)
          if (this.buffer.length < 4 + size) break
          const frame = this.buffer.subarray(4, 4 + size)
          this.buffer = this.buffer.subarray(4 + size)
          const corr = frame.readInt32BE(0)
          const p = this.pending.get(corr)
          if (p) { this.pending.delete(corr); p.resolve(new Reader(frame, 4)) }
        }
      })
      socket.on('connect', async () => {
        try {
          if (this.sasl) await this.doSasl()
          this.authed = true
          resolve()
        } catch (e) { reject(e) }
      })
    })
  }
  async doSasl() {
    const hs = await this.rawRequest(API.SaslHandshake, 0, new Writer().str('PLAIN').build(), (r) => ({ error: r.i16(), mechanisms: r.array(() => r.str()) }))
    if (hs.error !== 0) throw new Error('SASL 握手失败：' + errName(hs.error))
    const token = Buffer.from('\0' + (this.sasl.user || '') + '\0' + (this.sasl.pass || ''), 'utf8')
    const auth = await this.rawRequest(API.SaslAuthenticate, 0, new Writer().bytes(token).build(), (r) => ({ error: r.i16(), msg: r.str(), bytes: r.bytes() }))
    if (auth.error !== 0) throw new Error('SASL/PLAIN 认证失败：' + errName(auth.error) + (auth.msg ? '（' + auth.msg + '）' : ''))
  }
  rawRequest(apiKey, version, body, parse) {
    const task = () => new Promise((resolve, reject) => {
      if (!this.socket || this.dead) return reject(new Error('连接不可用（' + this.host + ':' + this.port + '）'))
      const corr = ++this.corrSeq
      const header = new Writer().i16(apiKey).i16(version).i32(corr).str(this.clientId).build()
      const frame = Buffer.concat([header, body])
      const pkg = Buffer.alloc(4); pkg.writeInt32BE(frame.length)
      const timer = setTimeout(() => { this.pending.delete(corr); reject(new Error('请求超时（' + apiKey + '）')) }, 20000)
      this.pending.set(corr, { resolve: (reader) => { clearTimeout(timer); try { resolve(parse(reader)) } catch (e) { reject(new Error('解析响应失败：' + e.message)) } }, reject: (e) => { clearTimeout(timer); reject(e) } })
      this.socket.write(Buffer.concat([pkg, frame]))
    })
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => {})
    return result
  }
  close() { try { if (this.socket) this.socket.destroy() } catch (_) {} this.socket = null }
}

/* ---- 各 API 的请求/响应 ---- */
function reqMetadata(conn, topics) {
  const w = new Writer()
  if (topics === null) w.i32(-1)
  else { w.i32(topics.length); for (const t of topics) w.str(t) }
  return conn.rawRequest(API.Metadata, 1, w.build(), (r) => {
    // Metadata v1 响应无 throttle_time_ms（v2 起才有，且 v2 还多 cluster_id）
    const brokers = r.array(() => ({ id: r.i32(), host: r.str(), port: r.i32(), rack: r.str() }))
    const controllerId = r.i32()
    const tps = r.array(() => ({
      error: r.i16(), name: r.str(), internal: r.bool(),
      partitions: r.array(() => ({ error: r.i16(), partition: r.i32(), leader: r.i32(), replicas: r.array(() => r.i32()), isr: r.array(() => r.i32()) }))
    }))
    return { brokers, controllerId, topics: tps }
  })
}
function reqListOffsets(conn, topicParts, timestamp) {
  const w = new Writer().i32(-1) // replicaId
  w.i32(topicParts.length)
  for (const tp of topicParts) {
    w.str(tp.topic); w.i32(tp.partitions.length)
    for (const p of tp.partitions) { w.i32(p); w.i64(timestamp) }
  }
  return conn.rawRequest(API.ListOffsets, 1, w.build(), (r) => {
    const out = {}
    const topics = r.array(() => ({ name: r.str(), partitions: r.array(() => ({ partition: r.i32(), error: r.i16(), ts: r.i64(), offset: r.i64() })) }))
    for (const t of topics) for (const p of t.partitions) { (out[t.name] = out[t.name] || {})[p.partition] = p }
    return out
  })
}
function reqFetch(conn, topic, partition, offset, maxBytes, limit) {
  const w = new Writer().i32(-1).i32(1200).i32(1).i32(50 * 1024 * 1024).i8(0) // replicaId, maxWait, minBytes, maxBytes, isolation(read_uncommitted)
  w.i32(1).str(topic).i32(1).i32(partition).i64(offset).i32(maxBytes)
  return conn.rawRequest(API.Fetch, 4, w.build(), (r) => {
    r.i32() // throttle
    let result = { error: 0, highWatermark: 0, records: [] }
    const topics = r.array(() => ({ name: r.str(), partitions: r.array(() => {
      const p = { partition: r.i32(), error: r.i16(), hw: r.i64() }
      r.i64() // lastStableOffset
      r.array(() => { r.i64(); r.i64(); return null }) // aborted transactions
      p.recordsBytes = r.bytes()
      return p
    }) }))
    for (const t of topics) for (const p of t.partitions) if (p.partition === partition) {
      result.error = p.error; result.highWatermark = p.hw; result.records = parseRecords(p.recordsBytes, limit)
    }
    return result
  })
}
function reqFindCoordinator(conn, groupId) {
  const w = new Writer().str(groupId).i8(1)
  return conn.rawRequest(API.FindCoordinator, 1, w.build(), (r) => {
    // FindCoordinator v1 响应无 throttle_time_ms（v2 起才有）
    const error = r.i16(); const msg = r.str(); const nodeId = r.i32(); const host = r.str(); const port = r.i32()
    return { error, msg, nodeId, host, port }
  })
}
function reqListGroups(conn) {
  return conn.rawRequest(API.ListGroups, 1, Buffer.alloc(0), (r) => ({ error: r.i16(), groups: r.array(() => ({ id: r.str(), protocolType: r.str() })) }))
}
function parseAssignment(buf) {
  if (!buf || !buf.length) return []
  const r = new Reader(buf)
  try {
    r.i16() // version
    const topics = r.array(() => ({ name: r.str(), partitions: r.array(() => r.i32()) }))
    r.bytes()
    return topics
  } catch (_) { return [] }
}
function reqDescribeGroups(conn, groupIds) {
  const w = new Writer(); w.i32(groupIds.length); for (const g of groupIds) w.str(g)
  return conn.rawRequest(API.DescribeGroups, 1, w.build(), (r) => {
    // DescribeGroups v1 响应无 throttle_time_ms（v2 起才有）
    return r.array(() => ({
      error: r.i16(), id: r.str(), state: r.str(), protocolType: r.str(), protocol: r.str(),
      members: r.array(() => { const m = { id: r.str(), clientId: r.str(), host: r.str() }; r.bytes(); m.assignment = parseAssignment(r.bytes()); return m })
    }))
  })
}
function reqOffsetFetch(conn, groupId) {
  const w = new Writer().str(groupId).i32(-1) // topics = null（全部）
  return conn.rawRequest(API.OffsetFetch, 2, w.build(), (r) => {
    // OffsetFetch v2 响应无 throttle_time_ms（v3 起才有）
    const topics = r.array(() => ({ name: r.str(), partitions: r.array(() => ({ partition: r.i32(), offset: r.i64(), metadata: r.str(), error: r.i16() })) }))
    r.i16() // top-level error (v2)
    const out = {}
    for (const t of topics) for (const p of t.partitions) { (out[t.name] = out[t.name] || {})[p.partition] = p }
    return out
  })
}
function reqOffsetCommit(conn, groupId, topic, partition, offset) {
  const w = new Writer().str(groupId).i32(-1).str('').i64(-1) // groupId, generationId=-1, memberId, retentionTime
  w.i32(1).str(topic).i32(1).i32(partition).i64(offset).str(null)
  return conn.rawRequest(API.OffsetCommit, 2, w.build(), (r) => {
    const topics = r.array(() => ({ name: r.str(), partitions: r.array(() => ({ partition: r.i32(), error: r.i16() })) }))
    for (const t of topics) for (const p of t.partitions) return p.error
    return 0
  })
}
function aclFilterFields(w, f) {
  w.i8(f.resourceType); w.str(f.resourceName != null ? f.resourceName : null); w.i8(f.patternType != null ? f.patternType : 1); w.str(f.principal != null ? f.principal : null); w.str(f.host != null ? f.host : null); w.i8(f.operation); w.i8(f.permissionType)
}
function reqDescribeAcls(conn, filter) {
  const w = new Writer(); aclFilterFields(w, filter)
  return conn.rawRequest(API.DescribeAcls, 1, w.build(), (r) => {
    r.i32()
    const error = r.i16(); const msg = r.str()
    const resources = r.array(() => ({ resourceType: r.i8(), resourceName: r.str(), patternType: r.i8(), acls: r.array(() => ({ principal: r.str(), host: r.str(), operation: r.i8(), permissionType: r.i8() })) }))
    return { error, msg, resources }
  })
}
function reqCreateAcls(conn, creation) {
  const w = new Writer().i32(1); aclFilterFields(w, creation)
  return conn.rawRequest(API.CreateAcls, 1, w.build(), (r) => {
    r.i32()
    const results = r.array(() => ({ error: r.i16(), msg: r.str() }))
    return results[0] || { error: 0 }
  })
}
function reqDeleteAcls(conn, filter) {
  const w = new Writer().i32(1); aclFilterFields(w, filter)
  return conn.rawRequest(API.DeleteAcls, 1, w.build(), (r) => {
    r.i32()
    const results = r.array(() => ({ error: r.i16(), msg: r.str(), matching: r.array(() => ({ resourceType: r.i8(), resourceName: r.str(), patternType: r.i8(), acls: r.array(() => ({ principal: r.str(), host: r.str(), operation: r.i8(), permissionType: r.i8() })) })) }))
    return results[0] || { error: 0, matching: [] }
  })
}

/* ================= 会话与操作分发 ================= */
class KafkaSession {
  constructor(cfg) {
    const brokers = String(cfg.brokers || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const i = s.lastIndexOf(':'); return i > 0 ? { host: s.slice(0, i), port: Number(s.slice(i + 1)) || 9092 } : { host: s, port: 9092 }
    })
    if (!brokers.length) throw new Error('请填写至少一个 Broker（host:port，逗号分隔）')
    this.bootstrapAddrs = brokers
    this.clientId = cfg.clientId || 'newshell-kafka-studio'
    this.sasl = cfg.sasl && cfg.sasl.user ? { user: cfg.sasl.user, pass: cfg.sasl.pass || '' } : null
    this.conns = new Map() // host:port -> KafkaConnection
    this.brokers = [] // metadata 中的 brokers
    this.meta = null
  }
  async connTo(host, port) {
    const key = host + ':' + port
    if (this.conns.has(key)) { const c = this.conns.get(key); if (c.socket && !c.dead) return c; this.conns.delete(key) }
    const c = new KafkaConnection(host, port, this.clientId, this.sasl)
    await c.connect()
    this.conns.set(key, c)
    return c
  }
  async anyConn() {
    let lastErr = null
    for (const b of this.bootstrapAddrs) { try { return await this.connTo(b.host, b.port) } catch (e) { lastErr = e } }
    throw lastErr || new Error('无可用 Broker')
  }
  async refreshMeta() {
    const conn = await this.anyConn()
    this.meta = await reqMetadata(conn, null)
    if (this.meta.brokers && this.meta.brokers.length) this.brokers = this.meta.brokers
    return this.meta
  }
  async brokerConn(nodeId) {
    const b = this.brokers.find((x) => x.id === nodeId)
    if (!b) return this.anyConn()
    return this.connTo(b.host, b.port)
  }
  close() { for (const c of this.conns.values()) c.close(); this.conns.clear() }
}

async function topicOffsets(session, topic) {
  if (!session.meta) await session.refreshMeta()
  const t = (session.meta.topics || []).find((x) => x.name === topic)
  if (!t) throw new Error('Topic 不存在：' + topic)
  const byLeader = new Map()
  for (const p of t.partitions) { if (!byLeader.has(p.leader)) byLeader.set(p.leader, []); byLeader.get(p.leader).push(p.partition) }
  const result = {}
  for (const [leader, parts] of byLeader) {
    const conn = await session.brokerConn(leader)
    const [earliest, latest] = [await reqListOffsets(conn, [{ topic, partitions: parts }], -2), await reqListOffsets(conn, [{ topic, partitions: parts }], -1)]
    for (const p of parts) {
      const meta = t.partitions.find((x) => x.partition === p)
      result[p] = { partition: p, leader: meta.leader, replicas: meta.replicas, isr: meta.isr, error: meta.error, earliest: earliest[topic]?.[p]?.offset ?? 0, latest: latest[topic]?.[p]?.offset ?? 0 }
    }
  }
  return Object.values(result).sort((a, b) => a.partition - b.partition)
}

async function handleKafkaOp(session, op, params) {
  params = params || {}
  switch (op) {
    case 'metadata': {
      const meta = await session.refreshMeta()
      const topics = []
      for (const t of meta.topics || []) {
        if (t.internal) continue
        let count = 0
        try { const offs = await topicOffsets(session, t.name); count = offs.reduce((a, p) => a + Math.max(0, p.latest - p.earliest), 0) } catch (_) { /* ignore */ }
        topics.push({ name: t.name, partitions: t.partitions.length, messages: count, error: t.error })
      }
      return { brokers: session.brokers, controllerId: meta.controllerId, topics }
    }
    case 'topicOffsets': return { partitions: await topicOffsets(session, params.topic) }
    case 'fetch': {
      if (!session.meta) await session.refreshMeta()
      const t = (session.meta.topics || []).find((x) => x.name === params.topic)
      if (!t) throw new Error('Topic 不存在：' + params.topic)
      const meta = t.partitions.find((x) => x.partition === params.partition)
      if (!meta) throw new Error('分区不存在')
      const conn = await session.brokerConn(meta.leader)
      const r = await reqFetch(conn, params.topic, params.partition, params.offset, params.maxBytes || 1024 * 1024, params.limit || 200)
      if (r.error !== 0) throw new Error(errName(r.error))
      return r
    }
    case 'groups': {
      const conn = await session.anyConn()
      const lg = await reqListGroups(conn)
      if (lg.error !== 0) throw new Error(errName(lg.error))
      return { groups: lg.groups }
    }
    case 'describeGroup': {
      const coord = await reqFindCoordinator(await session.anyConn(), params.group)
      if (coord.error !== 0) throw new Error(errName(coord.error) + (coord.msg ? '（' + coord.msg + '）' : ''))
      if (!session.brokers.length) await session.refreshMeta()
      const conn = await session.connTo(coord.host, coord.port)
      const described = await reqDescribeGroups(conn, [params.group])
      const g = described[0]
      if (!g) throw new Error('消费组不存在')
      if (g.error !== 0) throw new Error(errName(g.error))
      const committed = await reqOffsetFetch(conn, params.group).catch(() => ({}))
      const assignments = {}
      for (const m of g.members) for (const a of m.assignment) { (assignments[a.name] = assignments[a.name] || new Set()); for (const p of a.partitions) assignments[a.name].add(p) }
      const offsets = []
      const topicNames = new Set([...Object.keys(committed), ...Object.keys(assignments)])
      for (const topic of topicNames) {
        const parts = new Set([...Object.keys(committed[topic] || {}).map(Number), ...(assignments[topic] ? [...assignments[topic]] : [])])
        let latestMap = {}
        try { const offs = await topicOffsets(session, topic); for (const o of offs) latestMap[o.partition] = o } catch (_) { /* ignore */ }
        for (const p of [...parts].sort((a, b) => a - b)) {
          const c = committed[topic]?.[p]
          const latest = latestMap[p]?.latest
          offsets.push({ topic, partition: p, committed: c && c.offset >= 0 ? c.offset : null, latest: latest !== undefined ? latest : null, lag: c && c.offset >= 0 && latest !== undefined ? Math.max(0, latest - c.offset) : null })
        }
      }
      return { group: { id: g.id, state: g.state, protocolType: g.protocolType, protocol: g.protocol, members: g.members.map((m) => ({ id: m.id, clientId: m.clientId, host: m.host, assignment: m.assignment })) }, offsets }
    }
    case 'commitOffset': {
      const coord = await reqFindCoordinator(await session.anyConn(), params.group)
      if (coord.error !== 0) throw new Error(errName(coord.error))
      const conn = await session.connTo(coord.host, coord.port)
      const error = await reqOffsetCommit(conn, params.group, params.topic, params.partition, params.offset)
      if (error !== 0) throw new Error(errName(error))
      return { ok: true }
    }
    case 'acls': {
      const conn = await session.anyConn()
      const r = await reqDescribeAcls(conn, { resourceType: params.resourceType != null ? params.resourceType : 0, resourceName: null, patternType: 1, principal: null, host: null, operation: 0, permissionType: 0 })
      if (r.error !== 0) throw new Error(errName(r.error) + (r.msg ? '（' + r.msg + '）' : ''))
      const flat = []
      for (const res of r.resources) for (const a of res.acls) flat.push({ resourceType: res.resourceType, resourceName: res.resourceName, patternType: res.patternType, principal: a.principal, host: a.host, operation: a.operation, permissionType: a.permissionType })
      return { acls: flat }
    }
    case 'aclCreate': {
      const conn = await session.anyConn()
      const r = await reqCreateAcls(conn, params.creation)
      if (r.error !== 0) throw new Error(errName(r.error) + (r.msg ? '（' + r.msg + '）' : ''))
      return { ok: true }
    }
    case 'aclDelete': {
      const conn = await session.anyConn()
      const r = await reqDeleteAcls(conn, params.filter)
      if (r.error !== 0) throw new Error(errName(r.error) + (r.msg ? '（' + r.msg + '）' : ''))
      return { ok: true, matched: (r.matching || []).length }
    }
    default: throw new Error('未知操作：' + op)
  }
}

/* ================= HTTP 代理 ================= */
const sessions = new Map()
let server = null
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0
    req.on('data', (c) => { total += c.length; if (total > 32 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
function sendJson(res, obj, status) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(status || 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Length': body.length })
  res.end(body)
}
function srRequest(cfg, method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const base = String(cfg.url || '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(base)) return reject(new Error('Schema Registry 地址无效'))
    let url
    try { url = new URL(base + path) } catch (e) { return reject(new Error('地址无效：' + e.message)) }
    const isHttps = url.protocol === 'https:'
    const bodyBuf = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null
    const headers = { Accept: 'application/vnd.schemaregistry.v1+json' }
    if (cfg.auth) headers.Authorization = 'Basic ' + Buffer.from(cfg.auth).toString('base64')
    if (bodyBuf) { headers['Content-Type'] = 'application/vnd.schemaregistry.v1+json'; headers['Content-Length'] = bodyBuf.length }
    const req = (isHttps ? https : http).request({ method, hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, headers, timeout: 20000 }, (resp) => {
      const chunks = []
      resp.on('data', (c) => chunks.push(c))
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data = text
        try { data = JSON.parse(text) } catch (_) { /* 原样 */ }
        resolve({ status: resp.statusCode, data })
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (bodyBuf) req.write(bodyBuf)
    req.end()
  })
}
function startServer() {
  if (server) return
  server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*' })
        res.end(); return
      }
      const u = new URL(req.url, 'http://' + PROXY_HOST + ':' + PROXY_PORT)
      if (u.pathname === '/ping' && req.method === 'GET') return sendJson(res, { ok: true, plugin: 'kafka-studio' })
      const payload = JSON.parse((await readBody(req)).toString('utf8'))
      if (u.pathname === '/kafka/open' && req.method === 'POST') {
        const session = new KafkaSession(payload.cfg || {})
        await session.refreshMeta() // 打开即验证连通性
        const id = 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6)
        sessions.set(id, session)
        return sendJson(res, { sessionId: id, brokers: session.brokers })
      }
      if (u.pathname === '/kafka/call' && req.method === 'POST') {
        const session = sessions.get(payload.sessionId)
        if (!session) return sendJson(res, { error: '会话不存在或已关闭（请重新连接）' }, 400)
        const result = await handleKafkaOp(session, payload.op, payload.params)
        return sendJson(res, { result })
      }
      if (u.pathname === '/kafka/close' && req.method === 'POST') {
        const session = sessions.get(payload.sessionId)
        if (session) { session.close(); sessions.delete(payload.sessionId) }
        return sendJson(res, { ok: true })
      }
      if (u.pathname === '/sr' && req.method === 'POST') {
        const result = await srRequest(payload.cfg || {}, payload.method || 'GET', payload.path, payload.body)
        return sendJson(res, result)
      }
      sendJson(res, { error: 'not found' }, 404)
    } catch (e) {
      if (!res.headersSent) sendJson(res, { error: e.message || String(e) }, 500)
      else { try { res.end() } catch (_) { /* ignore */ } }
    }
  })
  server.on('error', (e) => { console.error('[KafkaStudio] proxy server error:', e.message) })
  server.listen(PROXY_PORT, PROXY_HOST, () => console.log(`[KafkaStudio] proxy on http://${PROXY_HOST}:${PROXY_PORT}`))
}

function activate(context) {
  console.log(`[KafkaStudio] Activating v${context.manifest.version}...`)
  try {
    context.ui.registerToolPage({ id: 'studio', title: 'Kafka Studio', icon: '📨', renderer: 'index.html' })
  } catch (err) {
    console.warn('[KafkaStudio] registerToolPage skipped:', err && err.message)
  }
  startServer()
}

async function deactivate() {
  for (const s of sessions.values()) s.close()
  sessions.clear()
  if (server) { server.close(); server = null }
  console.log('[KafkaStudio] Deactivated')
}

module.exports = { activate, deactivate, _test: { Writer, Reader, parseRecords } }

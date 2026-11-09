/**
 * 对象存储插件（Object Storage）— 主进程（Node 沙箱）
 *
 * 架构：全部业务集中在插件的唯一工具页（index.html）——连接管理、浏览、
 * 传输、预览都在该页内完成；S3 协议交互则在主进程执行：
 * - 插件启用时即在本机 127.0.0.1:17931 启动一个无状态本地代理服务。
 * - 工具页把「当前连接配置 + 结构化操作」发给代理；全部 SigV4 签名、XML
 *   解析、协议请求都在 Node 侧用 https/http + crypto 完成，渲染页不做签名、
 *   不直连 S3，也不受浏览器 CORS 约束。
 * - 代理不保存任何配置与密钥（配置随请求传入、用后即弃）。
 *
 * 代理 API（JSON，服务于本插件工具页）：
 *   POST /s3        {cfg, op, ...}   结构化操作：listBuckets/list/createFolder/
 *                                    delete/deleteMany/deletePrefix/copy/presign/
 *                                    multipartCreate/multipartComplete/multipartAbort
 *   PUT  /part?...  分片上传（raw body，cfg 在请求头 x-os-cfg 里，base64 JSON）
 *   PUT  /put?...   小文件整体上传（raw body）
 *   GET  /download?... 流式下载（raw body）
 *   cfg = {endpoint, region, ak, sk, pathStyle}
 */

const http = require('http')
const { URL, URLSearchParams } = require('url') // vm 沙箱无 URL 全局，从白名单 url 模块取
const https = require('https')
const crypto = require('crypto')

const PROXY_PORT = 17931
const PROXY_HOST = '127.0.0.1'

let server = null

/* ---------------- SigV4（Node crypto） ---------------- */
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }
function hmac(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest() }
function signingKey(sk, date, region) {
  let k = hmac('AWS4' + sk, date)
  k = hmac(k, region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request')
  return k
}
function rfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}
function encodeKey(key) { return key.split('/').map(rfc3986).join('/') }
function amzDates() {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
  return { date, amz: `${date}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z` }
}
function buildUrl(cfg, bucket, key, query) {
  const ep = String(cfg.endpoint || '').replace(/\/+$/, '')
  const u = new URL(ep)
  let path = ''
  if (bucket) {
    if (cfg.pathStyle) path = '/' + rfc3986(bucket)
    else u.hostname = bucket + '.' + u.hostname
    if (key) path += '/' + encodeKey(key)
  } else if (key) {
    path = '/' + encodeKey(key)
  }
  u.pathname = (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')) + (path || '/')
  if (query) for (const [k, v] of Object.entries(query)) { if (v !== undefined && v !== null) u.searchParams.set(k, v) }
  return u
}
function canonicalQuery(url) {
  const pairs = [...url.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return pairs.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&')
}

/**
 * 执行一次 S3 请求。body 可为 Buffer 或 (write function) 流式写入。
 * 返回 { status, headers, body:Buffer }；opts.streamTo 为可写流时响应体直接管道转发。
 */
function s3Request(cfg, opts) {
  return new Promise((resolve, reject) => {
    const method = opts.method || 'GET'
    const url = buildUrl(cfg, opts.bucket, opts.key, opts.query)
    const { date, amz } = amzDates()
    const bodyBuf = opts.body ? (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)) : null
    const payloadHash = opts.streamBody ? 'UNSIGNED-PAYLOAD' : sha256Hex(bodyBuf || Buffer.alloc(0))
    const headers = Object.assign({}, opts.headers || {})
    headers['x-amz-date'] = amz
    headers['x-amz-content-sha256'] = payloadHash
    if (bodyBuf) headers['content-length'] = bodyBuf.length
    else if (opts.contentLength) headers['content-length'] = opts.contentLength
    const signedNames = ['host', 'x-amz-content-sha256', 'x-amz-date']
    if (headers['content-type']) signedNames.push('content-type')
    if (headers['x-amz-copy-source']) signedNames.push('x-amz-copy-source')
    signedNames.sort()
    const headerVal = (n) => n === 'host' ? url.host : String(headers[n])
    const canonicalHeaders = signedNames.map((n) => `${n}:${headerVal(n).trim()}\n`).join('')
    const canonical = [method, url.pathname, canonicalQuery(url), canonicalHeaders, signedNames.join(';'), payloadHash].join('\n')
    const scope = `${date}/${cfg.region}/s3/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(Buffer.from(canonical))].join('\n')
    const signature = hmac(signingKey(cfg.sk, date, cfg.region), stringToSign).toString('hex')
    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${cfg.ak}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, { method, headers }, (res) => {
      if (opts.streamTo) {
        opts.streamTo.writeHead(res.statusCode, {
          'content-type': res.headers['content-type'] || 'application/octet-stream',
          'content-length': res.headers['content-length'] || '',
          'Access-Control-Allow-Origin': '*'
        })
        res.pipe(opts.streamTo)
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) }))
        res.on('error', reject)
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (opts.streamBody) {
      opts.streamBody(req).then(() => req.end()).catch(reject)
    } else {
      if (bodyBuf) req.write(bodyBuf)
      req.end()
    }
    if (opts.signal) opts.signal.addEventListener('abort', () => req.destroy(new Error('aborted')))
  })
}

function s3ErrorMessage(status, bodyBuf) {
  const text = bodyBuf ? bodyBuf.toString('utf8') : ''
  const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || ''
  const msg = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1] || text.slice(0, 200)
  return `${code ? code + ': ' : ''}${msg || '请求失败'}（HTTP ${status}）`
}
async function s3Checked(cfg, opts) {
  const res = await s3Request(cfg, opts)
  if (res.status < 200 || res.status >= 300) throw new Error(s3ErrorMessage(res.status, res.body))
  return res
}
function presignGet(cfg, bucket, key, expiresSec) {
  const url = buildUrl(cfg, bucket, key)
  const { date, amz } = amzDates()
  const scope = `${date}/${cfg.region}/s3/aws4_request`
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  url.searchParams.set('X-Amz-Credential', `${cfg.ak}/${scope}`)
  url.searchParams.set('X-Amz-Date', amz)
  url.searchParams.set('X-Amz-Expires', String(expiresSec))
  url.searchParams.set('X-Amz-SignedHeaders', 'host')
  const canonical = ['GET', url.pathname, canonicalQuery(url), `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(Buffer.from(canonical))].join('\n')
  const signature = hmac(signingKey(cfg.sk, date, cfg.region), stringToSign).toString('hex')
  url.searchParams.set('X-Amz-Signature', signature)
  return url.toString()
}

/* ---------------- XML 解析（正则足够覆盖 S3 响应结构） ---------------- */
function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return m ? m[1] : ''
}
function xmlBlocks(text, tag) {
  return [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1])
}
function xmlUnescape(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
}
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* ---------------- 结构化操作 ---------------- */
async function opListBuckets(cfg) {
  const res = await s3Checked(cfg, { method: 'GET' })
  const text = res.body.toString('utf8')
  return xmlBlocks(text, 'Bucket').map((b) => xmlUnescape(xmlTag(b, 'Name'))).filter(Boolean)
}
async function opList(cfg, p) {
  const query = { 'list-type': '2', delimiter: '/', 'max-keys': '200' }
  if (p.prefix) query.prefix = p.prefix
  if (p.token) query['continuation-token'] = p.token
  const res = await s3Checked(cfg, { method: 'GET', bucket: p.bucket, query })
  const text = res.body.toString('utf8')
  const prefix = p.prefix || ''
  const entries = []
  for (const cp of xmlBlocks(text, 'CommonPrefixes')) {
    const pre = xmlUnescape(xmlTag(cp, 'Prefix'))
    if (pre && pre !== prefix) entries.push({ key: pre, name: pre.slice(prefix.length).replace(/\/$/, ''), isDir: true, size: null, mtime: '', etag: '' })
  }
  for (const c of xmlBlocks(text, 'Contents')) {
    const k = xmlUnescape(xmlTag(c, 'Key'))
    if (!k || k === prefix) continue
    entries.push({
      key: k, name: k.slice(prefix.length), isDir: false,
      size: Number(xmlTag(c, 'Size') || 0),
      mtime: xmlTag(c, 'LastModified'),
      etag: xmlTag(c, 'ETag').replace(/"/g, '')
    })
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1))
  const truncated = xmlTag(text, 'IsTruncated') === 'true'
  return { entries, nextToken: truncated ? xmlTag(text, 'NextContinuationToken') || null : null }
}
async function opListAllKeys(cfg, bucket, prefix) {
  const keys = []
  let token = null
  do {
    const query = { 'list-type': '2', 'max-keys': '500', prefix }
    if (token) query['continuation-token'] = token
    const res = await s3Checked(cfg, { method: 'GET', bucket, query })
    const text = res.body.toString('utf8')
    for (const c of xmlBlocks(text, 'Contents')) { const k = xmlUnescape(xmlTag(c, 'Key')); if (k) keys.push(k) }
    token = xmlTag(text, 'IsTruncated') === 'true' ? xmlTag(text, 'NextContinuationToken') : null
  } while (token)
  return keys
}

/* ---------------- 本地代理服务 ---------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
function sendJson(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}
async function handleS3Op(cfg, p) {
  switch (p.op) {
    case 'listBuckets': return { buckets: await opListBuckets(cfg) }
    case 'list': return opList(cfg, p)
    case 'createFolder': {
      await s3Checked(cfg, { method: 'PUT', bucket: p.bucket, key: p.key, body: Buffer.alloc(0), headers: { 'content-type': 'application/x-directory' } })
      return { ok: true }
    }
    case 'delete': {
      await s3Checked(cfg, { method: 'DELETE', bucket: p.bucket, key: p.key })
      return { ok: true }
    }
    case 'deleteMany': {
      const errors = []
      for (let i = 0; i < p.keys.length; i += 500) {
        const batch = p.keys.slice(i, i + 500)
        const xml = '<?xml version="1.0" encoding="UTF-8"?><Delete>' + batch.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('') + '</Delete>'
        const res = await s3Checked(cfg, { method: 'POST', bucket: p.bucket, query: { delete: '' }, headers: { 'content-type': 'application/xml' }, body: Buffer.from(xml) })
        for (const e of xmlBlocks(res.body.toString('utf8'), 'Error')) errors.push(`${xmlTag(e, 'Key')}: ${xmlTag(e, 'Message')}`)
      }
      if (errors.length) throw new Error(errors[0])
      return { ok: true, count: p.keys.length }
    }
    case 'deletePrefix': {
      const keys = await opListAllKeys(cfg, p.bucket, p.prefix)
      if (keys.length) await handleS3Op(cfg, { op: 'deleteMany', bucket: p.bucket, keys })
      return { ok: true, count: keys.length }
    }
    case 'copy': {
      const source = '/' + rfc3986(p.srcBucket) + '/' + encodeKey(p.srcKey)
      await s3Checked(cfg, { method: 'PUT', bucket: p.dstBucket, key: p.dstKey, headers: { 'x-amz-copy-source': source } })
      return { ok: true }
    }
    case 'presign': return { url: presignGet(cfg, p.bucket, p.key, p.expires || 3600) }
    case 'multipartCreate': {
      const res = await s3Checked(cfg, { method: 'POST', bucket: p.bucket, key: p.key, query: { uploads: '' }, headers: p.contentType ? { 'content-type': p.contentType } : {} })
      const id = xmlTag(res.body.toString('utf8'), 'UploadId')
      if (!id) throw new Error('服务端未返回 UploadId')
      return { uploadId: id }
    }
    case 'multipartComplete': {
      const xml = '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>' +
        p.parts.map((pt) => `<Part><PartNumber>${pt.n}</PartNumber><ETag>${pt.etag}</ETag></Part>`).join('') + '</CompleteMultipartUpload>'
      await s3Checked(cfg, { method: 'POST', bucket: p.bucket, key: p.key, query: { uploadId: p.uploadId }, headers: { 'content-type': 'application/xml' }, body: Buffer.from(xml) })
      return { ok: true }
    }
    case 'multipartAbort': {
      try { await s3Checked(cfg, { method: 'DELETE', bucket: p.bucket, key: p.key, query: { uploadId: p.uploadId } }) } catch (_) { /* ignore */ }
      return { ok: true }
    }
    default: throw new Error('未知操作：' + p.op)
  }
}

function cfgFromHeader(req) {
  const raw = req.headers['x-os-cfg']
  if (!raw) throw new Error('缺少连接配置（x-os-cfg）')
  return normalizeConfig(JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8')))
}

function startServer() {
  if (server) return
  server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS', 'Access-Control-Allow-Headers': '*' })
        res.end()
        return
      }
      const u = new URL(req.url, 'http://' + PROXY_HOST + ':' + PROXY_PORT)
      if (u.pathname === '/ping' && req.method === 'GET') {
        return sendJson(res, { ok: true, plugin: 'object-storage' })
      }
      if (u.pathname === '/s3' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)).toString('utf8'))
        if (!payload.cfg) return sendJson(res, { error: '缺少连接配置' }, 400)
        const result = await handleS3Op(normalizeConfig(payload.cfg), payload)
        return sendJson(res, result)
      }
      if (u.pathname === '/put' && req.method === 'PUT') {
        const cfg = cfgFromHeader(req)
        const body = await readBody(req)
        await s3Checked(cfg, {
          method: 'PUT', bucket: u.searchParams.get('bucket'), key: u.searchParams.get('key'),
          body, headers: { 'content-type': u.searchParams.get('type') || 'application/octet-stream' }
        })
        return sendJson(res, { ok: true })
      }
      if (u.pathname === '/part' && req.method === 'PUT') {
        const cfg = cfgFromHeader(req)
        const body = await readBody(req)
        const r = await s3Checked(cfg, {
          method: 'PUT', bucket: u.searchParams.get('bucket'), key: u.searchParams.get('key'),
          query: { partNumber: u.searchParams.get('n'), uploadId: u.searchParams.get('uploadId') },
          body
        })
        const etag = r.headers['etag']
        if (!etag) throw new Error('分片未返回 ETag（服务端未返回 ETag 头）')
        return sendJson(res, { etag })
      }
      if (u.pathname === '/download' && req.method === 'GET') {
        const cfg = cfgFromHeader(req)
        await s3Request(cfg, { method: 'GET', bucket: u.searchParams.get('bucket'), key: u.searchParams.get('key'), streamTo: res })
        return
      }
      sendJson(res, { error: 'not found' }, 404)
    } catch (e) {
      if (!res.headersSent) sendJson(res, { error: e.message || String(e) }, 500)
      else { try { res.end() } catch (_) { /* ignore */ } }
    }
  })
  server.on('error', (e) => { console.error('[ObjectStorage] proxy server error:', e.message) })
  server.listen(PROXY_PORT, PROXY_HOST, () => console.log(`[ObjectStorage] proxy on http://${PROXY_HOST}:${PROXY_PORT}`))
}
/* ---------------- 连接配置归一化 ---------------- */
function normalizeConfig(raw) {
  const c = raw || {}
  return {
    endpoint: String(c.endpoint || '').trim(),
    region: String(c.region || 'us-east-1').trim(),
    bucket: String(c.bucket || '').trim(),
    ak: String(c.ak || c.accessKey || '').trim(),
    sk: String(c.sk || c.secretKey || ''),
    pathStyle: c.pathStyle === true || c.pathStyle === 'true'
  }
}

/* ---------------- 生命周期 ---------------- */
function activate(context) {
  console.log(`[ObjectStorage] Activating v${context.manifest.version}...`)
  try {
    context.ui.registerToolPage({ id: 'browser', title: '对象存储', icon: '🗄️', renderer: 'index.html' })
  } catch (err) {
    console.warn('[ObjectStorage] registerToolPage skipped:', err && err.message)
  }
  startServer()
}

async function deactivate() {
  if (server) { server.close(); server = null }
  console.log('[ObjectStorage] Deactivated')
}

module.exports = { activate, deactivate }

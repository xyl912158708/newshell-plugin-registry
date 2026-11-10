/* Kafka Studio · 页面应用（Vue render 函数） */
const { createApp, ref, reactive, computed, h, watch, nextTick, onMounted, onUnmounted } = Vue
const PROXY = 'http://127.0.0.1:17933'

const storeBridge = {
  req(action, payload) {
    return new Promise((resolve, reject) => {
      const requestId = Math.floor(Math.random() * 1e9) + 1
      const handler = (ev) => {
        const d = ev.data
        if (!d || d.type !== 'newshell:plugin-action-response' || d.requestId !== requestId) return
        window.removeEventListener('message', handler)
        if (d.error) reject(new Error(d.error)); else resolve(d.result)
      }
      window.addEventListener('message', handler)
      // 必须深克隆：payload 里的 Vue 响应式代理（ref/reactive）无法被 postMessage
      // 结构化克隆，会同步抛 DataCloneError，导致保存静默失败、数据丢失
      const safePayload = JSON.parse(JSON.stringify(Object.assign({}, payload)))
      parent.postMessage({ type: 'newshell:plugin-action', action, payload: safePayload, requestId }, '*')
      setTimeout(() => { window.removeEventListener('message', handler); reject(new Error('宿主响应超时')) }, 10000)
    })
  },
  get: (key) => storeBridge.req('storage-get', { key }),
  set: (key, value) => storeBridge.req('storage-set', { key, value }),
  getAll: () => storeBridge.req('storage-get-all', {})
}
let toastFn = null
function toast(msg) { if (toastFn) toastFn(msg) }
function fmtTime(ts) { if (!ts) return '-'; const d = new Date(ts); return isNaN(d) ? '-' : d.toLocaleString('zh-CN', { hour12: false }) }
function b64Bytes(b64) {
  if (b64 === null || b64 === undefined) return null
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function decodeBytes(b64, mode) {
  if (b64 === null || b64 === undefined) return '(null)'
  const bytes = b64Bytes(b64)
  if (mode === 'hex') return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (mode === 'base64') return b64
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (mode === 'json') { try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text } }
  return text
}
const RES_TYPES = [[0, '未知'], [1, '任意'], [2, 'Topic'], [3, '消费组'], [4, '事务 ID'], [5, 'Broker'], [6, 'Delegation Token'], [7, '用户']]
const OPS = [[0, '未知'], [1, '任意'], [2, 'Read'], [3, 'Write'], [4, 'Create'], [5, 'Delete'], [6, 'Alter'], [7, 'Describe'], [8, 'ClusterAction'], [9, 'DescribeConfigs'], [10, 'AlterConfigs'], [11, 'IdempotentWrite']]
const PERMS = [[0, '未知'], [1, '任意'], [2, 'Deny'], [3, 'Allow']]
const PATTERNS = [[1, '任意'], [2, 'Match'], [3, '字面量'], [4, '前缀']]
const nameOf = (table, v) => (table.find(([x]) => x === v) || [v, String(v)])[1]

const App = {
  setup() {
    const uiTheme = ref('dark')
    const toastText = ref(''); const toastShow = ref(false)
    let toastTimer = null
    toastFn = (msg) => { toastText.value = msg; toastShow.value = true; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastShow.value = false }, 2800) }
    function resize() { nextTick(() => { const el = document.getElementById('app'); parent.postMessage({ type: 'newshell:resize', height: el ? el.scrollHeight : document.body.scrollHeight }, '*') }) }
    async function toggleTheme() {
      uiTheme.value = uiTheme.value === 'dark' ? 'light' : 'dark'
      if (window.__osSetTheme) window.__osSetTheme(uiTheme.value)
      try { await storeBridge.set('ui-theme', uiTheme.value) } catch (_) {}
    }

    /* ---------- 连接与会话 ---------- */
    const connections = ref([])
    const connId = ref('')
    const curConn = computed(() => connections.value.find((c) => c.id === connId.value) || null)
    const session = reactive({ id: '', connecting: false, brokers: [] })
    const editor = reactive({ open: false, id: '', name: '', brokers: '', clientId: 'newshell-kafka-studio', saslUser: '', saslPass: '', srUrl: '', testing: false, testMsg: '', testOk: false })
    function cfgOf(c) { return c ? { brokers: c.brokers, clientId: c.clientId || 'newshell-kafka-studio', sasl: c.saslUser ? { user: c.saslUser, pass: c.saslPass || '' } : null } : null }
    async function proxyPost(path, obj) {
      let r
      try { r = await fetch(PROXY + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }).then((x) => x.json()) }
      catch (e) { throw new Error('无法连接插件代理（请确认插件已启用）') }
      if (r.error) throw new Error(r.error)
      return r
    }
    async function kcall(op, params) {
      if (!session.id) throw new Error('尚未连接集群（请先点「连接」）')
      const r = await proxyPost('/kafka/call', { sessionId: session.id, op, params })
      return r.result
    }
    async function connect() {
      if (!curConn.value) return
      session.connecting = true
      try {
        const r = await proxyPost('/kafka/open', { cfg: cfgOf(curConn.value) })
        session.id = r.sessionId; session.brokers = r.brokers || []
        toast('已连接 ' + curConn.value.name)
        loadCluster()
      } catch (e) { toast('连接失败：' + e.message) }
      session.connecting = false
    }
    async function disconnect() {
      stopStream()
      if (session.id) { try { await proxyPost('/kafka/close', { sessionId: session.id }) } catch (_) {} }
      session.id = ''; cluster.topics = []; cluster.brokers = []
    }
    function selectConnection(id) {
      if (connId.value === id) return
      disconnect()
      connId.value = id
      try { storeBridge.set('lastConnId', id) } catch (_) {}
      sr.subjects = []; msg.records = []
    }
    async function persistConns() { try { await storeBridge.set('connections', connections.value) } catch (_) {} }
    function openEditor(c) {
      Object.assign(editor, { open: true, id: c ? c.id : '', name: c ? c.name : '', brokers: c ? c.brokers : '127.0.0.1:9092', clientId: c ? (c.clientId || 'newshell-kafka-studio') : 'newshell-kafka-studio', saslUser: c ? (c.saslUser || '') : '', saslPass: c ? (c.saslPass || '') : '', srUrl: c ? (c.srUrl || '') : '', testing: false, testMsg: '', testOk: false })
    }
    async function testEditor() {
      editor.testing = true; editor.testMsg = ''
      try {
        const r = await proxyPost('/kafka/open', { cfg: { brokers: editor.brokers, clientId: editor.clientId, sasl: editor.saslUser ? { user: editor.saslUser, pass: editor.saslPass } : null } })
        await proxyPost('/kafka/close', { sessionId: r.sessionId })
        editor.testOk = true; editor.testMsg = '连接成功：发现 ' + (r.brokers || []).length + ' 个 Broker'
      } catch (e) { editor.testOk = false; editor.testMsg = '连接失败：' + e.message }
      editor.testing = false
    }
    async function saveEditor() {
      if (!editor.name.trim()) return toast('请填写连接名称')
      if (!editor.brokers.trim()) return toast('请填写 Broker 列表（host:port，逗号分隔）')
      const data = { name: editor.name.trim(), brokers: editor.brokers.trim(), clientId: editor.clientId.trim(), saslUser: editor.saslUser.trim(), saslPass: editor.saslPass, srUrl: editor.srUrl.trim().replace(/\/+$/, '') }
      if (editor.id) { const c = connections.value.find((x) => x.id === editor.id); if (c) Object.assign(c, data) }
      else { const id = 'k' + Date.now().toString(36); connections.value.push(Object.assign({ id }, data)); connId.value = id }
      await persistConns()
      editor.open = false
      if (editor.id === connId.value) disconnect()
      toast('连接已保存')
    }
    async function deleteEditor() {
      if (!(await showConfirm('删除连接', '确定删除该连接配置？', '删除'))) return
      if (connId.value === editor.id) await disconnect()
      connections.value = connections.value.filter((x) => x.id !== editor.id)
      if (connId.value === editor.id) connId.value = connections.value[0]?.id || ''
      await persistConns()
      editor.open = false
    }
    const confirmModal = reactive({ open: false, title: '', text: '', okText: '确定' })
    let confirmResolve = null
    function showConfirm(title, text, okText) { confirmModal.title = title; confirmModal.text = text; confirmModal.okText = okText || '确定'; confirmModal.open = true; return new Promise((r) => { confirmResolve = r }) }
    function resolveConfirm(v) { confirmModal.open = false; if (confirmResolve) { confirmResolve(v); confirmResolve = null } }

    /* ---------- 集群 ---------- */
    const tab = ref('cluster')
    const cluster = reactive({ brokers: [], topics: [], controllerId: null, loading: false, selTopic: '', partitions: [], partsLoading: false })
    async function loadCluster() {
      if (!session.id) return
      cluster.loading = true
      try {
        const r = await kcall('metadata')
        cluster.brokers = r.brokers; cluster.topics = r.topics; cluster.controllerId = r.controllerId
        if (cluster.selTopic) await loadTopicParts(cluster.selTopic)
      } catch (e) { toast('加载集群信息失败：' + e.message) }
      cluster.loading = false
      resize()
    }
    async function loadTopicParts(topic) {
      cluster.selTopic = topic; cluster.partsLoading = true
      try { const r = await kcall('topicOffsets', { topic }); cluster.partitions = r.partitions } catch (e) { toast('加载分区失败：' + e.message); cluster.partitions = [] }
      cluster.partsLoading = false
      resize()
    }

    /* ---------- 消息 ---------- */
    const msg = reactive({ topic: '', partition: 0, parts: [], mode: 'latest', count: 50, offset: 0, decode: 'text', fKey: '', fVal: '', records: [], loading: false, expanded: -1, streaming: false, intervalMs: 2000, nextOffset: 0, hw: 0 })
    let streamTimer = null
    async function msgLoadParts() {
      msg.parts = []
      if (!msg.topic) return
      try { const r = await kcall('topicOffsets', { topic: msg.topic }); msg.parts = r.partitions; if (!r.partitions.find((p) => p.partition === msg.partition)) msg.partition = r.partitions[0]?.partition ?? 0 } catch (e) { toast(e.message) }
    }
    function applyFilters(records) {
      return records.filter((rec) => {
        if (rec.placeholder) return true
        const k = msg.fKey ? decodeBytes(rec.key, 'text') : ''
        const v = msg.fVal ? decodeBytes(rec.value, 'text') : ''
        if (msg.fKey && !k.includes(msg.fKey)) return false
        if (msg.fVal && !v.includes(msg.fVal)) return false
        return true
      })
    }
    async function fetchOnce(fromOffset, limit) {
      const r = await kcall('fetch', { topic: msg.topic, partition: msg.partition, offset: fromOffset, maxBytes: 4 * 1024 * 1024, limit })
      msg.hw = r.highWatermark
      return r.records
    }
    async function msgFetch() {
      if (!msg.topic) return toast('请选择 Topic')
      stopStream()
      msg.loading = true; msg.expanded = -1
      try {
        const meta = msg.parts.find((p) => p.partition === msg.partition)
        let start
        if (msg.mode === 'latest') start = Math.max(meta ? meta.earliest : 0, (meta ? meta.latest : 0) - Number(msg.count || 50))
        else if (msg.mode === 'earliest') start = meta ? meta.earliest : 0
        else start = Number(msg.offset) || 0
        const records = await fetchOnce(start, 500)
        const real = records.filter((x) => !x.placeholder)
        msg.records = applyFilters(msg.mode === 'latest' && real.length > Number(msg.count || 50) ? [...records.filter((x) => x.placeholder), ...real.slice(-Number(msg.count || 50))] : records)
        msg.nextOffset = real.length ? real[real.length - 1].offset + 1 : start
      } catch (e) { toast('拉取消息失败：' + e.message) }
      msg.loading = false
      resize()
    }
    async function streamTick() {
      if (!msg.streaming) return
      try {
        const records = await fetchOnce(msg.nextOffset, 200)
        const real = records.filter((x) => !x.placeholder)
        if (real.length) {
          msg.records = applyFilters(msg.records.concat(records)).slice(-500)
          msg.nextOffset = real[real.length - 1].offset + 1
          resize()
        }
      } catch (e) { toast('流式消费出错：' + e.message); stopStream() }
    }
    function startStream() {
      if (!msg.topic) return toast('请选择 Topic')
      if (!msg.records.length && msg.mode !== 'offset') { /* 从最新开始 */ const meta = msg.parts.find((p) => p.partition === msg.partition); msg.nextOffset = meta ? meta.latest : 0 }
      msg.streaming = true
      streamTimer = setInterval(streamTick, Math.max(500, Number(msg.intervalMs) || 2000))
    }
    function stopStream() { msg.streaming = false; if (streamTimer) { clearInterval(streamTimer); streamTimer = null } }

    /* ---------- 消费组 ---------- */
    const grp = reactive({ list: [], loading: false, detail: null, offsets: [], busy: false })
    async function loadGroups() {
      grp.loading = true
      try { const r = await kcall('groups'); grp.list = r.groups } catch (e) { toast('加载消费组失败：' + e.message) }
      grp.loading = false
      resize()
    }
    async function openGroup(g) {
      grp.busy = true
      try { const r = await kcall('describeGroup', { group: g.id }); grp.detail = r.group; grp.offsets = r.offsets } catch (e) { toast('加载消费组详情失败：' + e.message) }
      grp.busy = false
      resize()
    }
    async function resetOffset(row, target) {
      let newOffset
      if (target === 'earliest' || target === 'latest') {
        try { const parts = await kcall('topicOffsets', { topic: row.topic }); const p = parts.partitions.find((x) => x.partition === row.partition); newOffset = target === 'earliest' ? p.earliest : p.latest } catch (e) { return toast(e.message) }
      } else {
        const v = await showPrompt('设置 Offset', '为 ' + row.topic + ' 分区 ' + row.partition + ' 输入新的已提交 Offset：', String(row.committed ?? 0), '设置')
        if (v === null) return
        newOffset = Number(v)
        if (!Number.isInteger(newOffset) || newOffset < 0) return toast('Offset 必须是非负整数')
      }
      if (!(await showConfirm('重置 Offset', '消费组 ' + grp.detail.id + '\n' + row.topic + ' / 分区 ' + row.partition + '：已提交 Offset ' + (row.committed ?? '无') + ' → ' + newOffset + '\n\n注意：组内有活跃成员时提交可能被拒绝或被覆盖。', '重置'))) return
      try { await kcall('commitOffset', { group: grp.detail.id, topic: row.topic, partition: row.partition, offset: newOffset }); toast('已重置'); openGroup(grp.detail) } catch (e) { toast('重置失败：' + e.message) }
    }
    const promptModal = reactive({ open: false, title: '', text: '', value: '', okText: '确定' })
    let promptResolve = null
    function showPrompt(title, text, value, okText) { promptModal.title = title; promptModal.text = text; promptModal.value = value || ''; promptModal.okText = okText || '确定'; promptModal.open = true; return new Promise((r) => { promptResolve = r }) }
    function resolvePrompt(v) { promptModal.open = false; if (promptResolve) { promptResolve(v ? promptModal.value : null); promptResolve = null } }

    /* ---------- ACL ---------- */
    const acl = reactive({ list: [], loading: false, filterType: 'all', create: { resourceType: 2, resourceName: '', patternType: 3, principal: '', host: '*', operation: 3, permissionType: 3 }, creating: false })
    async function loadAcls() {
      acl.loading = true
      try { const r = await kcall('acls', {}); acl.list = r.acls } catch (e) { toast('加载 ACL 失败：' + e.message) }
      acl.loading = false
      resize()
    }
    async function aclCreate() {
      const c = acl.create
      if (!c.resourceName.trim() || !c.principal.trim()) return toast('请填写资源名与 Principal（如 User:alice）')
      try { await kcall('aclCreate', { creation: { resourceType: Number(c.resourceType), resourceName: c.resourceName.trim(), patternType: Number(c.patternType), principal: c.principal.trim(), host: c.host.trim() || '*', operation: Number(c.operation), permissionType: Number(c.permissionType) } }); toast('ACL 已创建'); acl.creating = false; loadAcls() } catch (e) { toast('创建 ACL 失败：' + e.message) }
    }
    async function aclDelete(a) {
      if (!(await showConfirm('删除 ACL', '删除规则：' + nameOf(RES_TYPES, a.resourceType) + '「' + a.resourceName + '」 ' + a.principal + ' @ ' + a.host + ' ' + nameOf(OPS, a.operation) + '/' + nameOf(PERMS, a.permissionType) + '？', '删除'))) return
      try { const r = await kcall('aclDelete', { filter: { resourceType: a.resourceType, resourceName: a.resourceName, patternType: a.patternType, principal: a.principal, host: a.host, operation: a.operation, permissionType: a.permissionType } }); toast('已删除（匹配 ' + (r.matched ?? 0) + ' 条）'); loadAcls() } catch (e) { toast('删除 ACL 失败：' + e.message) }
    }

    /* ---------- Schema Registry ---------- */
    const sr = reactive({ subjects: [], loading: false, sel: '', versions: [], selVersion: '', schema: null, compat: '', err: '' })
    async function srCall(method, path, body) {
      if (!curConn.value || !curConn.value.srUrl) throw new Error('该连接未配置 Schema Registry 地址')
      const r = await proxyPost('/sr', { cfg: { url: curConn.value.srUrl }, method, path, body })
      if (r.status >= 400) throw new Error('SR HTTP ' + r.status + (r.data && r.data.message ? '：' + r.data.message : ''))
      return r.data
    }
    async function loadSubjects() {
      sr.loading = true; sr.err = ''
      try { sr.subjects = await srCall('GET', '/subjects'); sr.compat = (await srCall('GET', '/config').catch(() => ({}))).compatibilityLevel || '' } catch (e) { sr.err = e.message; sr.subjects = [] }
      sr.loading = false
      resize()
    }
    async function openSubject(name) {
      sr.sel = name; sr.schema = null
      try { sr.versions = await srCall('GET', '/subjects/' + encodeURIComponent(name) + '/versions'); if (sr.versions.length) await openSchemaVersion(sr.versions[sr.versions.length - 1]) } catch (e) { toast('加载版本失败：' + e.message) }
      resize()
    }
    async function openSchemaVersion(v) {
      sr.selVersion = String(v)
      try { sr.schema = await srCall('GET', '/subjects/' + encodeURIComponent(sr.sel) + '/versions/' + v) } catch (e) { toast('加载 Schema 失败：' + e.message) }
      resize()
    }

    function switchTab(t) {
      tab.value = t
      if (!session.id) return
      if (t === 'cluster' && !cluster.topics.length) loadCluster()
      if (t === 'groups' && !grp.list.length) loadGroups()
      if (t === 'acl' && !acl.list.length) loadAcls()
      if (t === 'schema' && curConn.value?.srUrl && !sr.subjects.length) loadSubjects()
      resize()
    }
    watch(tab, () => resize())
    onMounted(async () => {
      try {
        const all = await storeBridge.getAll()
        if (Array.isArray(all.connections)) connections.value = all.connections
        if (all.lastConnId) connId.value = all.lastConnId
        if (all['ui-theme'] === 'light' || all['ui-theme'] === 'dark') { uiTheme.value = all['ui-theme']; if (window.__osSetTheme) window.__osSetTheme(uiTheme.value) }
      } catch (_) { /* ignore */ }
      if (!connId.value && connections.value.length) connId.value = connections.value[0].id
      resize()
    })
    onUnmounted(() => stopStream())

    /* ---------- 渲染辅助 ---------- */
    function simpleTable(headers, rows) {
      return h('table', { class: 'kv-table' }, [
        h('thead', [h('tr', headers.map((x) => h('th', x)))]),
        h('tbody', rows.map((cells) => h('tr', cells.map((c) => h('td', c === null || c === undefined ? '-' : c)))))
      ])
    }

    function renderCluster() {
      if (!session.id) return h('div', { class: 'list-empty' }, [h('div', { class: 'big' }, '尚未连接集群'), h('div', '在左侧选择连接后点「连接」，即可巡检 Broker、Topic 与分区偏移')])
      return h('div', [
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } }, [h('span', { class: 'io-label', style: { margin: 0 } }, 'Broker（' + cluster.brokers.length + '）'), h('span', { style: { flex: 1 } }), h('button', { class: ['btn', 'ghost', 'small'], disabled: cluster.loading, onClick: loadCluster }, cluster.loading ? '刷新中…' : '刷新')]),
        simpleTable(['ID', '地址', 'Rack', '角色'], cluster.brokers.map((b) => [String(b.id), b.host + ':' + b.port, b.rack || '-', b.id === cluster.controllerId ? 'Controller' : 'Broker'])),
        h('div', { class: 'io-label', style: { marginTop: '14px' } }, 'Topic（' + cluster.topics.length + '）'),
        cluster.topics.length ? h('table', { class: 'kv-table' }, [
          h('tr', [h('th', 'Topic'), h('th', '分区数'), h('th', '消息总量（估算）'), h('th', '')]),
          ...cluster.topics.map((t) => h('tr', { class: 'clickable', onClick: () => loadTopicParts(t.name) }, [h('td', { class: 'mono' }, t.name), h('td', String(t.partitions)), h('td', String(t.messages)), h('td', cluster.selTopic === t.name ? '已展开' : '查看分区 →')]))
        ]) : h('div', { style: { color: 'var(--text-secondary)' } }, '暂无 Topic'),
        cluster.selTopic ? h('div', [
          h('div', { class: 'io-label', style: { marginTop: '14px' } }, '分区 · ' + cluster.selTopic),
          cluster.partsLoading ? h('div', '加载中…') : simpleTable(['分区', 'Leader', '副本', 'ISR', '最早 Offset', '最新 Offset', '消息数'], cluster.partitions.map((p) => [String(p.partition), String(p.leader), (p.replicas || []).join(','), (p.isr || []).join(','), String(p.earliest), String(p.latest), String(Math.max(0, p.latest - p.earliest))]))
        ]) : null
      ])
    }

    function renderMessages() {
      if (!session.id) return h('div', { class: 'list-empty' }, [h('div', { class: 'big' }, '尚未连接集群')])
      const topicOptions = cluster.topics.map((t) => t.name)
      return h('div', [
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '10px' } }, [
          h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', 'Topic'), h('select', { value: msg.topic, style: { height: '32px', width: 'auto', marginBottom: 0 }, onChange: (e) => { msg.topic = e.target.value; msgLoadParts() } }, [h('option', { value: '' }, '选择 Topic'), ...topicOptions.map((t) => h('option', { value: t }, t))])]),
          h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', '分区'), h('select', { value: String(msg.partition), style: { height: '32px', width: 'auto', marginBottom: 0 }, onChange: (e) => { msg.partition = Number(e.target.value) } }, msg.parts.map((p) => h('option', { value: String(p.partition) }, '分区 ' + p.partition + '（' + Math.max(0, p.latest - p.earliest) + ' 条）')))]),
          h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', '起点'), h('select', { value: msg.mode, style: { height: '32px', width: 'auto', marginBottom: 0 }, onChange: (e) => { msg.mode = e.target.value } }, [h('option', { value: 'latest' }, '最新 N 条'), h('option', { value: 'earliest' }, '从最早'), h('option', { value: 'offset' }, '指定 Offset')])]),
          msg.mode === 'latest' ? h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', '条数'), h('input', { value: msg.count, type: 'number', min: 1, max: 500, style: { height: '32px', width: '76px', marginBottom: 0 }, onInput: (e) => { msg.count = e.target.value } })]) : null,
          msg.mode === 'offset' ? h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', 'Offset'), h('input', { value: msg.offset, type: 'number', min: 0, style: { height: '32px', width: '110px', marginBottom: 0 }, onInput: (e) => { msg.offset = e.target.value } })]) : null,
          h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', '解码'), h('select', { value: msg.decode, style: { height: '32px', width: 'auto', marginBottom: 0 }, onChange: (e) => { msg.decode = e.target.value } }, [h('option', { value: 'text' }, '文本 UTF-8'), h('option', { value: 'json' }, 'JSON 美化'), h('option', { value: 'hex' }, 'Hex'), h('option', { value: 'base64' }, 'Base64')])]),
          h('button', { class: 'btn', disabled: msg.loading, onClick: msgFetch }, msg.loading ? '拉取中…' : '拉取'),
          msg.streaming ? h('button', { class: ['btn', 'danger'], onClick: stopStream }, '停止流式') : h('button', { class: ['btn', 'ghost'], onClick: startStream }, '流式消费'),
          msg.streaming ? h('span', { class: 'badge warn' }, '流式中 · 下一 Offset ' + msg.nextOffset) : null
        ]),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' } }, [
          h('input', { value: msg.fKey, placeholder: '按 Key 过滤（包含）…', style: { height: '30px', width: '200px', marginBottom: 0, fontSize: '12.5px' }, onInput: (e) => { msg.fKey = e.target.value } }),
          h('input', { value: msg.fVal, placeholder: '按 Value 过滤（包含）…', style: { height: '30px', width: '240px', marginBottom: 0, fontSize: '12.5px' }, onInput: (e) => { msg.fVal = e.target.value } }),
          h('span', { style: { fontSize: '12px', color: 'var(--text-secondary)', alignSelf: 'center' } }, '共 ' + msg.records.length + ' 条' + (msg.hw ? ' · 高水位 ' + msg.hw : '') + '（过滤在拉取后点「拉取」生效，流式实时生效）')
        ]),
        msg.records.length ? h('div', msg.records.map((rec, i) => {
          if (rec.placeholder) return h('div', { class: 'rec-item' }, [h('div', { class: 'rec-head' }, [h('span', { class: 'badge warn' }, '压缩批次'), h('span', rec.note + '（起始 Offset ' + rec.baseOffset + '，约 ' + rec.count + ' 条）')])])
          const expanded = msg.expanded === i
          return h('div', { class: 'rec-item' }, [
            h('div', { class: 'rec-head', onClick: () => { msg.expanded = expanded ? -1 : i; resize() } }, [
              h('span', { class: 'mono' }, '#' + rec.offset),
              h('span', { style: { color: 'var(--text-secondary)' } }, fmtTime(rec.timestamp)),
              h('span', { class: 'mono', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, 'key: ' + decodeBytes(rec.key, 'text').slice(0, 60) + ' · ' + decodeBytes(rec.value, msg.decode === 'json' ? 'text' : msg.decode).replace(/\s+/g, ' ').slice(0, 90))
            ]),
            expanded ? h('div', { class: 'rec-body' }, [
              h('div', { class: 'io-label' }, 'Key'), h('pre', decodeBytes(rec.key, msg.decode)),
              h('div', { class: 'io-label' }, 'Value'), h('pre', decodeBytes(rec.value, msg.decode)),
              rec.headers && rec.headers.length ? h('div', [h('div', { class: 'io-label' }, 'Headers'), ...rec.headers.map((hh) => h('div', { class: 'mono', style: { fontSize: '12px' } }, hh.key + ': ' + decodeBytes(hh.value, 'text')))]) : null
            ]) : null
          ])
        })) : h('div', { style: { color: 'var(--text-secondary)', padding: '8px 0' } }, '选择 Topic 与分区后点「拉取」，或直接开启流式消费')
      ])
    }

    function renderGroups() {
      if (!session.id) return h('div', { class: 'list-empty' }, [h('div', { class: 'big' }, '尚未连接集群')])
      if (grp.detail) {
        const g = grp.detail
        return h('div', [
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' } }, [
            h('button', { class: ['btn', 'ghost', 'small'], onClick: () => { grp.detail = null; resize() } }, '← 返回列表'),
            h('span', { style: { fontWeight: 650 } }, g.id),
            h('span', { class: 'badge' }, g.state),
            h('span', { style: { color: 'var(--text-secondary)', fontSize: '12px' } }, '协议 ' + (g.protocol || '-') + ' · 成员 ' + g.members.length)
          ]),
          g.members.length ? h('div', [h('div', { class: 'io-label' }, '成员'), simpleTable(['Member ID', 'Client ID', '主机', '订阅'], g.members.map((m) => [m.id, m.clientId, m.host, m.assignment.map((a) => a.name + '[' + a.partitions.join(',') + ']').join(' ')]))]) : null,
          h('div', { class: 'io-label', style: { marginTop: '12px' } }, 'Offset 与 Lag'),
          grp.offsets.length ? h('table', { class: 'kv-table' }, [
            h('tr', [h('th', 'Topic'), h('th', '分区'), h('th', '已提交'), h('th', '最新'), h('th', 'Lag'), h('th', '重置为')]),
            ...grp.offsets.map((o) => h('tr', [
              h('td', { class: 'mono' }, o.topic), h('td', String(o.partition)), h('td', o.committed === null ? '无' : String(o.committed)), h('td', o.latest === null ? '-' : String(o.latest)),
              h('td', o.lag === null ? '-' : h('span', { class: ['badge', { warn: o.lag > 0 }] }, String(o.lag))),
              h('td', h('span', { style: { display: 'flex', gap: '5px' } }, [
                h('button', { class: ['btn', 'ghost', 'small'], onClick: () => resetOffset(o, 'earliest') }, '最早'),
                h('button', { class: ['btn', 'ghost', 'small'], onClick: () => resetOffset(o, 'latest') }, '最新'),
                h('button', { class: ['btn', 'ghost', 'small'], onClick: () => resetOffset(o, 'custom') }, '指定…')
              ]))
            ]))
          ]) : h('div', { style: { color: 'var(--text-secondary)' } }, '该组暂无 Offset 记录')
        ])
      }
      return h('div', [
        h('div', { style: { display: 'flex', marginBottom: '8px' } }, [h('span', { class: 'io-label', style: { margin: 0 } }, '消费组（' + grp.list.length + '）'), h('span', { style: { flex: 1 } }), h('button', { class: ['btn', 'ghost', 'small'], disabled: grp.loading, onClick: loadGroups }, '刷新')]),
        grp.loading && !grp.list.length ? h('div', '加载中…') : grp.list.length ? h('div', grp.list.map((g) => h('div', { class: 'gl-item', style: { display: 'flex', gap: '10px', padding: '9px 4px', borderBottom: '1px solid color-mix(in srgb, var(--border-color) 40%, transparent)', cursor: 'pointer' }, onClick: () => openGroup(g) }, [
          h('span', { class: 'mono', style: { fontWeight: 550 } }, g.id),
          h('span', { style: { color: 'var(--text-secondary)', fontSize: '12px' } }, g.protocolType),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { color: 'var(--text-secondary)', fontSize: '12px' } }, '查看 Lag →')
        ]))) : h('div', { class: 'list-empty' }, '暂无消费组')
      ])
    }

    function renderAcl() {
      if (!session.id) return h('div', { class: 'list-empty' }, [h('div', { class: 'big' }, '尚未连接集群')])
      const filtered = acl.list.filter((a) => acl.filterType === 'all' || String(a.resourceType) === acl.filterType)
      return h('div', [
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } }, [
          h('span', { class: 'io-label', style: { margin: 0 } }, 'ACL 规则（' + filtered.length + '）'),
          h('span', { style: { flex: 1 } }),
          h('select', { value: acl.filterType, style: { height: '30px', width: 'auto', marginBottom: 0, fontSize: '12.5px' }, onChange: (e) => { acl.filterType = e.target.value } }, [h('option', { value: 'all' }, '全部资源类型'), ...RES_TYPES.slice(2).map(([v, t]) => h('option', { value: String(v) }, t))]),
          h('button', { class: ['btn', 'ghost', 'small'], disabled: acl.loading, onClick: loadAcls }, '刷新'),
          h('button', { class: ['btn', 'small'], onClick: () => { acl.creating = !acl.creating; resize() } }, '新建 ACL')
        ]),
        acl.creating ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '12px', padding: '10px', border: '1px solid color-mix(in srgb, var(--border-color) 50%, transparent)', borderRadius: '8px' } }, [
          h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', '资源类型'), h('select', { value: String(acl.create.resourceType), style: { height: '32px', marginBottom: 0 }, onChange: (e) => { acl.create.resourceType = e.target.value } }, RES_TYPES.slice(2).map(([v, t]) => h('option', { value: String(v) }, t)))]),
          h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', '资源名'), h('input', { value: acl.create.resourceName, placeholder: 'orders 或 *', style: { height: '32px', marginBottom: 0 }, onInput: (e) => { acl.create.resourceName = e.target.value } })]),
          h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', '模式'), h('select', { value: String(acl.create.patternType), style: { height: '32px', marginBottom: 0 }, onChange: (e) => { acl.create.patternType = e.target.value } }, PATTERNS.slice(2).map(([v, t]) => h('option', { value: String(v) }, t)))]),
          h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', 'Principal'), h('input', { value: acl.create.principal, placeholder: 'User:alice', style: { height: '32px', marginBottom: 0 }, onInput: (e) => { acl.create.principal = e.target.value } })]),
          h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', '主机'), h('input', { value: acl.create.host, style: { height: '32px', width: '90px', marginBottom: 0 }, onInput: (e) => { acl.create.host = e.target.value } })]),
          h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', '操作'), h('select', { value: String(acl.create.operation), style: { height: '32px', marginBottom: 0 }, onChange: (e) => { acl.create.operation = e.target.value } }, OPS.slice(2).map(([v, t]) => h('option', { value: String(v) }, t)))]),
          h('div', { class: 'form-row', style: { marginBottom: 0 } }, [h('label', '权限'), h('select', { value: String(acl.create.permissionType), style: { height: '32px', marginBottom: 0 }, onChange: (e) => { acl.create.permissionType = e.target.value } }, PERMS.slice(2).map(([v, t]) => h('option', { value: String(v) }, t)))]),
          h('button', { class: 'btn', onClick: aclCreate }, '创建')
        ]) : null,
        acl.loading && !acl.list.length ? h('div', '加载中…') : filtered.length ? simpleTable(['资源', '模式', 'Principal', '主机', '操作', '权限', ''], filtered.map((a) => [
          nameOf(RES_TYPES, a.resourceType) + ' · ' + a.resourceName, nameOf(PATTERNS, a.patternType), a.principal, a.host, nameOf(OPS, a.operation), nameOf(PERMS, a.permissionType),
          h('button', { class: ['btn', 'ghost', 'small'], onClick: () => aclDelete(a) }, '删除')
        ])) : h('div', { class: 'list-empty' }, '暂无 ACL 规则（集群可能未开启 ACL/授权器）')
      ])
    }

    function renderSchema() {
      if (!curConn.value) return h('div', { class: 'list-empty' }, [h('div', { class: 'big' }, '先选择一个连接')])
      if (!curConn.value.srUrl) return h('div', { class: 'list-empty' }, [h('div', { class: 'big' }, '该连接未配置 Schema Registry'), h('div', '编辑连接时填写 SR 地址（如 http://127.0.0.1:8081）后可用')])
      return h('div', [
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } }, [
          h('span', { class: 'io-label', style: { margin: 0 } }, 'Subjects（' + sr.subjects.length + '）'),
          sr.compat ? h('span', { class: 'badge', style: { marginLeft: '8px' } }, '全局兼容性 ' + sr.compat) : null,
          h('span', { style: { flex: 1 } }),
          h('button', { class: ['btn', 'ghost', 'small'], disabled: sr.loading, onClick: loadSubjects }, '刷新')
        ]),
        sr.err ? h('div', { class: 'err-text' }, '加载失败：' + sr.err) : null,
        h('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' } }, [
          h('div', { style: { minWidth: '220px' } }, sr.subjects.map((name) => h('div', { style: { padding: '7px 10px', cursor: 'pointer', borderRadius: '6px', fontSize: '12.5px', background: sr.sel === name ? 'var(--bg-tertiary)' : 'transparent' }, onClick: () => openSubject(name) }, name))),
          sr.sel ? h('div', { style: { flex: 1, minWidth: '300px' } }, [
            h('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' } }, sr.versions.map((v) => h('button', { class: ['gl-tab', { active: sr.selVersion === String(v) }], onClick: () => openSchemaVersion(v) }, 'v' + v))),
            sr.schema ? h('div', [h('div', { style: { color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '6px' } }, 'Schema ID ' + sr.schema.id + ' · ' + sr.sel + ' v' + sr.schema.version), h('div', { class: 'code-view' }, (() => { try { return JSON.stringify(JSON.parse(sr.schema.schema), null, 2) } catch { return sr.schema.schema } })())]) : null
          ]) : null
        ])
      ])
    }

    function maskWrap(children, onMask) { return h('div', { class: 'mask', onClick: (e) => { if (e.target === e.currentTarget && onMask) onMask() } }, children) }
    function renderConfirm() {
      return maskWrap([h('div', { class: 'modal', style: { width: '440px' } }, [
        h('h2', confirmModal.title),
        h('div', { style: { lineHeight: '1.65', whiteSpace: 'pre-wrap' } }, confirmModal.text),
        h('div', { class: 'foot' }, [h('button', { class: ['btn', 'ghost'], onClick: () => resolveConfirm(false) }, '取消'), h('button', { class: ['btn', 'danger'], onClick: () => resolveConfirm(true) }, confirmModal.okText)])
      ])], () => resolveConfirm(false))
    }
    function renderPrompt() {
      return maskWrap([h('div', { class: 'modal', style: { width: '420px' } }, [
        h('h2', promptModal.title),
        h('div', { style: { marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '12.5px' } }, promptModal.text),
        h('input', { value: promptModal.value, type: 'number', onInput: (e) => { promptModal.value = e.target.value } }),
        h('div', { class: 'foot' }, [h('button', { class: ['btn', 'ghost'], onClick: () => resolvePrompt(false) }, '取消'), h('button', { class: 'btn', onClick: () => resolvePrompt(true) }, promptModal.okText)])
      ])])
    }
    function renderEditor() {
      return maskWrap([h('div', { class: 'modal', style: { width: '490px' } }, [
        h('h2', editor.id ? '编辑连接' : '新建连接'),
        h('div', { class: 'form-row' }, [h('label', '名称'), h('input', { value: editor.name, placeholder: '生产集群', onInput: (e) => { editor.name = e.target.value } })]),
        h('div', { class: 'form-row' }, [h('label', 'Broker 列表（host:port，逗号分隔）'), h('input', { value: editor.brokers, placeholder: 'kafka1:9092,kafka2:9092', onInput: (e) => { editor.brokers = e.target.value } })]),
        h('div', { class: 'form-row' }, [h('label', 'Client ID'), h('input', { value: editor.clientId, onInput: (e) => { editor.clientId = e.target.value } })]),
        h('div', { class: 'form-row' }, [h('label', 'SASL/PLAIN 用户名（无则留空，仅支持 PLAIN）'), h('input', { value: editor.saslUser, onInput: (e) => { editor.saslUser = e.target.value } })]),
        h('div', { class: 'form-row' }, [h('label', 'SASL 密码'), h('input', { value: editor.saslPass, type: 'password', onInput: (e) => { editor.saslPass = e.target.value } })]),
        h('div', { class: 'form-row' }, [h('label', 'Schema Registry 地址（可选）'), h('input', { value: editor.srUrl, placeholder: 'http://127.0.0.1:8081', onInput: (e) => { editor.srUrl = e.target.value } })]),
        editor.testMsg ? h('div', { class: editor.testOk ? 'ok-text' : 'err-text' }, editor.testMsg) : null,
        h('div', { class: 'foot' }, [
          editor.id ? h('button', { class: ['btn', 'danger'], style: { marginRight: 'auto' }, onClick: deleteEditor }, '删除连接') : null,
          h('button', { class: ['btn', 'ghost'], disabled: editor.testing, onClick: testEditor }, editor.testing ? '测试中…' : '测试连接'),
          h('button', { class: ['btn', 'ghost'], onClick: () => { editor.open = false } }, '取消'),
          h('button', { class: 'btn', onClick: saveEditor }, '保存')
        ])
      ])])
    }

    return () => {
      const side = h('aside', { class: 'side' }, [
        h('div', { class: 'side-head' }, [h('span', { style: { fontSize: '13px' } }, 'Kafka 连接'), h('button', { class: 'icon-btn', title: '新建连接', onClick: () => openEditor(null) }, '＋')]),
        h('div', { class: 'conn-list' }, connections.value.length ? connections.value.map((c) => h('div', { class: ['conn-item', { active: c.id === connId.value }], onClick: () => selectConnection(c.id) }, [
          h('span', { class: ['conn-dot', { on: session.id && c.id === connId.value }] }),
          h('span', { class: 'nm' }, c.name),
          h('button', { class: 'icon-btn', title: '编辑', onClick: (e) => { e.stopPropagation(); openEditor(c) } }, h('span', { innerHTML: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>', style: { display: 'inline-flex' } }))
        ])) : h('div', { style: { color: 'var(--text-secondary)', fontSize: '12px', padding: '6px 2px', lineHeight: '1.7' } }, '暂无连接，点右上角 ＋ 新建')),
        curConn.value ? h('div', { style: { marginTop: '10px' } }, [
          session.id
            ? h('button', { class: ['btn', 'danger'], style: { width: '100%' }, onClick: disconnect }, '断开（' + session.brokers.length + ' 个 Broker）')
            : h('button', { class: 'btn', style: { width: '100%' }, disabled: session.connecting, onClick: connect }, session.connecting ? '连接中…' : '连接集群')
        ]) : null
      ])
      let main
      if (!curConn.value) {
        main = h('div', { class: 'list-empty', style: { margin: 'auto' } }, [h('div', { class: 'big' }, '欢迎使用 Kafka Studio'), h('div', '新建连接后即可巡检 Topic/Broker/消费组 Lag，流式消费消息，管理 Offset、ACL 与 Schema Registry')])
      } else {
        const content = tab.value === 'cluster' ? renderCluster() : tab.value === 'messages' ? renderMessages() : tab.value === 'groups' ? renderGroups() : tab.value === 'acl' ? renderAcl() : renderSchema()
        main = h('main', { class: 'main' }, [
          h('div', { class: 'gl-tabs' }, [['cluster', '集群'], ['messages', '消息'], ['groups', '消费组'], ['acl', 'ACL'], ['schema', 'Schema']].map(([v, t]) => h('button', { class: ['gl-tab', { active: tab.value === v }], onClick: () => switchTab(v) }, t))),
          content
        ])
      }
      return h('div', [
        h('div', { class: 'topbar' }, [h('h1', 'Kafka Studio'), h('span', { style: { flex: 1 } }), h('button', { class: ['btn', 'ghost'], onClick: toggleTheme }, uiTheme.value === 'dark' ? '切换浅色' : '切换深色')]),
        h('div', { class: 'layout' }, [side, main]),
        confirmModal.open ? renderConfirm() : null,
        promptModal.open ? renderPrompt() : null,
        editor.open ? renderEditor() : null,
        h('div', { class: ['toast', { show: toastShow.value }] }, toastText.value)
      ])
    }
  }
}
createApp(App).mount('#app')

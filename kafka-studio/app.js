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
    toastFn = (msg) => { try { ElementPlus.ElMessage({ message: msg, duration: 2600, grouping: true }) } catch (_) {} }
    function resize() { nextTick(() => { const el = document.getElementById('app'); parent.postMessage({ type: 'newshell:resize', height: el ? el.scrollHeight : document.body.scrollHeight }, '*') }) }
    async function toggleTheme() {
      uiTheme.value = uiTheme.value === 'dark' ? 'light' : 'dark'
      document.documentElement.classList.toggle('dark', uiTheme.value === 'dark')
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
    async function showConfirm(title, text, okText) {
      try { await ElementPlus.ElMessageBox.confirm(text, title, { confirmButtonText: okText || '确定', cancelButtonText: '取消', type: 'warning' }); return true } catch (_) { return false }
    }

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
    async function showPrompt(title, text, value, okText) {
      try { const r = await ElementPlus.ElMessageBox.prompt(text, title, { confirmButtonText: okText || '确定', cancelButtonText: '取消', inputValue: value || '', inputType: 'number' }); return r.value } catch (_) { return null }
    }

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

    /* ================= 渲染层（Element Plus） ================= */
    const { ElButton, ElInput, ElInputNumber, ElSelect, ElOption, ElDialog, ElForm, ElFormItem, ElSwitch, ElTabs, ElTabPane, ElTag, ElTable, ElTableColumn, ElScrollbar, ElEmpty } = ElementPlus
    const I = window.EP_ICONS || {}
    const loadingDir = Vue.resolveDirective ? Vue.resolveDirective('loading') : null
    function WL(vnode, on) { return loadingDir ? Vue.withDirectives(vnode, [[loadingDir, !!on]]) : vnode }
    function emptyPane(big, sub) { return h(ElEmpty, { description: sub ? big + ' · ' + sub : big, imageSize: 72, class: 'pane-empty' }) }
    function ctl(label, control, width) {
      return h('div', { class: 'ctl', style: width ? { width } : null }, [h('span', { class: 'ctl-label' }, label), control])
    }
    function epTable(cols, rows, extra) {
      return h(ElTable, Object.assign({ data: rows, size: 'small', style: { width: '100%' } }, extra || {}), () =>
        cols.map((c) => h(ElTableColumn, { label: c.label, width: c.width, minWidth: c.minWidth }, c.cell ? { default: ({ row }) => c.cell(row) } : undefined)))
    }

    function renderCluster() {
      if (!session.id) return emptyPane('尚未连接集群', '在左侧选择连接后点「连接」，即可巡检 Broker、Topic 与分区偏移')
      return h('div', [
        h('div', { class: 'tab-toolbar' }, [
          h('span', { class: 'block-label-inline' }, 'Broker（' + cluster.brokers.length + '）'),
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { size: 'small', icon: I.Refresh, loading: cluster.loading, onClick: loadCluster }, () => '刷新')
        ]),
        epTable([
          { label: 'ID', width: 70, cell: (b) => String(b.id) },
          { label: '地址', minWidth: 180, cell: (b) => h('span', { class: 'mono' }, b.host + ':' + b.port) },
          { label: 'Rack', width: 120, cell: (b) => b.rack || '-' },
          { label: '角色', width: 120, cell: (b) => h(ElTag, { size: 'small', effect: 'light', round: true, type: b.id === cluster.controllerId ? 'primary' : 'info' }, () => (b.id === cluster.controllerId ? 'Controller' : 'Broker')) }
        ], cluster.brokers),
        h('div', { class: 'block-label' }, 'Topic（' + cluster.topics.length + '）'),
        cluster.topics.length ? epTable([
          { label: 'Topic', minWidth: 200, cell: (t) => h('span', { class: 'mono' }, t.name) },
          { label: '分区数', width: 90, cell: (t) => String(t.partitions) },
          { label: '消息总量（估算）', width: 140, cell: (t) => String(t.messages) },
          { label: '', width: 110, cell: (t) => h('span', { class: 'link-text' }, cluster.selTopic === t.name ? '已展开' : '查看分区 →') }
        ], cluster.topics, { onRowClick: (row) => loadTopicParts(row.name), rowStyle: { cursor: 'pointer' } }) : h('div', { class: 'empty-line' }, '暂无 Topic'),
        cluster.selTopic ? h('div', [
          h('div', { class: 'block-label' }, '分区 · ' + cluster.selTopic),
          cluster.partsLoading ? h('div', { class: 'empty-line' }, '加载中…') : epTable([
            { label: '分区', width: 70, cell: (p) => String(p.partition) },
            { label: 'Leader', width: 80, cell: (p) => String(p.leader) },
            { label: '副本', width: 110, cell: (p) => (p.replicas || []).join(',') },
            { label: 'ISR', width: 110, cell: (p) => (p.isr || []).join(',') },
            { label: '最早 Offset', width: 110, cell: (p) => String(p.earliest) },
            { label: '最新 Offset', width: 110, cell: (p) => String(p.latest) },
            { label: '消息数', width: 90, cell: (p) => String(Math.max(0, p.latest - p.earliest)) }
          ], cluster.partitions)
        ]) : null
      ])
    }

    function renderMessages() {
      if (!session.id) return emptyPane('尚未连接集群')
      return h('div', [
        h('div', { class: 'msg-controls' }, [
          ctl('Topic', h(ElSelect, { modelValue: msg.topic, 'onUpdate:modelValue': (v) => { msg.topic = v; msgLoadParts() }, placeholder: '选择 Topic', style: { width: '190px' }, size: 'small' }, () =>
            cluster.topics.map((t) => h(ElOption, { label: t.name, value: t.name })))),
          ctl('分区', h(ElSelect, { modelValue: msg.partition, 'onUpdate:modelValue': (v) => (msg.partition = Number(v)), style: { width: '150px' }, size: 'small' }, () =>
            msg.parts.map((p) => h(ElOption, { label: '分区 ' + p.partition + '（' + Math.max(0, p.latest - p.earliest) + ' 条）', value: p.partition })))),
          ctl('起点', h(ElSelect, { modelValue: msg.mode, 'onUpdate:modelValue': (v) => (msg.mode = v), style: { width: '120px' }, size: 'small' }, () => [
            h(ElOption, { label: '最新 N 条', value: 'latest' }), h(ElOption, { label: '从最早', value: 'earliest' }), h(ElOption, { label: '指定 Offset', value: 'offset' })
          ])),
          msg.mode === 'latest' ? ctl('条数', h(ElInputNumber, { modelValue: Number(msg.count) || 50, 'onUpdate:modelValue': (v) => (msg.count = v), min: 1, max: 500, controls: false, style: { width: '76px' }, size: 'small' })) : null,
          msg.mode === 'offset' ? ctl('Offset', h(ElInputNumber, { modelValue: Number(msg.offset) || 0, 'onUpdate:modelValue': (v) => (msg.offset = v), min: 0, controls: false, style: { width: '110px' }, size: 'small' })) : null,
          ctl('解码', h(ElSelect, { modelValue: msg.decode, 'onUpdate:modelValue': (v) => (msg.decode = v), style: { width: '120px' }, size: 'small' }, () => [
            h(ElOption, { label: '文本 UTF-8', value: 'text' }), h(ElOption, { label: 'JSON 美化', value: 'json' }), h(ElOption, { label: 'Hex', value: 'hex' }), h(ElOption, { label: 'Base64', value: 'base64' })
          ])),
          h(ElButton, { type: 'primary', size: 'small', loading: msg.loading, onClick: msgFetch }, () => '拉取'),
          msg.streaming
            ? h(ElButton, { type: 'danger', size: 'small', onClick: stopStream }, () => '停止流式')
            : h(ElButton, { size: 'small', onClick: startStream }, () => '流式消费'),
          msg.streaming ? h(ElTag, { type: 'warning', effect: 'light', round: true, size: 'small' }, () => '流式中 · 下一 Offset ' + msg.nextOffset) : null
        ]),
        h('div', { class: 'msg-filters' }, [
          h(ElInput, { modelValue: msg.fKey, 'onUpdate:modelValue': (v) => (msg.fKey = v), size: 'small', placeholder: '按 Key 过滤（包含）…', clearable: true, style: { width: '200px' } }),
          h(ElInput, { modelValue: msg.fVal, 'onUpdate:modelValue': (v) => (msg.fVal = v), size: 'small', placeholder: '按 Value 过滤（包含）…', clearable: true, style: { width: '240px' } }),
          h('span', { class: 'toolbar-hint' }, '共 ' + msg.records.length + ' 条' + (msg.hw ? ' · 高水位 ' + msg.hw : '') + '（过滤在拉取后点「拉取」生效，流式实时生效）')
        ]),
        msg.records.length ? h('div', msg.records.map((rec, i) => {
          if (rec.placeholder) return h('div', { class: 'rec-item' }, [h('div', { class: 'rec-head static' }, [h(ElTag, { type: 'warning', size: 'small', effect: 'light', round: true }, () => '压缩批次'), h('span', rec.note + '（起始 Offset ' + rec.baseOffset + '，约 ' + rec.count + ' 条）')])])
          const expanded = msg.expanded === i
          return h('div', { class: 'rec-item' }, [
            h('div', { class: 'rec-head', onClick: () => { msg.expanded = expanded ? -1 : i } }, [
              h('span', { class: 'mono rec-offset' }, '#' + rec.offset),
              h('span', { class: 'muted' }, fmtTime(rec.timestamp)),
              h('span', { class: 'mono rec-preview' }, 'key: ' + decodeBytes(rec.key, 'text').slice(0, 60) + ' · ' + decodeBytes(rec.value, msg.decode === 'json' ? 'text' : msg.decode).replace(/\s+/g, ' ').slice(0, 90)),
              h('span', { class: 'rec-caret' }, expanded ? '▾' : '▸')
            ]),
            expanded ? h('div', { class: 'rec-body' }, [
              h('div', { class: 'block-label' }, 'Key'), h('pre', { class: 'rec-pre' }, decodeBytes(rec.key, msg.decode)),
              h('div', { class: 'block-label' }, 'Value'), h('pre', { class: 'rec-pre' }, decodeBytes(rec.value, msg.decode)),
              rec.headers && rec.headers.length ? h('div', [h('div', { class: 'block-label' }, 'Headers'), ...rec.headers.map((hh) => h('div', { class: 'mono', style: { fontSize: '12px' } }, hh.key + ': ' + decodeBytes(hh.value, 'text')))]) : null
            ]) : null
          ])
        })) : h('div', { class: 'empty-line' }, '选择 Topic 与分区后点「拉取」，或直接开启流式消费')
      ])
    }

    function renderGroups() {
      if (!session.id) return emptyPane('尚未连接集群')
      if (grp.detail) {
        const g = grp.detail
        return h('div', [
          h('div', { class: 'detail-head' }, [
            h(ElButton, { text: true, size: 'small', icon: I.ArrowLeft, onClick: () => { grp.detail = null } }, () => '返回列表'),
            h('span', { class: 'detail-title mono' }, g.id),
            h(ElTag, { size: 'small', effect: 'light', round: true }, () => g.state),
            h('span', { class: 'muted', style: { fontSize: '12px' } }, '协议 ' + (g.protocol || '-') + ' · 成员 ' + g.members.length)
          ]),
          g.members.length ? h('div', [h('div', { class: 'block-label' }, '成员'), epTable([
            { label: 'Member ID', minWidth: 180, cell: (m) => h('span', { class: 'mono' }, m.id) },
            { label: 'Client ID', width: 160, cell: (m) => m.clientId },
            { label: '主机', width: 140, cell: (m) => m.host },
            { label: '订阅', minWidth: 180, cell: (m) => m.assignment.map((a) => a.name + '[' + a.partitions.join(',') + ']').join(' ') }
          ], g.members)]) : null,
          h('div', { class: 'block-label' }, 'Offset 与 Lag'),
          grp.offsets.length ? epTable([
            { label: 'Topic', minWidth: 150, cell: (o) => h('span', { class: 'mono' }, o.topic) },
            { label: '分区', width: 70, cell: (o) => String(o.partition) },
            { label: '已提交', width: 100, cell: (o) => (o.committed === null ? '无' : String(o.committed)) },
            { label: '最新', width: 90, cell: (o) => (o.latest === null ? '-' : String(o.latest)) },
            { label: 'Lag', width: 90, cell: (o) => (o.lag === null ? '-' : h(ElTag, { size: 'small', effect: 'light', round: true, type: o.lag > 0 ? 'warning' : 'success' }, () => String(o.lag))) },
            { label: '重置为', width: 190, cell: (o) => h('span', { class: 'btn-row' }, [
              h(ElButton, { size: 'small', text: true, onClick: () => resetOffset(o, 'earliest') }, () => '最早'),
              h(ElButton, { size: 'small', text: true, onClick: () => resetOffset(o, 'latest') }, () => '最新'),
              h(ElButton, { size: 'small', text: true, onClick: () => resetOffset(o, 'custom') }, () => '指定…')
            ]) }
          ], grp.offsets) : h('div', { class: 'empty-line' }, '该组暂无 Offset 记录')
        ])
      }
      return h('div', [
        h('div', { class: 'tab-toolbar' }, [
          h('span', { class: 'block-label-inline' }, '消费组（' + grp.list.length + '）'),
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { size: 'small', icon: I.Refresh, loading: grp.loading, onClick: loadGroups }, () => '刷新')
        ]),
        WL(h('div', grp.list.length ? h('div', { class: 'row-list' }, grp.list.map((g) => h('div', { class: 'row-item', onClick: () => openGroup(g) }, [
          h('span', { class: 'mono', style: { fontWeight: 550 } }, g.id),
          h('span', { class: 'muted', style: { fontSize: '12px' } }, g.protocolType),
          h('span', { class: 'flex-spacer' }),
          h('span', { class: 'link-text' }, '查看 Lag →')
        ]))) : h('div', { class: 'empty-line' }, '暂无消费组')), grp.loading && !grp.list.length)
      ])
    }

    function renderAcl() {
      if (!session.id) return emptyPane('尚未连接集群')
      const filtered = acl.list.filter((a) => acl.filterType === 'all' || String(a.resourceType) === acl.filterType)
      const selOf = (model, set, options, width) => h(ElSelect, { modelValue: model, 'onUpdate:modelValue': set, size: 'small', style: { width: width || '130px' } }, () =>
        options.map(([v, t]) => h(ElOption, { label: t, value: String(v) })))
      return h('div', [
        h('div', { class: 'tab-toolbar' }, [
          h('span', { class: 'block-label-inline' }, 'ACL 规则（' + filtered.length + '）'),
          h('span', { class: 'flex-spacer' }),
          selOf(acl.filterType, (v) => (acl.filterType = v), [['all', '全部资源类型'], ...RES_TYPES.slice(2)], '140px'),
          h(ElButton, { size: 'small', icon: I.Refresh, loading: acl.loading, onClick: loadAcls }, () => '刷新'),
          h(ElButton, { type: 'primary', size: 'small', icon: I.Plus, onClick: () => { acl.creating = !acl.creating } }, () => '新建 ACL')
        ]),
        acl.creating ? h('div', { class: 'acl-form' }, [
          ctl('资源类型', selOf(String(acl.create.resourceType), (v) => (acl.create.resourceType = v), RES_TYPES.slice(2), '120px')),
          ctl('资源名', h(ElInput, { modelValue: acl.create.resourceName, 'onUpdate:modelValue': (v) => (acl.create.resourceName = v), size: 'small', placeholder: 'orders 或 *', style: { width: '150px' } })),
          ctl('模式', selOf(String(acl.create.patternType), (v) => (acl.create.patternType = v), PATTERNS.slice(2), '110px')),
          ctl('Principal', h(ElInput, { modelValue: acl.create.principal, 'onUpdate:modelValue': (v) => (acl.create.principal = v), size: 'small', placeholder: 'User:alice', style: { width: '150px' } })),
          ctl('主机', h(ElInput, { modelValue: acl.create.host, 'onUpdate:modelValue': (v) => (acl.create.host = v), size: 'small', style: { width: '90px' } })),
          ctl('操作', selOf(String(acl.create.operation), (v) => (acl.create.operation = v), OPS.slice(2), '130px')),
          ctl('权限', selOf(String(acl.create.permissionType), (v) => (acl.create.permissionType = v), PERMS.slice(2), '110px')),
          h(ElButton, { type: 'primary', size: 'small', onClick: aclCreate }, () => '创建')
        ]) : null,
        acl.loading && !acl.list.length ? h('div', { class: 'empty-line' }, '加载中…') : filtered.length ? epTable([
          { label: '资源', minWidth: 170, cell: (a) => nameOf(RES_TYPES, a.resourceType) + ' · ' + a.resourceName },
          { label: '模式', width: 90, cell: (a) => nameOf(PATTERNS, a.patternType) },
          { label: 'Principal', minWidth: 130, cell: (a) => a.principal },
          { label: '主机', width: 90, cell: (a) => a.host },
          { label: '操作', width: 110, cell: (a) => nameOf(OPS, a.operation) },
          { label: '权限', width: 90, cell: (a) => h(ElTag, { size: 'small', effect: 'light', round: true, type: a.permissionType === 3 ? 'success' : a.permissionType === 2 ? 'danger' : 'info' }, () => nameOf(PERMS, a.permissionType)) },
          { label: '', width: 70, cell: (a) => h(ElButton, { size: 'small', text: true, type: 'danger', onClick: () => aclDelete(a) }, () => '删除') }
        ], filtered) : h('div', { class: 'empty-line' }, '暂无 ACL 规则（集群可能未开启 ACL/授权器）')
      ])
    }

    function renderSchema() {
      if (!curConn.value) return emptyPane('先选择一个连接')
      if (!curConn.value.srUrl) return emptyPane('该连接未配置 Schema Registry', '编辑连接时填写 SR 地址（如 http://127.0.0.1:8081）后可用')
      return h('div', [
        h('div', { class: 'tab-toolbar' }, [
          h('span', { class: 'block-label-inline' }, 'Subjects（' + sr.subjects.length + '）'),
          sr.compat ? h(ElTag, { size: 'small', effect: 'light', round: true }, () => '全局兼容性 ' + sr.compat) : null,
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { size: 'small', icon: I.Refresh, loading: sr.loading, onClick: loadSubjects }, () => '刷新')
        ]),
        sr.err ? h('div', { class: 'err-text', style: { marginBottom: '8px' } }, '加载失败：' + sr.err) : null,
        h('div', { class: 'schema-layout' }, [
          h('div', { class: 'subject-list' }, sr.subjects.map((name) => h('div', { class: ['subject-item', { active: sr.sel === name }], onClick: () => openSubject(name) }, name))),
          sr.sel ? h('div', { class: 'schema-main' }, [
            h('div', { class: 'ver-row' }, sr.versions.map((v) => h(ElButton, { size: 'small', type: sr.selVersion === String(v) ? 'primary' : 'default', onClick: () => openSchemaVersion(v) }, () => 'v' + v))),
            sr.schema ? h('div', [h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '6px' } }, 'Schema ID ' + sr.schema.id + ' · ' + sr.sel + ' v' + sr.schema.version), h('pre', { class: 'code-view' }, (() => { try { return JSON.stringify(JSON.parse(sr.schema.schema), null, 2) } catch { return sr.schema.schema } })())]) : null
          ]) : null
        ])
      ])
    }

    function renderEditor() {
      return h(ElDialog, { modelValue: editor.open, 'onUpdate:modelValue': (v) => (editor.open = v), title: editor.id ? '编辑连接' : '新建连接', width: '500px', closeOnClickModal: false }, {
        default: () => h(ElForm, { labelWidth: '92px' }, () => [
          h(ElFormItem, { label: '名称', required: true }, () => h(ElInput, { modelValue: editor.name, 'onUpdate:modelValue': (v) => (editor.name = v), placeholder: '生产集群' })),
          h(ElFormItem, { label: 'Broker 列表', required: true }, () => h(ElInput, { modelValue: editor.brokers, 'onUpdate:modelValue': (v) => (editor.brokers = v), placeholder: 'kafka1:9092,kafka2:9092（逗号分隔）' })),
          h(ElFormItem, { label: 'Client ID' }, () => h(ElInput, { modelValue: editor.clientId, 'onUpdate:modelValue': (v) => (editor.clientId = v) })),
          h(ElFormItem, { label: 'SASL 用户名' }, () => h(ElInput, { modelValue: editor.saslUser, 'onUpdate:modelValue': (v) => (editor.saslUser = v), placeholder: '无则留空（仅支持 PLAIN）' })),
          h(ElFormItem, { label: 'SASL 密码' }, () => h(ElInput, { modelValue: editor.saslPass, 'onUpdate:modelValue': (v) => (editor.saslPass = v), type: 'password', showPassword: true })),
          h(ElFormItem, { label: 'Schema Registry' }, () => h(ElInput, { modelValue: editor.srUrl, 'onUpdate:modelValue': (v) => (editor.srUrl = v), placeholder: '可选，如 http://127.0.0.1:8081' })),
          h(ElFormItem, { label: ' ' }, () => h('span', { class: 'test-line' }, [
            h(ElButton, { size: 'small', loading: editor.testing, onClick: testEditor }, () => '测试连接'),
            editor.testMsg ? h('span', { class: editor.testOk ? 'ok-text' : 'err-text' }, editor.testMsg) : null
          ]))
        ]),
        footer: () => h('div', { class: 'dialog-foot' }, [
          editor.id ? h(ElButton, { type: 'danger', plain: true, onClick: deleteEditor }, () => '删除') : null,
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { onClick: () => (editor.open = false) }, () => '取消'),
          h(ElButton, { type: 'primary', onClick: saveEditor }, () => '保存')
        ])
      })
    }

    /* ---------- 根渲染 ---------- */
    return () => {
      const side = h('aside', { class: 'side' }, [
        h('div', { class: 'side-head' }, [
          h('span', { class: 'side-title' }, 'Kafka 连接'),
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { circle: true, size: 'small', icon: I.Plus, title: '新建连接', onClick: () => openEditor(null) })
        ]),
        connections.value.length ? h(ElScrollbar, { class: 'side-scroll' }, () => connections.value.map((c) => h('div', { class: ['conn-item', { active: c.id === connId.value }], onClick: () => selectConnection(c.id) }, [
          h('span', { class: 'conn-avatar' }, (c.name || '?').slice(0, 1).toUpperCase()),
          h('span', { class: 'conn-meta' }, [
            h('span', { class: 'conn-name' }, c.name),
            h('span', { class: 'conn-sub' }, c.brokers || '')
          ]),
          h('span', { class: ['conn-dot', { on: session.id && c.id === connId.value }] }),
          h(ElButton, { text: true, size: 'small', class: 'conn-edit', icon: I.Edit, title: '编辑', onClick: (e) => { e.stopPropagation(); openEditor(c) } })
        ]))) : h('div', { class: 'side-empty' }, '暂无连接，点右上角 + 新建'),
        curConn.value ? h('div', { class: 'side-foot' }, [
          session.id
            ? h(ElButton, { type: 'danger', plain: true, style: { width: '100%' }, onClick: disconnect }, () => '断开（' + session.brokers.length + ' 个 Broker）')
            : h(ElButton, { type: 'primary', style: { width: '100%' }, loading: session.connecting, onClick: connect }, () => '连接集群')
        ]) : null
      ])
      let main
      if (!curConn.value) {
        main = h('main', { class: 'main main-center' }, [emptyPane('欢迎使用 Kafka Studio', '新建连接后即可巡检 Topic/Broker/消费组 Lag，流式消费消息，管理 Offset、ACL 与 Schema Registry')])
      } else {
        main = h('main', { class: 'main' }, [
          h(ElTabs, { modelValue: tab.value, 'onUpdate:modelValue': (v) => switchTab(v), class: 'main-tabs' }, () => [
            h(ElTabPane, { label: '集群', name: 'cluster' }, () => renderCluster()),
            h(ElTabPane, { label: '消息', name: 'messages' }, () => renderMessages()),
            h(ElTabPane, { label: '消费组', name: 'groups' }, () => renderGroups()),
            h(ElTabPane, { label: 'ACL', name: 'acl' }, () => renderAcl()),
            h(ElTabPane, { label: 'Schema', name: 'schema' }, () => renderSchema())
          ])
        ])
      }
      return h('div', { class: 'app-root' }, [
        h('header', { class: 'topbar' }, [
          h('span', { class: 'logo' }, [h(I.DataLine, { size: 17 })]),
          h('div', { class: 'title-block' }, [h('h1', 'Kafka Studio'), h('span', { class: 'sub' }, '集群 · 消息 · 消费组 · ACL · Schema')]),
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { text: true, icon: uiTheme.value === 'dark' ? I.Sunny : I.Moon, onClick: toggleTheme }, () => (uiTheme.value === 'dark' ? '切换浅色' : '切换深色'))
        ]),
        h('div', { class: 'layout' }, [side, main]),
        editor.open ? renderEditor() : null
      ])
    }
  }
}
const app = createApp(App)
app.use(ElementPlus)
app.mount('#app')

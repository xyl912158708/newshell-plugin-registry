/* GitLab 管理台 · 页面应用（Vue render 函数） */
const { createApp, ref, reactive, computed, h, watch, nextTick, onMounted } = Vue
const PROXY = 'http://127.0.0.1:17932'

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
function toast(msg) { if (toastFn) toastFn(humanize(msg)) }
function humanize(msg) {
  const m = String(msg || '')
  if (/401/.test(m)) return '未授权：Token 无效或已过期（原文：' + m + '）'
  if (/403/.test(m)) return '没有权限执行该操作（原文：' + m + '）'
  if (/404/.test(m)) return '资源不存在或无权访问（原文：' + m + '）'
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|无法连接插件代理/i.test(m)) return '无法连接 GitLab 服务器，请检查地址与网络（原文：' + m + '）'
  return m
}
function fmtTime(t) { if (!t) return '-'; const d = new Date(t); return isNaN(d) ? '-' : d.toLocaleString('zh-CN', { hour12: false }) }
function relTime(t) {
  if (!t) return ''
  const s = (Date.now() - new Date(t).getTime()) / 1000
  if (s < 60) return '刚刚'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前'
  return new Date(t).toLocaleDateString('zh-CN')
}
function b64DecodeText(b64) {
  const bin = atob(String(b64 || '').replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}
    function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
    function mdInline(s) {
      return s
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
        .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    }
    function renderMarkdown(src) {
      const lines = src.split('\n')
      let html = '', inCode = false, codeBuf = [], listType = null, inTable = false
      const closeList = () => { if (listType) { html += listType === 'ul' ? '</ul>' : '</ol>'; listType = null } }
      const closeTable = () => { if (inTable) { html += '</table>'; inTable = false } }
      for (const line of lines) {
        if (/^```/.test(line.trim())) {
          if (inCode) { html += `<pre><code>${escHtml(codeBuf.join('\n'))}</code></pre>`; codeBuf = []; inCode = false } else inCode = true
          continue
        }
        if (inCode) { codeBuf.push(line); continue }
        const t = line.trim()
        if (/^\|.*\|$/.test(t)) {
          if (/^\|[\s:|-]+\|$/.test(t)) continue
          const cells = t.slice(1, -1).split('|').map((c) => c.trim())
          if (!inTable) { html += '<table>'; inTable = true; html += '<tr>' + cells.map((c) => `<th>${mdInline(escHtml(c))}</th>`).join('') + '</tr>' }
          else html += '<tr>' + cells.map((c) => `<td>${mdInline(escHtml(c))}</td>`).join('') + '</tr>'
          continue
        }
        closeTable()
        const h = t.match(/^(#{1,6})\s+(.*)$/)
        if (h) { closeList(); html += `<h${h[1].length}>${mdInline(escHtml(h[2]))}</h${h[1].length}>`; continue }
        if (/^(-{3,}|\*{3,})$/.test(t)) { closeList(); html += '<hr>'; continue }
        if (/^>\s?/.test(t)) { closeList(); html += `<blockquote>${mdInline(escHtml(t.replace(/^>\s?/, '')))}</blockquote>`; continue }
        const ul = t.match(/^[-*+]\s+(.*)$/)
        if (ul) { if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul' } html += `<li>${mdInline(escHtml(ul[1]))}</li>`; continue }
        const ol = t.match(/^\d+[.)]\s+(.*)$/)
        if (ol) { if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol' } html += `<li>${mdInline(escHtml(ol[1]))}</li>`; continue }
        closeList()
        if (t) html += `<p>${mdInline(escHtml(t))}</p>`
      }
      if (inCode) html += `<pre><code>${escHtml(codeBuf.join('\n'))}</code></pre>`
      closeList(); closeTable()
      return html
    }


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

    /* ---------- 连接 ---------- */
    const connections = ref([])
    const connId = ref('')
    const curConn = computed(() => connections.value.find((c) => c.id === connId.value) || null)
    const editor = reactive({ open: false, id: '', name: '', baseUrl: '', token: '', allowInsecure: false, testing: false, testMsg: '', testOk: false })
    function cfgOf(c) { return c ? { baseUrl: c.baseUrl, token: c.token, allowInsecure: !!c.allowInsecure } : null }
    async function api(method, path, query, body, conn) {
      const cfg = cfgOf(conn || curConn.value)
      if (!cfg) throw new Error('请先选择连接')
      let r
      try {
        r = await fetch(PROXY + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cfg, method, path, query, body }) }).then((x) => x.json())
      } catch (e) { throw new Error('无法连接插件代理（请确认插件已启用）') }
      if (r.error) throw new Error(r.error)
      if (r.status >= 400) {
        const msg = r.data && r.data.message ? (typeof r.data.message === 'string' ? r.data.message : JSON.stringify(r.data.message)) : ''
        throw new Error('HTTP ' + r.status + (msg ? '：' + msg : ''))
      }
      return r
    }
    async function persistConns() { try { await storeBridge.set('connections', connections.value) } catch (_) {} }
    function openEditor(c) {
      Object.assign(editor, { open: true, id: c ? c.id : '', name: c ? c.name : '', baseUrl: c ? c.baseUrl : 'https://gitlab.com', token: c ? c.token : '', allowInsecure: c ? !!c.allowInsecure : false, testing: false, testMsg: '', testOk: false })
    }
    async function testEditor() {
      editor.testing = true; editor.testMsg = ''
      try {
        const r = await api('GET', '/user', null, null, { baseUrl: editor.baseUrl, token: editor.token, allowInsecure: editor.allowInsecure })
        editor.testOk = true; editor.testMsg = '连接成功：' + (r.data.name || r.data.username) + '（@' + r.data.username + '）'
      } catch (e) { editor.testOk = false; editor.testMsg = '连接失败：' + humanize(e.message) }
      editor.testing = false
    }
    async function saveEditor() {
      if (!editor.name.trim()) return toast('请填写连接名称')
      if (!/^https?:\/\//.test(editor.baseUrl.trim())) return toast('GitLab 地址需以 http:// 或 https:// 开头')
      if (!editor.token.trim()) return toast('请填写 Access Token（需 api 权限）')
      const data = { name: editor.name.trim(), baseUrl: editor.baseUrl.trim().replace(/\/+$/, ''), token: editor.token.trim(), allowInsecure: editor.allowInsecure }
      if (editor.id) { const c = connections.value.find((x) => x.id === editor.id); if (c) Object.assign(c, data) }
      else { const id = 'c' + Date.now().toString(36); connections.value.push(Object.assign({ id }, data)); connId.value = id }
      await persistConns()
      editor.open = false
      toast('连接已保存')
      if (connId.value) selectConnection(connId.value, true)
    }
    async function deleteEditor() {
      if (!(await showConfirm('删除连接', '确定删除该连接配置？', '删除'))) return
      connections.value = connections.value.filter((x) => x.id !== editor.id)
      if (connId.value === editor.id) connId.value = connections.value[0]?.id || ''
      await persistConns()
      editor.open = false
      if (connId.value) selectConnection(connId.value, true)
    }
    function selectConnection(id, force) {
      if (connId.value === id && !force) return
      connId.value = id
      try { storeBridge.set('lastConnId', id) } catch (_) {}
      resetProjectState()
      loadProjects(true)
    }

    /* ---------- 通用弹窗 ---------- */
    async function showConfirm(title, text, okText) {
      try {
        await ElementPlus.ElMessageBox.confirm(text, title, { confirmButtonText: okText || '确定', cancelButtonText: '取消', type: 'warning' })
        return true
      } catch (_) { return false }
    }

    /* ---------- 项目 ---------- */
    const tab = ref('project')
    const projects = ref([])
    const projSearch = ref('')
    const projPage = reactive({ page: 1, totalPages: 1, total: 0 })
    const projLoading = ref(false)
    const curProject = ref(null)
    function resetProjectState() {
      curProject.value = null; projects.value = []
      tree.path = ''; tree.items = []; tree.ref = ''; branches.value = []
      fileView.open = false; readme.html = ''
      mr.list = []; pipe.list = []; issue.list = []
      mr.detail = null; pipe.detail = null; issue.detail = null
    }
    async function loadProjects(reset) {
      if (!curConn.value) return
      if (reset) { projects.value = []; projPage.page = 1 }
      projLoading.value = true
      try {
        const r = await api('GET', '/projects', { search: projSearch.value || undefined, membership: true, order_by: 'last_activity_at', sort: 'desc', per_page: 30, page: projPage.page, simple: true })
        projects.value = reset ? r.data : projects.value.concat(r.data)
        projPage.totalPages = Number(r.page.totalPages) || 1
        projPage.total = Number(r.page.total) || projects.value.length
      } catch (e) { toast('加载项目失败：' + e.message) }
      projLoading.value = false
    }
    function openProject(p) {
      curProject.value = p
      tree.ref = p.default_branch || 'main'
      tree.path = ''; fileView.open = false
      loadBranches(); loadTree(''); loadReadme()
      if (tab.value === 'mr') loadMrs(true)
      if (tab.value === 'pipeline') loadPipes(true)
      if (tab.value === 'issue') loadIssues(true)
      resize()
    }
    const branches = ref([])
    async function loadBranches() {
      if (!curProject.value) return
      try { const r = await api('GET', '/projects/' + curProject.value.id + '/repository/branches', { per_page: 100 }); branches.value = r.data.map((b) => b.name) } catch (_) { branches.value = [] }
    }
    const tree = reactive({ path: '', items: [], loading: false })
    async function loadTree(path) {
      if (!curProject.value) return
      tree.loading = true; tree.path = path
      try {
        const r = await api('GET', '/projects/' + curProject.value.id + '/repository/tree', { path: path || undefined, ref: tree.ref, per_page: 100 })
        tree.items = r.data
      } catch (e) { toast('加载目录失败：' + e.message); tree.items = [] }
      tree.loading = false
      resize()
    }
    const fileView = reactive({ open: false, path: '', content: '', isMd: false, loading: false })
    const readme = reactive({ html: '' })
    async function openFile(item) {
      const full = (tree.path ? tree.path + '/' : '') + item.name
      fileView.open = true; fileView.path = full; fileView.loading = true; fileView.content = ''
      fileView.isMd = /\.md$/i.test(item.name)
      try {
        const r = await api('GET', '/projects/' + curProject.value.id + '/repository/files/' + encodeURIComponent(full), { ref: tree.ref })
        fileView.content = b64DecodeText(r.data.content)
      } catch (e) { toast('加载文件失败：' + e.message); fileView.open = false }
      fileView.loading = false
      resize()
    }
    async function loadReadme() {
      readme.html = ''
      if (!curProject.value) return
      try {
        const r = await api('GET', '/projects/' + curProject.value.id + '/repository/files/README.md', { ref: tree.ref })
        readme.html = renderMarkdown(b64DecodeText(r.data.content))
      } catch (_) { /* 无 README 忽略 */ }
      resize()
    }
    function switchTab(t) {
      tab.value = t
      if (!curProject.value) return
      if (t === 'mr' && !mr.list.length) loadMrs(true)
      if (t === 'pipeline' && !pipe.list.length) loadPipes(true)
      if (t === 'issue' && !issue.list.length) loadIssues(true)
      resize()
    }

    /* ---------- 合并请求 ---------- */
    const mr = reactive({ state: 'opened', list: [], page: 1, totalPages: 1, loading: false, detail: null, changes: [], notes: [], comment: '', busy: false })
    async function loadMrs(reset) {
      if (!curProject.value) return
      if (reset) { mr.list = []; mr.page = 1 }
      mr.loading = true
      try {
        const r = await api('GET', '/projects/' + curProject.value.id + '/merge_requests', { state: mr.state === 'all' ? undefined : mr.state, order_by: 'updated_at', sort: 'desc', per_page: 30, page: mr.page })
        mr.list = reset ? r.data : mr.list.concat(r.data)
        mr.totalPages = Number(r.page.totalPages) || 1
      } catch (e) { toast('加载合并请求失败：' + e.message) }
      mr.loading = false
    }
    async function openMr(item) {
      mr.busy = true
      try {
        const base = '/projects/' + curProject.value.id + '/merge_requests/' + item.iid
        const [d, c, n] = await Promise.all([api('GET', base), api('GET', base + '/changes'), api('GET', base + '/notes', { order_by: 'created_at', sort: 'asc', per_page: 100 })])
        mr.detail = d.data; mr.changes = c.data.changes || []; mr.notes = n.data.filter((x) => !x.system)
      } catch (e) { toast('加载 MR 详情失败：' + e.message) }
      mr.busy = false
      resize()
    }
    async function mrApprove() {
      try { await api('POST', '/projects/' + curProject.value.id + '/merge_requests/' + mr.detail.iid + '/approve'); toast('已批准'); openMr(mr.detail) } catch (e) { toast('批准失败：' + e.message) }
    }
    async function mrMerge() {
      if (!(await showConfirm('合并请求', '确定合并 !' + mr.detail.iid + '（' + mr.detail.source_branch + ' → ' + mr.detail.target_branch + '）？', '合并'))) return
      try {
        await api('PUT', '/projects/' + curProject.value.id + '/merge_requests/' + mr.detail.iid + '/merge', null, { should_remove_source_branch: mrRemoveSource.value })
        toast('已合并'); mr.detail = null; loadMrs(true)
      } catch (e) { toast('合并失败：' + e.message) }
    }
    const mrRemoveSource = ref(false)
    async function mrComment() {
      if (!mr.comment.trim()) return
      try { await api('POST', '/projects/' + curProject.value.id + '/merge_requests/' + mr.detail.iid + '/notes', null, { body: mr.comment }); mr.comment = ''; toast('评论已发表'); openMr(mr.detail) } catch (e) { toast('发表评论失败：' + e.message) }
    }

    /* ---------- 流水线 ---------- */
    const pipe = reactive({ list: [], page: 1, totalPages: 1, loading: false, detail: null, jobs: [], trace: '', traceJob: null, traceAuto: true })
    async function loadPipes(reset) {
      if (!curProject.value) return
      if (reset) { pipe.list = []; pipe.page = 1 }
      pipe.loading = true
      try {
        const r = await api('GET', '/projects/' + curProject.value.id + '/pipelines', { order_by: 'updated_at', sort: 'desc', per_page: 30, page: pipe.page })
        pipe.list = reset ? r.data : pipe.list.concat(r.data)
        pipe.totalPages = Number(r.page.totalPages) || 1
      } catch (e) { toast('加载流水线失败：' + e.message) }
      pipe.loading = false
    }
    async function openPipe(item) {
      try {
        const [d, j] = await Promise.all([
          api('GET', '/projects/' + curProject.value.id + '/pipelines/' + item.id),
          api('GET', '/projects/' + curProject.value.id + '/pipelines/' + item.id + '/jobs', { per_page: 100 })
        ])
        pipe.detail = d.data; pipe.jobs = j.data; pipe.trace = ''; pipe.traceJob = null
      } catch (e) { toast('加载流水线详情失败：' + e.message) }
      resize()
    }
    async function pipeAction(action) {
      try { await api('POST', '/projects/' + curProject.value.id + '/pipelines/' + pipe.detail.id + '/' + action); toast(action === 'retry' ? '已重新触发' : '已取消'); pipe.detail = null; loadPipes(true) } catch (e) { toast('操作失败：' + e.message) }
    }
    async function openTrace(job) {
      pipe.traceJob = job; pipe.trace = '加载中…'
      try {
        const r = await api('GET', '/projects/' + curProject.value.id + '/jobs/' + job.id + '/trace')
        pipe.trace = typeof r.data === 'string' ? r.data : JSON.stringify(r.data)
      } catch (e) { pipe.trace = '日志加载失败：' + e.message }
      resize()
      nextTick(() => { const el = document.querySelector('.trace-view'); if (el && pipe.traceAuto) el.scrollTop = el.scrollHeight })
    }
    async function jobAction(job, action) {
      try { await api('POST', '/projects/' + curProject.value.id + '/jobs/' + job.id + '/' + action); toast('已' + (action === 'retry' ? '重跑' : action === 'cancel' ? '取消' : '触发')); if (pipe.detail) openPipe(pipe.detail) } catch (e) { toast('操作失败：' + e.message) }
    }

    /* ---------- Issue ---------- */
    const issue = reactive({ state: 'opened', list: [], page: 1, totalPages: 1, loading: false, detail: null, notes: [], comment: '', createOpen: false, createTitle: '', createDesc: '', createLabels: '' })
    async function loadIssues(reset) {
      if (!curProject.value) return
      if (reset) { issue.list = []; issue.page = 1 }
      issue.loading = true
      try {
        const r = await api('GET', '/projects/' + curProject.value.id + '/issues', { state: issue.state === 'all' ? undefined : issue.state, order_by: 'updated_at', sort: 'desc', per_page: 30, page: issue.page })
        issue.list = reset ? r.data : issue.list.concat(r.data)
        issue.totalPages = Number(r.page.totalPages) || 1
      } catch (e) { toast('加载 Issue 失败：' + e.message) }
      issue.loading = false
    }
    async function openIssue(item) {
      try {
        const [d, n] = await Promise.all([
          api('GET', '/projects/' + curProject.value.id + '/issues/' + item.iid),
          api('GET', '/projects/' + curProject.value.id + '/issues/' + item.iid + '/notes', { order_by: 'created_at', sort: 'asc', per_page: 100 })
        ])
        issue.detail = d.data; issue.notes = n.data.filter((x) => !x.system)
      } catch (e) { toast('加载 Issue 详情失败：' + e.message) }
      resize()
    }
    async function issueComment() {
      if (!issue.comment.trim()) return
      try { await api('POST', '/projects/' + curProject.value.id + '/issues/' + issue.detail.iid + '/notes', null, { body: issue.comment }); issue.comment = ''; toast('评论已发表'); openIssue(issue.detail) } catch (e) { toast('发表评论失败：' + e.message) }
    }
    async function issueToggleState() {
      const nextState = issue.detail.state === 'opened' ? 'close' : 'reopen'
      try { const r = await api('PUT', '/projects/' + curProject.value.id + '/issues/' + issue.detail.iid, null, { state_event: nextState }); issue.detail = r.data; toast(nextState === 'close' ? '已关闭' : '已重开'); loadIssues(true) } catch (e) { toast('操作失败：' + e.message) }
    }
    async function issueCreate() {
      if (!issue.createTitle.trim()) return toast('请填写标题')
      try {
        const r = await api('POST', '/projects/' + curProject.value.id + '/issues', null, { title: issue.createTitle.trim(), description: issue.createDesc, labels: issue.createLabels.trim() || undefined })
        issue.createOpen = false; issue.createTitle = ''; issue.createDesc = ''; issue.createLabels = ''
        toast('Issue 已创建'); loadIssues(true); openIssue(r.data)
      } catch (e) { toast('创建失败：' + e.message) }
    }

    /* ---------- 生命周期 ---------- */
    watch([tab, () => mr.detail, () => pipe.detail, () => issue.detail, () => fileView.open], () => resize())
    onMounted(async () => {
      try {
        const all = await storeBridge.getAll()
        if (Array.isArray(all.connections)) connections.value = all.connections
        if (all.lastConnId) connId.value = all.lastConnId
        if (all['ui-theme'] === 'light' || all['ui-theme'] === 'dark') { uiTheme.value = all['ui-theme']; if (window.__osSetTheme) window.__osSetTheme(uiTheme.value) }
      } catch (_) { /* 忽略 */ }
      if (!connId.value && connections.value.length) connId.value = connections.value[0].id
      if (connId.value) selectConnection(connId.value, true)
      resize()
    })

    /* ---------- 渲染辅助 ---------- */
    /* ================= 渲染层（Element Plus） ================= */
    const { ElButton, ElButtonGroup, ElInput, ElSelect, ElOption, ElDialog, ElForm, ElFormItem, ElSwitch, ElTabs, ElTabPane, ElTag, ElTable, ElTableColumn, ElSegmented, ElScrollbar, ElEmpty, ElCheckbox, ElTooltip } = ElementPlus
    const I = window.EP_ICONS || {}
    const loadingDir = Vue.resolveDirective ? Vue.resolveDirective('loading') : null
    function WL(vnode, on) { return loadingDir ? Vue.withDirectives(vnode, [[loadingDir, !!on]]) : vnode }
    function stateTag(state) {
      const map = { opened: ['success', '开启'], open: ['success', '开启'], merged: ['primary', '已合并'], closed: ['danger', '已关闭'], success: ['success', '成功'], failed: ['danger', '失败'], running: ['warning', '运行中'], pending: ['info', '等待'], canceled: ['info', '已取消'], cancelled: ['info', '已取消'], skipped: ['info', '跳过'], manual: ['info', '手动'], created: ['info', '已创建'], scheduled: ['info', '定时'] }
      const m = map[state] || ['info', state || '-']
      return h(ElTag, { type: m[0], size: 'small', effect: 'light', round: true }, () => m[1])
    }
    function notesList(notes) {
      if (!notes.length) return h('div', { class: 'empty-line' }, '暂无评论')
      return h('div', { class: 'notes' }, notes.map((n) => h('div', { class: 'note-item' }, [
        h('div', { class: 'note-head' }, [h('span', { class: 'who' }, n.author ? n.author.name : '未知'), h('span', { class: 'when' }, fmtTime(n.created_at))]),
        h('div', { class: 'md-body', innerHTML: renderMarkdown(n.body || '') })
      ])))
    }
    function commentBox(value, onInput, onSend) {
      return h('div', { class: 'comment-box' }, [
        h(ElInput, { modelValue: value, 'onUpdate:modelValue': onInput, type: 'textarea', rows: 3, placeholder: '写下评论（支持 Markdown）…' }),
        h('div', { class: 'comment-actions' }, [h(ElButton, { type: 'primary', size: 'small', onClick: onSend }, () => '发表评论')])
      ])
    }
    function loadMoreBtn(loading, page, totalPages, onClick) {
      if (page >= totalPages) return null
      return h('div', { class: 'load-more' }, [h(ElButton, { text: true, loading, onClick }, () => '加载更多')])
    }
    function emptyPane(big, sub) {
      return h(ElEmpty, { description: big + (sub ? ' · ' + sub : ''), imageSize: 72, class: 'pane-empty' })
    }

    /* ---------- 项目页 ---------- */
    function renderProjectTab() {
      if (!curProject.value) return emptyPane('从上方选择一个项目', '文件、合并请求、流水线与 Issue 都按项目组织')
      const p = curProject.value
      const crumbs = [h('span', { class: 'crumb', onClick: () => { fileView.open = false; loadTree('') } }, tree.ref || '根目录')]
      const parts = tree.path ? tree.path.split('/') : []
      parts.forEach((part, i) => {
        crumbs.push(h('span', { class: 'crumb-sep' }, '/'))
        crumbs.push(h('span', { class: 'crumb', onClick: () => { fileView.open = false; loadTree(parts.slice(0, i + 1).join('/')) } }, part))
      })
      let body
      if (fileView.open) {
        body = h('div', [
          h('div', { class: 'file-head' }, [
            h(ElButton, { text: true, size: 'small', icon: I.ArrowLeft, onClick: () => { fileView.open = false } }, () => '返回目录'),
            h('span', { class: 'mono file-path' }, fileView.path)
          ]),
          fileView.loading ? h('div', { class: 'empty-line' }, '加载中…') : fileView.isMd
            ? h('div', { class: 'md-body md-panel', innerHTML: renderMarkdown(fileView.content) })
            : h('pre', { class: 'code-view' }, fileView.content)
        ])
      } else {
        const sorted = [...tree.items].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1))
        body = h('div', [
          tree.loading ? h('div', { class: 'empty-line' }, '加载中…') :
          sorted.length ? h('div', { class: 'file-list' }, sorted.map((it) => h('div', { class: 'file-row', onClick: () => { if (it.type === 'tree') loadTree((tree.path ? tree.path + '/' : '') + it.name); else openFile(it) } }, [
            h(it.type === 'tree' ? I.Folder : I.Document, { size: 15, class: it.type === 'tree' ? 'file-ico dir' : 'file-ico' }),
            h('span', { class: 'file-name' }, it.name)
          ]))) : h('div', { class: 'empty-line' }, '此目录为空'),
          !tree.path && readme.html ? h('div', { class: 'readme-block' }, [h('div', { class: 'block-label' }, 'README'), h('div', { class: 'md-body md-panel', innerHTML: readme.html })]) : null
        ])
      }
      return h('div', [
        h('div', { class: 'proj-head' }, [
          h('span', { class: 'proj-name' }, p.path_with_namespace || p.name),
          p.visibility ? h(ElTag, { size: 'small', effect: 'plain', round: true }, () => p.visibility) : null,
          h('span', { class: 'flex-spacer' }),
          h('span', { class: 'field-label' }, '分支'),
          h(ElSelect, { modelValue: tree.ref, 'onUpdate:modelValue': (v) => { tree.ref = v; fileView.open = false; loadTree(tree.path); loadReadme() }, size: 'small', style: { width: '170px' } }, () =>
            branches.value.map((b) => h(ElOption, { label: b, value: b })))
        ]),
        p.description ? h('div', { class: 'proj-desc' }, p.description) : null,
        h('div', { class: 'crumbs' }, crumbs),
        body
      ])
    }

    /* ---------- MR ---------- */
    function renderMrTab() {
      if (!curProject.value) return emptyPane('从上方选择一个项目')
      if (mr.detail) {
        const d = mr.detail
        return h('div', [
          h('div', { class: 'detail-head' }, [
            h(ElButton, { text: true, size: 'small', icon: I.ArrowLeft, onClick: () => { mr.detail = null } }, () => '返回列表'),
            h('span', { class: 'detail-title' }, '!' + d.iid + ' ' + d.title),
            stateTag(d.state),
            h('span', { class: 'flex-spacer' }),
            d.state === 'opened' ? h(ElButton, { size: 'small', loading: mr.busy, onClick: mrApprove }, () => '批准') : null,
            d.state === 'opened' ? h(ElCheckbox, { modelValue: mrRemoveSource.value, 'onUpdate:modelValue': (v) => (mrRemoveSource.value = v), label: '合并后删源分支' }) : null,
            d.state === 'opened' ? h(ElButton, { type: 'primary', size: 'small', loading: mr.busy, onClick: mrMerge }, () => '合并') : null
          ]),
          h('div', { class: 'meta-line' }, [h('span', (d.author ? d.author.name : '未知') + ' 创建于 ' + fmtTime(d.created_at)), h('span', { class: 'mono' }, d.source_branch + ' → ' + d.target_branch)]),
          d.description ? h('div', { class: 'md-body md-panel', innerHTML: renderMarkdown(d.description) }) : null,
          h('div', { class: 'block-label' }, '变更（' + mr.changes.length + ' 个文件）'),
          mr.changes.length ? h('div', { class: 'diff-list' }, mr.changes.map((c) => h('div', { class: 'diff-box' }, [
            h('div', { class: 'diff-file mono' }, (c.new_file ? '+ ' : c.deleted_file ? '− ' : '') + c.new_path),
            h('pre', { class: 'diff-pre' }, (c.diff || '').split('\n').map((line) => {
              const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''
              return h('div', { class: ['dl', cls] }, line || ' ')
            }))
          ]))) : h('div', { class: 'empty-line' }, '无变更内容'),
          h('div', { class: 'block-label' }, '评论'),
          notesList(mr.notes),
          commentBox(mr.comment, (v) => (mr.comment = v), mrComment)
        ])
      }
      return h('div', [
        h('div', { class: 'tab-toolbar' }, [
          h(ElSegmented, { modelValue: mr.state, 'onUpdate:modelValue': (v) => { mr.state = v; mr.detail = null; loadMrs(true) }, options: [{ label: '开启', value: 'opened' }, { label: '已合并', value: 'merged' }, { label: '已关闭', value: 'closed' }, { label: '全部', value: 'all' }], size: 'small' }),
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { size: 'small', icon: I.Refresh, loading: mr.loading, onClick: () => loadMrs(true) }, () => '刷新')
        ]),
        WL(h('div', mr.list.length ? h('div', { class: 'row-list' }, mr.list.map((m) => h('div', { class: 'row-item', onClick: () => openMr(m) }, [
          h('div', { class: 'row-main' }, [
            h('div', { class: 'row-title' }, [h('span', { class: 'mono muted' }, '!' + m.iid), h('span', m.title)]),
            h('div', { class: 'row-sub' }, (m.author ? m.author.name : '') + ' · ' + relTime(m.updated_at) + ' 更新 · ' + m.source_branch + ' → ' + m.target_branch)
          ]),
          stateTag(m.state)
        ]))) : h('div', { class: 'empty-line' }, mr.loading ? '加载中…' : '暂无合并请求')), mr.loading),
        loadMoreBtn(mr.loading, mr.page, mr.totalPages, () => { mr.page++; loadMrs(false) })
      ])
    }

    /* ---------- 流水线 ---------- */
    function jobStatusBtn(job) {
      const btns = [h(ElButton, { size: 'small', text: true, onClick: () => openTrace(job) }, () => '日志')]
      if (job.status === 'failed' || job.status === 'canceled' || job.status === 'success') btns.push(h(ElButton, { size: 'small', text: true, onClick: () => jobAction(job, 'retry') }, () => '重试'))
      if (job.status === 'manual') btns.push(h(ElButton, { size: 'small', text: true, type: 'primary', onClick: () => jobAction(job, 'play') }, () => '运行'))
      if (job.status === 'running' || job.status === 'pending') btns.push(h(ElButton, { size: 'small', text: true, type: 'danger', onClick: () => jobAction(job, 'cancel') }, () => '取消'))
      return h('span', { class: 'btn-row' }, btns)
    }
    function renderPipeTab() {
      if (!curProject.value) return emptyPane('从上方选择一个项目')
      if (pipe.detail) {
        const d = pipe.detail
        return h('div', [
          h('div', { class: 'detail-head' }, [
            h(ElButton, { text: true, size: 'small', icon: I.ArrowLeft, onClick: () => { pipe.detail = null; pipe.jobs = [] } }, () => '返回列表'),
            h('span', { class: 'detail-title' }, '流水线 #' + d.id),
            stateTag(d.status),
            h('span', { class: 'flex-spacer' }),
            (d.status === 'running' || d.status === 'pending') ? h(ElButton, { size: 'small', type: 'danger', plain: true, onClick: () => pipeAction('cancel') }, () => '取消流水线') : null,
            (d.status === 'failed' || d.status === 'canceled' || d.status === 'success') ? h(ElButton, { size: 'small', onClick: () => pipeAction('retry') }, () => '重试流水线') : null
          ]),
          h('div', { class: 'meta-line' }, [h('span', { class: 'mono' }, d.ref), h('span', { class: 'mono' }, (d.sha || '').slice(0, 8)), h('span', fmtTime(d.created_at))]),
          h(ElTable, { data: pipe.jobs, size: 'small', style: { width: '100%' } }, () => [
            h(ElTableColumn, { prop: 'name', label: 'Job', minWidth: 140 }),
            h(ElTableColumn, { prop: 'stage', label: '阶段', width: 110 }),
            h(ElTableColumn, { label: '状态', width: 100 }, { default: ({ row }) => stateTag(row.status) }),
            h(ElTableColumn, { label: '耗时', width: 90 }, { default: ({ row }) => row.duration ? Math.round(row.duration) + 's' : '-' }),
            h(ElTableColumn, { label: '操作', width: 170 }, { default: ({ row }) => jobStatusBtn(row) })
          ])
        ])
      }
      return h('div', [
        h('div', { class: 'tab-toolbar' }, [
          h('span', { class: 'toolbar-hint' }, '最近的流水线运行'),
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { size: 'small', icon: I.Refresh, loading: pipe.loading, onClick: () => loadPipes(true) }, () => '刷新')
        ]),
        h(ElTable, { data: pipe.list, size: 'small', style: { width: '100%' }, onRowClick: (row) => openPipe(row), rowStyle: { cursor: 'pointer' } }, () => [
          h(ElTableColumn, { label: 'ID', width: 90 }, { default: ({ row }) => '#' + row.id }),
          h(ElTableColumn, { prop: 'ref', label: '分支', minWidth: 130 }),
          h(ElTableColumn, { label: '状态', width: 100 }, { default: ({ row }) => stateTag(row.status) }),
          h(ElTableColumn, { label: '提交', width: 110 }, { default: ({ row }) => h('span', { class: 'mono' }, (row.sha || '').slice(0, 8)) }),
          h(ElTableColumn, { label: '创建时间', minWidth: 150 }, { default: ({ row }) => fmtTime(row.created_at) })
        ]),
        !pipe.list.length && !pipe.loading ? h('div', { class: 'empty-line' }, '暂无流水线') : null,
        loadMoreBtn(pipe.loading, pipe.page, pipe.totalPages, () => { pipe.page++; loadPipes(false) })
      ])
    }

    /* ---------- Issue ---------- */
    function renderIssueTab() {
      if (!curProject.value) return emptyPane('从上方选择一个项目')
      if (issue.detail) {
        const d = issue.detail
        return h('div', [
          h('div', { class: 'detail-head' }, [
            h(ElButton, { text: true, size: 'small', icon: I.ArrowLeft, onClick: () => { issue.detail = null } }, () => '返回列表'),
            h('span', { class: 'detail-title' }, '#' + d.iid + ' ' + d.title),
            stateTag(d.state),
            h('span', { class: 'flex-spacer' }),
            h(ElButton, { size: 'small', type: d.state === 'opened' ? 'danger' : 'primary', plain: true, onClick: issueToggleState }, () => (d.state === 'opened' ? '关闭 Issue' : '重新打开'))
          ]),
          h('div', { class: 'meta-line' }, [h('span', (d.author ? d.author.name : '未知') + ' 创建于 ' + fmtTime(d.created_at)), (d.labels && d.labels.length) ? h('span', d.labels.map((l) => h(ElTag, { size: 'small', effect: 'plain', round: true, style: { marginRight: '4px' } }, () => l))) : null]),
          d.description ? h('div', { class: 'md-body md-panel', innerHTML: renderMarkdown(d.description) }) : null,
          h('div', { class: 'block-label' }, '评论'),
          notesList(issue.notes),
          commentBox(issue.comment, (v) => (issue.comment = v), issueComment)
        ])
      }
      return h('div', [
        h('div', { class: 'tab-toolbar' }, [
          h(ElSegmented, { modelValue: issue.state, 'onUpdate:modelValue': (v) => { issue.state = v; issue.detail = null; loadIssues(true) }, options: [{ label: '开启', value: 'opened' }, { label: '已关闭', value: 'closed' }, { label: '全部', value: 'all' }], size: 'small' }),
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { size: 'small', icon: I.Refresh, loading: issue.loading, onClick: () => loadIssues(true) }, () => '刷新'),
          h(ElButton, { type: 'primary', size: 'small', icon: I.Plus, onClick: () => { issue.createOpen = true } }, () => '新建 Issue')
        ]),
        WL(h('div', issue.list.length ? h('div', { class: 'row-list' }, issue.list.map((it) => h('div', { class: 'row-item', onClick: () => openIssue(it) }, [
          h('div', { class: 'row-main' }, [
            h('div', { class: 'row-title' }, [h('span', { class: 'mono muted' }, '#' + it.iid), h('span', it.title)]),
            h('div', { class: 'row-sub' }, (it.author ? it.author.name : '') + ' · ' + relTime(it.updated_at) + ' 更新' + ((it.labels && it.labels.length) ? ' · ' + it.labels.join(', ') : ''))
          ]),
          stateTag(it.state)
        ]))) : h('div', { class: 'empty-line' }, issue.loading ? '加载中…' : '暂无 Issue')), issue.loading),
        loadMoreBtn(issue.loading, issue.page, issue.totalPages, () => { issue.page++; loadIssues(false) })
      ])
    }

    /* ---------- 弹窗 ---------- */
    function renderEditor() {
      return h(ElDialog, { modelValue: editor.open, 'onUpdate:modelValue': (v) => (editor.open = v), title: editor.id ? '编辑连接' : '新建连接', width: '480px', closeOnClickModal: false }, {
        default: () => h(ElForm, { labelWidth: '84px' }, () => [
          h(ElFormItem, { label: '名称', required: true }, () => h(ElInput, { modelValue: editor.name, 'onUpdate:modelValue': (v) => (editor.name = v), placeholder: '公司 GitLab' })),
          h(ElFormItem, { label: '地址', required: true }, () => h(ElInput, { modelValue: editor.baseUrl, 'onUpdate:modelValue': (v) => (editor.baseUrl = v), placeholder: 'https://gitlab.example.com' })),
          h(ElFormItem, { label: 'Token', required: true }, () => h(ElInput, { modelValue: editor.token, 'onUpdate:modelValue': (v) => (editor.token = v), type: 'password', showPassword: true, placeholder: 'glpat-…（需 api 权限）' })),
          h(ElFormItem, { label: '自签证书' }, () => h('span', { class: 'switch-line' }, [h(ElSwitch, { modelValue: editor.allowInsecure, 'onUpdate:modelValue': (v) => (editor.allowInsecure = v) }), h('span', { class: 'hint' }, '内网自签 HTTPS 时开启')])),
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
    function renderIssueCreate() {
      return h(ElDialog, { modelValue: issue.createOpen, 'onUpdate:modelValue': (v) => (issue.createOpen = v), title: '新建 Issue', width: '520px', closeOnClickModal: false }, {
        default: () => h(ElForm, { labelWidth: '64px' }, () => [
          h(ElFormItem, { label: '标题', required: true }, () => h(ElInput, { modelValue: issue.createTitle, 'onUpdate:modelValue': (v) => (issue.createTitle = v), placeholder: '简要描述问题' })),
          h(ElFormItem, { label: '描述' }, () => h(ElInput, { modelValue: issue.createDesc, 'onUpdate:modelValue': (v) => (issue.createDesc = v), type: 'textarea', rows: 4, placeholder: '支持 Markdown' })),
          h(ElFormItem, { label: '标签' }, () => h(ElInput, { modelValue: issue.createLabels, 'onUpdate:modelValue': (v) => (issue.createLabels = v), placeholder: '多个标签用逗号分隔' }))
        ]),
        footer: () => h('div', { class: 'dialog-foot' }, [
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { onClick: () => (issue.createOpen = false) }, () => '取消'),
          h(ElButton, { type: 'primary', onClick: issueCreate }, () => '创建')
        ])
      })
    }
    function renderTrace() {
      if (!pipe.traceJob) return null
      return h(ElDialog, { modelValue: true, 'onUpdate:modelValue': (v) => { if (!v) pipe.traceJob = null }, title: 'Job 日志 · ' + pipe.traceJob.name, width: '780px' }, {
        default: () => h('pre', { class: 'log-view' }, pipe.trace || '（无输出）'),
        footer: () => h('div', { class: 'dialog-foot' }, [h('span', { class: 'flex-spacer' }), h(ElButton, { type: 'primary', onClick: () => (pipe.traceJob = null) }, () => '关闭')])
      })
    }

    /* ---------- 根渲染 ---------- */
    return () => {
      const cur = connections.value.find((c) => c.id === connId.value)
      const side = h('aside', { class: 'side' }, [
        h('div', { class: 'side-head' }, [
          h('span', { class: 'side-title' }, 'GitLab 连接'),
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { circle: true, size: 'small', icon: I.Plus, title: '新建连接', onClick: () => openEditor(null) })
        ]),
        connections.value.length ? h(ElScrollbar, { class: 'side-scroll' }, () => connections.value.map((c) => h('div', { class: ['conn-item', { active: c.id === connId.value }], onClick: () => selectConnection(c.id) }, [
          h('span', { class: 'conn-avatar' }, (c.name || '?').slice(0, 1).toUpperCase()),
          h('span', { class: 'conn-meta' }, [
            h('span', { class: 'conn-name' }, c.name),
            h('span', { class: 'conn-sub' }, String(c.baseUrl || '').replace(/^https?:\/\//, ''))
          ]),
          h('span', { class: ['conn-dot', { on: cur && c.id === connId.value }] }),
          h(ElButton, { text: true, size: 'small', class: 'conn-edit', icon: I.Edit, title: '编辑', onClick: (e) => { e.stopPropagation(); openEditor(c) } })
        ]))) : h('div', { class: 'side-empty' }, '暂无连接，点右上角 + 新建（需要 GitLab 地址与 Access Token）')
      ])
      const projBar = h('div', { class: 'proj-bar' }, [
        h(ElInput, { modelValue: projSearch.value, 'onUpdate:modelValue': (v) => (projSearch.value = v), size: 'small', placeholder: '搜索项目（名称或路径）', prefixIcon: I.Search, clearable: true, style: { width: '230px' }, onKeyup: (e) => { if (e.key === 'Enter') loadProjects(true) } }),
        h(ElButton, { size: 'small', loading: projLoading.value, onClick: () => loadProjects(true) }, () => '搜索'),
        h(ElSelect, { modelValue: curProject.value ? String(curProject.value.id) : '', 'onUpdate:modelValue': (v) => { const p = projects.value.find((x) => String(x.id) === String(v)); if (p) openProject(p) }, size: 'small', placeholder: projects.value.length ? '选择项目（共 ' + projPage.total + ' 个）' : '（暂无项目，先点搜索）', style: { width: '300px' }, noDataText: '无匹配项目' }, () =>
          projects.value.map((p) => h(ElOption, { label: p.path_with_namespace || p.name, value: String(p.id) }))),
        projPage.totalPages > 1 && projects.value.length < projPage.total ? h(ElButton, { size: 'small', text: true, loading: projLoading.value, onClick: () => { projPage.page++; loadProjects(false) } }, () => '加载更多项目') : null,
        h('span', { class: 'flex-spacer' }),
        curProject.value && curProject.value.web_url ? h(ElButton, { size: 'small', text: true, type: 'primary', onClick: () => window.open(curProject.value.web_url, '_blank') }, () => '在 GitLab 打开') : null
      ])
      const main = h('main', { class: 'main' }, [
        projBar,
        h(ElTabs, { modelValue: tab.value, 'onUpdate:modelValue': (v) => switchTab(v), class: 'main-tabs' }, () => [
          h(ElTabPane, { label: '项目与代码', name: 'project' }, () => renderProjectTab()),
          h(ElTabPane, { label: '合并请求', name: 'mr' }, () => renderMrTab()),
          h(ElTabPane, { label: '流水线', name: 'pipeline' }, () => renderPipeTab()),
          h(ElTabPane, { label: 'Issue', name: 'issue' }, () => renderIssueTab())
        ])
      ])
      return h('div', { class: 'app-root' }, [
        h('header', { class: 'topbar' }, [
          h('span', { class: 'logo' }, [h(I.Connection, { size: 17 })]),
          h('div', { class: 'title-block' }, [h('h1', 'GitLab 管理台'), h('span', { class: 'sub' }, '项目 · 合并请求 · 流水线 · Issue')]),
          h('span', { class: 'flex-spacer' }),
          h(ElButton, { text: true, icon: uiTheme.value === 'dark' ? I.Sunny : I.Moon, onClick: toggleTheme }, () => (uiTheme.value === 'dark' ? '切换浅色' : '切换深色'))
        ]),
        h('div', { class: 'layout' }, [side, main]),
        editor.open ? renderEditor() : null,
        issue.createOpen ? renderIssueCreate() : null,
        renderTrace()
      ])
    }
  }
}
const app = createApp(App)
app.use(ElementPlus)
app.mount('#app')

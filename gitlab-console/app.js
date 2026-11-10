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
    const toastText = ref(''); const toastShow = ref(false)
    let toastTimer = null
    toastFn = (msg) => { toastText.value = msg; toastShow.value = true; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastShow.value = false }, 2800) }
    function resize() { nextTick(() => { const el = document.getElementById('app'); parent.postMessage({ type: 'newshell:resize', height: el ? el.scrollHeight : document.body.scrollHeight }, '*') }) }
    async function toggleTheme() {
      uiTheme.value = uiTheme.value === 'dark' ? 'light' : 'dark'
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
    const confirmModal = reactive({ open: false, title: '', text: '', okText: '确定' })
    let confirmResolve = null
    function showConfirm(title, text, okText) { confirmModal.title = title; confirmModal.text = text; confirmModal.okText = okText || '确定'; confirmModal.open = true; return new Promise((r) => { confirmResolve = r }) }
    function resolveConfirm(v) { confirmModal.open = false; if (confirmResolve) { confirmResolve(v); confirmResolve = null } }

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
    function badge(state) { return h('span', { class: ['badge', state] }, state) }
    function notesList(notes) {
      if (!notes.length) return h('div', { style: { color: 'var(--text-secondary)', fontSize: '12.5px', padding: '6px 0' } }, '暂无评论')
      return h('div', notes.map((n) => h('div', { class: 'note-item' }, [
        h('span', { class: 'who' }, n.author ? n.author.name : '未知'),
        h('span', { class: 'when' }, fmtTime(n.created_at)),
        h('div', { class: 'md-body', style: { marginTop: '4px' }, innerHTML: renderMarkdown(n.body || '') })
      ])))
    }
    function commentBox(value, onInput, onSend) {
      return h('div', { style: { marginTop: '12px' } }, [
        h('textarea', { value, placeholder: '写下评论（支持 Markdown）…', rows: 3, style: { width: '100%' }, onInput: (e) => onInput(e.target.value) }),
        h('div', { style: { textAlign: 'right', marginTop: '6px' } }, [h('button', { class: 'btn', onClick: onSend }, '发表评论')])
      ])
    }
    function loadMoreBtn(loading, page, totalPages, onClick) {
      if (page >= totalPages) return null
      return h('div', { style: { textAlign: 'center', padding: '10px' } }, [h('button', { class: ['btn', 'ghost', 'small'], disabled: loading, onClick }, loading ? '加载中…' : '加载更多')])
    }

    /* ---------- 渲染：项目页 ---------- */
    function renderProjectTab() {
      if (!curProject.value) return h('div', { class: 'list-empty' }, [h('div', { class: 'big' }, '从上方选择一个项目'), h('div', '项目文件浏览、合并请求、流水线与 Issue 都按项目组织')])
      const p = curProject.value
      const crumbs = [h('span', { class: 'crumb', onClick: () => { fileView.open = false; loadTree('') } }, p.default_branch ? tree.ref : '')]
      const parts = tree.path ? tree.path.split('/') : []
      parts.forEach((part, i) => {
        crumbs.push(h('span', { class: 'crumb-sep' }, '/'))
        crumbs.push(h('span', { class: 'crumb', onClick: () => { fileView.open = false; loadTree(parts.slice(0, i + 1).join('/')) } }, part))
      })
      let body
      if (fileView.open) {
        body = h('div', [
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' } }, [
            h('button', { class: ['btn', 'ghost', 'small'], onClick: () => { fileView.open = false; resize() } }, '← 返回目录'),
            h('span', { class: 'mono', style: { fontSize: '12.5px' } }, fileView.path)
          ]),
          fileView.loading ? h('div', '加载中…') : fileView.isMd
            ? h('div', { class: 'md-body', innerHTML: renderMarkdown(fileView.content) })
            : h('div', { class: 'code-view' }, fileView.content)
        ])
      } else {
        const sorted = [...tree.items].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1))
        body = h('div', [
          tree.loading ? h('div', { style: { padding: '10px', color: 'var(--text-secondary)' } }, '加载中…') :
          sorted.length ? h('div', sorted.map((it) => h('div', { class: 'file-tree-item', onClick: () => { if (it.type === 'tree') loadTree((tree.path ? tree.path + '/' : '') + it.name); else openFile(it) } }, [
            h('span', it.type === 'tree' ? '📁' : '📄'), h('span', it.name), it.type === 'blob' ? null : h('span', { style: { color: 'var(--text-secondary)', fontSize: '11px' } }, '')
          ]))) : h('div', { style: { padding: '12px', color: 'var(--text-secondary)' } }, '此目录为空'),
          !tree.path && readme.html ? h('div', { style: { marginTop: '14px' } }, [h('div', { class: 'io-label' }, 'README'), h('div', { class: 'md-body', innerHTML: readme.html })]) : null
        ])
      }
      return h('div', [
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' } }, [
          h('span', { style: { fontWeight: 650, fontSize: '14px' } }, p.name_with_namespace || p.name),
          p.visibility ? h('span', { class: 'label-chip' }, p.visibility) : null,
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: '12px', color: 'var(--text-secondary)' } }, '分支'),
          h('select', { value: tree.ref, style: { height: '30px', fontSize: '12.5px', width: 'auto', marginBottom: 0 }, onChange: (e) => { tree.ref = e.target.value; fileView.open = false; loadTree(tree.path); loadReadme() } }, branches.value.map((b) => h('option', { value: b }, b)))
        ]),
        p.description ? h('div', { style: { color: 'var(--text-secondary)', fontSize: '12.5px', marginBottom: '8px' } }, p.description) : null,
        h('div', { class: 'crumbs' }, crumbs),
        body
      ])
    }

    /* ---------- 渲染：MR ---------- */
    function renderMrTab() {
      if (!curProject.value) return h('div', { class: 'list-empty' }, [h('div', { class: 'big' }, '从上方选择一个项目')])
      if (mr.detail) {
        const d = mr.detail
        return h('div', [
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' } }, [
            h('button', { class: ['btn', 'ghost', 'small'], onClick: () => { mr.detail = null; resize() } }, '← 返回列表'),
            h('span', { style: { fontWeight: 650, minWidth: 0 } }, '!' + d.iid + ' ' + d.title),
            badge(d.state),
            h('span', { style: { flex: 1 } }),
            d.state === 'opened' ? h('button', { class: ['btn', 'ghost', 'small'], onClick: mrApprove }, '批准') : null,
            d.state === 'opened' ? h('label', { style: { fontSize: '12px', display: 'inline-flex', gap: '4px', alignItems: 'center', whiteSpace: 'nowrap' } }, [h('input', { type: 'checkbox', checked: mrRemoveSource.value, style: { width: 'auto', margin: 0 }, onChange: (e) => { mrRemoveSource.value = e.target.checked } }), '合并后删源分支']) : null,
            d.state === 'opened' ? h('button', { class: ['btn', 'small'], onClick: mrMerge }, '合并') : null
          ]),
          h('div', { style: { color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' } }, (d.author ? d.author.name : '') + ' · ' + d.source_branch + ' → ' + d.target_branch + ' · 更新于 ' + relTime(d.updated_at)),
          d.description ? h('div', { class: 'md-body', style: { marginBottom: '12px' }, innerHTML: renderMarkdown(d.description) }) : null,
          h('div', { class: 'io-label' }, '变更（' + mr.changes.length + ' 个文件）'),
          ...mr.changes.map((c) => h('div', { style: { marginBottom: '10px' } }, [
            h('div', { class: 'mono', style: { fontSize: '12px', marginBottom: '4px' } }, (c.new_file ? '新增 ' : c.deleted_file ? '删除 ' : '') + c.new_path),
            c.diff ? h('div', { class: 'diff-box' }, c.diff.split('\n').map((line) => h('div', { class: ['dl', line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''] }, line || ' '))) : h('div', { style: { color: 'var(--text-secondary)', fontSize: '12px' } }, '（二进制或无文本差异）')
          ])),
          h('div', { class: 'io-label' }, '评论'),
          notesList(mr.notes),
          commentBox(mr.comment, (v) => { mr.comment = v }, mrComment)
        ])
      }
      return h('div', [
        h('div', { class: 'gl-tabs' }, [['opened', '开启中'], ['merged', '已合并'], ['closed', '已关闭'], ['all', '全部']].map(([v, t]) => h('button', { class: ['gl-tab', { active: mr.state === v }], onClick: () => { mr.state = v; loadMrs(true) } }, t))),
        mr.loading && !mr.list.length ? h('div', '加载中…') : mr.list.length ? h('div', { class: 'gl-list' }, mr.list.map((m) => h('div', { class: 'gl-item', onClick: () => openMr(m) }, [
          h('span', { class: 'title' }, '!' + m.iid + ' ' + m.title),
          m.labels && m.labels.length ? h('span', { style: { display: 'flex', gap: '4px' } }, m.labels.slice(0, 3).map((l) => h('span', { class: 'label-chip' }, typeof l === 'string' ? l : l.name))) : null,
          badge(m.state),
          h('span', { class: 'sub' }, (m.author ? m.author.name : '') + ' · ' + relTime(m.updated_at))
        ]))) : h('div', { class: 'list-empty' }, '暂无合并请求'),
        loadMoreBtn(mr.loading, mr.page, mr.totalPages, () => { mr.page++; loadMrs(false) })
      ])
    }

    /* ---------- 渲染：流水线 ---------- */
    function renderPipeTab() {
      if (!curProject.value) return h('div', { class: 'list-empty' }, [h('div', { class: 'big' }, '从上方选择一个项目')])
      if (pipe.detail) {
        const d = pipe.detail
        const stages = []
        const seenStages = []
        for (const j of pipe.jobs) if (!seenStages.includes(j.stage)) seenStages.push(j.stage)
        for (const stg of seenStages) stages.push({ name: stg, jobs: pipe.jobs.filter((j) => j.stage === stg) })
        return h('div', [
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' } }, [
            h('button', { class: ['btn', 'ghost', 'small'], onClick: () => { pipe.detail = null; resize() } }, '← 返回列表'),
            h('span', { style: { fontWeight: 650 } }, '流水线 #' + d.id),
            badge(d.status),
            h('span', { class: 'sub', style: { color: 'var(--text-secondary)', fontSize: '12px' } }, d.ref + ' · ' + (d.sha || '').slice(0, 8) + ' · ' + relTime(d.updated_at)),
            h('span', { style: { flex: 1 } }),
            ['running', 'pending', 'created'].includes(d.status) ? h('button', { class: ['btn', 'ghost', 'small'], onClick: () => pipeAction('cancel') }, '取消流水线') : null,
            ['failed', 'canceled', 'success'].includes(d.status) ? h('button', { class: ['btn', 'small'], onClick: () => pipeAction('retry') }, '重试流水线') : null
          ]),
          ...stages.map((stg) => h('div', { style: { marginBottom: '10px' } }, [
            h('div', { class: 'io-label' }, stg.name),
            h('div', { class: 'gl-list' }, stg.jobs.map((j) => h('div', { class: 'gl-item' }, [
              h('span', { class: 'title' }, j.name),
              badge(j.status),
              h('span', { class: 'sub' }, j.duration ? Math.round(j.duration) + ' 秒' : ''),
              j.status === 'manual' ? h('button', { class: ['btn', 'ghost', 'small'], onClick: () => jobAction(j, 'play') }, '触发') : null,
              ['failed', 'canceled', 'success'].includes(j.status) ? h('button', { class: ['btn', 'ghost', 'small'], onClick: () => jobAction(j, 'retry') }, '重跑') : null,
              ['running', 'pending'].includes(j.status) ? h('button', { class: ['btn', 'ghost', 'small'], onClick: () => jobAction(j, 'cancel') }, '取消') : null,
              h('button', { class: ['btn', 'ghost', 'small'], onClick: () => openTrace(j) }, '日志')
            ])))
          ])),
          pipe.traceJob ? h('div', [
            h('div', { class: 'io-label' }, [h('span', 'Job 日志 · ' + pipe.traceJob.name), h('label', { style: { fontSize: '11.5px', fontWeight: 400, display: 'inline-flex', gap: '4px', alignItems: 'center' } }, [h('input', { type: 'checkbox', checked: pipe.traceAuto, style: { width: 'auto', margin: 0 }, onChange: (e) => { pipe.traceAuto = e.target.checked } }), '自动滚到底部']) ]),
            h('div', { class: 'trace-view' }, pipe.trace)
          ]) : null
        ])
      }
      return h('div', [
        pipe.loading && !pipe.list.length ? h('div', '加载中…') : pipe.list.length ? h('div', { class: 'gl-list' }, pipe.list.map((p) => h('div', { class: 'gl-item', onClick: () => openPipe(p) }, [
          h('span', { class: 'title' }, '#' + p.id + ' · ' + p.ref),
          badge(p.status),
          h('span', { class: 'sub' }, (p.sha || '').slice(0, 8) + ' · ' + relTime(p.updated_at))
        ]))) : h('div', { class: 'list-empty' }, '暂无流水线'),
        loadMoreBtn(pipe.loading, pipe.page, pipe.totalPages, () => { pipe.page++; loadPipes(false) })
      ])
    }

    /* ---------- 渲染：Issue ---------- */
    function renderIssueTab() {
      if (!curProject.value) return h('div', { class: 'list-empty' }, [h('div', { class: 'big' }, '从上方选择一个项目')])
      if (issue.detail) {
        const d = issue.detail
        return h('div', [
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' } }, [
            h('button', { class: ['btn', 'ghost', 'small'], onClick: () => { issue.detail = null; resize() } }, '← 返回列表'),
            h('span', { style: { fontWeight: 650 } }, '#' + d.iid + ' ' + d.title),
            badge(d.state),
            h('span', { style: { flex: 1 } }),
            h('button', { class: ['btn', 'ghost', 'small'], onClick: issueToggleState }, d.state === 'opened' ? '关闭 Issue' : '重新打开')
          ]),
          h('div', { style: { color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' } }, (d.author ? d.author.name : '') + ' 创建于 ' + fmtTime(d.created_at)),
          d.labels && d.labels.length ? h('div', { style: { display: 'flex', gap: '4px', marginBottom: '8px' } }, d.labels.map((l) => h('span', { class: 'label-chip' }, typeof l === 'string' ? l : l.name))) : null,
          d.description ? h('div', { class: 'md-body', style: { marginBottom: '12px' }, innerHTML: renderMarkdown(d.description) }) : null,
          h('div', { class: 'io-label' }, '评论'),
          notesList(issue.notes),
          commentBox(issue.comment, (v) => { issue.comment = v }, issueComment)
        ])
      }
      return h('div', [
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '10px' } }, [
          h('div', { class: 'gl-tabs', style: { marginBottom: 0 } }, [['opened', '开启中'], ['closed', '已关闭'], ['all', '全部']].map(([v, t]) => h('button', { class: ['gl-tab', { active: issue.state === v }], onClick: () => { issue.state = v; loadIssues(true) } }, t))),
          h('span', { style: { flex: 1 } }),
          h('button', { class: ['btn', 'small'], onClick: () => { issue.createOpen = true } }, '新建 Issue')
        ]),
        issue.loading && !issue.list.length ? h('div', '加载中…') : issue.list.length ? h('div', { class: 'gl-list' }, issue.list.map((it) => h('div', { class: 'gl-item', onClick: () => openIssue(it) }, [
          h('span', { class: 'title' }, '#' + it.iid + ' ' + it.title),
          it.labels && it.labels.length ? h('span', { style: { display: 'flex', gap: '4px' } }, it.labels.slice(0, 3).map((l) => h('span', { class: 'label-chip' }, typeof l === 'string' ? l : l.name))) : null,
          badge(it.state),
          h('span', { class: 'sub' }, (it.author ? it.author.name : '') + ' · ' + relTime(it.updated_at))
        ]))) : h('div', { class: 'list-empty' }, '暂无 Issue'),
        loadMoreBtn(issue.loading, issue.page, issue.totalPages, () => { issue.page++; loadIssues(false) })
      ])
    }

    /* ---------- 渲染：弹窗 ---------- */
    function maskWrap(children, onMask) {
      return h('div', { class: 'mask', onClick: (e) => { if (e.target === e.currentTarget && onMask) onMask() } }, children)
    }
    function renderConfirm() {
      return maskWrap([h('div', { class: 'modal', style: { width: '420px' } }, [
        h('h2', confirmModal.title),
        h('div', { style: { lineHeight: '1.65', whiteSpace: 'pre-wrap' } }, confirmModal.text),
        h('div', { class: 'foot' }, [
          h('button', { class: ['btn', 'ghost'], onClick: () => resolveConfirm(false) }, '取消'),
          h('button', { class: ['btn', 'danger'], onClick: () => resolveConfirm(true) }, confirmModal.okText)
        ])
      ])], () => resolveConfirm(false))
    }
    function renderEditor() {
      return maskWrap([h('div', { class: 'modal', style: { width: '480px' } }, [
        h('h2', editor.id ? '编辑连接' : '新建连接'),
        h('div', { class: 'form-row' }, [h('label', '名称'), h('input', { value: editor.name, placeholder: '公司 GitLab', onInput: (e) => { editor.name = e.target.value } })]),
        h('div', { class: 'form-row' }, [h('label', 'GitLab 地址'), h('input', { value: editor.baseUrl, placeholder: 'https://gitlab.example.com', onInput: (e) => { editor.baseUrl = e.target.value } })]),
        h('div', { class: 'form-row' }, [h('label', 'Access Token（需 api 权限）'), h('input', { value: editor.token, type: 'password', placeholder: 'glpat-…', onInput: (e) => { editor.token = e.target.value } })]),
        h('div', { class: 'form-row' }, [h('label', [h('input', { type: 'checkbox', checked: editor.allowInsecure, style: { width: 'auto', marginRight: '6px' }, onChange: (e) => { editor.allowInsecure = e.target.checked } }), '允许自签证书（跳过 TLS 校验）'])]),
        editor.testMsg ? h('div', { class: editor.testOk ? 'ok-text' : 'err-text' }, editor.testMsg) : null,
        h('div', { class: 'foot' }, [
          editor.id ? h('button', { class: ['btn', 'danger'], style: { marginRight: 'auto' }, onClick: deleteEditor }, '删除连接') : null,
          h('button', { class: ['btn', 'ghost'], disabled: editor.testing, onClick: testEditor }, editor.testing ? '测试中…' : '测试连接'),
          h('button', { class: ['btn', 'ghost'], onClick: () => { editor.open = false } }, '取消'),
          h('button', { class: 'btn', onClick: saveEditor }, '保存')
        ])
      ])])
    }
    function renderIssueCreate() {
      return maskWrap([h('div', { class: 'modal', style: { width: '520px' } }, [
        h('h2', '新建 Issue'),
        h('div', { class: 'form-row' }, [h('label', '标题'), h('input', { value: issue.createTitle, onInput: (e) => { issue.createTitle = e.target.value } })]),
        h('div', { class: 'form-row' }, [h('label', '描述（Markdown）'), h('textarea', { value: issue.createDesc, rows: 5, onInput: (e) => { issue.createDesc = e.target.value } })]),
        h('div', { class: 'form-row' }, [h('label', '标签（逗号分隔）'), h('input', { value: issue.createLabels, placeholder: 'bug, 高优先级', onInput: (e) => { issue.createLabels = e.target.value } })]),
        h('div', { class: 'foot' }, [
          h('button', { class: ['btn', 'ghost'], onClick: () => { issue.createOpen = false } }, '取消'),
          h('button', { class: 'btn', onClick: issueCreate }, '创建')
        ])
      ])])
    }

    /* ---------- 渲染：外壳 ---------- */
    return () => {
      const side = h('aside', { class: 'side' }, [
        h('div', { class: 'side-head' }, [h('span', { style: { fontSize: '13px' } }, 'GitLab 连接'), h('button', { class: 'icon-btn', title: '新建连接', onClick: () => openEditor(null) }, '＋')]),
        h('div', { class: 'conn-list' }, connections.value.length ? connections.value.map((c) => h('div', { class: ['conn-item', { active: c.id === connId.value }], onClick: () => selectConnection(c.id) }, [
          h('span', { class: 'avatar' }, '🦊'), h('span', { class: 'nm' }, c.name),
          h('button', { class: 'icon-btn', title: '编辑', onClick: (e) => { e.stopPropagation(); openEditor(c) } }, h('span', { innerHTML: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>', style: { display: 'inline-flex' } }))
        ])) : h('div', { style: { color: 'var(--text-secondary)', fontSize: '12px', padding: '6px 2px', lineHeight: '1.7' } }, '暂无连接，点右上角 ＋ 新建（需要 GitLab 地址与 Access Token）'))
      ])
      let main
      if (!curConn.value) {
        main = h('div', { class: 'list-empty', style: { margin: 'auto' } }, [h('div', { class: 'big' }, '欢迎使用 GitLab 管理台'), h('div', '在左侧新建一个连接（GitLab 地址 + Access Token），即可浏览项目与代码、评审合并请求、查看流水线并处理 Issue')])
      } else {
        const projBar = h('div', { class: 'proj-bar' }, [
          h('input', { value: projSearch.value, placeholder: '搜索项目…', style: { height: '32px', width: '220px', marginBottom: 0 }, onInput: (e) => { projSearch.value = e.target.value }, onKeydown: (e) => { if (e.key === 'Enter') loadProjects(true) } }),
          h('button', { class: ['btn', 'ghost', 'small'], onClick: () => loadProjects(true) }, '搜索'),
          h('select', { value: curProject.value ? String(curProject.value.id) : '', style: { height: '32px', fontSize: '12.5px', width: 'auto', maxWidth: '380px', marginBottom: 0 }, onChange: (e) => { const p = projects.value.find((x) => String(x.id) === e.target.value); if (p) openProject(p) } }, [
            h('option', { value: '', disabled: true }, projects.value.length ? '选择项目（共 ' + projPage.total + ' 个）' : '（暂无项目，点搜索加载）'),
            ...projects.value.map((p) => h('option', { value: String(p.id) }, p.path_with_namespace || p.name))
          ]),
          projPage.totalPages > 1 && projects.value.length < projPage.total ? h('button', { class: ['btn', 'ghost', 'small'], disabled: projLoading.value, onClick: () => { projPage.page++; loadProjects(false) } }, '加载更多项目') : null,
          curProject.value && curProject.value.web_url ? h('a', { href: curProject.value.web_url, target: '_blank', style: { fontSize: '12px' } }, '在 GitLab 打开 ↗') : null
        ])
        const tabContent = tab.value === 'project' ? renderProjectTab() : tab.value === 'mr' ? renderMrTab() : tab.value === 'pipeline' ? renderPipeTab() : renderIssueTab()
        main = h('main', { class: 'main' }, [
          projBar,
          h('div', { class: 'gl-tabs' }, [['project', '项目与代码'], ['mr', '合并请求'], ['pipeline', '流水线'], ['issue', 'Issue']].map(([v, t]) => h('button', { class: ['gl-tab', { active: tab.value === v }], onClick: () => switchTab(v) }, t))),
          tabContent
        ])
      }
      return h('div', [
        h('div', { class: 'topbar' }, [h('h1', 'GitLab 管理台'), h('span', { style: { flex: 1 } }), h('button', { class: ['btn', 'ghost'], onClick: toggleTheme }, uiTheme.value === 'dark' ? '切换浅色' : '切换深色')]),
        h('div', { class: 'layout' }, [side, main]),
        confirmModal.open ? renderConfirm() : null,
        editor.open ? renderEditor() : null,
        issue.createOpen ? renderIssueCreate() : null,
        h('div', { class: ['toast', { show: toastShow.value }] }, toastText.value)
      ])
    }
  }
}
createApp(App).mount('#app')

// GoShell 插件：直连 GoShell Agent 的 HTTP/WS 接口，无需本地客户端二进制
// 终端协议（对接文档）：WS /ws/shell，客户端 Text 帧=键盘输入，JSON {"type":"resize",cols,rows}=调整尺寸；
// 服务端 Text 帧=原始终端输出。Agent 空闲读超时 120s，客户端每 30s 发送空 Text 帧保活。
// 文件面板：按宿主通用插件文件接口（fs 处理器）实现——list 走 /api/listdir，
// 语义操作走 /api/exec（路径单引号转义），上传走 /api/upload multipart，下载走 exec+base64。

const http = require('http')

const KEEPALIVE_INTERVAL_MS = 30000
const OPEN_TIMEOUT_MS = 15000
// base64 下载通道整文件进内存的上限
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

const connections = new Map()

function agentOf(sessionId) {
  const conn = connections.get(sessionId)
  if (!conn || !conn.agent) throw new Error('GoShell 会话不存在或已断开，请重新连接')
  return conn.agent
}

// ---- Agent HTTP 基础封装（沙箱无 fetch，使用 http 模块） ----

function shellQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`
}

function agentRequest(agent, path, options = {}) {
  const data = options.body === undefined
    ? null
    : (typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : options.body)
  const timeoutMs = options.timeoutMs || 35000
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: agent.host,
      port: agent.port,
      path,
      method: options.method || 'GET',
      headers: {
        ...(agent.token ? { Authorization: 'Bearer ' + agent.token } : {}),
        ...(data ? { 'Content-Length': data.length } : {}),
        ...(data && !(options.headers && options.headers['Content-Type']) ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    // 网络黑洞（TCP 可达但不响应）时 socket 空闲超时兜底，避免请求永不返回
    const TIMEOUT_MESSAGE = 'GoShell Agent 响应超时，请检查 Agent 状态与网络'
    req.setTimeout(timeoutMs, () => req.destroy(new Error(TIMEOUT_MESSAGE)))
    req.on('error', error => reject(new Error(error.message === TIMEOUT_MESSAGE ? error.message : '无法连接 GoShell Agent: ' + error.message)))
    if (data) req.write(data)
    req.end()
  })
}

async function agentJson(agent, path, options) {
  const res = await agentRequest(agent, path, options)
  if (res.status < 200 || res.status >= 300) throw new Error(`GoShell Agent HTTP ${res.status}: ${res.text || ''}`)
  try { return JSON.parse(res.text) } catch { return res.text }
}

/** /api/exec；退出码非 0 抛错 */
async function agentExec(agent, command, timeout = 30, timeoutMs) {
  const result = await agentJson(agent, '/api/exec', { method: 'POST', body: JSON.stringify({ command, timeout }), timeoutMs })
  if (result.code !== 0) throw new Error(result.stderr || `命令执行失败 (exit ${result.code})`)
  return result.stdout || ''
}

// ---- listdir 条目 → 宿主文件面板通用格式（Go FileMode 低 9 位兼容 POSIX，目录位 1<<31） ----

function formatPermissionBits(mode) {
  const group = value => `${value & 4 ? 'r' : '-'}${value & 2 ? 'w' : '-'}${value & 1 ? 'x' : '-'}`
  return `${group((mode >> 6) & 7)}${group((mode >> 3) & 7)}${group(mode & 7)}`
}

function listdirItemToPanel(file) {
  const directory = file.is_dir || (file.mode & 0x80000000) !== 0
  const permissionBits = file.mode & 0o777
  const mode = (directory ? 0o040000 : 0o100000) | permissionBits
  const size = file.size === undefined ? 0 : file.size
  const mtime = file.mod_time ? Math.floor(new Date(file.mod_time).getTime() / 1000) : 0
  return {
    filename: file.name,
    longname: `${directory ? 'd' : '-'}${formatPermissionBits(permissionBits)} 1 - - ${size} ${mtime ? new Date(mtime * 1000).toISOString() : ''} ${file.name}`,
    attrs: { mode, size, mtime, uid: 0, gid: 0 }
  }
}

// ---- 上传：手工构造 multipart/form-data（沙箱无 FormData） ----

function buildMultipartBody(boundary, fields, filename, content) {
  const parts = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'))
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${String(filename).replace(/["\r\n]/g, '_')}"\r\n\r\n`, 'utf8'))
  parts.push(content)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return Buffer.concat(parts)
}

function activate(context) {
  console.log('[GoShell Plugin] Activating...')

  // 宿主在 network 权限下注入全局 WebSocket
  const WebSocketCtor = context.WebSocket || globalThis.WebSocket

  // 1. 注册连接类型
  const typeRegistered = context.connection.registerType({
    type: 'goshell',
    displayName: 'GoShell',
    defaultPort: 8080,
    defaultUsername: '',
    supportedAuthTypes: ['password'],
    supportsTerminal: true,
    supportsPortForward: false,
    supportsProxy: false,
    needsUsername: false,
    badgeBackground: 'rgba(0, 191, 165, 0.15)',
    badgeColor: '#00bfa5',
    iconFilter: 'hue-rotate(160deg) saturate(1.5) brightness(1.1)',
    rightPanelTabs: ['files', 'commands', 'ai'],
    filePanel: { edit: false, chmod: true }
  })

  if (!typeRegistered) {
    console.error('[GoShell Plugin] Failed to register connection type')
    return
  }

  // 2. 注册工具页面
  context.ui.registerToolPage({
    id: 'dashboard',
    title: 'GoShell 管理',
    icon: '🐹',
    renderer: 'dashboard.html'
  })

  // 3. 注册连接处理器（终端 WS + 文件面板 fs）
  const handlerRegistered = context.connection.registerHandler('goshell', {
    connect: (sessionId, config) => new Promise((resolve, reject) => {
      if (typeof WebSocketCtor !== 'function') {
        reject(new Error('宿主未注入 WebSocket，无法直连 GoShell Agent'))
        return
      }

      const agent = { host: config.host, port: config.port || 8080, token: config.token || config.password || '' }
      const token = agent.token
      const url = `ws://${agent.host}:${agent.port}/ws/shell?token=${encodeURIComponent(token)}`
      console.log('[GoShell Plugin] Connecting ws://' + agent.host + ':' + agent.port + '/ws/shell, hasToken:', !!token)

      const ws = new WebSocketCtor(url)
      const conn = { ws, keepalive: null, agent }
      let opened = false
      let failed = false

      const openTimer = setTimeout(() => {
        if (!opened) failOpen(new Error('GoShell 连接超时（15s）'))
      }, OPEN_TIMEOUT_MS)

      function failOpen(error) {
        // undici WebSocket 在握手被拒（如 401）后会连续触发多次 error，只处理一次
        if (failed || opened) return
        failed = true
        clearTimeout(openTimer)
        console.error('[GoShell Plugin] Connect failed:', error.message)
        try { ws.close() } catch (_) {}
        reject(error)
      }

      ws.onopen = () => {
        opened = true
        clearTimeout(openTimer)
        conn.keepalive = setInterval(() => {
          if (conn.ws.readyState === 1) {
            try { conn.ws.send('') } catch (_) {}
          }
        }, KEEPALIVE_INTERVAL_MS)
        connections.set(sessionId, conn)
        console.log('[GoShell Plugin] Session connected:', sessionId)
        resolve()
      }

      ws.onmessage = (event) => {
        const data = event.data
        if (typeof data === 'string') {
          context.terminal.emitData(sessionId, new Uint8Array(Buffer.from(data, 'utf8')))
        } else if (data instanceof ArrayBuffer) {
          context.terminal.emitData(sessionId, new Uint8Array(data))
        }
      }

      ws.onerror = () => {
        if (!opened) failOpen(new Error('GoShell WebSocket 连接失败，请检查 Agent 地址、端口与令牌'))
      }

      ws.onclose = () => {
        clearInterval(conn.keepalive)
        connections.delete(sessionId)
        console.log('[GoShell Plugin] Session closed:', sessionId)
        if (opened) {
          context.terminal.emitData(sessionId, new Uint8Array(Buffer.from('\r\n[GoShell] 连接已断开\r\n')))
        }
      }
    }),

    disconnect: (sessionId) => {
      const conn = connections.get(sessionId)
      if (!conn) return
      console.log('[GoShell Plugin] Disconnecting session:', sessionId)
      clearInterval(conn.keepalive)
      try { conn.ws.close() } catch (_) {}
      connections.delete(sessionId)
    },

    write: (sessionId, data) => {
      const conn = connections.get(sessionId)
      if (!conn || conn.ws.readyState !== 1) return
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      try { conn.ws.send(text) } catch (_) {}
    },

    resize: (sessionId, cols, rows) => {
      const conn = connections.get(sessionId)
      if (!conn || conn.ws.readyState !== 1) return
      try { conn.ws.send(JSON.stringify({ type: 'resize', cols, rows })) } catch (_) {}
    },

    // ---- 文件面板：宿主通用插件文件接口 ----

    fs: {
      async list(sessionId, path) {
        const data = await agentJson(agentOf(sessionId), '/api/listdir', {
          method: 'POST',
          body: JSON.stringify({ path })
        })
        return (data.files || []).map(listdirItemToPanel)
      },

      async rename(sessionId, oldPath, newPath) {
        const agent = agentOf(sessionId)
        // mv 会静默覆盖已存在目标（SFTP/FTP rename 均报错），先探测目标保持一致语义
        const exists = await agentExec(agent, `if [ -e ${shellQuote(newPath)} ]; then echo __GOSHELL_EXISTS__; fi`)
        if (exists.includes('__GOSHELL_EXISTS__')) {
          throw new Error(`目标已存在，为避免覆盖已中止重命名: ${newPath}`)
        }
        await agentExec(agent, `mv -- ${shellQuote(oldPath)} ${shellQuote(newPath)}`)
      },

      async delete(sessionId, path, isDir) {
        await agentExec(agentOf(sessionId), `${isDir ? 'rm -rf' : 'rm -f'} -- ${shellQuote(path)}`)
      },

      async mkdir(sessionId, path) {
        await agentExec(agentOf(sessionId), `mkdir -p -- ${shellQuote(path)}`)
      },

      async touch(sessionId, path) {
        await agentExec(agentOf(sessionId), `touch -- ${shellQuote(path)}`)
      },

      async chmod(sessionId, path, mode) {
        const octal = (mode & 0o777).toString(8).padStart(3, '0')
        await agentExec(agentOf(sessionId), `chmod ${octal} -- ${shellQuote(path)}`)
      },

      async upload(sessionId, remotePath, filename, content) {
        const agent = agentOf(sessionId)
        const boundary = 'goshell-' + Math.random().toString(16).slice(2)
        const body = buildMultipartBody(boundary, { path: remotePath, mkdir: 'true', overwrite: 'true' }, filename, content)
        await agentJson(agent, '/api/upload', {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
          timeoutMs: 130000
        })
      },

      async download(sessionId, remotePath) {
        const agent = agentOf(sessionId)
        // base64 通道整文件进内存，超限直接报明确错误而不是假死/超时报错
        const size = await agentExec(agent, `wc -c < ${shellQuote(remotePath)}`, 15)
        const sizeBytes = Number.parseInt(size.trim(), 10)
        if (!Number.isFinite(sizeBytes)) throw new Error(`无法获取文件大小，下载中止 (${remotePath})`)
        if (sizeBytes > MAX_DOWNLOAD_BYTES) {
          throw new Error(`文件过大（约 ${(sizeBytes / 1024 / 1024).toFixed(0)}MB）：GoShell 下载经 base64 通道，仅支持不超过 100MB 的文件`)
        }
        const stdout = await agentExec(agent, `base64 -w0 ${shellQuote(remotePath)}`, 120, 135000)
        return Buffer.from(stdout.trim(), 'base64')
      }
    }
  })

  if (!handlerRegistered) {
    console.error('[GoShell Plugin] Failed to register connection handler')
    context.connection.unregisterType('goshell')
    return
  }

  console.log('[GoShell Plugin] Activated successfully')
}

function deactivate() {
  console.log('[GoShell Plugin] Deactivating...')
  for (const [sessionId, conn] of connections) {
    console.log('[GoShell Plugin] Closing session:', sessionId)
    clearInterval(conn.keepalive)
    try { conn.ws.close() } catch (_) {}
  }
  connections.clear()
  console.log('[GoShell Plugin] Deactivated')
}

module.exports = { activate, deactivate }

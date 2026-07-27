const { spawn } = require('child_process')
const { join } = require('path')

// 优先使用插件目录下的 exe，其次回退到外部路径
const DEFAULT_CLIENT_PATH = join(__dirname, 'goshell-client.exe')

const connections = new Map()

function activate(context) {
  console.log('[GoShell Plugin] Activating...')

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
    rightPanelTabs: ['commands','ai']
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

  // 3. 注册连接处理器
  const handlerRegistered = context.connection.registerHandler('goshell', {
    connect: async (sessionId, config) => {
      console.log('[GoShell Plugin] Connecting session:', sessionId)

      const clientPath = config.clientPath || DEFAULT_CLIENT_PATH
      const serverUrl = `http://${config.host}:${config.port}`
      const token = config.token || config.password

      // 根据用户手册，-s/-t 是全局选项，必须放在子命令之前
      // urfave/cli v2 的 DefaultCommand 在处理全局 flag 时有 bug，必须显式指定 shell 子命令
      const args = ['-s', serverUrl]
      if (token) {
        args.push('-t', token)
      }
      args.push('shell')

      console.log('[GoShell Plugin] Spawning:', clientPath)
      console.log('[GoShell Plugin] Arguments:', JSON.stringify(args))
      console.log('[GoShell Plugin] Config:', JSON.stringify({ host: config.host, port: config.port, hasToken: !!token }))

      const proc = spawn(clientPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      return new Promise((resolve, reject) => {
        let connected = false
        const timeout = setTimeout(() => {
          if (!connected) {
            proc.kill()
            reject(new Error('GoShell connection timeout (15s)'))
          }
        }, 15000)

        proc.on('error', (err) => {
          clearTimeout(timeout)
          console.error('[GoShell Plugin] Spawn error:', err.message)
          reject(new Error(`Failed to spawn goshell-client: ${err.message}`))
        })

        proc.on('spawn', () => {
          connected = true
          clearTimeout(timeout)
          connections.set(sessionId, { proc, config })
          console.log('[GoShell Plugin] Session connected:', sessionId)
          resolve()
        })

        proc.stdout.on('data', (data) => {
          const text = data.toString()
          console.log('[GoShell Plugin] stdout (' + data.length + ' bytes):', text.slice(0, 200))
          context.terminal.emitData(sessionId, new Uint8Array(data))
        })

        proc.stderr.on('data', (data) => {
          const text = data.toString()
          console.error('[GoShell Plugin] stderr (' + data.length + ' bytes):', text.slice(0, 200))
        })

        proc.on('close', (code) => {
          console.log(`[GoShell Plugin] Session ${sessionId} exited with code ${code}`)
          connections.delete(sessionId)
          context.terminal.emitData(sessionId, new Uint8Array(Buffer.from(`\r\n[GoShell] Process exited with code ${code}\r\n`)))
        })
      })
    },

    disconnect: (sessionId) => {
      console.log('[GoShell Plugin] Disconnecting session:', sessionId)
      const conn = connections.get(sessionId)
      if (!conn) return
      if (conn.disconnecting) return
      conn.disconnecting = true

      const proc = conn.proc

      // 1. 尝试优雅关闭：发送 exit 命令 + EOF，给客户端时间发送 WebSocket Close 帧
      try {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.write('exit\n')
          proc.stdin.end()
        }
      } catch (e) {
        console.error('[GoShell Plugin] Error sending graceful exit:', e)
      }

      // 2. 等待 1s 让进程自己退出；若未退出则强制 kill
      setTimeout(() => {
        if (connections.has(sessionId)) {
          console.log('[GoShell Plugin] Graceful close timeout, force kill:', sessionId)
          if (!proc.killed) {
            proc.kill('SIGTERM')
          }
        }
      }, 1000)
    },

    write: (sessionId, data) => {
      const conn = connections.get(sessionId)
      if (conn && conn.proc.stdin && !conn.proc.stdin.destroyed) {
        conn.proc.stdin.write(data)
      }
    },

    resize: (_sessionId, _cols, _rows) => {
      // goshell-client 暂不支持终端 resize
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

  // 优雅关闭所有活跃连接
  for (const [sessionId, conn] of connections) {
    if (conn.disconnecting) continue
    conn.disconnecting = true
    console.log('[GoShell Plugin] Graceful disconnect session:', sessionId)
    try {
      if (conn.proc.stdin && !conn.proc.stdin.destroyed) {
        conn.proc.stdin.write('exit\n')
        conn.proc.stdin.end()
      }
    } catch (e) {
      console.error('[GoShell Plugin] Graceful exit error:', e)
    }
  }

  // 等待 1.5s 后强制清理残余进程
  setTimeout(() => {
    for (const [sessionId, conn] of connections) {
      console.log('[GoShell Plugin] Force kill session:', sessionId)
      if (!conn.proc.killed) {
        try { conn.proc.kill('SIGTERM') } catch (_) {}
      }
    }
    connections.clear()
    console.log('[GoShell Plugin] Deactivated')
  }, 1500)
}

module.exports = { activate, deactivate }

/**
 * Test Panel Plugin
 * 验证左右面板标签溢出 ⋮ 下拉效果 + 演示所有 Plugin API
 *
 * 涵盖 API：
 *   - UI API（工具页、左/右侧面板标签）
 *   - Dialog API（居中弹窗）
 *   - Storage API（持久化键值存储）
 *   - Storage Sync API（S3 多端同步）
 *   - Connection API（自定义连接类型 + 处理器）
 *   - Terminal API（监听输入/输出、向终端写入）
 */

// ============================================================
// 状态管理
// ============================================================

const connections = new Map()
const disposables = []
let pluginCtx = null

const SIDE_TABS = [
  { id: 'api-manager',  title: 'API 管理',     icon: '📡' },
  { id: 'dialog-test',  title: '弹窗测试',     icon: '💬' },
  { id: 'test-left',    title: '测试左侧',     icon: '🧪' },
  { id: 'test-monitor', title: '资源监控',     icon: '📈' },
  { id: 'test-log',     title: '日志查看器',   icon: '📋' },
  { id: 'test-quick',   title: '快捷操作面板', icon: '⚡' },
  { id: 'test-sysinfo', title: '系统信息',     icon: '💻' },
  { id: 'test-network', title: '网络诊断',     icon: '🌐' },
  { id: 'test-database', title: '数据库管理',  icon: '🗄️' },
  { id: 'test-deploy',  title: '部署管理',     icon: '🚀' }
]

const RIGHT_TABS = [
  { id: 'test-right',   title: '测试右侧', icon: '🔬' },
  { id: 'test-session', title: '会话分析', icon: '📊' },
  { id: 'test-perf',    title: '性能图表', icon: '📉' },
  { id: 'test-httplog', title: '请求日志', icon: '📜' },
  { id: 'test-env',     title: '环境变量', icon: '🔧' },
  { id: 'test-docker',  title: '容器管理', icon: '🐳' }
]

// ============================================================
// 1. activate - 插件入口
// ============================================================

async function activate(context) {
  pluginCtx = context
  console.log(`[TestPanel] Activating v${context.manifest.version}...`)

  // 1.1 Storage API 演示
  await demoStorageAPI(context)

  // 1.2 Sync Storage API 演示
  await demoSyncAPI(context)

  // 1.3 UI API 演示（工具页 + 左右面板标签）
  demoUIAPI(context)

  // 1.4 Dialog API 演示
  demoDialogAPI(context)

  // 1.5 Connection API 演示（自定义连接类型）
  demoConnectionAPI(context)

  // 1.6 Terminal API 演示
  demoTerminalAPI(context)

  console.log(`[TestPanel] Done — ${SIDE_TABS.length} side + ${RIGHT_TABS.length} right tabs`)
}

// ============================================================
// 2. deactivate - 插件清理出口
// ============================================================

async function deactivate() {
  console.log('[TestPanel] Deactivating...')

  // 断开所有活跃会话
  for (const [sessionId, conn] of connections) {
    try {
      if (typeof conn.close === 'function') await conn.close()
    } catch (e) {
      console.error(`[TestPanel] Error closing session ${sessionId}:`, e)
    }
  }
  connections.clear()

  // 取消所有订阅
  for (const dispose of disposables) {
    try { if (typeof dispose === 'function') dispose() } catch (_) {}
  }
  disposables.length = 0

  pluginCtx = null
  console.log('[TestPanel] Deactivated')
}

// ============================================================
// 3. Storage API 演示
// ============================================================

async function demoStorageAPI(context) {
  const { storage } = context

  await storage.set('activateCount', (await storage.get('activateCount') || 0) + 1)
  await storage.set('lastActivateAt', Date.now())

  const count = await storage.get('activateCount')
  const lastAt = await storage.get('lastActivateAt')
  console.log(`[TestPanel] Storage: activateCount=${count}, lastActivateAt=${lastAt}`)
}

// ============================================================
// 4. Sync Storage API 演示
// ============================================================

async function demoSyncAPI(context) {
  const { storage } = context

  await storage.sync.save('test-note-1', {
    title: 'TestPanel 同步笔记',
    content: '这是一条参与多端同步的测试数据',
    tags: ['test', 'panel']
  })

  const items = await storage.sync.list()
  console.log(`[TestPanel] Sync: ${items.length} items`)
  items.forEach(item => {
    console.log(`  [${item.id}] updatedAt=${new Date(item.updatedAt).toISOString()}`)
  })
}

// ============================================================
// 5. UI API 演示
// ============================================================

function demoUIAPI(context) {
  const { ui } = context

  ui.registerToolPage({
    id: 'test-dashboard',
    title: 'Test 面板',
    icon: '🧪',
    renderer: 'dashboard.html'
  })
  console.log('[TestPanel] ToolPage: test-dashboard')

  ui.registerToolPage({
    id: 'api-detail',
    title: 'API 详情',
    icon: '📋',
    renderer: 'api-detail.html',
    hidden: true
  })
  console.log('[TestPanel] ToolPage: api-detail')

  SIDE_TABS.forEach(tab => {
    ui.registerSidePanelTab({ ...tab, renderer: tab.id === 'dialog-test' ? 'dialog-test.html' : (tab.id === 'api-manager' ? 'api-list.html' : 'left.html') })
    console.log(`[TestPanel] SidePanel: ${tab.id}`)
  })

  RIGHT_TABS.forEach(tab => {
    ui.registerRightPanelTab({ ...tab, renderer: 'right.html' })
    console.log(`[TestPanel] RightPanel: ${tab.id}`)
  })
}

// ============================================================
// 6. Dialog API 演示
// ============================================================

function demoDialogAPI(context) {
  // 3秒后自动弹出测试弹窗
  const timer = setTimeout(() => {
    context.dialog.show({
      title: 'Test-Panel Dialog',
      width: 500,
      height: 340,
      renderer: 'dialog-demo.html',
      data: {
        source: 'test-panel-activate',
        message: '插件激活时自动弹出的测试弹窗'
      }
    })
  }, 3000)
  disposables.push(() => clearTimeout(timer))
}

// ============================================================
// 7. Connection API 演示（自定义连接类型）
// ============================================================

function demoConnectionAPI(context) {
  const { connection } = context

  const typeOk = connection.registerType({
    type: 'testpanel',
    displayName: 'TestPanel',
    defaultPort: 9999,
    defaultUsername: 'tester',
    supportedAuthTypes: ['password'],
    supportsTerminal: true,
    supportsPortForward: false,
    supportsProxy: false,
    needsHost: true,
    needsPort: true,
    needsUsername: true,
    needsPassword: true,
    extraFields: [
      { name: 'echoMode', type: 'boolean', label: 'Echo 模式', defaultValue: true }
    ],
    badgeBackground: 'rgba(245, 169, 127, 0.15)',
    badgeColor: '#f5a97f',
    iconFilter: 'hue-rotate(20deg) saturate(1.5) brightness(1.1)',
    rightPanelTabs: ['commands']
  })

  if (!typeOk) {
    console.error('[TestPanel] Connection: failed to register type "testpanel"')
    return
  }
  console.log('[TestPanel] Connection: registered type "testpanel"')

  const handlerOk = connection.registerHandler('testpanel', {
    connect: async (sessionId, config) => {
      console.log(`[TestPanel] Connecting session: ${sessionId}`, config)

      // 模拟心跳：每 8 秒输出一次测试信息
      const intervalId = setInterval(() => {
        const msg = `[TestPanel] heartbeat @ ${new Date().toLocaleTimeString()}\r\n`
        context.terminal.emitData(sessionId, Buffer.from(msg))
      }, 8000)

      const connState = {
        sessionId,
        config,
        intervalId,
        close: async () => {
          clearInterval(intervalId)
          console.log(`[TestPanel] Session ${sessionId} closed`)
        }
      }
      connections.set(sessionId, connState)

      // 发送欢迎消息
      context.terminal.emitData(sessionId, Buffer.from(
        `\r\n[TestPanel Connection] Welcome!\r\n` +
        `  Host: ${config.host || 'N/A'}\r\n` +
        `  Echo mode: ${config.echoMode ? 'ON' : 'OFF'}\r\n` +
        `  Type something and press Enter...\r\n\r\n`
      ))

      return Promise.resolve()
    },

    disconnect: (sessionId) => {
      console.log(`[TestPanel] Disconnecting session: ${sessionId}`)
      const conn = connections.get(sessionId)
      if (conn) {
        conn.close().catch(() => {})
        connections.delete(sessionId)
      }
    },

    write: (sessionId, data) => {
      const conn = connections.get(sessionId)
      if (!conn) return

      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8')
      console.log(`[TestPanel] Received input (${text.length} chars) from ${sessionId}`)

      if (conn.config.echoMode !== false) {
        const echo = `[echo] ${text}`
        context.terminal.emitData(sessionId, Buffer.from(echo))
      }
    },

    resize: (sessionId, cols, rows) => {
      console.log(`[TestPanel] Resize session ${sessionId} to ${cols}x${rows}`)
    }
  })

  if (!handlerOk) {
    console.error('[TestPanel] Connection: failed to register handler for "testpanel"')
    connection.unregisterType('testpanel')
    return
  }
  console.log('[TestPanel] Connection: registered handler for "testpanel"')
}

// ============================================================
// 8. Terminal API 演示
// ============================================================

function demoTerminalAPI(context) {
  const { terminal } = context

  // Terminal API 通常结合 Connection handler 使用（见上方 demoConnectionAPI）
  // 以下代码仅为 API 用法注释说明，不在 activate 顶层直接监听固定 sessionId

  // const unsubData = terminal.onData('some-session-id', (data) => {
  //   console.log('[TestPanel] Terminal data:', data.length, 'bytes')
  // })
  // disposables.push(unsubData)

  // const unsubInput = terminal.onInput('some-session-id', (data) => {
  //   console.log('[TestPanel] Terminal input:', data)
  // })
  // disposables.push(unsubInput)

  console.log('[TestPanel] Terminal: API ready (used inside Connection handler)')
}

// ============================================================
// 模块导出
// ============================================================

module.exports = { activate, deactivate }

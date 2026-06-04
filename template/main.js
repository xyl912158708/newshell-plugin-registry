/**
 * NewShell Template Plugin
 * 官方模板，演示所有 PluginContext API 的标准用法。
 *
 * 生命周期：
 *   activate(context)   -> 插件被启用时调用（注册类型、启动服务、订阅事件）
 *   deactivate()        -> 插件被禁用时调用（清理资源、断开连接、注销类型）
 */

const { join } = require('path')

// ============================================================
// 状态管理（建议集中管理，便于 deactivate 时清理）
// ============================================================

/** 活跃连接会话表：sessionId -> connectionState */
const connections = new Map()

/** 存储所有需要注销的句柄/订阅（防止内存泄漏） */
const disposables = []

/** 插件上下文引用（仅用于非 activate 场景下的日志等辅助功能） */
let pluginCtx = null

// ============================================================
// 1. activate - 插件入口
// ============================================================

async function activate(context) {
  pluginCtx = context
  console.log(`[Template Plugin] Activating v${context.manifest.version}...`)
  console.log(`[Template Plugin] Plugin path: ${context.pluginPath}`)

  // ----------------------------------------------------------
  // 1.1 Storage API 演示（持久化键值存储）
  // ----------------------------------------------------------
  await demoStorageAPI(context)

  // 1.1.5 Sync Storage API 演示（参与 S3 多端同步的结构化数据）
  await demoSyncAPI(context)

  // ----------------------------------------------------------
  // 1.2 UI API 演示（注册工具页）
  // ----------------------------------------------------------
  demoUIAPI(context)

  // ----------------------------------------------------------
  // 1.3 Dialog API 演示（居中弹窗，自定义宽高和内容）
  // ----------------------------------------------------------
  demoDialogAPI(context)

  // ----------------------------------------------------------
  // 1.4 Connection API 演示（注册自定义连接类型 + 处理器）
  // ----------------------------------------------------------
  demoConnectionAPI(context)

  // ----------------------------------------------------------
  // 1.5 Terminal API 演示（监听终端输入/输出、向终端写入）
  // ----------------------------------------------------------
  demoTerminalAPI(context)

  console.log('[Template Plugin] Activated successfully')
}

// ============================================================
// 2. deactivate - 插件清理出口
// ============================================================

async function deactivate() {
  console.log('[Template Plugin] Deactivating...')

  // 2.1 断开所有活跃会话
  for (const [sessionId, conn] of connections) {
    console.log(`[Template Plugin] Closing session: ${sessionId}`)
    try {
      if (typeof conn.close === 'function') {
        await conn.close()
      }
    } catch (e) {
      console.error(`[Template Plugin] Error closing session ${sessionId}:`, e)
    }
  }
  connections.clear()

  // 2.2 清理所有订阅/句柄
  for (const dispose of disposables) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch (e) {
      console.error('[Template Plugin] Error disposing resource:', e)
    }
  }
  disposables.length = 0

  pluginCtx = null
  console.log('[Template Plugin] Deactivated')
}

// ============================================================
// 3. Storage API 演示
// ============================================================

async function demoStorageAPI(context) {
  const { storage } = context

  // 写入数据
  await storage.set('activateCount', (await storage.get('activateCount') || 0) + 1)
  await storage.set('lastActivateAt', Date.now())

  // 读取数据
  const count = await storage.get('activateCount')
  const lastAt = await storage.get('lastActivateAt')
  console.log(`[Template Plugin] Storage: activateCount=${count}, lastActivateAt=${lastAt}`)

  // 示例：移除不再需要的键
  // await storage.remove('tempKey')
}

// ============================================================
// 3.5 Sync Storage API 演示（S3 同步数据）
// ============================================================

async function demoSyncAPI(context) {
  const { storage } = context

  // 同步数据的每一项都有 id + updatedAt，支持多端合并
  await storage.sync.save('note-1', {
    title: '欢迎使用模板插件',
    content: '这是第一条同步笔记',
    tags: ['demo', 'sync']
  })

  await storage.sync.save('note-2', {
    title: 'S3 同步说明',
    content: '此数据将在多端之间自动同步',
    tags: ['s3', 'sync']
  })

  const items = await storage.sync.list()
  console.log(`[Template Plugin] Sync: ${items.length} items`)
  items.forEach(item => {
    console.log(`  [${item.id}] updatedAt=${new Date(item.updatedAt).toISOString()}`)
  })

  // 删除示例
  // await storage.sync.remove('note-2')
}

// ============================================================
// 4. UI API 演示（工具页 + 左右面板标签）
// ============================================================

function demoUIAPI(context) {
  const { ui, manifest } = context

  // 4.1 注册工具页（有 renderer 时占据终端主区域，无 renderer 时仅显示 toast）
  ui.registerToolPage({
    id: 'dashboard',
    title: 'Template Dashboard',
    icon: '📋',
    renderer: 'dashboard.html'
  })

  // 4.1.2 注册第二个工具页（仅通过侧边栏 postMessage 打开，不在工具菜单显示）
  ui.registerToolPage({
    id: 'detail',
    title: '数据详情',
    icon: '📄',
    renderer: 'detail.html',
    hidden: true
  })

  // 4.1.3 以编程方式打开工具页（openToolPage）
  // 可在任意时机调用，支持传递自定义数据 params
  // ui.openToolPage('detail', { key: 'value', nested: { a: 1 } })

  // 4.2 注册左侧面板标签页（SidePanel）
  // 标签将出现在左侧面板的 Tab 切换器中，与"连接"、"项目"并列
  // renderer 指向插件目录下的 HTML 文件，选中标签后以 iframe 加载
  ui.registerSidePanelTab({
    id: 'template-left',
    title: '模板左侧',
    icon: '📌',
    renderer: 'left-panel.html'
  })

  // 4.2.2 注册演示侧边栏→主面板通信的左侧标签
  // 选中后展示 API 列表，点击项通过 postMessage 打开主面板工具页并传递数据
  ui.registerSidePanelTab({
    id: 'template-api-list',
    title: '数据列表',
    icon: '📡',
    renderer: 'api-list.html'
  })

  // 4.3 注册右侧面板标签页（RightPanel）
  // 标签将出现在右侧面板的 Tab 切换器中，与"文件"、"命令"等并列
  // 所有连接类型下均可见（不受连接类型 rightPanelTabs 配置影响）
  ui.registerRightPanelTab({
    id: 'template-right',
    title: '模板右侧',
    icon: '📊',
    renderer: 'right-panel.html'
  })

  // 记录以便后续可选的手动注销演示（deactivate 时 PluginManager 会自动清理）
  console.log(`[Template Plugin] UI: registered 2 tool pages + 2 side panel tabs + 1 right panel tab for "${manifest.id}"`)
}

// ============================================================
// 4.5 Dialog API 演示（弹窗）
// ============================================================

function demoDialogAPI(context) {
  const { dialog } = context

  // 演示：5 秒后自动弹出示例弹窗（生产环境中应在用户操作触发）
  setTimeout(() => {
    dialog.show({
      title: '插件弹窗示例',
      width: 500,
      height: 360,
      renderer: 'dialog-demo.html',
      data: {
        pluginName: 'Template Plugin',
        message: '这是从插件 main.js 传入的数据',
        items: ['项 A', '项 B', '项 C']
      }
    })
    console.log('[Template Plugin] Dialog: shown')
  }, 5000)
}

// ============================================================
// 5. Connection API 演示（自定义连接类型）
// ============================================================

function demoConnectionAPI(context) {
  const { connection } = context

  // 5.1 注册连接类型定义（决定连接表单渲染哪些字段）
  const typeOk = connection.registerType({
    type: 'template',               // 连接类型标识（全局唯一，不可与内置类型冲突）
    displayName: 'Template',        // 界面显示名称
    defaultPort: 9000,              // 默认端口
    defaultUsername: 'admin',       // 默认用户名
    supportedAuthTypes: ['password', 'privateKey'],
    supportsTerminal: true,         // 是否支持终端交互
    supportsPortForward: false,     // 是否支持端口转发
    supportsProxy: false,           // 是否支持代理配置
    needsHost: true,                // 是否需要主机输入框（默认 true）
    needsPort: true,                // 是否需要端口输入框（默认 true）
    needsUsername: true,            // 是否需要用户名输入框（默认 true）
    needsPassword: true,            // 是否需要密码输入框（默认 true）
    extraFields: [                  // 额外自定义字段
      {
        name: 'enableLog',
        type: 'boolean',
        label: 'Enable Debug Log',
        defaultValue: false
      },
      {
        name: 'customTimeout',
        type: 'number',
        label: 'Timeout (ms)',
        defaultValue: 30000
      }
    ],
    badgeBackground: 'rgba(99, 102, 241, 0.15)',
    badgeColor: '#6366f1',
    iconFilter: 'hue-rotate(230deg) saturate(1.5) brightness(1.1)',
    rightPanelTabs: ['commands', 'ai']  // 右侧面板显示的标签页
  })

  if (!typeOk) {
    console.error('[Template Plugin] Connection: failed to register type "template"')
    return
  }
  console.log('[Template Plugin] Connection: registered type "template"')

  // 5.2 注册连接处理器（实际建立/断开/读写连接）
  const handlerOk = connection.registerHandler('template', {
    connect: async (sessionId, config) => {
      console.log(`[Template Plugin] Connecting session: ${sessionId}`, config)

      // 在此处实现真实协议握手（TCP/WebSocket/串口/子进程等）
      // 模板示例：模拟一个定时输出心跳的伪连接
      const intervalId = setInterval(() => {
        const heartbeat = `[Template] heartbeat @ ${new Date().toLocaleTimeString()}\r\n`
        context.terminal.emitData(sessionId, Buffer.from(heartbeat))
      }, 5000)

      const connState = {
        sessionId,
        config,
        intervalId,
        close: async () => {
          clearInterval(intervalId)
          console.log(`[Template Plugin] Session ${sessionId} closed`)
        }
      }

      connections.set(sessionId, connState)

      // 若连接是异步建立的，应在 Promise 中 resolve/reject
      // 本示例为同步建立，直接 resolve
      return Promise.resolve()
    },

    disconnect: (sessionId) => {
      console.log(`[Template Plugin] Disconnecting session: ${sessionId}`)
      const conn = connections.get(sessionId)
      if (conn) {
        conn.close().catch(() => {})
        connections.delete(sessionId)
      }
    },

    write: (sessionId, data) => {
      // 当用户在终端输入时，数据会路由到这里
      // 示例：将输入回显到终端（echo）
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8')
      console.log(`[Template Plugin] Received input (${text.length} chars) from ${sessionId}`)

      // 实际场景中应将数据转发到真实连接（如 socket.write(data)）
      // 此处演示：回显用户输入并附带提示
      const echo = `[echo] ${text}`
      context.terminal.emitData(sessionId, Buffer.from(echo))
    },

    resize: (sessionId, cols, rows) => {
      console.log(`[Template Plugin] Resize session ${sessionId} to ${cols}x${rows}`)
      // 若底层协议支持终端尺寸变更，在此处转发
    }
  })

  if (!handlerOk) {
    console.error('[Template Plugin] Connection: failed to register handler for "template"')
    connection.unregisterType('template')
    return
  }
  console.log('[Template Plugin] Connection: registered handler for "template"')
}

// ============================================================
// 6. Terminal API 演示（双向数据交互）
// ============================================================

function demoTerminalAPI(context) {
  const { terminal } = context

  // 示例：监听某个固定 session 的数据输出（实际应通过 connection handler 内部使用）
  // 注意：onData / onInput 返回的是一个取消订阅函数，需要保存以便 deactivate 时调用
  // 以下代码仅为 API 用法演示，通常不在 activate 顶层直接监听固定 sessionId

  // const unsubData = terminal.onData('some-session-id', (data) => {
  //   console.log('[Template Plugin] Terminal data:', data.length, 'bytes')
  // })
  // disposables.push(unsubData)

  // const unsubInput = terminal.onInput('some-session-id', (data) => {
  //   console.log('[Template Plugin] Terminal input:', data)
  // })
  // disposables.push(unsubInput)

  // terminal.write(sessionId, 'Hello from plugin\r\n')   // 向终端写入（不经过 renderer）
  // terminal.emitData(sessionId, Buffer.from('data'))    // 向终端 + 渲染进程广播数据

  console.log('[Template Plugin] Terminal: API ready (see code comments for usage)')
}

// ============================================================
// 模块导出（必须包含 activate，可选 deactivate）
// ============================================================

module.exports = { activate, deactivate }

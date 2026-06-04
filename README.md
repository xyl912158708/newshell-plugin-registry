# NewShell 插件开发文档

本文档面向开发者，介绍如何为 NewShell 终端应用编写、打包和安装插件。

---

## 1. 插件系统概述

NewShell 采用基于 Node.js `vm` 模块的沙箱化插件架构，插件以 ZIP 包形式分发，安装后解压至用户数据目录的 `plugins/<plugin-id>/` 下，支持热加载（无需重启应用即可启用）。

核心设计原则：
- **自包含**：所有运行依赖（二进制、配置文件）必须随插件一同打包。
- **最小权限**：插件默认运行在受限沙箱中，敏感模块（如 `child_process`）需在 `manifest.json` 中声明权限，并经用户手动授权后方可使用。
- **双向交互**：插件可通过标准 API 与主进程、渲染进程及终端会话进行双向数据交换。

---

## 2. 插件目录结构

一个合法的插件目录名必须与 `manifest.json` 中的 `id` 完全一致。

```
template/                 <- 目录名 = manifest.id
├── manifest.json         <- 插件元数据（必需）
├── main.js               <- 主进程入口（必需）
├── left-panel.html       <- 左侧面板渲染页（可选）
├── right-panel.html      <- 右侧面板渲染页（可选）
├── api-list.html         <- 侧边栏→主面板通信演示（可选）
├── detail.html           <- 工具页接收 params 演示（可选）
├── README.md             <- 插件说明（可选，建议提供）
└── assets/               <- 静态资源目录（可选）
    └── icon.png
```

---

## 3. manifest.json

`manifest.json` 是插件的唯一标识和配置入口，必须包含以下字段：

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 插件唯一标识，只能包含小写字母、数字、连字符、下划线。必须与插件目录名一致。 |
| `name` | `string` | 是 | 人类可读的插件名称。 |
| `version` | `string` | 是 | 语义化版本号，如 `1.0.0`。 |
| `description` | `string` | 是 | 插件功能简介。 |
| `author` | `string` | 是 | 作者信息。 |
| `main` | `string` | 是 | 主进程入口文件路径，相对于插件根目录，如 `main.js`。 |
| `renderer` | `string` | 否 | 渲染进程脚本路径（预留字段，当前版本尚未启用）。 |
| `contributions` | `object` | 否 | UI 贡献点声明，支持 `toolPages`、`sidePanelTabs`、`rightPanelTabs`。 |
| `permissions` | `string[]` | 否 | 需要用户授权的敏感模块列表，如 `["child_process"]`。 |

### contributions.toolPages

声明插件向左侧工具栏贡献的页面入口：

```json
{
  "contributions": {
    "toolPages": [
      {
        "id": "dashboard",
        "title": "Dashboard",
        "icon": "📊",
        "renderer": "dashboard.html"
      }
    ]
  }
}
```

- `id`：在插件内部唯一。
- `title`：渲染进程中显示的标题。
- `icon`：图标字符串（可为 Emoji 或 CSS class）。
- `renderer`（可选）：渲染此页面的 HTML 文件路径，相对于插件根目录。**设置后，点击该工具页面时将占据终端主区域**，以 iframe 加载页面。不设置则仅显示 toast 提示。
- `hidden`（可选）：设为 `true` 时，该工具页不会出现在顶部「工具」菜单中，仅可通过 `openToolPage()` API 或侧边栏 postMessage 打开。适用于仅作为详情页、不独立入口的页面。

运行时，页面 ID 会自动拼接为全局限定名：`{pluginId}::{pageId}`（如 `template::dashboard`）。

### contributions.sidePanelTabs

声明插件向**左侧面板**贡献的标签页，与内置的"连接"、"项目"标签并列。

```json
{
  "contributions": {
    "sidePanelTabs": [
      {
        "id": "my-left-tab",
        "title": "我的面板",
        "icon": "📌",
        "renderer": "left-panel.html"
      }
    ]
  }
}
```

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 标签唯一标识，在插件内部唯一。 |
| `title` | `string` | 是 | 标签标题。 |
| `icon` | `string` | 否 | 图标（Emoji 或 Unicode 字符）。 |
| `renderer` | `string` | 否 | 面板内容的 HTML 文件路径，相对于插件根目录。不提供则显示占位内容。 |

### contributions.rightPanelTabs

声明插件向**右侧面板**贡献的标签页，与内置的"文件"、"命令"、"信息"、"AI"标签并列。所有连接类型下均可见。

```json
{
  "contributions": {
    "rightPanelTabs": [
      {
        "id": "my-right-tab",
        "title": "分析面板",
        "icon": "📊",
        "renderer": "right-panel.html"
      }
    ]
  }
}
```

字段含义与 `sidePanelTabs` 完全相同。

> **关于 renderer 文件**：面板标签被选中后，内容通过 iframe 以 `file://` 协议加载指定的 HTML 文件。该 HTML 是独立的 Web 页面，可以使用任意前端技术。推荐使用 CSS 变量适配主题（如 `var(--bg-primary)`、`var(--text-primary)`、`var(--accent-color)` 等）。

---

## 4. main.js 入口规范

`main.js` 必须在沙箱上下文中导出至少一个 `activate` 函数，可选导出 `deactivate`。

```js
module.exports = { activate, deactivate }
```

### 4.1 activate(context)

插件被**启用**时调用，接收一个 `PluginContext` 对象，包含以下属性：

| 属性 | 类型 | 说明 |
|------|------|------|
| `manifest` | `PluginManifest` | 当前插件的 manifest 对象。 |
| `pluginPath` | `string` | 插件在磁盘上的绝对路径，可用于加载本地资源。 |
| `storage` | `PluginStorageAPI` | 持久化键值存储。 |
| `ui` | `PluginUIAPI` | UI 贡献点注册接口。 |
| `connection` | `PluginConnectionAPI` | 自定义连接类型注册接口。 |
| `terminal` | `PluginTerminalAPI` | 终端双向交互接口。 |
| `dialog` | `PluginDialogAPI` | 居中弹窗显示接口。 |

### 4.2 deactivate()

插件被**禁用**或**卸载**时调用。必须在此处完成：
- 断开所有活跃连接；
- 取消所有事件订阅；
- 释放文件句柄、定时器、子进程等资源。

> 注意：即使插件未实现 `deactivate`，PluginManager 也会自动注销该插件注册的连接类型、连接处理器和 UI 贡献点。但**自定义资源（如定时器、socket、子进程）必须由插件自身清理**，否则会造成内存泄漏或孤儿进程。

---

## 5. 沙箱规则与权限

插件运行于 Node.js `vm` 隔离上下文中，具备以下全局对象：

```
console, require, module, exports, __dirname, __filename,
Buffer, process（只读子集）, Promise,
setTimeout, clearTimeout, setInterval, clearInterval, global
```

### 5.1 模块白名单

默认允许引入的内置模块：

```
path, util, crypto, buffer, stream, events, string_decoder,
url, querystring, punycode, dgram, timers, os
```

以下模块**禁止引入**（即使声明权限也不行）：

```
fs, worker_threads, cluster, vm, module
```

如需读写文件，请使用 `context.storage` API；如需访问插件自身目录下的文件，可通过相对路径 `require('./local-module')` 引入。

### 5.2 权限声明

若插件需要 `child_process` 等敏感能力，必须在 `manifest.json` 中显式声明：

```json
{ "permissions": ["child_process"] }
```

首次启用该插件时，系统会弹出权限确认对话框，用户同意后方可使用。授权状态会持久化保存，后续启动自动生效。

---

## 6. API 详解

### 6.1 Storage API

基于 JSON 文件的持久化存储，每个插件拥有独立的存储空间，互不影响。

```js
const { storage } = context

// 写入
await storage.set('key', { foo: 'bar' })

// 读取
const value = await storage.get('key')   // 若不存在返回 undefined

// 删除
await storage.remove('key')
```

- 支持存储任意可 JSON 序列化的数据。
- 存储文件位于应用用户数据目录的 `plugin-storage/{pluginId}.json`。

#### Storage Sync API

`storage.sync` 提供参与 S3 多端同步的结构化数据存储。每条数据必须包含 `id` 和 `updatedAt` 字段，系统会自动处理冲突合并。

```js
const { storage } = context

// 保存/更新同步数据项（自动设置 updatedAt）
await storage.sync.save('note-1', {
  title: '同步笔记',
  content: '这是多端同步的内容',
  tags: ['demo', 'sync']
})

// 获取所有同步数据项
const items = await storage.sync.list()
// items: [{ id: 'note-1', updatedAt: 1717000000000, data: { ... } }]

// 删除同步数据项
await storage.sync.remove('note-1')
```

> 同步数据存储在插件目录的 `sync.json` 中，由应用统一管理上传/下载。

### 6.2 UI API

提供 UI 贡献点的运行时注册接口。

```js
const { ui } = context

// 注册工具页（有 renderer 时占据终端主区域，无 renderer 时仅显示 toast）
// hidden: true 时不在顶部「工具」菜单中显示，仅通过 API/postMessage 打开
ui.registerToolPage({
  id: 'pageId',
  title: 'Page Title',
  icon: '📋',
  renderer: 'page.html',
  hidden: true              // 可选，隐藏菜单入口，仅通过 API/postMessage 打开
})

// 注销工具页（参数可为简单 ID，也可为全限定 ID）
ui.unregisterToolPage('pageId')
// 或 ui.unregisterToolPage('template::pageId')

// 以编程方式打开工具页（在主面板创建标签），支持传递自定义数据
// params 可以是任意可序列化的对象（嵌套对象、数组等均支持）
ui.openToolPage('pageId', {
  key: 'value',
  nested: { foo: 'bar' },
  items: [1, 2, 3]
})
// 也可传全限定 ID：ui.openToolPage('pluginId::pageId', params)

// 注册左侧面板标签页
ui.registerSidePanelTab({
  id: 'my-left-tab',
  title: '我的面板',
  icon: '📌',
  renderer: 'left-panel.html'   // 相对于插件根目录的 HTML 文件路径
})

// 注销左侧面板标签
ui.unregisterSidePanelTab('my-left-tab')

// 注册右侧面板标签页
ui.registerRightPanelTab({
  id: 'my-right-tab',
  title: '分析面板',
  icon: '📊',
  renderer: 'right-panel.html'
})

// 注销右侧面板标签
ui.unregisterRightPanelTab('my-right-tab')
```

> 注意：`registerSidePanelTab` / `registerRightPanelTab` 也可在 `activate` 中**动态调用**，不依赖 manifest 声明。但建议同时在 `manifest.json` 的 `contributions` 中声明，以便 UI 在插件尚未启用时即可预览其提供的标签。

### 6.2.1 面板 Renderer HTML 编写指南

面板标签被选中后，内容通过 iframe 加载指定的 HTML 文件。HTML 是完全独立的 Web 页面，推荐遵循以下规范：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    /* 使用 CSS 变量适配应用主题 */
    background: var(--bg-primary, #1e1e2e);
    color: var(--text-primary, #cdd6f4);
    padding: 16px;
    overflow-y: auto;
  }
  .card {
    background: var(--bg-secondary, #313244);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 8px;
  }
</style>
</head>
<body>
  <!-- 你的面板内容 -->
</body>
</html>
```

**可用 CSS 变量**（部分）：

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `--bg-primary` | 主背景色 | `#1e1e2e` |
| `--bg-secondary` | 次背景色 | `#313244` |
| `--bg-tertiary` | 三级背景色 | `#45475a` |
| `--text-primary` | 主文字色 | `#cdd6f4` |
| `--text-secondary` | 次文字色 | `#a6adc8` |
| `--text-muted` | 弱化文字色 | `#6c7086` |
| `--accent-color` | 强调色 | `#89b4fa` |
| `--border-color` | 边框色 | `#585b70` |

> 这些变量在宿主应用中使用 Catppuccin Mocha 主题，在 iframe 中同样可用。可提供 fallback 值以兼容独立预览场景。

### 6.2.2 跨面板 postMessage 通信

插件侧边栏/右侧面板的 iframe 可通过 `postMessage` 与主面板进行双向通信，实现**侧边栏点击 → 主面板打开工具页 → 传递数据**的完整链路。

#### 通信架构

```
┌─────────────────┐    postMessage('newshell:open-tool-page')     ┌──────────────┐
│  侧边栏 iframe   │ ──────────────────────────────────────────→  │  MainLayout   │
│  (api-list.html) │                                              │  (Vue组件)    │
└─────────────────┘                                              └──────┬───────┘
                                                                       │
                                                   创建 PluginMainPage │
                                                                       │
                                                               ┌──────▼───────┐
                                          postMessage('newshell:params') │  工具页 iframe │
                                                               └──────────────┘
                                                                  (detail.html)
```

#### 方式一：侧边栏 → 主面板打开工具页（带数据）

侧边栏或右侧面板的 iframe 通过 `parent.postMessage` 通知主面板打开工具页：

```js
// 在侧边栏 iframe（如 api-list.html）中
parent.postMessage({
  type: 'newshell:open-tool-page',   // 固定消息类型
  pageId: 'my-plugin::detail',       // 目标工具页全限定 ID（pluginId::pageId）
  data: {                            // 传递给工具页的任意数据
    method: 'GET',
    path: '/api/users',
    name: '查询用户列表',
    description: '获取所有用户信息',
    params: [
      { name: 'page', type: 'number', required: false, desc: '页码' }
    ],
    response: { code: 200, data: [...] }
  }
}, '*')
```

主面板收到消息后，自动创建/激活对应的工具页标签，并将 `data` 作为 `params` 传递给目标 iframe。

#### 方式二：插件 main.js 编程方式打开

在 `main.js` 中通过 `ui.openToolPage()` 在任意时机以代码方式打开工具页：

```js
// 在 activate() 中，或在某个事件回调中调用
context.ui.openToolPage('detail', {
  method: 'POST',
  path: '/api/users',
  name: '创建新用户',
  requestBody: { name: 'string', email: 'string' }
})
```

#### 方式三：工具页 iframe 接收数据

无论哪种方式打开，工具页的 iframe 都会通过 `postMessage` 收到数据：

```js
// 在工具页 iframe（如 detail.html）中
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'newshell:params') return

  const params = event.data.params  // Record<string, unknown>
  console.log('Received:', params.method, params.path)
  // 根据 params 渲染页面内容
  renderDetail(params)
})
```

> **注意**：
> - `params` 类型为 `Record<string, unknown>`，支持嵌套对象、数组等任意可序列化数据
> - 数据通过 postMessage 的结构化克隆算法传递，**不经过 URL**，无长度限制
> - 若同一工具页标签被重复点击，主面板会通过 `watch` 机制自动重新发送最新的 params
> - 工具页 iframe 默认 `scrolling="no"`，内容高度变化时需向父窗口发送 `newshell:resize` 消息（见模板 `detail.html` 示例）

### 6.2.3 Dialog API — 居中弹窗

插件可通过 `context.dialog` 显示居中弹窗，支持**自定义宽高**和**任意 iframe 内容**。适用于表单输入、确认操作、详情展示等场景。

```js
const { dialog } = context

// 显示弹窗
dialog.show({
  title: '用户确认',        // 弹窗标题
  width: 500,               // 宽度（px），默认 600
  height: 400,              // 高度（px），默认 400
  renderer: 'dialog.html',  // 弹窗内容的 HTML 文件（相对于插件根目录）
  data: {                   // 传递给弹窗 iframe 的初始数据
    userName: 'Alice',
    action: 'delete-file'
  }
})

// 关闭弹窗（插件主动关闭）
dialog.close()
```

#### 弹窗 iframe 与主进程通信

弹窗内容通过 iframe 加载，支持 postMessage 双向通信：

**接收初始数据**（主面板 → iframe）：

```js
// 在弹窗 HTML（dialog.html）中
window.addEventListener('message', (event) => {
  if (event.data?.type === 'newshell:dialog-params') {
    const { userName, action } = event.data.data
    // 渲染弹窗内容
  }
})
```

**关闭弹窗**（iframe → 主面板）：

```js
// 直接关闭
parent.postMessage({ type: 'newshell:dialog-close' }, '*')

// 关闭并返回结果
parent.postMessage({
  type: 'newshell:dialog-close',
  result: { confirmed: true, data: { ... } }
}, '*')
```

> **注意**：
> - 弹窗始终居中显示，通过 `position: fixed` 实现
> - 一个插件同时只能有一个弹窗，新弹窗会覆盖旧弹窗
> - 点击遮罩层可关闭弹窗
> - `data` 支持任意可序列化对象（嵌套对象、数组等）
> - 弹窗 iframe 的 sandbox 为 `allow-scripts allow-same-origin`

### 6.3 Connection API

允许插件注册全新的连接类型，与内置的 SSH、Telnet、RDP 等并列。

#### 6.3.1 registerType(def)

注册连接类型的元数据，决定连接配置表单渲染哪些字段。

```js
const ok = context.connection.registerType({
  type: 'myprotocol',               // 类型标识（全局唯一，不可覆盖内置类型）
  displayName: 'My Protocol',
  defaultPort: 8080,
  defaultUsername: 'root',
  supportedAuthTypes: ['password', 'privateKey'],
  supportsTerminal: true,
  supportsPortForward: false,
  supportsProxy: false,
  needsHost: true,
  needsPort: true,
  needsUsername: true,
  needsPassword: true,
  extraFields: [
    { name: 'optionA', type: 'boolean', label: 'Option A', defaultValue: false },
    { name: 'timeout', type: 'number', label: 'Timeout', defaultValue: 30000 }
  ],
  badgeBackground: 'rgba(99, 102, 241, 0.15)',
  badgeColor: '#6366f1',
  iconFilter: 'hue-rotate(230deg) saturate(1.5)',
  rightPanelTabs: ['commands', 'ai']
})
```

字段说明：
- `needsHost/needsPort/needsUsername/needsPassword`：控制连接表单是否显示对应输入框。
- `extraFields`：自定义额外配置项，支持 `boolean` / `string` / `number` 三种类型。
- `rightPanelTabs`：右侧面板标签配置。未定义则显示所有默认标签；空数组 `[]` 则不显示右侧面板。

返回 `boolean`：`true` 表示注册成功，`false` 表示失败（通常是 ID 与内置类型冲突）。

#### 6.3.2 registerHandler(type, handler)

为指定连接类型注册实际处理器，处理连接的建立、断开、数据收发和终端尺寸变更。

```js
context.connection.registerHandler('myprotocol', {
  connect: async (sessionId, config) => {
    // config 包含用户填写的所有连接字段（host, port, username, password, 以及 extraFields）
    // 在此处建立真实连接（TCP/WebSocket/串口/子进程等）
    // 建立成功后 resolve；失败则 reject(Error)
  },

  disconnect: (sessionId) => {
    // 用户点击断开或关闭标签页时调用
    // 执行优雅关闭，清理资源
  },

  write: (sessionId, data) => {
    // 用户在终端输入的数据会路由到这里
    // data 类型为 string 或 Uint8Array
    // 将数据转发到底层连接
  },

  resize: (sessionId, cols, rows) => {
    // 终端尺寸变更时调用（若底层协议支持）
  }
})
```

#### 6.3.3 unregisterType / unregisterHandler

插件被禁用时，PluginManager 会自动调用，通常无需手动处理。但在 `activate` 中若注册失败需要回滚时，可以手动调用：

```js
context.connection.unregisterType('myprotocol')
context.connection.unregisterHandler('myprotocol')
```

### 6.4 Terminal API

提供终端级别的双向数据交互能力。

```js
const { terminal } = context

// 监听终端输出（来自底层连接的数据，已转换为 Uint8Array）
const unsubscribeData = terminal.onData(sessionId, (data) => {
  // data: Uint8Array
})

// 监听终端输入（来自用户键盘输入的字符串）
const unsubscribeInput = terminal.onInput(sessionId, (data) => {
  // data: string
})

// 向终端主进程写入数据（不经过渲染进程）
terminal.write(sessionId, 'hello\r\n')
terminal.write(sessionId, Buffer.from([0x1b, 0x63]))  // 也支持 Uint8Array/Buffer

// 向终端广播数据，同时发送给渲染进程显示
terminal.emitData(sessionId, new Uint8Array([...]))
```

> **注意**：`onData` 和 `onInput` 返回的是取消订阅函数，必须在 `deactivate` 中调用，否则会造成内存泄漏。

---

## 7. 生命周期与资源清理

正确管理资源是插件稳定运行的关键。推荐模式：

```js
const connections = new Map()   // 活跃会话
const disposables = []          // 订阅/句柄清单

function activate(context) {
  // ... 注册连接处理器 ...
  // 若需要在外部监听终端事件：
  // const unsub = context.terminal.onData(sessionId, cb)
  // disposables.push(unsub)
}

async function deactivate() {
  // 1. 关闭所有会话
  for (const [id, conn] of connections) {
    await conn.close().catch(() => {})
  }
  connections.clear()

  // 2. 取消所有订阅
  for (const dispose of disposables) {
    try { dispose() } catch (_) {}
  }
  disposables.length = 0
}

module.exports = { activate, deactivate }
```

---

## 8. 打包与安装

### 8.1 打包为 ZIP

将插件目录打包为标准 ZIP 文件即可：

```powershell
# PowerShell 示例
Compress-Archive -Path ./template/* -DestinationPath ./template.zip
```

ZIP 根目录可以直接是插件文件，也可以嵌套一层目录（如 `template/manifest.json`），安装器会自动识别。

### 8.2 安装方式

1. **手动安装**：将 ZIP 包复制到应用用户数据目录的 `plugins/` 下，重启应用后扫描加载。
2. **通过应用界面安装**：使用 NewShell 内置的插件管理功能上传 ZIP 包，支持热加载，无需重启。

### 8.3 目录位置

- Windows: `%APPDATA%\NewShell\plugins\{pluginId}\`
- macOS: `~/Library/Application Support/NewShell/plugins/{pluginId}/`
- Linux: `~/.config/NewShell/plugins/{pluginId}/`

---

## 9. 最佳实践

1. **自包含原则**：所有二进制依赖必须放在插件目录内，不要依赖系统 PATH。使用 `context.pluginPath` 或 `__dirname` 定位本地资源。
2. **防御性编程**：`activate` 中的任何未捕获异常都会导致插件进入 `error` 状态，建议在关键路径使用 `try/catch`。
3. **优雅关闭**：网络连接或子进程应先尝试优雅关闭（发送退出命令、关闭 socket），超时后再强制清理。
4. **避免覆盖内置类型**：`ssh`、`rdp`、`telnet`、`ftp`、`serial` 为内置类型，插件无法注册同名类型。
5. **日志规范**：使用 `console.log` / `console.error` 输出日志，建议统一前缀（如 `[MyPlugin]`），便于排查问题。
6. **不要泄露 session 数据**：插件可以监听所有终端数据，但应遵守用户隐私，不要将敏感信息输出到外部服务。

---

## 10. 完整示例：模板插件

项目已内置官方模板插件，位于 `plugins/template/`，演示了所有 API 的标准用法，包括：

- **UI API**：工具页注册、侧边栏/右侧面板标签注册
- **Dialog API**：居中弹窗，自定义宽高和 iframe 内容（`dialog-demo.html`）
- **跨面板通信**：侧边栏点击 → postMessage 打开工具页 → 传递数据（`api-list.html` → `detail.html`）
- **编程打开**：`ui.openToolPage()` 以代码方式创建工具页标签
- **Storage API**：持久化键值存储
- **Connection API**：自定义连接类型注册与处理器实现
- **Terminal API**：终端数据双向交互

开发者可将其复制为起点：

```
cp -r plugins/template plugins/my-plugin
```

然后修改 `manifest.json` 中的 `id`、`name`、`version` 等信息，并在 `main.js` 中实现具体业务逻辑。

---

## 附录：类型速查表

```ts
interface PluginContext {
  manifest: PluginManifest
  pluginPath: string
  storage: PluginStorageAPI
  ui: PluginUIAPI
  connection: PluginConnectionAPI
  terminal: PluginTerminalAPI
  /** 弹窗 API */
  dialog: PluginDialogAPI
}

interface PluginDialogOptions {
  title: string
  /** 弹窗宽度（px），默认 600 */
  width?: number
  /** 弹窗高度（px），默认 400 */
  height?: number
  /** 弹窗内容的 HTML 文件路径 */
  renderer: string
  /** 传递给 iframe 的初始数据 */
  data?: Record<string, unknown>
}

interface PluginDialogAPI {
  show(options: PluginDialogOptions): void
  close(): void
}

interface PluginStorageAPI {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  remove(key: string): Promise<void>
}

interface ToolPageContribution {
  id: string
  title: string
  icon?: string
  /** 渲染此页面的 HTML 文件路径 */
  renderer?: string
  /** 设为 true 时不在顶部\"工具\"菜单中显示 */
  hidden?: boolean
}

interface PluginUIAPI {
  registerToolPage(page: ToolPageContribution): void
  unregisterToolPage(pageId: string): void
  /** 以编程方式打开工具页（在主面板创建标签），传递自定义参数 */
  openToolPage(pageId: string, params?: Record<string, unknown>): void
  registerSidePanelTab(tab: PanelTabContribution): void
  unregisterSidePanelTab(tabId: string): void
  registerRightPanelTab(tab: PanelTabContribution): void
  unregisterRightPanelTab(tabId: string): void
}

interface PluginConnectionAPI {
  registerType(def: ConnectionTypeDefinition): boolean
  unregisterType(type: string): void
  registerHandler(type: string, handler: {
    connect(sessionId: string, config: unknown): Promise<void>
    disconnect(sessionId: string): void
    write?(sessionId: string, data: string | Uint8Array): void
    resize?(sessionId: string, cols: number, rows: number): void
  }): boolean
  unregisterHandler(type: string): void
}

interface PluginTerminalAPI {
  onData(sessionId: string, callback: (data: Uint8Array) => void): () => void
  onInput(sessionId: string, callback: (data: string) => void): () => void
  write(sessionId: string, data: string | Uint8Array): void
  emitData(sessionId: string, data: Uint8Array): void
}

interface PluginMainEntry {
  activate(context: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
```

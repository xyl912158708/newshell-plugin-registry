# NewShell 插件统一设计系统 · NS-DS v1

> 2026-11-22 落地。覆盖四个 Element Plus 插件：开发者工具箱、GitLab 管理台、
> Kafka Studio、对象存储。解决：界面不现代、层级不清、导航原始、操作区
> 不专业、空间与细节浪费、四插件样式各自复制漂移。

## 单一事实源

- 样式源文件：`shared/design-system.css`（本系统唯一可手改处）
- 同步脚本：`python3 sync_design_system.py` —— 把源文件注入各插件
  `index.src.html` 的 `NS-DS` 标记段（位于插件自有样式之后，靠层叠覆盖）
- 构建：`python3 build_plugins.py`（照旧）
- 校验口径：四个插件构建产物中的 NS-DS 段应逐字节一致（SHA 相同）

## 四段层级结构（所有插件一致）

1. **页头** `.topbar` 52px：Logo 块 + 标题/副标题 + 当前上下文胶囊
   （`.ns-pill`：当前连接/会话状态/本地运行标识）+ 主题切换
2. **导航** `.side` 240px：与内容区不同明暗的分层表面；分组标题
   11px 大写字距；条目 40px、圆角 10、选中态主色左指示条 + 浅底；
   工具箱分类带数量徽标（`.nav-count`）
3. **内容** `.main`：上下文栏（`.proj-bar` / `.crumbs` / `.toolbar`，
   统一为白色表面卡：边框+圆角 12+轻阴影）→ 分段式页签
   （`.main-tabs` 改为胶囊分段控件，替代 EP 默认下划线页签）→
   工具栏（`.tab-toolbar` 同为表面卡且吸顶）→ 内容（卡片/行列表/
   统计/表格统一圆角 12、悬停轻抬升）
4. **状态栏** `.ns-statusbar` 30px：当前连接 / 项目 / Bucket /
   会话状态等只读上下文，右侧放运行状态

## 令牌与细节

- 间距 4/8/12/16/20/24 六档（`--ns-space-*`）、圆角 8/10/12/14 四档
- 阴影两档 `--ns-shadow-1/2`，明暗分别取值；克制使用，不用渐变与玻璃模糊
- 颜色不新增色板：一律消费 EP 变量（`--el-*`，其值已映射宿主主题令牌），
  混色用 `color-mix` 从主色派生，保证三档主题（明/暗/高对比折算）一致
- 控件：按钮圆角 8 + 字重 550、主按钮轻阴影；输入框聚焦主色环
  （`--ns-ring`）；弹窗圆角 14 + 头尾分隔；滚动条统一 8px；
  `:focus-visible` 焦点环；`prefers-reduced-motion` 降级
- 空间：内容内边距统一 20–24px，页签内容 16/20/24，侧栏条目收紧到
  40px 行高但保留呼吸感；对象存储虚拟列表行高 42px 是 JS 常量，未动

## 本轮未动

- 业务逻辑、接口、存储键、权限、`main.js`：全部零改动，只改渲染结构
  中的页头/页头胶囊/状态栏/导航徽标与样式层
- goshell：其注册表源码目录是已知的陈旧版本（1.1.1 坏包根因），
  本轮不基于陈旧源码做 UI 改造，避免重蹈覆辙；待其源码与已发布
  直连版对齐后，再按本系统套改（它是非 EP 的原生页，届时消费
  `--ui-*` 令牌实现同一套四段结构）
- template / test-panel：前者已是 Plugin UI SDK 组件页，后者是测试夹具

## 版本

- dev-toolbox 1.2.1 → 1.3.0
- gitlab-console 1.2.1 → 1.3.0
- kafka-studio 1.2.2 → 1.3.0
- object-storage 1.3.1 → 1.4.0

## 2026-11-22 第二轮：按宿主插件模块变更统一同步

宿主侧变更（feature/plugin-optimization 至 b1b2f28）：scheme 注册为
privileged（642f3f0，`_sdk/` 脚本在真机恢复加载、插件 origin 恢复为
`newshell-plugin://<id>`）、更新加载失败不再误标 loaded（7c80f27）、
Plugin UI SDK 统一能力审计（0d3a604：图标收口 ui-icon、七表单控件
invalid 错误态、data-table 空/加载复用 ui-empty/ui-loading、
plugin-ui.js 重建；plugin-api.js 仍为 0.2.0 未变）。

各插件处置（逐个核对后执行，无变化不虚升版本）：

- **template 1.0.1 → 1.0.2**：页内图标按新统一图标体系收口——六个页面
  里以 emoji/字符充当的图标（📋📊📌📡🔌🖥️💾📦✅🔍💡✕ 共 13 处）全部
  换成 `<ui-icon>`（link/copy/home/database/arrow-left/arrow-right/
  upload/circle-check/search/info/file/check/x）；manifest 的贡献点
  icon 是宿主侧栏的既定机制（各插件皆用 emoji），不在此列、保留。
- **EP 四插件（1.3.0/1.4.0）**：只经 `_sdk/plugin-api.js` 用主题通道，
  该文件本轮未变、引用名未变，逐个复核引用 intact；EP 组件自动受益于
  宿主 scheme 修复。不改、不升版本。
- **goshell 1.1.2**：刚发布，只加载 plugin-ui.js，其 ui-button/input/
  checkbox 自动获得新版组件内部（图标/错误态等），页面无需改；其页面
  CSS 中 `--ui-*` 的深色 hex 回退值是 SDK 不可用时的降级底色，作为
  保留例外记录（与 SDK 审计的「内部几何保留」同性质）。不改、不升版本。
- **test-panel 1.0.0**：旧 API 兼容夹具，按设计不迁移；scheme 修复后
  其页面恢复正常加载。不改。

## 2026-11-22 第三轮：EP 四插件按宿主五条统一标准补齐

用户明确 EP 四插件也要按宿主统一能力五条动。逐条处置（版本：
dev-toolbox/gitlab-console/kafka-studio 1.3.0 → 1.3.1，
object-storage 1.4.0 → 1.4.1）：

1. **共享组件**：四插件同为 Vue + Element Plus 栈，按钮/输入/下拉/卡片
   本就全量用 EP 组件（原生控件命中 0）；本轮再统一 EP 全局配置
   `app.use(ElementPlus, { size: 'small' })`，未显式写尺寸的控件（多在
   弹窗表单）与各插件工具栏既定小尺寸密度对齐。自绘件（连接项/行列表/
   统计卡等）继续由 NS-DS 同名类统一，不另造组件。
2. **间距/字体/颜色/边框/圆角**：已由 NS-DS 令牌层统一（第一轮）；
   各插件自有 CSS 中残留的圆角字面量（8px×23、7px×11 等）属插件内部
   几何（头像/小徽标/代码块），按 SDK 审计同一口径列为保留项，
   共享组件的圆角已全部由 NS-DS 覆盖。
3. **三档主题（本轮重点）**：此前 HC 被 sdkTheme 折算成 dark、只有两档
   观感。本轮主题跟随片段改用快照原始 `theme` 判 HC 并给 `<html>` 打
   `.hc` 标记；NS-DS 新增 `html.hc` 覆盖层：主色对齐宿主 HC 令牌
   `#00ffff`、边框提强至 .35–.55 白、文本纯白、焦点环 3px、选中指示
   加粗、主按钮黑字加粗。明/暗/HC 三档从此在 EP 插件里真实可分。
4. **统一图标**：字符图标清零——kafka 记录展开 `▾/▸` 换 EP 图标
   ArrowDown/ArrowRight；object-storage 任务折叠 `▾/▸` 换同套 SVG
   chevron（I 集补 chevD/chevR）、`↻ 重试` 去字符、预览加载 `⏳`
   换 refresh SVG + spin。dev/gitlab 本无字符图标。
5. **加载/错误/空状态/反馈**：ElMessage 规格统一为 duration 2600 +
   grouping（原 2200/2600/2600/2800 不一）；NS-DS 统一 el-loading
   遮罩与转圈主色、el-empty 描述规格、el-message/notification
   圆角与阴影。空状态各插件已统一用 ElEmpty（kafka/gitlab）或
   NS-DS 同规格的 .side-empty/.list-empty（dev/object）。

校验：四插件 app.js 与 object 内联脚本语法过；构建产物 NS-DS 段仍
逐字节一致且含 html.hc 层；zip 内 manifest 版本核对过。HC 与小尺寸
弹窗的真实观感待真机验（沙箱无渲染截图条件，同前两轮）。

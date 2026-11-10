# GitLab 管理台（gitlab-console）

为 NewShell 插件系统开发的 GitLab 客户端。当前版本：**1.0.0**。

## 功能

- **多连接管理**：连接（名称/GitLab 地址/Access Token/自签证书开关）全部在插件主页内管理，存插件数据；编辑器内可测试连接（调 `/user` 验证）。支持 GitLab.com 与自托管实例。
- **项目与代码**：项目搜索与分页加载；分支切换；文件树逐级浏览；文件内容查看（代码纯文本、Markdown 渲染）；项目根目录自动展示 README。
- **合并请求**：按状态过滤列表；详情含描述（Markdown）、变更文件列表与 unified diff 渲染（增删着色）、评论列表与发表评论、批准（Approve）、合并（Merge，可选删除源分支，合并前确认）。
- **流水线**：列表与状态徽章；详情按 Stage 分组展示 Jobs（状态/耗时）；Job 日志（trace）查看；Job 触发/重跑/取消；流水线重试/取消。
- **Issue**：按状态过滤；详情与评论、发表评论、关闭/重开；新建 Issue（标题/描述/标签）。

## 架构

- 页面（Vue 3 render 函数 + Pico.css，均内联）承载全部业务；GitLab REST API v4 调用经插件主进程（main.js）的**本地无状态代理**转发：启用即在 `127.0.0.1:17932` 起服务，页面把连接配置随每个请求传入（`POST /api {cfg, method, path, query, body}`），代理拼 `{baseUrl}/api/v4{path}`、带 `PRIVATE-TOKEN` 头转发并回传状态码、数据与分页响应头（x-total/x-total-pages/x-next-page）。代理不保存任何配置。
- 之所以走代理：插件页跨域且来源为 null，直连 GitLab 会被 CORS 拦截。
- Token 明文保存在插件数据目录（plugin-data.json）中，与 NewShell 其他插件（如对象存储）的既有做法一致；请使用最小权限（api scope）的 Token。
- 已用假 GitLab 服务器对代理做全流程冒烟（user/项目/文件树/文件/MR 变更与批准合并/流水线与 Job 日志/Issue 创建关闭/401 透传，共 13 项通过）。

## 已知限制

- MR/流水线/Issue 按「当前所选项目」组织（顶栏先选项目）；未做跨项目全局列表。
- 文件查看为只读，不支持在线编辑与提交；二进制文件不做预览。
- 合并冲突、MR 审批规则、流水线人工审批等高级流程仅透传 API 的结果提示，未深度建模。

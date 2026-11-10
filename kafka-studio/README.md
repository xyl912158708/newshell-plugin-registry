# Kafka Studio（kafka-studio）

为 NewShell 插件系统开发的 Kafka 巡检与运维台。当前版本：**1.0.0**。

## 功能

- **集群巡检**：Broker 列表（含 Controller 标记）、Topic 列表（分区数与消息总量估算）、Topic 分区表（Leader/副本/ISR/最早与最新 Offset）。
- **消息检索与流式消费**：按 Topic/分区拉取（最新 N 条/从最早/指定 Offset）、Key 与 Value 过滤；流式消费模式按可调间隔轮询追加；payload 解码方式可切换（UTF-8 文本/JSON 美化/Hex/Base64）；记录可展开看 Key/Value/Headers/时间戳。
- **消费组**：组列表与状态、成员与订阅分配、每分区已提交 Offset / 最新 Offset / Lag 表；Offset 重置（最早/最新/指定值，二次确认）。
- **ACL**：规则列表（按资源类型过滤）、新建、删除（确认）。
- **Schema Registry**：Subjects 列表、版本列表与 Schema 内容（JSON 美化）、全局兼容性显示（连接里配置 SR 地址后可用）。
- **多连接管理**：连接（Broker 列表/Client ID/SASL 凭证/SR 地址）在主页内管理，编辑器内可测试连接。

## 架构

- Kafka 是有状态二进制 TCP 协议：插件主进程（main.js）在 `127.0.0.1:17933` 起本地代理维护会话（`open/call/close`），页面把操作结构化发给代理。
- 协议客户端为纯 Node 手写（net + Buffer），实现的 API 与版本：Metadata v1、ListOffsets v1、Fetch v4、FindCoordinator v1、ListGroups v1、DescribeGroups v1、OffsetFetch v2、OffsetCommit v2（generationId=-1 简单提交）、DescribeAcls/CreateAcls/DeleteAcls v1、SaslHandshake/Authenticate v0（PLAIN）。消息解码支持 RecordBatch v2（varint/zigzag）与旧 MessageSet（magic 0/1）。
- Schema Registry 走同一代理的 HTTP 透传（`/sr`）。
- 已用独立实现的假 Kafka Broker 做协议级冒烟（Metadata/ListOffsets/Fetch 双格式解码/消费组 Lag/Offset 提交往返/ACL 增删查 + 假 SR，共 14 项通过）。

## 已知限制

- **压缩消息无法解压**：插件主进程沙箱的 require 白名单没有 zlib，gzip/snappy/lz4/zstd 压缩的批次会以占位形式提示 codec 类型，不展示内容。
- **SASL 仅 PLAIN**：不支持 SCRAM 与 TLS 加密连接（沙箱 tls 模块可用但证书管理未做），请在内网或配合隧道使用。
- Offset 重置采用简单提交（generationId=-1）：组内有活跃成员时可能被 Broker 拒绝或被成员的提交覆盖，界面有提示，操作前请先停消费者。
- 协议版本为兼容优先的老版本（Fetch v4 等），新版本 Broker 均向后兼容；未实现消息生产（发送）功能。

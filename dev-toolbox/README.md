# 开发者工具箱（dev-toolbox）

轻量开发者工具集，为 NewShell 插件系统开发。**即开即用、沙箱离线运行、零网络权限**（manifest 不申请任何权限，无主进程代码），全部计算在插件页内以纯 JS 完成。注：本插件为纯静态插件——不声明 main 入口、不申请任何权限，工具页直接由 manifest 的 contributions 声明，启用不需要授权确认（需 NewShell 宿主支持静态插件启用）。「零网络」：未申请 network 权限，页面 CSP 的 connect-src 为 none，工具计算全部在页面内离线完成。

当前版本：**1.0.0**。

## 工具清单（30 个）

- **加解密**：哈希计算（MD5/SHA-1/SHA-256/SHA-512）、HMAC 计算、AES 加解密（128/192/256、CBC/ECB、PKCS7、密钥/IV 支持 Hex）、随机密码生成（熵估算）
- **编解码**：Base64（含 URL 安全变体）、Base32、Hex、URL 编码、Unicode 转义、HTML 实体、JWT 解码（过期状态提示，不验签）
- **文本处理**：命名风格转换、行处理（排序/去重/反转/行号/打乱）、文本统计、Slug 生成、正则测试（高亮/捕获组/替换）
- **数据转换**：进制转换（BigInt 大整数）、字节大小换算、JSON↔YAML、CSV↔JSON、URL 参数解析
- **格式化**：JSON 格式化/压缩/校验（错误位置提示）、XML 格式化（良构校验）、SQL 格式化、JSON 字符串转义
- **时间计算**：时间戳转换（多时区、实时时钟）、日期差计算与日期加减、Cron 表达式（中文说明 + 未来 5 次执行）
- **网络运维**：子网计算（CIDR）、IP 地址工具（整数互转/分类）、常用端口速查（静态表）
- **图像生成**：二维码生成（字节模式、纠错等级 M、版本 1–10、PNG 下载）、占位图生成、颜色工具（HEX/RGB/HSL + WCAG 对比度）

## 实现说明

- 插件页处于非安全上下文，`crypto.subtle` 不可用，因此 MD5/SHA/AES/二维码 Reed-Solomon 等均为手写纯 JS 实现（lib.js），已用标准测试向量验证：MD5/SHA/HMAC 官方向量、AES FIPS-197 向量、二维码与独立实现（segno/reedsolo）逐码字比对并通过 OpenCV 解码验证（版本 1–10）。
- Vue 3 与 Pico.css 以官方发行文件存于 `vendor/`（含 MIT 许可证），构建时内联进 `index.html`（插件页无法加载外部子资源）；页面只用 Vue render 函数（CSP 无 unsafe-eval）。
- 界面为深/浅双主题（页内切换、偏好经宿主 storage 持久化）；宿主不向插件页注入主题，故默认深色。
- `index.html` 由 `index.src.html` 构建（占位符 `__PICO_CSS__` / `__LIB_JS__` / `__VUE_JS__` / `__APP_JS__` 分别替换为 vendor/pico.conditional.min.css、lib.js、vendor/vue.global.prod.js、app.js）。

## 已知限制

- YAML 互转为常用子集（嵌套对象/数组/标量），不支持锚点、别名、多行块标量。
- 二维码最长约 271 字节（纠错等级 M、版本 10 上限）；仅字节模式与固定掩码 0（可正常扫码）。
- SQL 格式化为基础排版；JWT 工具只解码不验签。

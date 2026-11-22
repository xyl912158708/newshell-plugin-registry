# NewShell 插件模板项目



## SDK 迁移（v1.0.1）

本模板已迁移到 Plugin UI SDK：页面经 `./_sdk/plugin-ui.js` 加载组件
（ui-page / ui-page-header / ui-card / ui-tag / ui-button / ui-empty），
页面样式使用 `--ui-*` Token 并跟随宿主主题；dashboard 另引
`./_sdk/plugin-api.js` 演示 plugin.theme 与 plugin.storage。
新插件开发建议直接以本模板为起点。

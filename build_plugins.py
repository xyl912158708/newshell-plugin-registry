#!/usr/bin/env python3
"""构建四个插件的 index.html 并重新打包 zip。

index.src.html 中的占位符是整段 HTML 注释，构建时须整段替换，规则分两类：
  未被标签包裹（PICO/VUE）：整段注释换成带标签的块
    <!-- __PICO_CSS__ --> -> <style>/* 许可头 */ + vendor/pico.conditional.min.css + </style>
    <!-- __VUE_JS__ -->   -> <script>/* 许可头 */ + vendor/vue.global.prod.js + </script>
  已在 <script> 标签内（LIB/APP）：整段注释只换成原始内容，不要再加 <script> 包裹
    <!-- __LIB_JS__ -->   -> lib.js 原文                        （仅 dev-toolbox）
    <!-- __APP_JS__ -->   -> app.js 原文
注意两个错误做法：只替换 __X__ 本体（保留 <!-- -->）会把内容留在注释里；
给 LIB/APP 再套一层 <script> 会生成嵌套脚本标签。两者都会损坏页面。

用法：python3 build_plugins.py [plugin-id ...]（缺省构建全部三个）
"""
import io
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
PLUGINS = ['dev-toolbox', 'gitlab-console', 'kafka-studio', 'object-storage']

PICO_HEAD = '/* Pico.css v2.0.6 (MIT) inline copy of vendor/pico.conditional.min.css */'
EP_CSS_HEAD = '/* Element Plus 2.11.8 (MIT) inline copy of vendor/element-plus.css */'
EP_DARK_HEAD = '/* Element Plus dark vars (MIT) inline copy of vendor/element-plus-dark-vars.css */'
EP_JS_HEAD = '/* Element Plus 2.11.8 (MIT) inline copy of vendor/element-plus.full.min.js */'
EP_ICONS_HEAD = '/* Element Plus Icons 2.3.2 (MIT) extracted paths, see vendor/ep-icons.js */'
VUE_HEAD = '/* Vue 3.5.13 (MIT) inline copy of vendor/vue.global.prod.js */'


def read(pid, rel):
    return io.open(os.path.join(ROOT, pid, rel), encoding='utf-8').read()


def build(pid):
    html = read(pid, 'index.src.html')
    html = html.replace('<!-- __PICO_CSS__ -->',
                        '<style>\n' + PICO_HEAD + '\n' + read(pid, 'vendor/pico.conditional.min.css') + '\n</style>')
    html = html.replace('<!-- __VUE_JS__ -->',
                        '<script>\n' + VUE_HEAD + '\n' + read(pid, 'vendor/vue.global.prod.js') + '\n</script>')
    if '<!-- __EP_CSS__ -->' in html:
        html = html.replace('<!-- __EP_CSS__ -->',
                            '<style>\n' + EP_CSS_HEAD + '\n' + read(pid, 'vendor/element-plus.css') + '\n</style>')
    if '<!-- __EP_DARK_CSS__ -->' in html:
        html = html.replace('<!-- __EP_DARK_CSS__ -->',
                            '<style>\n' + EP_DARK_HEAD + '\n' + read(pid, 'vendor/element-plus-dark-vars.css') + '\n</style>')
    if '<!-- __EP_JS__ -->' in html:
        html = html.replace('<!-- __EP_JS__ -->',
                            '<script>\n' + EP_JS_HEAD + '\n' + read(pid, 'vendor/element-plus.full.min.js') + '\n</script>')
    if '<!-- __EP_ICONS_JS__ -->' in html:
        html = html.replace('<!-- __EP_ICONS_JS__ -->',
                            '<script>\n' + EP_ICONS_HEAD + '\n' + read(pid, 'vendor/ep-icons.js') + '\n</script>')
    if '<!-- __LIB_JS__ -->' in html:
        html = html.replace('<!-- __LIB_JS__ -->', read(pid, 'lib.js'))
    if '<!-- __APP_JS__ -->' in html:
        html = html.replace('<!-- __APP_JS__ -->', read(pid, 'app.js'))
    for token in ('__PICO_CSS__', '__VUE_JS__', '__APP_JS__', '__LIB_JS__', '__EP_CSS__', '__EP_DARK_CSS__', '__EP_JS__', '__EP_ICONS_JS__'):
        assert token not in html, f'{pid}: placeholder {token} left'
    out = os.path.join(ROOT, pid, 'index.html')
    io.open(out, 'w', encoding='utf-8').write(html)
    print(pid, 'index.html bytes', len(html.encode('utf-8')))

    candidates = ['manifest.json', 'index.html', 'index.src.html', 'app.js', 'README.md', 'main.js', 'lib.js']
    members = [m for m in candidates if os.path.exists(os.path.join(ROOT, pid, m))]
    manifest = io.open(os.path.join(ROOT, pid, 'manifest.json'), encoding='utf-8').read()
    import json
    version = json.loads(manifest)['version']
    zpath = os.path.join(ROOT, 'plugins', pid, f'{pid}-v{version}.zip')
    os.makedirs(os.path.dirname(zpath), exist_ok=True)
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
        for m in members:
            z.write(os.path.join(ROOT, pid, m), m)
        vdir = os.path.join(ROOT, pid, 'vendor')
        for root, _, fns in os.walk(vdir):
            for fn in fns:
                p = os.path.join(root, fn)
                z.write(p, os.path.relpath(p, os.path.join(ROOT, pid)))
    print(pid, 'zip bytes', os.path.getsize(zpath), '->', os.path.relpath(zpath, ROOT))


if __name__ == '__main__':
    targets = sys.argv[1:] or PLUGINS
    for pid in targets:
        build(pid)

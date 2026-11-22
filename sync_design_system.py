#!/usr/bin/env python3
"""把 shared/design-system.css 同步进四个 EP 插件的 index.src.html。

注入位置：</head> 之前的 NS-DS 标记段（独立 <style>，位于插件自有样式之后，
靠层叠顺序覆盖）。重复运行只替换标记段内容，不会叠加。
用法：python3 sync_design_system.py [plugin-id ...]
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PLUGINS = ['dev-toolbox', 'gitlab-console', 'kafka-studio', 'object-storage']
BEGIN = '<!-- NS-DS:BEGIN 统一设计系统（源：shared/design-system.css，勿手改本段，用 sync_design_system.py 同步） -->'
END = '<!-- NS-DS:END -->'


def sync(pid):
    path = os.path.join(ROOT, pid, 'index.src.html')
    src = io.open(path, encoding='utf-8').read()
    css = io.open(os.path.join(ROOT, 'shared', 'design-system.css'), encoding='utf-8').read()
    block = BEGIN + '\n<style>\n' + css + '\n</style>\n' + END
    if BEGIN in src:
        start = src.index(BEGIN)
        end = src.index(END) + len(END)
        src = src[:start] + block + src[end:]
    else:
        assert '</head>' in src, pid + ': no </head>'
        src = src.replace('</head>', block + '\n</head>', 1)
    io.open(path, 'w', encoding='utf-8').write(src)
    print(pid, 'design-system synced, src bytes', len(src.encode('utf-8')))


if __name__ == '__main__':
    for pid in (sys.argv[1:] or PLUGINS):
        sync(pid)

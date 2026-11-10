#!/usr/bin/env python3
"""生成 Gitea 版注册表 staging 目录（双发流程的一半）。

用法: python3 tools/make_gitea_registry.py <输出目录>

从本仓库 registry.json 生成 Gitea 版：
- downloadUrl 改写为 git.xhome.cc 上 xieyinlu/newshell-plugin-registry 的 raw 地址
- versions 只保留最新版（Gitea 仓只收最新版安装包）
- 把各插件最新版 zip 复制到 plugins/<id>/ 下

之后在输出目录里逐个 zip 一个提交，经 gitea shim 推到
xieyinlu/newshell-plugin-registry（每笔推送控制在约 850KB 以内，
该链路约 40KB/s，大推送会超时）。
"""
import json
import os
import shutil
import sys

BASE = 'https://git.xhome.cc/xieyinlu/newshell-plugin-registry/raw/branch/main'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    out_dir = sys.argv[1]
    reg = json.load(open(os.path.join(ROOT, 'registry.json')))
    result = {'plugins': []}
    for plugin in reg['plugins']:
        latest = [v for v in plugin['versions'] if v['version'] == plugin['latestVersion']]
        if not latest:
            print(f"跳过 {plugin['id']}：registry 中没有最新版条目")
            continue
        version = dict(latest[0])
        filename = version['downloadUrl'].rsplit('/', 1)[-1]
        version['downloadUrl'] = f"{BASE}/plugins/{plugin['id']}/{filename}"
        entry = dict(plugin)
        entry['versions'] = [version]
        result['plugins'].append(entry)
        src = os.path.join(ROOT, 'plugins', plugin['id'], filename)
        dst = os.path.join(out_dir, 'plugins', plugin['id'], filename)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy(src, dst)
        print(f"{plugin['id']} {plugin['latestVersion']}: {filename} ({os.path.getsize(dst)} B)")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, 'registry.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"Gitea 版 registry.json 已写入 {out_dir}")
    return 0


if __name__ == '__main__':
    sys.exit(main())

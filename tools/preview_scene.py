#!/usr/bin/env python3
"""
preview_scene.py —— 离线渲染一张场景预览图，用于和 TTS 存档缩略图目视对拍

这是第 0 步的验收工具：把我们的坐标映射（posX/posZ -> x/y、rotY -> r、
rotZ -> f）画成 PNG，跟 Saves/*.png 缩略图并排比。
不通过就不该继续往后写前端。

用法：python3 tools/preview_scene.py scene-08
"""

import json
import os
import sys

from PIL import Image

PUB = 'public'
OUT = '.work'


def main():
    slug = sys.argv[1] if len(sys.argv) > 1 else 'scene-08'
    scene = json.load(open(os.path.join(PUB, 'scenes', slug + '.json'), encoding='utf-8'))

    pieces = scene['pieces']
    xs = [p['x'] for p in pieces]
    ys = [p['y'] for p in pieces]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)

    # 每世界单位 -> 预览像素
    PAD = 40
    W, H = 1400, 1100
    k = min((W - PAD * 2) / max(x1 - x0, 1), (H - PAD * 2) / max(y1 - y0, 1))

    img = Image.new('RGB', (W, H), (245, 241, 232))
    loaded = {}
    drawn = 0

    for p in pieces:
        aid = p['bimg'] if p.get('f') else p['img']
        path = os.path.join(PUB, 'assets', aid + '.webp')
        if aid not in loaded:
            loaded[aid] = Image.open(path).convert('RGBA') if os.path.exists(path) else None
        src = loaded[aid]
        if src is None:
            continue

        pw = max(1, int(round(p['w'] * k)))
        ph = max(1, int(round(p['h'] * k)))
        tile = src.resize((pw, ph), Image.LANCZOS)

        if p.get('r'):
            # 我们存的是平面内旋转角（度）。预览里按屏幕坐标旋转取负，
            # 因为世界 y 向下、TTS Z 朝观察者，两者手性相反。
            tile = tile.rotate(-p['r'], expand=True, resample=Image.BICUBIC)

        cx = PAD + (p['x'] - x0) * k
        cy = PAD + (p['y'] - y0) * k
        # 世界坐标 y 向下，图片直接以此为中心贴上去
        img.paste(tile, (int(cx - tile.width / 2), int(cy - tile.height / 2)), tile)
        drawn += 1

    out = os.path.join(OUT, 'preview_%s.png' % slug)
    img.save(out)
    print('绘制 %d/%d 枚 -> %s' % (drawn, len(pieces), out))
    print('世界包围盒 x[%.0f,%.0f] y[%.0f,%.0f]  k=%.3f' % (x0, x1, y0, y1, k))
    print('面板尺寸分布:', sorted({(p['w'], p['h']) for p in pieces})[:6])
    print('背面朝上数量:', sum(1 for p in pieces if p.get('f')))


if __name__ == '__main__':
    main()

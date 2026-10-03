#!/usr/bin/env python3
"""
build_assets.py —— TTS《大洋落日》资产 → Web 资产管线

做三件事（一次性构建，不占运行时）：
  1. 从 zip 里按 manifest.tsv 提取被引用的贴图，转成 WebP 并降采样
  2. 产出 URL → 资产 id 的索引
  3. 把 TTS 存档 JSON 转成我们的场景 JSON（棋子引用资产 id，不再含 URL）

坐标映射
  our.x = -posX * WORLD
  our.y = -posZ * WORLD
  our.r = 180 - rotY
  our.f = 1 if |rotZ| ≈ 180 else 0   （平面棋子在 XZ 平面内被翻转 = 背面朝上）

即：**位置绕场景中心旋转 180°**（x、y 同时取反），朝向按 180 - rotY。

r = 180 - rotY 的依据（**这条有硬证据，别凭感觉改**）：
  本模组 762 枚棋子的 rotY 都 ≈ 180，代入得 r = 0，即原图直接正着画。
  把大板块原图取出来看，文字「大洋落日」「中途岛战役地图」在
  rotY=180 的素材里本来就是正立的 —— 早期写成 r = -rotY，
  -180 与 +180 同余，等于又转了一次 180°，导致整个盘面文字倒立。

位置的依据：
  早期用的是 x=+posX / y=+posZ，卡片文字是对的、但卡片之间的
  相对位置整体反了（等于场景被转了 180°）。按用户要求改成两个轴
  同时取反后与 TTS 缩略图一致。

注意：rotY ≈ 180 的棋子（绝大多数）在 180-rotY 与 180+rotY 下
结果相同（都是 0），所以「文字朝向」无法区分这两个公式；
只有少数倾斜棋子（如 rotY≈29 的 6 枚）能区分。修改这里时
必须拿这些倾斜的棋子去核，不要只看大盘面。

尺寸：TTS 棋子的基础边长是 2.0 单位（与存档里 Grid.xSize = 2.0 吻合），
  实测相邻棋子中位间距 1.29、常见 scale 0.6 → 1.29 / 0.6 ≈ 2.15 ≈ 2.0，交叉验证成立。
  因此世界尺寸 w = 2.0 * scale * WORLD / 2 = BASE_TILE * scale（BASE_TILE=64）。
  高度按图片宽高比换算 —— 底图板块是 1.5:1 的长方形，不能用正方形假设。

用法：
  python3 tools/build_assets.py            # 全量
  python3 tools/build_assets.py --limit 40 # 只处理少量，用于快速验证
"""

import hashlib
import io
import json
import os
import re
import sys
import zipfile

from PIL import Image, ImageFile

# 源包里有 1 张 JPEG 尾部截断（少 6 字节）。这类文件浏览器照样能解，
# 不该因为 PIL 严格校验就整张丢掉 —— 放宽到容忍截断。
ImageFile.LOAD_TRUNCATED_IMAGES = True

SRC = '大洋落日_资产.zip'
ZROOT = '大洋落日/'

OUT_ASSETS = 'public/assets'
OUT_SCENES = 'public/scenes'

# 世界坐标：1 TTS 单位 = 32 世界单位；scale=1 的棋子边长 64 世界单位
WORLD = 32.0
BASE_TILE = 64.0

# 降采样目标（最长边）。超过这个尺寸就缩，不放大
BOARD_MAX = 1024      # 底图板块
TILE_MAX = 192        # 普通棋子

WHITE_ID = 'white'


def sha1_16(s):
    return hashlib.sha1(s.encode('utf-8')).hexdigest()[:16]


def load_manifest(z):
    """返回 (url -> 相对路径) 与 (missing url 列表)

    只收图片。manifest 里还有 .unity3d / .pdf / .obj 等非图片资源，
    对它们调 PIL 只会抛 UnidentifiedImageError —— 在入口过滤掉，
    不要靠异常兜底（否则每次构建都会刷一屏 FAIL，真的坏图就淹没了）。
    """
    raw = z.read(ZROOT + 'manifest.tsv').decode('utf-8')
    ok, missing = {}, []
    for line in raw.splitlines()[1:]:
        parts = line.split('\t')
        if len(parts) < 3:
            continue
        url, cat, rel = parts[0], parts[1], parts[2]
        if cat == 'missing':
            # missing 行的 rel 是空的（本地根本没这个文件），
            # 所以扩展名过滤只能对 ok 行做，否则这 25 条会被一起滤掉，
            # 白占位就登记不上了。
            missing.append(url)
            continue
        if cat != 'ok':
            continue
        if not rel.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.gif')):
            continue
        ok[url] = rel
    return ok, missing


def target_max(w, h):
    m = max(w, h)
    if m > 1200:
        return BOARD_MAX
    if m > TILE_MAX:
        return TILE_MAX
    return None          # 已经够小，保留原尺寸


def convert(data, want_max):
    """把图片字节转成 WebP 字节，返回 (bytes, w, h)"""
    im = Image.open(io.BytesIO(data))

    # JPEG 可以先让解码器直接吐小图（DCT 缩放），对 65MP 的底图能省几十倍内存与时间
    if im.format == 'JPEG':
        im.draft('RGB', (want_max or 1200, want_max or 1200))
    im.load()

    w, h = im.size
    if want_max and max(w, h) > want_max:
        k = want_max / float(max(w, h))
        nw, nh = max(1, round(w * k)), max(1, round(h * k))
        im = im.resize((nw, nh), Image.LANCZOS)
        w, h = nw, nh

    # 有 alpha 就保留（圆形指示物的透明角必须留，否则会变成白方块）
    if im.mode not in ('RGB', 'RGBA'):
        im = im.convert('RGBA' if 'A' in im.mode else 'RGB')

    buf = io.BytesIO()
    q = 78 if want_max == BOARD_MAX else 82
    im.save(buf, 'WEBP', quality=q, method=5)
    return buf.getvalue(), w, h


def make_white(size=192):
    im = Image.new('RGB', (size, size), (255, 255, 255))
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=90, method=5)
    return buf.getvalue()


def build_images(z, ok, missing, limit=None):
    os.makedirs(OUT_ASSETS, exist_ok=True)

    index = {}
    done = 0
    failures = []
    total_raw = 0
    total_web = 0

    items = list(ok.items())
    if limit:
        items = items[:limit]

    for url, rel in items:
        try:
            data = z.read(ZROOT + rel)
        except KeyError:
            failures.append((url, 'not in zip'))
            continue

        total_raw += len(data)
        try:
            probe = Image.open(io.BytesIO(data))
            pw, ph = probe.size
            want = target_max(pw, ph)
            web, w, h = convert(data, want)
        except Exception as e:               # 单张坏图不该中断整批
            failures.append((url, repr(e)))
            continue

        aid = sha1_16(url)
        with open(os.path.join(OUT_ASSETS, aid + '.webp'), 'wb') as f:
            f.write(web)

        total_web += len(web)
        index[url] = {'id': aid, 'w': w, 'h': h}
        done += 1
        if done % 100 == 0:
            print('  ... %d/%d' % (done, len(items)), flush=True)

    # 缺失资源 -> 纯白占位（用户指定：占位用纯白）
    white = make_white()
    with open(os.path.join(OUT_ASSETS, WHITE_ID + '.webp'), 'wb') as f:
        f.write(white)
    for url in missing:
        index[url] = {'id': WHITE_ID, 'w': 192, 'h': 192, 'missing': True}

    with open(os.path.join(OUT_ASSETS, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))

    print('图片：%d 张转出，%d 张失败' % (done, len(failures)))
    if failures:
        for u, e in failures[:10]:
            print('   FAIL %s  %s' % (u[-40:], e))
    print('原始 %.1f MB -> WebP %.1f MB (%.1f%%)' % (
        total_raw / 1e6, total_web / 1e6,
        100.0 * total_web / max(total_raw, 1)))
    return index


# ---------------------------------------------------------------- 场景转换

def norm360(v):
    """归一化角度到 [0, 360)。

    % 的语义本身没问题（(-180) % 360 == 180），坑在**浮点**上：
    359.996 这类「差一点到 360」的值会在后面 round(x, 2) 时进位成 360.0，
    于是 r 出现 360 这个越界值 —— 任何假设 r ∈ [0,360) 的代码都会出错。
    所以在源头就把贴近 360 的噪声折回 0。
    """
    r = v % 360.0
    # 0.05 度 ≈ 屏幕上完全看不出的偏差，却足以避免 359.996 -> 360.0
    if r < 0.05 or r > 359.95:
        r = 0.0
    return r


def is_face_down(t):
    """平面棋子被翻成背面的判定。rotX 与 rotZ 都能翻，实测只有 rotZ 出现 ~180。"""
    rz = norm360(t.get('rotZ', 0.0))
    rx = norm360(t.get('rotX', 0.0))
    return (abs(rz - 180.0) < 30.0) or (abs(rx - 180.0) < 30.0)


def convert_save(save, index):
    """TTS 存档 dict -> 我们的场景 dict"""
    pieces = []
    skipped = {}
    no_state_asset = 0

    for i, o in enumerate(save.get('ObjectStates', [])):
        name = o.get('Name')
        if name != 'Custom_Tile':
            skipped[name] = skipped.get(name, 0) + 1
            continue

        ci = o.get('CustomImage') or {}
        fu, bu = ci.get('ImageURL'), ci.get('ImageSecondaryURL')
        if not fu:
            skipped['Custom_Tile(no image)'] = skipped.get('Custom_Tile(no image)', 0) + 1
            continue

        fe = index.get(fu)
        be = index.get(bu) if bu else None
        if not fe:
            skipped['Custom_Tile(no asset)'] = skipped.get('Custom_Tile(no asset)', 0) + 1
            continue

        t = o.get('Transform') or {}
        scale = t.get('scaleX', 1.0) or 1.0
        w = BASE_TILE * scale

        # 图片宽高比 -> 世界高度。底图板块是长方形，必须按比例算
        aspect = (fe['w'] / float(fe['h'])) if fe.get('h') else 1.0
        h = w / aspect if aspect else w

        # ---- 形态（TTS 的 States / 右键 Alternate）----
        #
        # 数据形状：**顶层对象就是当前形态**，States 字典里是其余形态。
        # 所以形态总数 = 1 + len(States)，索引 0 是当前形态。
        # 每个形态有自己的 CustomImage（图片）和 Transform.scale
        #（实测同对象内各形态 scale 一致，但不同对象的 scale 差很多，
        #  底图板块和卡牌不是一个量级，所以宽高还是要按形态自己算）。
        #
        # 形态自带 Transform 里的坐标是残留数据 —— TTS 切形态时位置不变，
        # 所以这里**只取图片和尺寸，位置一律沿用顶层**。
        states = [{'img': fe['id'], 'bimg': (be or fe)['id'], 'w': round(w, 2), 'h': round(h, 2)}]

        for key in sorted((o.get('States') or {}).keys(), key=lambda k: int(k) if str(k).isdigit() else 0):
            st = o['States'][key]
            sci = st.get('CustomImage') or {}
            su = sci.get('ImageURL')
            se = index.get(su) if su else None
            if not se:
                no_state_asset += 1
                continue

            st_t = st.get('Transform') or {}
            st_scale = st_t.get('scaleX', scale) or scale
            sw = BASE_TILE * st_scale
            sa = (se['w'] / float(se['h'])) if se.get('h') else 1.0
            sh = sw / sa if sa else sw
            sb = index.get(sci.get('ImageSecondaryURL')) if sci.get('ImageSecondaryURL') else None

            states.append({
                'img': se['id'],
                'bimg': (sb or se)['id'],
                'w': round(sw, 2),
                'h': round(sh, 2),
            })

        pieces.append({
            'id': 't%03d' % i,
            # 这里输出 **TTS 原始符号**（x=+posX, y=+posZ），不做任何翻转：
            # 位置映射是「显示约定」，放在前端做（app.js 的映射档位），
            # 这样切换映射不用重新构建资产，也能让用户当场看到对错。
            # 早期把翻转烘进构建脚本，导致每次都要重跑管线 + 重启服务，
            # 试错成本高，而且我连着猜错了几轮。
            'x': round(t.get('posX', 0.0) * WORLD, 3),
            'y': round(t.get('posZ', 0.0) * WORLD, 3),
            'r': round(norm360(180.0 - t.get('rotY', 0.0)), 2),
            'f': 1 if is_face_down(t) else 0,
            'w': round(w, 2),
            'h': round(h, 2),
            'img': fe['id'],
            'bimg': (be or fe)['id'],
            'z': i,                                        # 数组序 = 层叠序，后面的在上
            'lk': 1 if o.get('Locked') else 0,             # 冻结
            'st': states,                                  # 形态数组，st[0] = 当前形态
        })

    if no_state_asset:
        skipped['States(no asset)'] = no_state_asset

    return {
        'name': save.get('SaveName') or '',
        'source': '',
        'pieces': pieces,
        'skipped': skipped,
    }


def build_scenes(z, index):
    os.makedirs(OUT_SCENES, exist_ok=True)

    saves = sorted(n for n in z.namelist()
                   if n.endswith('.json')
                   and ('/Saves/' in n)
                   and 'SaveFileInfos' not in n)

    catalog = []
    for n in saves:
        try:
            save = json.loads(z.read(n))
        except Exception as e:
            print('  跳过 %s: %r' % (n, e))
            continue

        scene = convert_save(save, index)
        if not scene['pieces']:
            continue

        rel = n[len(ZROOT):] if n.startswith(ZROOT) else n
        slug = 'scene-%02d' % (len(catalog) + 1)
        scene['source'] = rel
        scene['slug'] = slug

        with open(os.path.join(OUT_SCENES, slug + '.json'), 'w', encoding='utf-8') as f:
            json.dump(scene, f, ensure_ascii=False, separators=(',', ':'))

        catalog.append({
            'slug': slug,
            'label': scene['name'],
            'source': rel,
            'count': len(scene['pieces']),
        })
        print('  %-10s %-16s %4d 棋子  <- %s'
              % (slug, scene['name'][:16], len(scene['pieces']), rel))

    with open(os.path.join(OUT_SCENES, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(catalog, f, ensure_ascii=False, indent=1)

    return catalog


def main():
    limit = None
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])

    z = zipfile.ZipFile(SRC)
    ok, missing = load_manifest(z)
    print('manifest: %d 个可用 URL, %d 个缺失' % (len(ok), len(missing)))

    print('\n[1/2] 转换贴图 ...')
    index = build_images(z, ok, missing, limit)

    print('\n[2/2] 转换存档 ...')
    catalog = build_scenes(z, index)

    print('\n完成：%d 张贴图, %d 个场景' % (len(index), len(catalog)))
    for c in catalog:
        print('  %s  %s' % (c['slug'], c['label']))


if __name__ == '__main__':
    main()

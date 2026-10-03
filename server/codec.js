/*
 * codec.js —— 存档编解码（紧凑格式 <-> 棋子数组）
 *
 * 存档的输出形态是 **base64 字符串**，给用户复制粘贴用，不落文件。
 *
 * 为什么不用「把 pieces 原样 JSON.stringify」：
 *   778 枚棋子按对象形式序列化约 120KB 文本，base64 后 ~160KB。
 *   这有两个问题：
 *     1. 顶爆 WebSocket 的 maxPayload（64KB）—— 但那不是主要理由，
 *        因为存档走的是 HTTP，本来就不受它约束；
 *     2. 真正的问题是「给用户看的字符串太长了」，160KB 的 base64
 *        复制粘贴体验很差，而且里面大量重复的键名（"id"/"x"/"y"...）。
 *
 * 所以这里做两件事：
 *   1. **列式数组**代替对象数组，省掉 778 份键名
 *   2. **贴图字典**去重 —— img/bimg 只存下标，
 *      像那张被 120 枚棋子复用的图，只需要出现一次
 *
 * id 处理：id **不存在**紧凑格式的数值行里，而是单独一张 `ids` 表
 *（通常是 null，因为场景 id 是规整的 t000/t001...，可按下标还原；
 * 只有在 id 不规则时才真的写进去）。
 *
 * 早期版本每次导入都按位置重新生成 id（p0..pN），
 * 这跟场景装载用的 t012 风格对不上 —— 结果是「导出再导入」之后
 * id 全变，客户端上原有的 op 引用、多选集合、层叠关系全都悬空。
 * id 必须在往返中保持不变，否则存档就不是存档。
 *
 * 实测 778 枚棋子约 54KB 文本 / 72KB base64。
 *
 * 注意：只在存档的边界上做压缩，**运行时状态仍然是普通对象**。
 * 不要把紧凑格式泄漏到棋子对象里去，否则每次绘制都要解一次下标。
 */

'use strict';

const VERSION = 1;

// 坐标保留 2 位（世界单位下 0.01 远小于 1 像素，肉眼无感）
// 角度保留 1 位（转 90 度那种整数角已经是精确值）
function r2(v) { return Math.round(v * 100) / 100; }
function r1(v) { return Math.round(v * 10) / 10; }

/**
 * 棋子数组 -> 紧凑对象
 */
function encode(pieces, meta) {
  const dict = [];
  const index = new Map();

  function aid(id) {
    if (id == null) return -1;
    let i = index.get(id);
    if (i === undefined) {
      i = dict.length;
      dict.push(id);
      index.set(id, i);
    }
    return i;
  }

  const rows = [];
  const ids = [];
  let idsRegular = true;

  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    rows.push([
      r2(p.x), r2(p.y), r1(p.r || 0), p.f ? 1 : 0,
      r2(p.w), r2(p.h),
      aid(p.img), aid(p.bimg),
      p.z | 0
    ]);

    // 绝大多数场景的 id 就是 t000/t001…，能按下标还原，不必写进存档。
    // 只有不规整时才落 ids 表，省掉几 KB。
    const expect = 't' + String(i).padStart(3, '0');
    if (p.id === expect) ids.push(null);
    else { ids.push(String(p.id)); idsRegular = false; }
  }

  const out = {
    v: VERSION,
    label: (meta && meta.label) || '',
    scene: (meta && meta.scene) || '',
    a: dict,
    p: rows
  };
  if (!idsRegular) out.ids = ids;
  return out;
}

/**
 * 紧凑对象 -> 棋子数组
 *
 * 校验从严：存档是用户手动粘贴进来的，什么畸形内容都可能出现。
 * 这里宁可整份拒绝，也不要塞一半坏数据进房间
 *（房间状态是所有客户端的一致性基准，脏数据会传染）。
 */
function decode(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('不是对象');
  if (obj.v !== VERSION) throw new Error('版本不支持: ' + obj.v);
  if (!Array.isArray(obj.a)) throw new Error('缺少贴图字典 a');
  if (!Array.isArray(obj.p)) throw new Error('缺少棋子数组 p');
  if (obj.p.length > 20000) throw new Error('棋子数量超限');

  const dict = obj.a;
  const pieces = [];
  const seen = new Set();
  const ids = Array.isArray(obj.ids) ? obj.ids : null;

  for (let i = 0; i < obj.p.length; i++) {
    const r = obj.p[i];
    if (!Array.isArray(r) || r.length < 9) throw new Error('第 ' + i + ' 行格式错误');

    for (const v of r) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error('第 ' + i + ' 行含非有限数值');
      }
    }

    const [x, y, rot, f, w, h, ai, bi, z] = r;

    const img = ai >= 0 ? dict[ai] : null;
    const bimg = bi >= 0 ? dict[bi] : null;
    if (ai >= 0 && typeof img !== 'string') throw new Error('第 ' + i + ' 行贴图下标越界');
    if (bi >= 0 && typeof bimg !== 'string') throw new Error('第 ' + i + ' 行贴图下标越界');
    if (w <= 0 || h <= 0) throw new Error('第 ' + i + ' 行尺寸非法');

    // id 必须还原成原样，不能按下标另起一套命名 ——
    // 否则「导出再导入」之后所有 id 都变了，
    // 客户端已有的选择集合和 op 引用会全部悬空。
    let id;
    if (ids && ids[i] != null) {
      id = String(ids[i]).slice(0, 64);
      if (!id) throw new Error('第 ' + i + ' 行 id 为空');
    } else {
      id = 't' + String(i).padStart(3, '0');
    }

    if (seen.has(id)) throw new Error('id 重复: ' + id);
    seen.add(id);

    pieces.push({
      id,
      x, y,
      r: ((Math.round(rot) % 360) + 360) % 360,
      f: f ? 1 : 0,
      w, h,
      img: img || bimg,
      bimg: bimg || img,
      z
    });
  }

  return {
    pieces,
    label: String(obj.label || '').slice(0, 64),
    scene: String(obj.scene || '').slice(0, 64)
  };
}

function toBase64(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function fromBase64(b64) {
  const s = String(b64 || '').trim().replace(/\s+/g, '');
  if (!s) throw new Error('内容为空');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error('不是合法的 base64');

  let text;
  try {
    text = Buffer.from(s, 'base64').toString('utf8');
  } catch (_) {
    throw new Error('base64 解码失败');
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_) {
    throw new Error('解出的内容不是 JSON');
  }
  return obj;
}

module.exports = { encode, decode, toBase64, fromBase64, VERSION };

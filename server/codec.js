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

// 角度归一到 [0,360)，保留**两位**小数。
//
// 精度必须和场景数据对齐：build_assets.py 里 r 是 round(..., 2)，
// 实测有 0.27 / 359.94 这类值。用 r1（一位小数）会把 0.27 变 0.3，
// 用 Math.round 更会把 596 枚棋子的朝向直接抹平 ——
// 两者都是「不报错但不可逆」的精度损失。
//
// 注意**不能**写成 ((r2(n) % 360) + 360) % 360：
// 0.27 先 +360 变 360.27，再取模得到 0.2699999999999818 ——
// 浮点残留。正确做法是先归一到非负，再取整。
function normR(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;

  let m = n % 360;
  if (m < 0) m += 360;
  m = Math.round(m * 100) / 100;
  if (m >= 360) m = 0;          // 359.999 之类的取整进位要折回 0
  return m;
}

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
  const states = {};             // 稀疏：只有多形态的棋子才落这里
  let hasStates = false;
  let idsRegular = true;

  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    rows.push([
      r2(p.x), r2(p.y), r2(p.r || 0), p.f ? 1 : 0,
      r2(p.w), r2(p.h),
      aid(p.img), aid(p.bimg),
      p.z | 0,
      p.lk ? 1 : 0,              // 9: 冻结
      p.si | 0,                  // 10: 当前形态下标
      p.ds | 0,                  // 11: 骰子面数（0 = 非骰子）
      p.v | 0,                   // 12: 骰子当前点数
      p.sh | 0,                  // 13: 标记形状（0 = 非标记）
      p.c >>> 0                  // 14: 自定义颜色 0xRRGGBB（0 = 默认）
    ]);

    // 形态数组只对多形态棋子存（778 枚里只有 59 枚有）。
    // 全量存的话每行都要多塞一个数组，体积翻倍且 92% 是冗余。
    if (Array.isArray(p.st) && p.st.length > 1) {
      states[i] = p.st.map((s) => [aid(s.img), aid(s.bimg), r2(s.w), r2(s.h)]);
      hasStates = true;
    }

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
  if (hasStates) out.st = states;
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
  const stMap = (obj.st && typeof obj.st === 'object') ? obj.st : null;

  function resolveTex(idx, where) {
    if (idx < 0) return null;
    const t = dict[idx];
    if (typeof t !== 'string') throw new Error(where + ' 贴图下标越界');
    return t;
  }

  for (let i = 0; i < obj.p.length; i++) {
    const r = obj.p[i];
    if (!Array.isArray(r) || r.length < 9) throw new Error('第 ' + i + ' 行格式错误');

    for (const v of r) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error('第 ' + i + ' 行含非有限数值');
      }
    }

    const [x, y, rot, f, w, h, ai, bi, z] = r;
    // 行结构 = [x,y,rot,f,w,h,ai,bi,z,lk,si]，共 11 项、下标 0..10。
    // 注意 si 在 **10** 不是 11 —— 早期写成 r[11] 恒为 undefined，
    // 于是 si 永远解析成 0：形态选择被静默重置，
    // 而且「下标越界」这条校验也永远不触发。
    const lk = r.length > 9 ? (r[9] ? 1 : 0) : 0;
    const si = r.length > 10 ? (r[10] | 0) : 0;
    // 12 列起是后来加的字段（骰子、标记）。全部用长度判断，
    // 保证老存档（9 列 / 11 列）仍可解。
    const ds = r.length > 11 ? (r[11] | 0) : 0;
    const dv = r.length > 12 ? (r[12] | 0) : 0;
    const sh = r.length > 13 ? (r[13] | 0) : 0;
    const cl = r.length > 14 ? (r[14] >>> 0) : 0;

    const img = resolveTex(ai, '第 ' + i + ' 行');
    const bimg = resolveTex(bi, '第 ' + i + ' 行');
    if (w <= 0 || h <= 0) throw new Error('第 ' + i + ' 行尺寸非法');

    // 形态数组：稀疏存放在 st 表里，键是行下标
    let st = null;
    if (stMap && stMap[i] != null) {
      const raw = stMap[i];
      if (!Array.isArray(raw) || raw.length < 1) throw new Error('第 ' + i + ' 行形态格式错误');
      st = raw.map((s, j) => {
        if (!Array.isArray(s) || s.length < 4) throw new Error('第 ' + i + ' 行形态 ' + j + ' 格式错误');
        const [sa, sb, sw, sh] = s;
        for (const v of s) {
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new Error('第 ' + i + ' 行形态 ' + j + ' 含非有限数值');
          }
        }
        if (sw <= 0 || sh <= 0) throw new Error('第 ' + i + ' 行形态 ' + j + ' 尺寸非法');
        const simg = resolveTex(sa, '第 ' + i + ' 行形态');
        const sbimg = resolveTex(sb, '第 ' + i + ' 行形态');
        return { img: simg || sbimg, bimg: sbimg || simg, w: sw, h: sh };
      });
      if (si < 0 || si >= st.length) throw new Error('第 ' + i + ' 行形态下标越界');
    } else if (si !== 0) {
      throw new Error('第 ' + i + ' 行有形态下标但没有形态数据');
    }

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

    // 多形态棋子的当前图片/尺寸以形态表为准（st 是权威，
    // 行里的 img/w 只是写入时的快照，两者理应一致，以 st 为准更稳）
    let fimg = img || bimg, fbimg = bimg || img, fw = w, fh = h;
    if (st) {
      const cur = st[si] || st[0];
      fimg = cur.img; fbimg = cur.bimg; fw = cur.w; fh = cur.h;
    }

    pieces.push({
      id,
      x, y,
      // r 用**一位小数**保留，不能 Math.round 成整数。
      // 场景里 7796 枚棋子有 596 枚的 r 是非整数（如 0.27），
      // 那是 rotY 换算后的小数部分。encode 按 r1() 写一位小数、
      // decode 却取整，于是「导出再导入」每轮都在丢精度，
      // 存档字节数也随之下漂（实测 92300 -> 91900）。不报错但不可逆。
      r: normR(rot),
      f: f ? 1 : 0,
      w: fw, h: fh,
      img: fimg,
      bimg: fbimg,
      z,
      lk,
      si,
      st,
      ds: [2, 4, 6, 10, 12].indexOf(ds) >= 0 ? ds : 0,
      v: dv,
      sh: [1, 2, 3, 4].indexOf(sh) >= 0 ? sh : 0,
      c: cl
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

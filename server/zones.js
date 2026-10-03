/*
 * zones.js —— 视野区（双盲的判定核心）
 *
 * 一个「视野区」是一块矩形，加上「谁能看见」与「看见什么」：
 *
 *   { id, name, x, y, w, h, see:[队伍id], mode:'hide'|'blind' }
 *
 *   x/y 是世界坐标的**左上角**（允许负宽高，会归一成左上角 + 正尺寸）
 *   see   名单内的队伍享受完整可见
 *   hide  不在名单里 = **完全不知道这块区域存在**（连框都看不到）
 *   blind 不在名单里 = 看得见框，但里面的棋子只显示背面
 *
 * 判定规则的优先级（**这条要定死，否则行为不可预测**）：
 *
 *   1. 只要有任何一块区域**授权**了该队伍 -> 完整可见
 *      （明确授权压过遮挡：重叠区域里出现「给了权限却还看不见」
 *        是最难解释的行为）
 *   2. 否则有任何一块 hide 区覆盖 -> 不可见（连 id 都不下发）
 *   3. 否则有任何一块 blind 区覆盖 -> 可见但脱敏
 *   4. 都不沾 -> 正常可见
 *
 * 「脱敏」是**服务端做**的：把 img 换成背面图、清掉 st（备用形态）
 * 与 tx（文字）。只把 f 置 1 是不够的 —— 前端仍能读到 img 与 st，
 * 那就等于没做双盲。
 */
'use strict';

const MODES = ['hide', 'blind'];
const MAX_ZONES = 32;
const MIN_SIZE = 4;
const MAX_SIZE = 1e7;
const MAX_SEE = 8;
const ZONE_ID = /^[A-Za-z0-9_-]{1,32}$/;

function num(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

function cleanText(raw, max) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * 归一化一块区域。非法输入返回 null（调用方整条拒绝，不做部分接受）。
 * forceId 用于「按 id 更新」时保持 id 不变。
 */
function normZone(raw, forceId) {
  if (!raw || typeof raw !== 'object') return null;

  let x = num(raw.x), y = num(raw.y), w = num(raw.w), h = num(raw.h);
  if (x === null || y === null || w === null || h === null) return null;

  // 从右下往左上拖会得到负宽高，归一成左上角 + 正尺寸
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }

  if (w < MIN_SIZE || h < MIN_SIZE) return null;
  if (w > MAX_SIZE || h > MAX_SIZE) return null;

  const see = Array.isArray(raw.see)
    ? raw.see.filter((s) => typeof s === 'string' && s).slice(0, MAX_SEE)
    : [];

  const mode = MODES.indexOf(raw.mode) >= 0 ? raw.mode : 'hide';

  let id = cleanText(forceId || raw.id, 32);
  if (!ZONE_ID.test(id)) {
    id = 'z' + Math.random().toString(36).slice(2, 10);
  }

  return {
    id: id,
    name: cleanText(raw.name, 24) || '视野区',
    x: x, y: y, w: w, h: h,
    see: see,
    mode: mode
  };
}

// 棋子按**中心点**判是否落在区域内
function inRect(px, py, z) {
  return px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h;
}

/**
 * 求一枚棋子对某队伍的可见性。
 * 返回 { hidden, blind } —— 两者不会同时为真。
 */
function resolve(piece, zones, teamId) {
  if (!zones || !zones.length) return { hidden: false, blind: false };

  let granted = false, hidden = false, blind = false;

  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (!inRect(piece.x, piece.y, z)) continue;

    if (teamId && z.see.indexOf(teamId) >= 0) { granted = true; break; }
    if (z.mode === 'blind') blind = true;
    else hidden = true;
  }

  if (granted) return { hidden: false, blind: false };
  return { hidden: hidden, blind: blind && !hidden };
}

/**
 * 脱敏副本。
 *
 * 关键：**不能只把 f 置 1**。那样 img（正面贴图 id）和 st（备用形态）
 * 仍在下发，抓包或看内存就能知道是什么棋 —— 等于没做双盲。
 * 所以要把会和「正面」相关的字段都换掉：
 *   img -> 背面图、f -> 1、st -> null（形态表里也是正面信息）、tx -> ''（文字牌内容）
 * 保留 ds/v（骰子点数要公开）、c/sh（标记的外形颜色）。
 */
function blindCopy(p) {
  return Object.assign({}, p, {
    f: 1,
    img: p.bimg || p.img,
    st: null,
    si: 0,
    tx: ''
  });
}

/** 该队伍能看到这枚棋子吗？能看到则返回（可能脱敏的）副本，否则 null。 */
function pieceFor(piece, zones, teamId) {
  const r = resolve(piece, zones, teamId);
  if (r.hidden) return null;
  if (r.blind) return blindCopy(piece);
  return piece;
}

/**
 * 该队伍能看到哪些**区域本身**。
 *
 * blind 区人人都能看到框 —— 它的语义就是「你知道这边有块区域，
 * 但不知道里面是什么」。
 * hide 区不在名单里就完全看不到：连「这里有个禁区」也是情报。
 */
function zoneList(zones, teamId) {
  if (!zones || !zones.length) return [];
  return zones.filter(function (z) {
    if (z.mode !== 'hide') return true;
    return !!(teamId && z.see.indexOf(teamId) >= 0);
  });
}

/** 能否看到这枚棋子的真实正面。用于拦住「翻面/切形态」这类会泄露的操作。 */
function full(piece, zones, teamId) {
  const r = resolve(piece, zones, teamId);
  return !r.hidden && !r.blind;
}

module.exports = {
  MODES, MAX_ZONES, MIN_SIZE, MAX_SIZE,
  normZone, inRect, resolve, pieceFor, zoneList, full, blindCopy
};

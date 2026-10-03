/*
 * index.js —— HTTP 静态服务 + 存档 API + WebSocket 纯中继
 *
 * 依赖只有 ws 一个。不用 express、不用 Socket.io —— readme 明确要求
 * 「摒弃重型 Socket.io，改用极简原生 WebSocket 纯中继」。
 *
 * 中继的职责边界：
 *   - 分配 seq / z（唯一不能省的事，见 room.js 顶部注释）
 *   - 维护权威状态副本
 *   - 广播
 * 不做：规则判定、权限裁剪、房间管理 UI。
 *
 * 存档走 HTTP 而不是 WebSocket：
 *   导出/导入是一问一答的请求，而且 base64 字符串可能到几十 KB，
 *   走 WS 会顶到 maxPayload，还会把「可靠请求」和「不可靠广播」
 *   两件事混在同一条通道上。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { RoomStore } = require('./room');
const { SceneStore } = require('./scene');
const {
  RoomRegistry, normCode, cleanName, cleanRoomName, MAX_PLAYERS, OFFLINE_GRACE_MS
} = require('./rooms');
const zones = require('./zones');
const codec = require('./codec');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = path.join(__dirname, '..', 'data');

const PING_INTERVAL_MS = 30000;
const MAX_WS_BYTES = 1024 * 1024;     // WS 入站上限（客户端只发小 op，留足余量）
const MAX_API_BYTES = 8 * 1024 * 1024; // 存档 POST 上限

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

// 贴图与场景是构建期产物，内容按内容哈希命名，可以长缓存
const IMMUTABLE = /^\/assets\//;

const scenes = new SceneStore(path.join(PUBLIC_DIR, 'scenes'));

// 房间元数据（谁建的、谁是房主、有谁）与盘面分开存，见 rooms.js 的文件头
const registry = new RoomRegistry({ dir: DATA_DIR });
registry.startSweeper(15000);
const rooms = new RoomStore({
  dir: DATA_DIR,
  scenes,
  scene: scenes.defaultSlug()
});

/* ---------- 工具 ---------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sanitizeRoom(raw) {
  const s = String(raw || 'demo').replace(/[^\w-]/g, '').slice(0, 32);
  return s || 'demo';
}

/* ---------- 房间 API ---------- */

// 从请求头取身份。HTTP 是无状态的，每次都要带，
// **不能**只信 body 里报的 playerId —— 那等于没有权限。
function ident(req) {
  return {
    id: String(req.headers['x-player-id'] || ''),
    token: String(req.headers['x-player-token'] || '')
  };
}

// 鉴权并返回 { room, player }；失败时已写好响应，调用方 return 即可。
function authed(req, res, code) {
  const room = registry.get(code);
  if (!room) {
    sendJson(res, 404, { error: '房间不存在' });
    return null;
  }
  const me = ident(req);
  const player = room.auth(me.id, me.token);
  if (!player) {
    sendJson(res, 403, { error: '身份无效，请重新加入房间' });
    return null;
  }
  return { room, player };
}

// 把房间状态广播给房里所有人（含各自的私密字段，如自己的 token）
function roomState(room, forPlayer) {
  return {
    t: 'room',
    room: room.publicState(),
    you: forPlayer ? {
      id: forPlayer.id,
      name: forPlayer.name,
      teamId: forPlayer.teamId,
      owner: forPlayer.owner
    } : null
  };
}

async function handleRoomApi(req, res, urlPath, query) {
  /* 建房 */
  if (urlPath === '/api/room/create' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await readBody(req, 64 * 1024)); }
    catch (e) { return sendJson(res, 400, { error: '请求体不是 JSON' }); }

    const made = registry.create({
      ownerName: cleanName(payload.name, '玩家'),
      name: payload.roomName
    });
    if (!made) return sendJson(res, 503, { error: '房间已满，请稍后再试' });

    // 建房者直接算在线（下一步就连 WS 了）
    made.room.setOnline(made.player.id, true);
    console.log(`[room] 新建 ${made.room.code} "${made.room.name}" 房主 ${made.player.name}`);

    return sendJson(res, 200, {
      ok: true,
      code: made.room.code,
      playerId: made.player.id,
      token: made.player.token,
      room: made.room.publicState()
    });
  }

  /* 加入 */
  if (urlPath === '/api/room/join' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await readBody(req, 64 * 1024)); }
    catch (e) { return sendJson(res, 400, { error: '请求体不是 JSON' }); }

    const code = normCode(payload.code);
    const room = registry.get(code);
    if (!room) return sendJson(res, 404, { error: '邀请码无效' });

    const existing = payload.playerId && payload.token
      ? room.auth(payload.playerId, payload.token) : null;

    // 老玩家带对了凭证 -> 直接复用身份（刷新页面走这条）
    if (existing) {
      room.setOnline(existing.id, true);
      if (payload.name) room.setName(existing.id, payload.name);
      return sendJson(res, 200, {
        ok: true, code: room.code, reused: true,
        playerId: existing.id, token: existing.token,
        room: room.publicState()
      });
    }

    const p = room.addPlayer(payload.name);
    if (!p) return sendJson(res, 503, { error: '房间人数已满（' + MAX_PLAYERS + ' 人）' });
    room.setOnline(p.id, true);
    console.log(`[room] ${room.code} + ${p.name}`);

    return sendJson(res, 200, {
      ok: true, code: room.code, reused: false,
      playerId: p.id, token: p.token,
      room: room.publicState()
    });
  }

  /* 查房间：不鉴权，只用来让「加入」界面先确认邀请码有效、显示房名。
     刻意**不返回玩家列表与 token** —— 还没证明身份的人不该看到房里有什么人。 */
  if (urlPath === '/api/room/info') {
    const room = registry.get(normCode(query.get('code')));
    if (!room) return sendJson(res, 404, { error: '邀请码无效' });
    return sendJson(res, 200, {
      ok: true,
      code: room.code,
      name: room.name,
      playerCount: room.players.size,
      maxPlayers: MAX_PLAYERS,
      teams: room.teams
    });
  }

  /* 改队伍：房主可改任何人；普通人只能改自己 */
  if (urlPath === '/api/room/team' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await readBody(req, 64 * 1024)); }
    catch (e) { return sendJson(res, 400, { error: '请求体不是 JSON' }); }

    const a = authed(req, res, normCode(payload.code));
    if (!a) return;

    const target = String(payload.targetId || a.player.id);
    // **只有房主能改队伍，包括改自己。**
    //
    // 早期允许「自己改自己」，但那样队伍就不受控了：房里任何人都能
    // 点一下切到红方、再点一下切到旁观看穿全部 —— 双盲形同虚设。
    // 队伍是**房主分配的**，这才是它的语义。
    if (!a.room.isOwner(a.player.id)) {
      return sendJson(res, 403, { error: '只有房主能调整队伍' });
    }
    if (!a.room.get(target)) return sendJson(res, 404, { error: '玩家不在房间里' });

    const teamId = payload.teamId == null ? null : String(payload.teamId);
    const before = (a.room.get(target) || {}).teamId || null;
    if (!a.room.setTeam(target, teamId)) {
      return sendJson(res, 400, { error: '队伍不存在' });
    }

    // 换队会改变「能看到什么」，所以广播完状态还要推一次可见性差分
    const roomForVis = rooms.get(a.room.code);

    if (before !== teamId) {
      const who = a.room.get(target).name;
      const tname = teamId
        ? (a.room.teams.find((t) => t.id === teamId) || {}).name || teamId
        : '旁观';
      // 自己改自己 vs 房主分配，提示语要能区分
      const byOther = target !== a.player.id;
      emit(a.room, who + (byOther ? ' 被安排到 ' : ' 加入了 ') + tname, 'team');
    }

    broadcastRoomState(a.room);
    if (roomForVis) pushVisibility(roomForVis);
    return sendJson(res, 200, { ok: true, room: a.room.publicState() });
  }

  /* 踢人：仅房主。房主不能踢自己。 */
  if (urlPath === '/api/room/kick' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await readBody(req, 64 * 1024)); }
    catch (e) { return sendJson(res, 400, { error: '请求体不是 JSON' }); }

    const a = authed(req, res, normCode(payload.code));
    if (!a) return;

    if (!a.room.isOwner(a.player.id)) {
      return sendJson(res, 403, { error: '只有房主能踢人' });
    }

    const target = String(payload.targetId || '');
    if (target === a.player.id) {
      return sendJson(res, 400, { error: '房主不能踢自己' });
    }

    const victim = a.room.get(target);
    if (!victim) return sendJson(res, 404, { error: '玩家不在房间里' });

    a.room.removePlayer(target);

    // 把被踢的人从房间里断开。他的 token 已随名册一起删掉，
    // 所以即便他拿着旧凭证重连，也会在 WS 握手时被拒。
    const room = rooms.get(a.room.code);
    if (room) {
      room.clients.forEach((c) => {
        if (c.playerId !== target) return;
        send(c, { t: 'fatal', error: '你已被房主移出房间' });
        try { c.close(4003, 'kicked'); } catch (_) {}
      });
    }

    emit(a.room, victim.name + ' 被房主移出房间', 'kick');
    broadcastRoomState(a.room);
    console.log(`[room] ${a.room.code} 踢出 ${victim.name}`);
    return sendJson(res, 200, { ok: true, room: a.room.publicState() });
  }

  /* 改名 */
  if (urlPath === '/api/room/rename' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await readBody(req, 64 * 1024)); }
    catch (e) { return sendJson(res, 400, { error: '请求体不是 JSON' }); }

    const a = authed(req, res, normCode(payload.code));
    if (!a) return;

    if (payload.roomName != null) {
      if (!a.room.isOwner(a.player.id)) {
        return sendJson(res, 403, { error: '只有房主能改房间名' });
      }
      a.room.name = cleanRoomName(payload.roomName, a.room.name);
    }
    if (payload.name != null) {
      a.room.setName(a.player.id, payload.name);
    }

    broadcastRoomState(a.room);
    return sendJson(res, 200, { ok: true, room: a.room.publicState() });
  }

  return false;   // 不是房间 API
}

/* ---------- 存档 API ---------- */

async function handleApi(req, res, urlPath, query) {
  /* 场景目录 */
  if (urlPath === '/api/scenes') {
    return sendJson(res, 200, { scenes: scenes.list() });
  }

  /* 导出：房间状态 -> base64 字符串（不落文件） */
  if (urlPath === '/api/save') {
    // **只有房主能导出**。
    //
    // 这条同时堵住了双盲的一个旁路：导出的是**全量**盘面
    //（含看不见的棋子与视野区定义），任何成员能调它就能看到全部。
    // 导出是「把整桌备份走」的管理动作，交给房主。
    const code = normCode(query.get('room'));
    const meta = registry.get(code);
    if (!meta) return sendJson(res, 404, { error: '房间不存在' });
    const me = meta.auth(ident(req).id, ident(req).token);
    if (!me) return sendJson(res, 403, { error: '身份无效，请重新加入房间' });
    if (!meta.isOwner(me.id)) {
      return sendJson(res, 403, { error: '只有房主能导出存档' });
    }

    const room = rooms.get(sanitizeRoom(code));
    const compact = codec.encode(Array.from(room.pieces.values()), {
      label: room.label,
      scene: room.scene,
      zones: room.zoneList          // 视野区也是盘面的一部分，见 codec.encode
    });
    const b64 = codec.toBase64(compact);

    return sendJson(res, 200, {
      room: room.id,
      label: room.label,
      scene: room.scene,
      count: compact.p.length,
      bytes: Buffer.byteLength(b64, 'utf8'),
      data: b64
    });
  }

  /* 导入：base64 字符串 -> 替换房间状态，并广播给所有客户端 */
  if (urlPath === '/api/load' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req, MAX_API_BYTES);
    } catch (e) {
      return sendJson(res, 413, { error: e.message });
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch (_) {
      return sendJson(res, 400, { error: '请求体不是 JSON' });
    }

    // **只有房主能导入**：导入会整盘替换（含视野区），
    // 等于把所有人的局面和规则一起改掉，是房间级操作。
    const meta = registry.get(normCode(payload.room));
    if (!meta) return sendJson(res, 404, { error: '房间不存在' });
    const me = meta.auth(ident(req).id, ident(req).token);
    if (!me) return sendJson(res, 403, { error: '身份无效，请重新加入房间' });
    if (!meta.isOwner(me.id)) {
      return sendJson(res, 403, { error: '只有房主能导入存档' });
    }

    const roomId = sanitizeRoom(meta.code);

    let decoded;
    try {
      decoded = codec.decode(codec.fromBase64(payload.data));
    } catch (e) {
      // 存档是用户手动粘贴的，报错要能指明原因
      return sendJson(res, 400, { error: '存档解析失败：' + e.message });
    }

    const room = rooms.get(roomId);
    const n = room.loadPieces(decoded.pieces, {
      scene: payload.scene || '',
      label: decoded.label,
      zones: decoded.zones           // 视野区随盘面一起替换
    });

    // 盘面整个换了，增量补发没有意义 —— 直接给所有人推一份新快照
    room.seq++;
    room.flushNow();
    broadcastRoom(room, { t: 'init', room: roomId });

    console.log(`[api] 载入存档 ${roomId}: ${n} 枚棋子`);
    return sendJson(res, 200, { ok: true, room: roomId, count: n, label: decoded.label });
  }

  /* 切换场景 */
  if (urlPath === '/api/scene' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req, MAX_API_BYTES);
    } catch (e) {
      return sendJson(res, 413, { error: e.message });
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch (_) {
      return sendJson(res, 400, { error: '请求体不是 JSON' });
    }

    const roomId = sanitizeRoom(payload.room);
    const slug = String(payload.slug || '');
    if (!scenes.has(slug)) {
      return sendJson(res, 404, { error: '场景不存在: ' + slug });
    }

    const room = rooms.get(roomId);
    const n = room.loadScene(slug);
    room.seq++;
    room.flushNow();
    broadcastRoom(room, { t: 'init', room: roomId });

    console.log(`[api] 切换场景 ${roomId} -> ${slug}: ${n} 枚`);
    return sendJson(res, 200, { ok: true, room: roomId, scene: slug, count: n });
  }

  return sendJson(res, 404, { error: 'unknown api' });
}

/* ---------- WebSocket ---------- */

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_BYTES });

function send(ws, obj) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (_) {}
}

function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  room.clients.forEach((c) => {
    if (c.readyState === 1) {
      try { c.send(s); } catch (_) {}
    }
  });
}

/**
 * 按连接裁剪一条 op。
 *
 * 返回 null 表示「这条 op 整条都不该发给你」。
 * 返回对象表示可以发，但可能已被裁剪（比如批量 move 里滤掉了看不见的 id）。
 *
 * 逐 op 的处理策略：
 *   move   批量里只保留你看得见的项；全被滤掉就整条不发
 *   clone  新棋子若落在你看不见的区里 -> 不发
 *   dice/token  同理（新物品可能造在隐藏区）
 *   roll   同上，只发你看得见的骰子
 *   zone   区域定义要过滤：hide 区对未授权者是保密的
 *   其它（flip/rot/lock/edit/del/state）单棋子 op，看得见才发
 *
 * **注意 del**：棋子被删掉了就查不到它的位置，只能凭「之前是否
 * 已下发过」判断 —— 这正是 seen 集合的用处。
 */
function filterOp(room, ws, op) {
  if (!op || !op.k) return op;
  const team = ws.teamId || null;
  const canSee = (id) => {
    const p = room.pieces.get(id);
    if (!p) {
      // 已经不在场上了（多半是 del）。用 seen 基线判断：
      // 之前发过就允许通知删除，没发过就当它不存在。
      const seen = room.seen.get(ws);
      return !!(seen && seen.has(id));
    }
    return zones.pieceFor(p, room.zoneList, team) !== null;
  };

  switch (op.k) {
    case 'move': {
      const list = (op.list || []).filter((it) => canSee(it.id));
      if (!list.length) return null;
      return { k: 'move', list: list };
    }
    case 'roll': {
      const list = (op.list || []).filter((it) => canSee(it.id));
      if (!list.length) return null;
      return { k: 'roll', list: list };
    }
    case 'clone':
    case 'dice':
    case 'token': {
      // 新物品的 id 在 piece 里；看不见就整条不发
      const id = op.piece && op.piece.id;
      if (id && !canSee(id)) return null;
      return op;
    }
    case 'zone': {
      // 区域列表按队伍过滤 —— hide 区对未授权者是保密的。
      //
      // **但房主必须看到自己建的全部区域**，否则他刚画完就看不到、
      // 也没法删（实测踩到：房主建了 see:[] 的区，回包里 zone 是 null，
      // 界面上列表空白，看起来像「画了没生效」）。
      // 房主要管理规则，就不能被规则挡住。
      const isOwner = !!(ws.isOwner);
      const vis = (list) => isOwner ? (list || []) : zones.zoneList(list, team);

      const zs = vis(op.zones || room.zoneList);
      if (op.del) return { k: 'zone', del: true, id: op.id, zones: zs };
      const az = op.zone ? vis([op.zone]) : [];
      return { k: 'zone', zone: az[0] || null, zones: zs };
    }
    default: {
      // 单棋子 op：看得见才发
      if (op.id && !canSee(op.id)) return null;
      return op;
    }
  }
}

/**
 * 全量快照广播。
 *
 * **必须逐连接生成**（不再是共用一份字符串）—— 双盲要求每队看到的
 * 盘面不同。共用字符串时，谁看不见什么就只能靠客户端自觉，
 * 而客户端是拿得到全部数据的。
 *
 * 每个连接发完快照后，顺便把它的 `seen` 基线重置为「刚下发的集合」，
 * 后续的可见集差分以此为准。
 */
function broadcastRoom(room, obj) {
  room.clients.forEach((c) => {
    if (c.readyState !== 1) return;
    try {
      c.send(JSON.stringify(Object.assign({}, obj, room.snapshotFor(c))));
    } catch (_) {}
  });
}

/**
 * 把「可见集发生变化」推给受影响的连接。
 *
 * 场景：棋子被拖进/拖出隐藏区、区域被改动、玩家换了队伍。
 * 没有这一步的话，移进隐藏区的棋子会**永远留在**对面屏幕上 ——
 * 这是双盲最容易漏的一环。
 */
function pushVisibility(room) {
  room.clients.forEach((c) => {
    if (c.readyState !== 1) return;
    const d = room.visibilityDiff(c);
    if (!d) return;
    try { c.send(JSON.stringify({ t: 'vis', add: d.add, remove: d.remove })); } catch (_) {}
  });
}

/**
 * 把房间状态广播给房内每个连接。
 *
 * 必须**逐连接**发，不能像 broadcast 那样共用一份字符串 ——
 * 每个人的 `you` 不同（自己的 id/队伍/房主位）。
 * 老玩家带凭证重连时，也靠这条消息恢复「我是谁」。
 */
function broadcastRoomState(meta) {
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room) return;

  const base = meta.publicState();

  // **广播前先把每个连接的 teamId 刷新一遍**。
  // 双盲的判定依赖 c.teamId，如果换队后不更新它，
  // 会出现「列表里我是红方、视野还是旧的」这种诡异状态。
  // 顺带把已不在房间里的连接的基线清掉，避免 Map 泄漏。
  room.clients.forEach((c) => {
    const p = meta.get(c.playerId);
    c.teamId = p ? (p.teamId || null) : null;
    // 房主位也要同步给连接 —— 视野区的过滤要用它
    c.isOwner = !!(p && p.owner);
    if (!p) room.seen.delete(c);
  });

  room.clients.forEach((c) => {
    if (c.readyState !== 1) return;
    const p = meta.get(c.playerId);
    send(c, {
      t: 'room',
      room: base,
      you: p ? {
        id: p.id, name: p.name, teamId: p.teamId, owner: p.owner
      } : null
    });
  });
}

/**
 * 消息流广播（左下角提示）。
 *
 * 只发给**当前在线的人**，不做历史持久化 —— 新进来的人看不到
 * 之前发生了什么。这是明确的取舍：省掉一份存储与淘汰逻辑，
 * 代价是「中途加入的人不知道刚才有人被踢」。
 *
 * kind 用来选颜色/图标：info | join | leave | team | kick | warn
 */
function emit(meta, text, kind) {
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room) return;
  const msg = { t: 'log', text: text, kind: kind || 'info', at: Date.now() };
  room.clients.forEach((c) => {
    if (c.readyState === 1) send(c, msg);
  });
}

function peerCount(room) {
  broadcast(room, { t: 'peer', n: room.clients.size });
}

wss.on('connection', (ws, req) => {
  let roomId = '';
  let name = '';
  let pid = '';
  let token = '';
  let code = '';
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    code = normCode(q.get('room'));
    name = String(q.get('name') || '').slice(0, 24);
    pid = String(q.get('pid') || '');
    token = String(q.get('token') || '');
  } catch (_) {}

  // 必须是已注册的房间，而且凭证要对。
  //
  // 这里**不能**回落到「随便建一个房间」：以前 rooms.get() 是随手就建，
  // 于是任何知道房间名的人都能开一个新房间。现在房间必须先由
  // /api/room/create 建出来，WS 只认已存在的。
  const meta = registry.get(code);
  if (!meta) {
    send(ws, { t: 'fatal', error: '房间不存在，请从主页重新进入' });
    try { ws.close(4004, 'no room'); } catch (_) {}
    return;
  }

  const player = meta.auth(pid, token);
  if (!player) {
    // 身份无效（被踢、换了设备、清过缓存）-> 明确告知并断开，
    // 让前端退回主页重新加入，而不是当匿名用户混进来。
    send(ws, { t: 'fatal', error: '身份已失效，请重新加入房间' });
    try { ws.close(4003, 'bad auth'); } catch (_) {}
    return;
  }

  roomId = code;
  name = player.name;

  const room = rooms.get(roomId);

  ws.isAlive = true;
  ws.roomId = roomId;
  ws.name = name;
  ws.playerId = player.id;
  ws.code = code;
  room.clients.add(ws);

  meta.setOnline(player.id, true);

  // 进场即全量快照。重连也走这条路 —— 所以这版不需要增量补发/重放机制。
  // **必须用 snapshotFor(ws)**，不能用 snapshot() —— 后者是完整盘面，
  // 会把隐藏区里的棋子一并下发，双盲当场失效。
  ws.teamId = player.teamId || null;
  ws.isOwner = !!player.owner;
  send(ws, Object.assign({ t: 'init', room: roomId }, room.snapshotFor(ws)));
  // 房间状态（玩家列表 / 队伍）单独给：它是元数据，不是盘面
  send(ws, roomState(meta, player));
  peerCount(room);
  // 别人也要看到「谁来了」
  broadcastRoomState(meta);
  emit(meta, player.name + ' 进入了房间', 'join');

  console.log(`[ws] + ${roomId} "${name}" -> ${room.clients.size} 人 (${room.pieces.size} 枚)`);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || m.t !== 'op') return;

    // 改视野区是**房主专属**：它是双盲规则的载体，
    // 让任何人都能改等于让任何人都能给自己开视野。
    if (m.op && m.op.k === 'zone') {
      const meta2 = registry.get(code);
      const me2 = meta2 && meta2.get(ws.playerId);
      if (!me2 || !meta2.isOwner(me2.id)) {
        send(ws, { t: 'log', kind: 'warn', text: '只有房主能调整视野区' });
        return;
      }
    }

    // 拦住会泄露「正面信息」的操作。
    //
    // 你能看到一枚棋子但只能看到背面（盲区）时，**翻面 / 切形态**
    // 这类操作会让你间接读到正面 —— 比如连点形态看轮廓变化。
    // 移动、冻结、删除是允许的：那些不泄露它是什么棋。
    if (m.op && room.zoneList.length &&
        (m.op.k === 'flip' || m.op.k === 'state')) {
      const target = room.pieces.get(m.op.id);
      if (target && !room.canSeeFull(ws, target)) {
        send(ws, { t: 'log', kind: 'warn', text: '这枚棋子被遮挡，无法翻面/切换形态' });
        return;
      }
    }

    const norm = room.applyOp(m.op);
    if (!norm) return;

    // 直接透传 applyOp 的返回值，不要手工挑字段：
    // move 带 list 数组（含服务端分配的 z），手挑字段会把 list 悄悄丢掉。
    //
    // 但**逐连接发**，因为 op 里可能带着看不见的棋子：
    // 比如一次批量 move 里既有可见的也有隐藏区的，
    // 或者别人移动了你看不见的棋子（那种情况整个 op 都不该发给你）。
    const zoneOn = room.zoneList.length > 0;
    room.clients.forEach((c) => {
      if (c.readyState !== 1) return;
      const filtered = zoneOn ? filterOp(room, c, norm) : norm;
      if (!filtered) return;              // 整条 op 与你无关
      try {
        c.send(JSON.stringify({ t: 'op', seq: room.seq, by: name, op: filtered }));
      } catch (_) {}
    });

    // 可见集可能变了（棋子进出隐藏区 / 区域本身被改动）
    if (zoneOn) pushVisibility(room);
  });

  const leave = () => {
    if (!room.clients.has(ws)) return;
    room.clients.delete(ws);
    peerCount(room);
    room.save();

    // 标记离线但**不把人踢出名册** —— 60s 宽限期内刷新能回到原队伍。
    // 真正移除由 registry 的 sweeper 到期处理。
    const m = registry.get(code);
    if (m && m.get(player.id)) {
      // 同一个人可能开了多个标签页：还有别的连接就不算离线
      let stillHere = false;
      room.clients.forEach((c) => { if (c.playerId === player.id) stillHere = true; });
      if (!stillHere) {
        m.setOnline(player.id, false);
        broadcastRoomState(m);
        emit(m, player.name + ' 离开了房间', 'leave');
        console.log(`[ws]   ${player.name} 离线（${OFFLINE_GRACE_MS / 1000}s 内可回来）`);
      }
    }

    console.log(`[ws] - ${roomId} "${name}" -> ${room.clients.size} 人`);
  };

  ws.on('close', leave);
  ws.on('error', leave);
});

// 心跳：不做这个，长时间挂机会留下死连接，peer 计数虚高
const heart = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, PING_INTERVAL_MS);
heart.unref();

/* ---------- HTTP ---------- */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch (_) {
    res.writeHead(400);
    return res.end('bad request');
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(url.pathname);
  } catch (_) {
    res.writeHead(400);
    return res.end('bad request');
  }

  if (urlPath.startsWith('/api/')) {
    try {
      const handled = await handleRoomApi(req, res, urlPath, url.searchParams);
      if (handled !== false) return handled;
      return await handleApi(req, res, urlPath, url.searchParams);
    } catch (e) {
      console.error('[api] 未捕获异常', e);
      return sendJson(res, 500, { error: '服务器内部错误' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('method not allowed');
  }

  if (urlPath === '/') urlPath = '/index.html';

  // 目录穿越防护：解析后必须仍在 PUBLIC_DIR 内
  const filePath = path.resolve(PUBLIC_DIR, '.' + urlPath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }

    const headers = {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size
    };
    // 贴图按内容哈希命名，可以放心长缓存（低端机上省掉重复下载）
    headers['Cache-Control'] = IMMUTABLE.test(urlPath)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache, no-store, must-revalidate';

    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
});

// WS 挂在同一个 http server 上。用 noServer + 手动 handleUpgrade，
// 这样 /ws 之外的 upgrade 请求会被明确拒绝，而不是被静默接管。
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (_) {}
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/* ---------- 生命周期 ---------- */

server.listen(PORT, HOST, () => {
  const d = scenes.defaultSlug();
  console.log(`web-tts  http://localhost:${PORT}/?room=demo`);
  console.log(`局域网访问: http://<本机IP>:${PORT}/?room=demo`);
  console.log(`场景: ${scenes.list().length} 个${d ? '，默认 ' + d : '（未找到，先跑 tools/build_assets.py）'}`);
});

function shutdown(sig) {
  console.log(`\n[${sig}] 落盘并退出…`);
  clearInterval(heart);
  rooms.flushAll();
  wss.close();
  server.close();
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

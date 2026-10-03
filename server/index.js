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
    // **权限校验**：不是房主就只能改自己。这一条是硬的 ——
    // 前端把按钮藏起来只是体验，真正拦住越权的是这里。
    if (target !== a.player.id && !a.room.isOwner(a.player.id)) {
      return sendJson(res, 403, { error: '只有房主能调整别人的队伍' });
    }
    if (!a.room.get(target)) return sendJson(res, 404, { error: '玩家不在房间里' });

    const teamId = payload.teamId == null ? null : String(payload.teamId);
    const before = (a.room.get(target) || {}).teamId || null;
    if (!a.room.setTeam(target, teamId)) {
      return sendJson(res, 400, { error: '队伍不存在' });
    }

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
    const room = rooms.get(sanitizeRoom(query.get('room')));
    const compact = codec.encode(Array.from(room.pieces.values()), {
      label: room.label,
      scene: room.scene
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

    const roomId = sanitizeRoom(payload.room);

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
      label: decoded.label
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

function broadcastRoom(room, obj) {
  const s = JSON.stringify(Object.assign({}, obj, room.snapshot()));
  room.clients.forEach((c) => {
    if (c.readyState === 1) {
      try { c.send(s); } catch (_) {}
    }
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
  send(ws, Object.assign({ t: 'init', room: roomId }, room.snapshot()));
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

    const norm = room.applyOp(m.op);
    if (!norm) return;

    // 直接透传 applyOp 的返回值，不要手工挑字段：
    // move 带 list 数组（含服务端分配的 z），手挑字段会把 list 悄悄丢掉。
    broadcast(room, { t: 'op', seq: room.seq, by: name, op: norm });
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

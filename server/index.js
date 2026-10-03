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

function peerCount(room) {
  broadcast(room, { t: 'peer', n: room.clients.size });
}

wss.on('connection', (ws, req) => {
  let roomId = 'demo';
  let name = '';
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    roomId = sanitizeRoom(q.get('room'));
    name = String(q.get('name') || '').slice(0, 24);
  } catch (_) {}

  const room = rooms.get(roomId);

  ws.isAlive = true;
  ws.roomId = roomId;
  ws.name = name;
  room.clients.add(ws);

  // 进场即全量快照。重连也走这条路 —— 所以这版不需要增量补发/重放机制。
  send(ws, Object.assign({ t: 'init', room: roomId }, room.snapshot()));
  peerCount(room);

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

/*
 * index.js —— HTTP 静态服务 + WebSocket 纯中继
 *
 * 依赖只有 ws 一个。不用 express、不用 Socket.io —— README 明确要求
 * 「摒弃重型 Socket.io，改用极简原生 WebSocket 纯中继」。
 *
 * 中继的职责边界：
 *   - 分配 seq（唯一不能省的事，见 room.js 顶部注释）
 *   - 维护权威状态副本
 *   - 广播
 * 不做：规则判定、权限裁剪、房间管理 UI。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { RoomStore } = require('./room');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = path.join(__dirname, '..', 'data');

const PING_INTERVAL_MS = 30000;
const MAX_MSG_BYTES = 64 * 1024;

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

const rooms = new RoomStore({ dir: DATA_DIR });

/* ---------- 静态文件 ---------- */

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('method not allowed');
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (_) {
    res.writeHead(400);
    return res.end('bad request');
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

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      // demo 阶段禁用缓存，改完刷新即生效
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });

    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
});

/* ---------- WebSocket ---------- */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });

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

function peerCount(room) {
  broadcast(room, { t: 'peer', n: room.clients.size });
}

function sanitizeRoom(raw) {
  const s = String(raw || 'demo').replace(/[^\w-]/g, '').slice(0, 32);
  return s || 'demo';
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

  console.log(`[ws] + ${roomId} "${name}" -> ${room.clients.size} 人`);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || m.t !== 'op') return;

    const norm = room.applyOp(m.op);
    if (!norm) return;

    // 广播给所有人，包含发送者：这样发送者的乐观应用被服务端权威值覆盖，
    // 两端收敛到同一份数据。
    broadcast(room, {
      t: 'op',
      seq: room.seq,
      by: name,
      op: {
        k: norm.k,
        id: norm.id,
        x: norm.x,
        y: norm.y,
        r: norm.r,
        f: norm.f
      }
    });
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

/* ---------- 生命周期 ---------- */

server.listen(PORT, HOST, () => {
  console.log(`web-tts  http://localhost:${PORT}/?room=demo`);
  console.log(`局域网访问: http://<本机IP>:${PORT}/?room=demo`);
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

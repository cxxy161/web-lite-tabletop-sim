/*
 * app.js —— 组装层：状态 + 渲染 + 输入 + 网络
 *
 * 分层原则：
 *   board.js  只认像素和世界坐标，不知道棋子和网络的存在
 *   net.js    只认字节，不知道棋子的存在
 *   app.js    在这里把两边接起来，并持有唯一的权威状态副本
 *
 * 幂等约定：所有 op 都是绝对赋值（move 设坐标而非加位移），
 * 因此本地乐观应用 + 服务端回显重复应用 = 无害，demo 阶段不需要回滚。
 */
(function (global) {
  'use strict';

  /* ---------- 配置 ---------- */

  var COLS = 12;
  var ROWS = 20;          // 9 + 2 + 9 行：216 枚棋子（覆盖 README 的 200+）+ 中间 2 行空地带
  var CELL = 64;          // 世界坐标下的格边长（逻辑单位，不是像素）

  var qs = new URLSearchParams(global.location.search);
  var ROOM = (qs.get('room') || 'demo').replace(/[^\w-]/g, '').slice(0, 32) || 'demo';
  var NAME = (qs.get('name') || '').slice(0, 24);

  /* ---------- 状态 ---------- */

  var pieces = new Map();     // id -> {id,x,y,r,f,k}，x/y 为网格坐标（可含小数）
  var selected = null;
  var dragging = null;
  var dragFrom = null;
  var seq = 0;

  var elHudRoom = document.getElementById('hud-room');
  var elHudConn = document.getElementById('hud-conn');
  var elHudPeers = document.getElementById('hud-peers');
  var elHudSeq = document.getElementById('hud-seq');

  elHudRoom.textContent = ROOM;

  /* ---------- 图集 ---------- */

  var atlas = global.Atlas.build();

  /* ---------- 渲染器 ---------- */

  var board = global.Board.create({
    bg: document.getElementById('bg'),
    fg: document.getElementById('fg'),
    atlas: atlas,
    cell: CELL,
    cols: COLS,
    rows: ROWS,
    onTap: onTap,
    onContext: onContext,
    onDragStart: onDragStart,
    onDragMove: onDragMove,
    onDragEnd: onDragEnd
  });

  board.setHitTest(function (wx, wy) {
    return pick(wx, wy);
  });

  var ACell = global.Atlas.CELL;

  board.setDrawer(function (g, view) {
    var s = view.s;

    // 拖拽中的棋子最后画，保证浮在最上层
    var list = [];
    pieces.forEach(function (p) { if (p !== dragging) list.push(p); });
    if (dragging) list.push(dragging);

    var showDetail = CELL * s >= 14;   // 缩得太小时省掉描边，优先保帧率
    var rotFill = new Array(4);

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var idx = global.Atlas.indexOf(p.k, p.f);
      var sx = (idx % global.Atlas.COLS) * ACell;
      var sy = Math.floor(idx / global.Atlas.COLS) * ACell;

      var dx = p.x * CELL;
      var dy = p.y * CELL;
      var rr = p.r || 0;

      if (rr) {
        g.save();
        g.translate(dx + CELL / 2, dy + CELL / 2);
        g.rotate(rr * Math.PI / 180);
        g.drawImage(atlas, sx, sy, ACell, ACell, -CELL / 2, -CELL / 2, CELL, CELL);
        if (showDetail && p === selected) strokeSel(g, -CELL / 2, -CELL / 2);
        g.restore();
      } else {
        g.drawImage(atlas, sx, sy, ACell, ACell, dx, dy, CELL, CELL);
        if (showDetail && p === selected) strokeSel(g, dx, dy);
      }
    }
  });

  function strokeSel(g, x, y) {
    g.strokeStyle = '#4c9aff';
    g.lineWidth = 2 / Math.max(board.view.s, 0.2);
    g.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
  }

  function pick(wx, wy) {
    var gx = Math.floor(wx / CELL);
    var gy = Math.floor(wy / CELL);
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return null;

    // 后写的在上层，倒序查找
    var best = null;
    pieces.forEach(function (p) {
      if (Math.floor(p.x) === gx && Math.floor(p.y) === gy) best = p;
    });
    return best;
  }

  /* ---------- 操作（本地乐观应用 + 广播） ---------- */

  // 注意：拖拽过程中只改本地，松手才发 op。
  // 否则 200 枚棋子场景下每秒几十条 move 会把中继打爆。

  function sendOp(op) {
    net.send({ t: 'op', op: op });
  }

  function applyOp(op, fromRemote) {
    var p = pieces.get(op.id);
    if (!p) return;

    if (op.k === 'move') { p.x = op.x; p.y = op.y; }
    else if (op.k === 'flip') { p.f = op.f ? 1 : 0; }
    else if (op.k === 'rot') { p.r = ((op.r | 0) % 360 + 360) % 360; }

    if (!fromRemote) board.requestDraw();
  }

  function commit(op) {
    applyOp(op, false);
    board.requestDraw();
    sendOp(op);
  }

  /* ---------- 输入回调 ---------- */

  function onTap(e) {
    var hit = e.hit;

    if (hit) {
      // 点到棋子：选中（再点一次取消）
      selected = (selected === hit) ? null : hit;
      board.requestDraw();
      return;
    }

    // 点到空格：若有选中棋子 -> 吸附落子
    if (selected && e.gx >= 0 && e.gy >= 0 && e.gx < COLS && e.gy < ROWS) {
      var gx = Math.floor(e.gx);
      var gy = Math.floor(e.gy);
      var prev = { x: selected.x, y: selected.y };
      if (Math.floor(prev.x) !== gx || Math.floor(prev.y) !== gy) {
        commit({ k: 'move', id: selected.id, x: gx, y: gy });
      }
      return;
    }

    selected = null;
    board.requestDraw();
  }

  function onDragStart(p) {
    selected = p;
    dragging = p;
    dragFrom = { x: p.x, y: p.y };
    board.requestDraw();
  }

  function onDragMove(p, wx, wy) {
    // 让棋子中心跟随手指
    p.x = wx / CELL - 0.5;
    p.y = wy / CELL - 0.5;
    board.requestDraw();
  }

  function onDragEnd(p) {
    var x = Math.max(0, Math.min(COLS - 1, Math.round(p.x)));
    var y = Math.max(0, Math.min(ROWS - 1, Math.round(p.y)));
    dragging = null;

    var moved = !dragFrom || dragFrom.x !== x || dragFrom.y !== y || p.x !== x || p.y !== y;
    p.x = x; p.y = y;
    dragFrom = null;
    board.requestDraw();

    if (moved) sendOp({ k: 'move', id: p.id, x: x, y: y });
  }

  // 桌面端右键：翻面；Shift+右键：旋转 90°
  function onContext(e) {
    var p = e.hit;
    if (!p) return;
    if (e.shiftKey) commit({ k: 'rot', id: p.id, r: ((p.r || 0) + 90) % 360 });
    else commit({ k: 'flip', id: p.id, f: p.f ? 0 : 1 });
  }

  /* ---------- 网络 ---------- */

  var net = global.Net({
    url: (location.protocol === 'https:' ? 'wss://' : 'ws://') +
         location.host + '/ws?room=' + encodeURIComponent(ROOM) +
         (NAME ? '&name=' + encodeURIComponent(NAME) : ''),

    onOpen: function () {
      elHudConn.textContent = '已连接';
      elHudConn.className = 'on';
    },

    onClose: function () {
      elHudConn.textContent = '重连中';
      elHudConn.className = 'off';
    },

    // 全量状态：首次进入、断线重连都走这里
    onInit: function (m) {
      seq = m.seq | 0;
      CELL = m.cell || CELL;
      COLS = m.cols || COLS;
      ROWS = m.rows || ROWS;

      pieces.clear();
      (m.pieces || []).forEach(function (p) { pieces.set(p.id, p); });

      selected = null;
      dragging = null;
      dragFrom = null;

      board.setCell(CELL);
      board.setGrid(COLS, ROWS);
      board.fit();
      board.requestDraw();
      syncHud();
    },

    onOp: function (m) {
      seq = m.seq | 0;
      applyOp(m.op, true);
      board.requestDraw();
      syncHud();
    },

    onPeer: function (n) {
      elHudPeers.textContent = n + ' 人';
    }
  });

  function syncHud() {
    elHudSeq.textContent = 'seq ' + seq;
  }

  /* ---------- 工具按钮 ---------- */

  document.getElementById('btn-fit').addEventListener('click', function () {
    board.fit();
  });

  document.getElementById('btn-flipall').addEventListener('click', function () {
    pieces.forEach(function (p) {
      commit({ k: 'flip', id: p.id, f: p.f ? 0 : 1 });
    });
  });

  /* ---------- 键盘（桌面端调试用） ---------- */

  global.addEventListener('keydown', function (e) {
    if (!selected) return;
    if (e.key === 'f') commit({ k: 'flip', id: selected.id, f: selected.f ? 0 : 1 });
    else if (e.key === 'r') commit({ k: 'rot', id: selected.id, r: ((selected.r || 0) + 90) % 360 });
  });

  /* ---------- 启动 ---------- */

  board.fit();
  syncHud();

  global.__app = {
    pieces: pieces,
    board: board,
    net: net,
    commit: commit
  };
})(window);

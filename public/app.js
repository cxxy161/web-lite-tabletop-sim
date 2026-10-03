/*
 * app.js —— 组装层：状态 + 渲染 + 输入 + 网络
 *
 * 分层原则：
 *   board.js  只认世界坐标和像素，不知道棋子和网络的存在
 *   net.js    只认字节，不知道棋子的存在
 *   app.js    在这里把两边接起来，并持有唯一的权威状态副本
 *
 * 坐标约定（本次重做的重点）：
 *   - 棋子位置是 **任意浮点世界坐标**，表示棋子中心。不吸附、不取整。
 *   - 地图无边界，棋子可以放在任何地方（包括负坐标、很大的坐标）。
 *   - 世界坐标没有「大小」概念，只有 PIECE 这个渲染尺寸。
 *
 * 绘制坐标系（见 board.js 文件头第 4 条）：
 *   canvas 已 scale(view.s) 但未 translate，
 *   所以绘制坐标 = 世界坐标 - (view.ox, view.oy)。
 *   写成 p.x - view.ox 而不是 p.x + view.tx/view.s，
 *   是为避免在超大坐标下丢精度。
 */
(function (global) {
  'use strict';

  /* ---------- 配置 ---------- */

  var PIECE = 64;        // 棋子的世界尺寸（逻辑单位，不是像素）

  var qs = new URLSearchParams(global.location.search);
  var ROOM = (qs.get('room') || 'demo').replace(/[^\w-]/g, '').slice(0, 32) || 'demo';
  var NAME = (qs.get('name') || '').slice(0, 24);

  /* ---------- 状态 ---------- */

  var pieces = new Map();     // id -> {id,x,y,r,f,k}，x/y 为浮点中心坐标
  var selected = null;
  var dragging = null;
  var dragMoved = false;
  var seq = 0;

  var elHudRoom = document.getElementById('hud-room');
  var elHudConn = document.getElementById('hud-conn');
  var elHudPeers = document.getElementById('hud-peers');
  var elHudSeq = document.getElementById('hud-seq');
  var elHudPos = document.getElementById('hud-pos');

  elHudRoom.textContent = ROOM;

  /* ---------- 图集 ---------- */

  var atlas = global.Atlas.build();
  var ACell = global.Atlas.CELL;

  /* ---------- 渲染器 ---------- */

  var board = global.Board.create({
    bg: document.getElementById('bg'),
    fg: document.getElementById('fg'),
    onTap: onTap,
    onContext: onContext,
    onDragStart: onDragStart,
    onDragMove: onDragMove,
    onDragEnd: onDragEnd
  });

  board.setHitTest(function (wx, wy) {
    return pick(wx, wy);
  });

  board.setDrawer(function (g, view) {
    var s = view.s;
    var ox = view.ox, oy = view.oy;
    var w = board.size.w, h = board.size.h;
    var half = PIECE / 2;
    var showDetail = PIECE * s >= 14;   // 缩得太小时省掉描边，优先保帧率

    // 视口裁剪：棋子虽不多，但无限地图上没必要画屏幕外的
    var m = PIECE;   // 留一个棋子的余量
    var x0 = ox - m, x1 = ox + w / s + m;
    var y0 = oy - m, y1 = oy + h / s + m;

    var list = [];
    pieces.forEach(function (p) {
      if (p.x + half < x0 || p.x - half > x1) return;
      if (p.y + half < y0 || p.y - half > y1) return;
      if (p !== dragging) list.push(p);
    });
    if (dragging) list.push(dragging);   // 拖拽中的最后画，浮在最上层

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var idx = global.Atlas.indexOf(p.k, p.f);
      var sx = (idx % global.Atlas.COLS) * ACell;
      var sy = Math.floor(idx / global.Atlas.COLS) * ACell;

      var cx = p.x - ox;
      var cy = p.y - oy;
      var rr = p.r || 0;

      if (rr) {
        g.save();
        g.translate(cx, cy);
        g.rotate(rr * Math.PI / 180);
        g.drawImage(atlas, sx, sy, ACell, ACell, -half, -half, PIECE, PIECE);
        if (showDetail && p === selected) strokeSel(g, -half, -half);
        g.restore();
      } else {
        g.drawImage(atlas, sx, sy, ACell, ACell, cx - half, cy - half, PIECE, PIECE);
        if (showDetail && p === selected) strokeSel(g, cx - half, cy - half);
      }
    }
  });

  function strokeSel(g, x, y) {
    g.strokeStyle = '#4c9aff';
    g.lineWidth = 2 / Math.max(board.view.s, 0.05);
    g.strokeRect(x + 1, y + 1, PIECE - 2, PIECE - 2);
  }

  // 命中测试：以棋子中心为基准的方形范围，取最上面（最后加入）的一个
  function pick(wx, wy) {
    var half = PIECE / 2;
    var best = null;
    pieces.forEach(function (p) {
      if (wx >= p.x - half && wx <= p.x + half &&
          wy >= p.y - half && wy <= p.y + half) {
        best = p;
      }
    });
    return best;
  }

  /* ---------- 操作（本地乐观应用 + 广播） ---------- */

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
    setHudPos(e.wx, e.wy);

    if (e.hit) {
      // 点到棋子：选中（再点一次取消）
      selected = (selected === e.hit) ? null : e.hit;
      board.requestDraw();
      return;
    }

    // 点到空白：若有选中棋子 -> 落到这个精确浮点位置（不吸附）
    if (selected) {
      var p = selected;
      if (p.x !== e.wx || p.y !== e.wy) {
        commit({ k: 'move', id: p.id, x: e.wx, y: e.wy });
      }
      return;
    }

    selected = null;
    board.requestDraw();
  }

  function onDragStart(p) {
    selected = p;
    dragging = p;
    dragMoved = false;
    board.requestDraw();
  }

  function onDragMove(p, wx, wy) {
    p.x = wx;          // 直接跟随手指，无吸附
    p.y = wy;
    dragMoved = true;
    board.requestDraw();
  }

  function onDragEnd(p) {
    dragging = null;
    board.requestDraw();
    // 只有真的动过才发 op，纯点击不产生无谓广播
    if (dragMoved) {
      sendOp({ k: 'move', id: p.id, x: p.x, y: p.y });
    }
  }

  // 桌面端右键：翻面；Shift+右键：旋转 90°
  function onContext(e) {
    var p = e.hit;
    if (!p) return;
    if (e.shiftKey) commit({ k: 'rot', id: p.id, r: ((p.r || 0) + 90) % 360 });
    else commit({ k: 'flip', id: p.id, f: p.f ? 0 : 1 });
  }

  /* ---------- HUD ---------- */

  function fmt(v) { return (Math.round(v * 10) / 10).toFixed(1); }

  function setHudPos(x, y) {
    if (elHudPos) elHudPos.textContent = 'x ' + fmt(x) + '  y ' + fmt(y);
  }

  function syncHud() {
    elHudSeq.textContent = 'seq ' + seq;
  }

  // 所有棋子的世界包围盒（无限地图上「适配视图」用它）
  function bounds() {
    if (!pieces.size) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pieces.forEach(function (p) {
      var h = PIECE / 2;
      if (p.x - h < x0) x0 = p.x - h;
      if (p.y - h < y0) y0 = p.y - h;
      if (p.x + h > x1) x1 = p.x + h;
      if (p.y + h > y1) y1 = p.y + h;
    });
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  function fitPieces() {
    var b = bounds();
    if (!b) { board.resetView(); return; }
    board.fitBounds(b.x0, b.y0, b.x1, b.y1);
    syncHud();
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

      pieces.clear();
      (m.pieces || []).forEach(function (p) { pieces.set(p.id, p); });

      selected = null;
      dragging = null;

      fitPieces();
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

  /* ---------- 工具按钮 ---------- */

  document.getElementById('btn-fit').addEventListener('click', fitPieces);

  document.getElementById('btn-origin').addEventListener('click', function () {
    board.resetView();
  });

  document.getElementById('btn-flipall').addEventListener('click', function () {
    pieces.forEach(function (p) {
      commit({ k: 'flip', id: p.id, f: p.f ? 0 : 1 });
    });
  });

  /* ---------- 键盘（桌面端） ---------- */

  global.addEventListener('keydown', function (e) {
    if (e.key === '0') { board.resetView(); return; }
    if (!selected) return;
    if (e.key === 'f') commit({ k: 'flip', id: selected.id, f: selected.f ? 0 : 1 });
    else if (e.key === 'r') commit({ k: 'rot', id: selected.id, r: ((selected.r || 0) + 90) % 360 });
  });

  /* ---------- 启动 ---------- */

  // 无限地图没有「适配」可言，初始把世界原点摆在屏幕正中
  board.resetView();
  syncHud();

  global.__app = {
    pieces: pieces,
    board: board,
    net: net,
    commit: commit,
    bounds: bounds,
    PIECE: PIECE
  };
})(window);

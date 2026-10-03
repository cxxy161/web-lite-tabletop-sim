/*
 * app.js —— 组装层：状态 + 渲染 + 输入 + 网络
 *
 * 分层原则：
 *   board.js  只认世界坐标、命中、位移，不知道「棋子」是什么
 *   net.js    只认字节
 *   app.js    在这里把两边接起来，并持有唯一的权威状态副本
 *
 * 交互模型（本次重做）
 *   - 点击棋子 = 选中它（替换原选择）
 *   - 拖动棋子 = 移动（单选就是移动一枚，多选就是整组一起移动）
 *   - 点击空白 = 取消选择
 *   - Shift+点击 / 长按 = 加选、减选
 *   - 拖动空白 = 平移地图
 *
 * 层叠序（z）
 *   每个被移动过的棋子从服务端拿一个递增 z，绘制时按 z 升序，
 *   于是「最后放的在最上面」。z 由服务端分配 —— 客户端自己发的话，
 *   两端对「谁更晚」判断不一致，重叠时的上下关系会各画各的。
 *   翻面/旋转不改变 z（只有「放」才改变层叠）。
 *
 * 坐标：棋子位置是任意浮点世界坐标（棋子中心），无网格、无吸附、无边界。
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

  var PIECE = 64;          // 棋子的世界尺寸（逻辑单位，不是像素）
  var ACCENT = '#c2703f';  // 选中色（暖陶土色，配米白底）
  var SELECT_FILL = 'rgba(194,112,63,.13)';

  var qs = new URLSearchParams(global.location.search);
  var ROOM = (qs.get('room') || 'demo').replace(/[^\w-]/g, '').slice(0, 32) || 'demo';
  var NAME = (qs.get('name') || '').slice(0, 24);

  /* ---------- 状态 ---------- */

  var pieces = new Map();      // id -> {id,x,y,r,f,k,z}
  var selection = new Set();   // 选中的棋子 id
  var dragging = null;         // 正在拖拽的棋子 id 集合（数组），null = 没在拖
  var dragStart = null;        // id -> {x,y} 拖拽起点快照
  var dragMoved = false;
  var zMax = 0;                // 本地乐观分配 z 用；会被服务端的值覆盖
  var seq = 0;

  // 绘制/命中顺序缓存：按 z 升序（数组末尾 = 最上面）
  var order = [];
  var orderDirty = true;

  var elHudRoom = document.getElementById('hud-room');
  var elHudConn = document.getElementById('hud-conn');
  var elHudPeers = document.getElementById('hud-peers');
  var elHudSeq = document.getElementById('hud-seq');
  var elHudPos = document.getElementById('hud-pos');
  var elHudSel = document.getElementById('hud-sel');

  elHudRoom.textContent = ROOM;

  /* ---------- 图集 ---------- */

  var atlas = global.Atlas.build();
  var ACell = global.Atlas.CELL;

  function ordered() {
    if (orderDirty) {
      order = Array.from(pieces.values());
      order.sort(function (a, b) { return (a.z || 0) - (b.z || 0); });
      orderDirty = false;
    }
    return order;
  }

  /* ---------- 渲染器 ---------- */

  var board = global.Board.create({
    bg: document.getElementById('bg'),
    fg: document.getElementById('fg'),
    originColor: '#ddd3bf',
    onTap: onTap,
    onContext: onContext,
    onLongPress: onLongPress,
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
    var showRing = PIECE * s >= 12;   // 缩得太小时省掉选中框，优先保帧率

    // 视口裁剪：无限地图上没必要画屏幕外的
    var m = PIECE;
    var x0 = ox - m, x1 = ox + w / s + m;
    var y0 = oy - m, y1 = oy + h / s + m;

    var list = ordered();
    var dragSet = null;
    if (dragging) {
      dragSet = {};
      for (var d = 0; d < dragging.length; d++) dragSet[dragging[d]] = 1;
    }

    // 两趟：先画非拖拽的，再画拖拽中的，保证被拖的浮在最上层
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var isDrag = dragSet && dragSet[p.id];

        if (pass === 0 && isDrag) continue;
        if (pass === 1 && !isDrag) continue;

        if (p.x + half < x0 || p.x - half > x1) continue;
        if (p.y + half < y0 || p.y - half > y1) continue;

        var idx = global.Atlas.indexOf(p.k, p.f);
        var sx = (idx % global.Atlas.COLS) * ACell;
        var sy = Math.floor(idx / global.Atlas.COLS) * ACell;

        var cx = p.x - ox;
        var cy = p.y - oy;
        var rr = p.r || 0;
        var sel = selection.has(p.id);

        if (sel && showRing) {
          // 选中底座：让多选时每一枚都看得清
          g.fillStyle = SELECT_FILL;
          roundRect(g, cx - half, cy - half, PIECE, PIECE, 10);
          g.fill();
        }

        if (rr) {
          g.save();
          g.translate(cx, cy);
          g.rotate(rr * Math.PI / 180);
          g.drawImage(atlas, sx, sy, ACell, ACell, -half, -half, PIECE, PIECE);
          if (sel && showRing) strokeSel(g, -half, -half, s);
          g.restore();
        } else {
          g.drawImage(atlas, sx, sy, ACell, ACell, cx - half, cy - half, PIECE, PIECE);
          if (sel && showRing) strokeSel(g, cx - half, cy - half, s);
        }
      }
    }
  });

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function strokeSel(g, x, y, s) {
    g.strokeStyle = ACCENT;
    g.lineWidth = 2.5 / Math.max(s, 0.05);
    roundRect(g, x + 1.5, y + 1.5, PIECE - 3, PIECE - 3, 9);
    g.stroke();
  }

  // 命中测试：取 z 最大的（最上面那枚）
  function pick(wx, wy) {
    var half = PIECE / 2;
    var list = ordered();
    for (var i = list.length - 1; i >= 0; i--) {
      var p = list[i];
      if (wx >= p.x - half && wx <= p.x + half &&
          wy >= p.y - half && wy <= p.y + half) {
        return p;
      }
    }
    return null;
  }

  /* ---------- 操作 ---------- */

  function sendOp(op) {
    net.send({ t: 'op', op: op });
  }

  function applyOp(op, fromRemote) {
    if (op.k === 'move' && Array.isArray(op.list)) {
      for (var i = 0; i < op.list.length; i++) {
        var it = op.list[i];
        var p = pieces.get(it.id);
        if (!p) continue;
        p.x = it.x; p.y = it.y;
        if (typeof it.z === 'number') {
          p.z = it.z;
          if (it.z > zMax) zMax = it.z;
        }
      }
      orderDirty = true;
      return;
    }

    var q = pieces.get(op.id);
    if (!q) return;

    if (op.k === 'flip') q.f = op.f ? 1 : 0;
    else if (op.k === 'rot') q.r = ((op.r | 0) % 360 + 360) % 360;

    if (typeof op.z === 'number' && op.z > 0) {
      q.z = op.z;
      if (op.z > zMax) zMax = op.z;
    }
    orderDirty = true;
  }

  function commit(op) {
    applyOp(op, false);
    board.requestDraw();
    sendOp(op);
  }

  /* ---------- 选择 ---------- */

  function selectOnly(p) {
    selection.clear();
    if (p) selection.add(p.id);
    syncHudSel();
    board.requestDraw();
  }

  function toggleSelect(p) {
    if (selection.has(p.id)) selection.delete(p.id);
    else selection.add(p.id);
    syncHudSel();
    board.requestDraw();
  }

  function clearSelection() {
    if (!selection.size) return;
    selection.clear();
    syncHudSel();
    board.requestDraw();
  }

  function selectedPieces() {
    var out = [];
    selection.forEach(function (id) {
      var p = pieces.get(id);
      if (p) out.push(p);
    });
    return out;
  }

  /* ---------- 输入回调 ---------- */

  function onTap(e) {
    setHudPos(e.wx, e.wy);

    if (!e.hit) {
      // 点空白 = 取消选择
      clearSelection();
      return;
    }

    // onTap 只在「按下-抬起之间没有拖动」时才会走到这里
    //（一拖就进 drag 分支，onTap 不触发）。
    // 所以这里可以放心地做两件事：
    //   shift+点击 -> 加选 / 减选
    //   普通点击   -> 替换选择，即使点在已选中的一员上
    //                 （想整组拖就直接拖，那条路径不会经过这里）
    if (e.shiftKey) toggleSelect(e.hit);
    else selectOnly(e.hit);
  }

  function onLongPress(hit) {
    // 触屏上的加选/减选（手机没有 shift）
    if (hit) toggleSelect(hit);
  }

  function onDragStart(hit, wx, wy) {
    if (!hit) return;

    // 拖的是「已选中的一员」-> 整组一起移动；
    // 否则这次拖拽先把选择收缩到它自己。
    if (!selection.has(hit.id)) selectOnly(hit);

    dragging = Array.from(selection);
    dragStart = {};
    for (var i = 0; i < dragging.length; i++) {
      var p = pieces.get(dragging[i]);
      if (p) dragStart[p.id] = { x: p.x, y: p.y };
    }
    dragMoved = false;
    board.requestDraw();
  }

  function onDragMove(hit, wx, wy, dx, dy) {
    if (!dragging || !dragStart) return;
    for (var i = 0; i < dragging.length; i++) {
      var p = pieces.get(dragging[i]);
      var s0 = dragStart[dragging[i]];
      if (!p || !s0) continue;
      p.x = s0.x + dx;
      p.y = s0.y + dy;
    }
    dragMoved = true;
    board.requestDraw();
  }

  function onDragEnd(hit, delta, interrupted) {
    if (!dragging || !dragStart) { dragging = null; dragStart = null; return; }

    var ids = dragging;
    dragging = null;

    if (!dragMoved) { dragStart = null; return; }
    dragMoved = false;

    // 乐观分配 z：立刻把被拖的压到最上层。
    // 服务端会在回显里给出权威 z，把这里的值覆盖掉，
    // 所以即使这一步猜错了，最终仍会收敛。
    var list = [];
    for (var i = 0; i < ids.length; i++) {
      var p = pieces.get(ids[i]);
      if (!p) continue;
      p.z = ++zMax;
      list.push({ id: p.id, x: p.x, y: p.y });
    }
    dragStart = null;
    orderDirty = true;
    board.requestDraw();

    if (list.length) sendOp({ k: 'move', list: list });
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

  function syncHudSel() {
    if (!elHudSel) return;
    elHudSel.textContent = selection.size ? ('已选 ' + selection.size) : '未选中';
    elHudSel.className = selection.size ? 'sel-on' : '';
  }

  function syncHud() {
    elHudSeq.textContent = 'seq ' + seq;
  }

  function bounds() {
    if (!pieces.size) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    var h = PIECE / 2;
    pieces.forEach(function (p) {
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

    onInit: function (m) {
      seq = m.seq | 0;

      pieces.clear();
      selection.clear();
      dragging = null;
      dragStart = null;
      zMax = 0;

      (m.pieces || []).forEach(function (p) {
        if (typeof p.z !== 'number') p.z = 0;
        if (p.z > zMax) zMax = p.z;
        pieces.set(p.id, p);
      });

      orderDirty = true;
      fitPieces();
      board.requestDraw();
      syncHud();
      syncHudSel();
    },

    onOp: function (m) {
      seq = m.seq | 0;
      applyOp(m.op, true);

      // 远端把棋子删了/换了集合时要清理悬空选择
      if (selection.size) {
        selection.forEach(function (id) {
          if (!pieces.has(id)) selection.delete(id);
        });
      }
      board.requestDraw();
      syncHud();
      syncHudSel();
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

  document.getElementById('btn-all').addEventListener('click', function () {
    selection.clear();
    pieces.forEach(function (p) { selection.add(p.id); });
    syncHudSel();
    board.requestDraw();
  });

  document.getElementById('btn-none').addEventListener('click', clearSelection);

  document.getElementById('btn-flipall').addEventListener('click', function () {
    // 只翻选中的；没有选择时翻全部
    var list = selection.size ? selectedPieces() : Array.from(pieces.values());
    list.forEach(function (p) {
      commit({ k: 'flip', id: p.id, f: p.f ? 0 : 1 });
    });
  });

  /* ---------- 键盘（桌面端） ---------- */

  global.addEventListener('keydown', function (e) {
    if (e.key === '0') { board.resetView(); return; }
    if (e.key === 'Escape') { clearSelection(); return; }
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      selection.clear();
      pieces.forEach(function (p) { selection.add(p.id); });
      syncHudSel();
      board.requestDraw();
      return;
    }

    // 方向键微调：有选择时移动选中的，步长 1 / Shift 为 10
    var step = e.shiftKey ? 10 : 1;
    var dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;

    if (dx || dy) {
      var list = selectedPieces();
      if (!list.length) return;
      e.preventDefault();
      var batch = [];
      for (var i = 0; i < list.length; i++) {
        var p = pieces.get(list[i].id);
        p.x += dx; p.y += dy;
        p.z = ++zMax;
        batch.push({ id: p.id, x: p.x, y: p.y });
      }
      orderDirty = true;
      board.requestDraw();
      sendOp({ k: 'move', list: batch });
      return;
    }

    if (!selection.size) return;
    var one = pieces.get(selection.values().next().value);
    if (!one) return;
    if (e.key === 'f') commit({ k: 'flip', id: one.id, f: one.f ? 0 : 1 });
    else if (e.key === 'r') commit({ k: 'rot', id: one.id, r: ((one.r || 0) + 90) % 360 });
  });

  /* ---------- 启动 ---------- */

  board.resetView();
  syncHud();
  syncHudSel();

  global.__app = {
    pieces: pieces,
    selection: selection,
    board: board,
    net: net,
    commit: commit,
    bounds: bounds,
    ordered: ordered,
    PIECE: PIECE
  };
})(window);

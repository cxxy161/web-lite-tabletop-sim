/*
 * app.js —— 组装层：状态 + 渲染 + 输入 + 网络
 *
 * 分层原则：
 *   board.js   只认世界坐标、命中、位移，不知道「棋子」是什么
 *   texture.js 管贴图加载与 LRU，不知道棋子在哪儿
 *   net.js     只认字节
 *   app.js     在这里把三方接起来，并持有唯一的权威状态副本
 *
 * 棋子数据（来自场景转换）：
 *   { id, x, y, r, f, w, h, img, bimg, z }
 *   每枚棋子有自己的宽高 —— 真实资产里 scale 从 0.6 到 15，
 *   底图板块还是长方形，不能像早期 demo 那样全局写死边长。
 *
 * 交互模型
 *   - 点击棋子 = 选中它（替换原选择）
 *   - 拖动棋子 = 移动（多选则整组移动）
 *   - 点击空白 = 取消选择
 *   - Shift+点击 / 长按 = 加选、减选
 *   - 拖动空白 = 平移地图
 *
 * 层叠序 z：由服务端分配，绘制按 z 升序、命中取 z 最大，
 * 于是「最后放的在最上面」。翻面/旋转不改 z。
 */
(function (global) {
  'use strict';

  var ACCENT = '#c2703f';
  var SELECT_FILL = 'rgba(194,112,63,.18)';

  // 细节层次阈值（屏幕像素）。棋子的屏幕长边小于这个值时**不加载贴图**，
  // 改画一个纯色块。
  //
  // 这不是省事的偷懒，而是低配机能跑起来的必要条件：
  // 全场景适配时 778 枚棋子全在屏幕上，如果每枚都要真贴图，
  // LRU 一个也淘汰不掉（全都「可见」），瞬间就要
  // 778 × 192×192×4B ≈ 114MB 显存 —— 老手机必崩。
  // 缩到 8px 的卡面本来也看不出画的是什么，
  // 用色块顶上既保住帧率又不损失可读信息。
  var LOD_MIN = 18;

  var qs = new URLSearchParams(global.location.search);
  var ROOM = (qs.get('room') || 'demo').replace(/[^\w-]/g, '').slice(0, 32) || 'demo';
  var NAME = (qs.get('name') || '').slice(0, 24);

  /* ---------- 状态 ---------- */

  var pieces = new Map();      // id -> piece
  var selection = new Set();
  var dragging = null;         // 正在拖拽的 id 数组
  var dragStart = null;        // id -> {x,y}
  var dragMoved = false;
  var zMax = 0;
  var seq = 0;

  var order = [];
  var orderDirty = true;

  var elHudRoom = document.getElementById('hud-room');
  var elHudConn = document.getElementById('hud-conn');
  var elHudPeers = document.getElementById('hud-peers');
  var elHudSeq = document.getElementById('hud-seq');
  var elHudPos = document.getElementById('hud-pos');
  var elHudSel = document.getElementById('hud-sel');
  var elHudScene = document.getElementById('hud-scene');
  var elTex = document.getElementById('hud-tex');

  elHudRoom.textContent = ROOM;

  /* ---------- 贴图 ---------- */

  var tex = global.Texture.create({
    base: 'assets/',
    white: 'assets/white.webp',
    onReady: function () { board.requestDraw(); }
  });

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

  board.setHitTest(function (wx, wy) { return pick(wx, wy); });

  board.setDrawer(function (g, view) {
    var s = view.s;
    var ox = view.ox, oy = view.oy;
    var vw = board.size.w, vh = board.size.h;
    var showRing = s >= 0.05;

    var list = ordered();
    var used = [];
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

        // 视口裁剪（用这枚棋子自己的尺寸，大板块不能按小棋子算）
        var hw = p.w / 2, hh = p.h / 2;
        if (p.x + hw < ox - hw || p.x - hw > ox + vw / s + hw) continue;
        if (p.y + hh < oy - hh || p.y - hh > oy + vh / s + hh) continue;

        var cx = p.x - ox;
        var cy = p.y - oy;
        var rr = p.r || 0;

        // LOD：屏幕长边太小就不加载贴图，画色块。
        // 这是「全场景缩放时显存不爆」的关键闸门，见文件头 LOD_MIN 注释。
        var screenLong = Math.max(p.w, p.h) * s;
        if (screenLong < LOD_MIN) {
          g.fillStyle = p.f ? '#cfc6b4' : '#b9ac93';
          g.fillRect(cx - hw, cy - hh, p.w, p.h);
          if (selection.has(p.id) && showRing) strokeSel(g, cx - hw, cy - hh, p.w, p.h, s);
          continue;
        }

        var t = tex.get(p.f ? p.bimg : p.img);
        used.push(p.f ? p.bimg : p.img);

        // 旋转非 0/180 时才走 save/rotate（大多数棋子是 180，直接跳过省开销）
        var trivial = (rr < 0.5 || Math.abs(rr - 180) < 0.5);

        if (trivial) {
          // 180 度等价于「上下左右都翻转」，用负步长缩放实现，比 rotate 便宜
          if (Math.abs(rr - 180) < 0.5) {
            g.save();
            g.translate(cx, cy);
            g.scale(-1, -1);
            g.drawImage(t.img, -hw, -hh, p.w, p.h);
            g.restore();
          } else {
            g.drawImage(t.img, cx - hw, cy - hh, p.w, p.h);
          }
          if (selection.has(p.id) && showRing) strokeSel(g, cx - hw, cy - hh, p.w, p.h, s);
        } else {
          g.save();
          g.translate(cx, cy);
          g.rotate(rr * Math.PI / 180);
          g.drawImage(t.img, -hw, -hh, p.w, p.h);
          g.restore();
          if (selection.has(p.id) && showRing) {
            // 选中框不跟着转，保持正立，否则旋转的棋子选框会歪
            strokeSel(g, cx - hw, cy - hh, p.w, p.h, s);
          }
        }
      }
    }

    tex.markFrame(used);      // 钉住本帧用到的贴图，其余可被 LRU 淘汰
  });

  function strokeSel(g, x, y, w, h, s) {
    g.strokeStyle = ACCENT;
    g.lineWidth = 2.5 / Math.max(s, 0.05);
    g.strokeRect(x, y, w, h);
  }

  /* ---------- 顺序 / 命中 ---------- */

  function ordered() {
    if (orderDirty) {
      order = Array.from(pieces.values());
      order.sort(function (a, b) { return (a.z || 0) - (b.z || 0); });
      orderDirty = false;
    }
    return order;
  }

  // 取 z 最大的（最上面那枚）；按各自矩形判定
  function pick(wx, wy) {
    var list = ordered();
    for (var i = list.length - 1; i >= 0; i--) {
      var p = list[i];
      var hw = p.w / 2, hh = p.h / 2;
      if (wx >= p.x - hw && wx <= p.x + hw &&
          wy >= p.y - hh && wy <= p.y + hh) {
        return p;
      }
    }
    return null;
  }

  /* ---------- 操作 ---------- */

  function sendOp(op) { net.send({ t: 'op', op: op }); }

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

    if (!e.hit) { clearSelection(); return; }

    // onTap 只在「按下-抬起之间没拖动」时触发，
    // 所以这里可以放心：shift = 加选/减选，普通 = 替换选择。
    if (e.shiftKey) toggleSelect(e.hit);
    else selectOnly(e.hit);
  }

  function onLongPress(hit) {
    if (hit) toggleSelect(hit);      // 触屏加选（手机没有 shift）
  }

  function onDragStart(hit) {
    if (!hit) return;
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

  function onDragEnd() {
    if (!dragging || !dragStart) { dragging = null; dragStart = null; return; }

    var ids = dragging;
    dragging = null;

    if (!dragMoved) { dragStart = null; return; }
    dragMoved = false;

    // 乐观分配 z（立刻压到最上层），服务端回显会覆盖成权威值
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

  function syncTex() {
    if (!elTex) return;
    var s = tex.stats();
    elTex.textContent = '贴图 ' + s.ready + '/' + s.cached + (s.pending ? ' +' + s.pending : '');
  }

  setInterval(syncTex, 600);   // 贴图统计不进绘制循环，免得每帧都在刷 DOM

  function bounds() {
    if (!pieces.size) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pieces.forEach(function (p) {
      var hw = p.w / 2, hh = p.h / 2;
      if (p.x - hw < x0) x0 = p.x - hw;
      if (p.y - hh < y0) y0 = p.y - hh;
      if (p.x + hw > x1) x1 = p.x + hw;
      if (p.y + hh > y1) y1 = p.y + hh;
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
      if (elHudScene) elHudScene.textContent = m.label || m.scene || '—';

      fitPieces();
      board.requestDraw();
      syncHud();
      syncHudSel();
      syncTex();
    },

    onOp: function (m) {
      seq = m.seq | 0;
      applyOp(m.op, true);

      // 远端换了盘面时要清掉悬空选择
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

  /* ---------- 键盘 ---------- */

  global.addEventListener('keydown', function (e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

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
  syncTex();

  global.__app = {
    pieces: pieces,
    selection: selection,
    board: board,
    net: net,
    tex: tex,
    commit: commit,
    bounds: bounds,
    ordered: ordered,
    pick: pick
  };
})(window);

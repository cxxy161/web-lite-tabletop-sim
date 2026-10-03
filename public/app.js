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

  // LOD 阈值（屏幕像素），由 settings.js 的档位控制。
  //
  // 棋子的屏幕长边小于这个值时**不加载贴图**，改画纯色块。
  // 这不是偷懒，而是低配机能跑起来的必要条件：全场景适配时 778 枚
  // 棋子全在屏幕上，如果每枚都要真贴图，LRU 一个也淘汰不掉（全都
  // 「可见」），瞬间要 778 × 192×192×4B ≈ 114MB 显存 —— 老手机必崩。
  //
  // 默认 18 是「均衡」档；可在设置面板里放宽到 8 或完全关闭。
  var lodThreshold = 18;

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

  /* ---------- 位置映射 ---------- */

  // TTS 的 (posX, posZ) -> 画布 (x, y) 有 4 种轴符号组合，纯数学推不唯一
  //（透视缩略图信噪比太低），所以做成设置项由使用者目视选定。
  //
  // 关键性质：这个映射**只翻转符号，是自逆的**（应用两次 = 恒等）。
  // 因此「显示坐标 -> 原始坐标」和「原始坐标 -> 显示坐标」是同一个函数，
  // 不用写两套。约定：
  //   服务端与磁盘始终存 **TTS 原始坐标**；
  //   客户端内存里始终是 **显示坐标**。
  //   init / 远端 op 进来时 原始->显示；发出去的 op 显示->原始。
  // 这样换映射档位不会污染数据，导出存档也永远是一致的原始坐标。
  var mapSX = 1, mapSY = 1;

  function mapPt(x, y) {
    return { x: x * mapSX, y: y * mapSY };
  }

  var elHudRoom = document.getElementById('hud-room');
  var elHudConn = document.getElementById('hud-conn');
  var elHudPeers = document.getElementById('hud-peers');
  var elHudSeq = document.getElementById('hud-seq');
  var elHudPos = document.getElementById('hud-pos');
  var elHudSel = document.getElementById('hud-sel');
  var elHudScene = document.getElementById('hud-scene');
  var elTex = document.getElementById('hud-tex');
  var elFatal = document.getElementById('fatal');

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
    onMarquee: onMarquee,
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
        // 阈值可调（设置面板），0 表示关闭 LOD（任何尺寸都画真贴图）。
        var screenLong = Math.max(p.w, p.h) * s;
        if (lodThreshold > 0 && screenLong < lodThreshold) {
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
          if (p.lk) strokeLock(g, cx - hw, cy - hh, p.w, p.h, s);
          if (selection.has(p.id) && showRing) strokeSel(g, cx - hw, cy - hh, p.w, p.h, s);
        } else {
          g.save();
          g.translate(cx, cy);
          g.rotate(rr * Math.PI / 180);
          g.drawImage(t.img, -hw, -hh, p.w, p.h);
          g.restore();
          if (p.lk) strokeLock(g, cx - hw, cy - hh, p.w, p.h, s);
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

  // 冻结标记：虚线框。故意用和选中框不同的画法（虚线 vs 实线、
  // 灰色 vs 橙色），这样「选中且冻结」时两种状态都能看出来。
  function strokeLock(g, x, y, w, h, s) {
    g.save();
    g.strokeStyle = 'rgba(90,120,150,.85)';
    g.lineWidth = 1.6 / Math.max(s, 0.05);
    g.setLineDash([5 / Math.max(s, 0.05), 3 / Math.max(s, 0.05)]);
    g.strokeRect(x, y, w, h);
    g.restore();
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

  // 该点下方的**所有**棋子，最上面的排在前。
  //
  // pick 只给最上面那枚，但「拖底下的棋子」需要看见被压住的那些 ——
  // 否则底层棋子永远抓不到，需求二无从触发。
  function pickAll(wx, wy) {
    var list = ordered();
    var out = [];
    for (var i = list.length - 1; i >= 0; i--) {
      var p = list[i];
      var hw = p.w / 2, hh = p.h / 2;
      if (wx >= p.x - hw && wx <= p.x + hw &&
          wy >= p.y - hh && wy <= p.y + hh) {
        out.push(p);
      }
    }
    return out;   // 最上面在前
  }

  /* ---------- 操作 ---------- */

  function sendOp(op) {
    // 发出去之前把显示坐标换回 TTS 原始坐标（自逆，同一函数）。
    // 服务端与磁盘永远只认原始坐标，换映射档不会污染数据。
    if (op.k === 'move' && op.list) {
      var mapped = op.list.map(function (it) {
        var q = mapPt(it.x, it.y);
        return { id: it.id, x: q.x, y: q.y };
      });
      net.send({ t: 'op', op: { k: 'move', list: mapped } });
      return;
    }
    if (op.k === 'clone') {
      var c = mapPt(op.x, op.y);
      net.send({ t: 'op', op: { k: 'clone', id: op.id, x: c.x, y: c.y } });
      return;
    }
    net.send({ t: 'op', op: op });
  }

  function applyOp(op, fromRemote) {
    // 远端来的坐标是 TTS 原始坐标，落到内存前换成显示坐标。
    // 本地乐观应用时 op 已经是显示坐标了，不能再换一次
    //（所以只有 fromRemote 才走映射）。
    if (op.k === 'move' && Array.isArray(op.list)) {
      for (var i = 0; i < op.list.length; i++) {
        var it = op.list[i];
        var p = pieces.get(it.id);
        if (!p) continue;
        if (fromRemote) {
          var w = mapPt(it.x, it.y);
          p.x = w.x; p.y = w.y;
        } else {
          p.x = it.x; p.y = it.y;
        }
        if (typeof it.z === 'number') {
          p.z = it.z;
          if (it.z > zMax) zMax = it.z;
        }
      }
      orderDirty = true;
      return;
    }

    // 克隆：服务端回了完整棋子对象（原始坐标），转成显示坐标后入库
    if (op.k === 'clone' && op.piece) {
      var np = Object.assign({}, op.piece);
      var cw = mapPt(np.x, np.y);
      np.x = cw.x; np.y = cw.y;
      pieces.set(np.id, np);
      if (typeof np.z === 'number' && np.z > zMax) zMax = np.z;
      orderDirty = true;
      // 克隆体默认选中，方便接着拖
      selection.clear();
      selection.add(np.id);
      syncHudSel();
      return;
    }

    if (op.k === 'del') {
      pieces.delete(op.id);
      selection.delete(op.id);
      syncHudSel();
      orderDirty = true;
      return;
    }

    var q = pieces.get(op.id);
    if (!q) return;

    if (op.k === 'flip') q.f = op.f ? 1 : 0;
    else if (op.k === 'rot') q.r = ((op.r | 0) % 360 + 360) % 360;
    else if (op.k === 'lock') q.lk = op.lk ? 1 : 0;
    else if (op.k === 'state') {
      q.si = op.si | 0;
      q.img = op.img; q.bimg = op.bimg;
      q.w = op.w; q.h = op.h;
    }

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
    if (e.shiftKey) { toggleSelect(e.hit); return; }

    // 重叠时「渗选」：重复点同一处，依次选到下面那一枚。
    //
    // 没有这个的话底层棋子永远选不中（pick 总是给最上面的），
    // 需求二「拖动底下的棋子」就无从触发。
    // 交互上等同于多数绘图软件的「再点一次选中下面一层」。
    var under = pickAll(e.wx, e.wy);
    if (under.length > 1 && selection.size === 1) {
      var cur = selection.values().next().value;
      for (var i = 0; i < under.length - 1; i++) {
        if (under[i].id === cur) {
          selectOnly(under[i + 1]);
          return;
        }
      }
    }

    selectOnly(e.hit);
  }

  // 长按（触屏）：弹出与右键相同的菜单。
  // 手机没有右键，长按是唯一的入口；加选改由框选承担。
  function onLongPress(hit, at) {
    if (!hit) return;
    if (!selection.has(hit.id)) selectOnly(hit);
    // 长按点就是菜单锚点（board 传的是局部屏幕坐标）
    var pos = at ? { x: at.x + 8, y: at.y + 8 }
                 : { x: board.size.w / 2, y: board.size.h / 2 };
    openMenu(hit, pos);
  }

  // 框选：矩形相交即选中（不要求完全包含，手指框不准）
  function onMarquee(box, additive) {
    if (!additive) selection.clear();

    pieces.forEach(function (p) {
      var hw = p.w / 2, hh = p.h / 2;
      if (p.x + hw < box.x0 || p.x - hw > box.x1) return;
      if (p.y + hh < box.y0 || p.y - hh > box.y1) return;
      selection.add(p.id);
    });

    syncHudSel();
    board.requestDraw();
  }

  /* ---------- 被覆盖的棋子（拖动连带） ---------- */

  // b 是否压住 a：z 更大且矩形相交
  function covers(b, a) {
    if (b === a) return false;
    if ((b.z || 0) <= (a.z || 0)) return false;
    return Math.abs(b.x - a.x) * 2 < (b.w + a.w) &&
           Math.abs(b.y - a.y) * 2 < (b.h + a.h);
  }

  // 收集「直接或间接压在某些棋子上面」的全部棋子。
  //
  // 这是需求里的「移动底下的棋子会连带移动上面盖着的」。
  // 做成**传递闭包**（A 压 B、B 压 C，拖 C 时 A、B 都跟着走），
  // 否则只挪一层，上面的牌堆会散开。
  function coverClosure(roots) {
    var out = [];
    var seen = {};
    var i, j;

    for (i = 0; i < roots.length; i++) {
      if (!seen[roots[i]]) { seen[roots[i]] = 1; out.push(roots[i]); }
    }

    // 反复扫到不再新增为止。棋子总量几百，这点开销可忽略，
    // 而且只在拖拽开始时算一次。
    var changed = true;
    while (changed) {
      changed = false;
      var list = ordered();
      for (i = 0; i < list.length; i++) {
        var top = list[i];
        if (seen[top.id]) continue;
        for (j = 0; j < out.length; j++) {
          var below = pieces.get(out[j]);
          if (below && covers(top, below)) {
            seen[top.id] = 1;
            out.push(top.id);
            changed = true;
            break;
          }
        }
      }
    }
    return out;
  }

  function onDragStart(hit, wx, wy) {
    if (!hit) return;
    if (hit.lk && !selection.has(hit.id)) return;   // 冻结的拖不动

    // 起点处压着哪些棋子（含被覆盖的）。
    //
    // 关键：如果其中**任意一枚已经被选中**，就沿用当前选择，
    // 不要替换成最上面那枚。否则「渗选」选好底层棋子后一拖，
    // 选择立刻被最上面那枚顶掉，需求二等于白做。
    var under = pickAll(wx, wy);
    var keepSel = false;
    for (var i = 0; i < under.length; i++) {
      if (selection.has(under[i].id)) { keepSel = true; break; }
    }

    if (!keepSel) {
      if (hit.lk) return;
      selectOnly(hit);
    }

    // 把压在选中棋子上的也拉进来（需求二）
    var closure = coverClosure(Array.from(selection));

    // 冻结的棋子**完全不参与拖动**（视作钉在桌上）：
    // 它们既不该跟着动，也不该进批量。
    // 如果只在最后一步把它们剔出批量、却仍让 onDragMove 改它们的坐标，
    // 屏幕上它们会跟着走、但服务端从不确认 —— 看起来就是「拖完弹回去」。
    dragging = closure.filter(function (id) {
      var q = pieces.get(id);
      return q && !q.lk;
    });
    if (!dragging.length) return;

    dragStart = {};
    for (var j = 0; j < dragging.length; j++) {
      var p = pieces.get(dragging[j]);
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

    // 冻结的不进批量。服务端对含冻结项的批量是**整批拒绝**，
    // 所以必须在这里先剔掉，否则一次拖拽会因为夹了一枚冻结棋子而全废。
    var list = [];
    for (var i = 0; i < ids.length; i++) {
      var p = pieces.get(ids[i]);
      if (!p || p.lk) continue;
      p.z = ++zMax;                        // 乐观置顶，服务端回显会覆盖
      list.push({ id: p.id, x: p.x, y: p.y });
    }
    dragStart = null;
    orderDirty = true;
    board.requestDraw();

    if (list.length) sendOp({ k: 'move', list: list });
  }

  // 桌面右键 = 弹菜单（不再是「右键翻面」那种隐式操作）
  function onContext(e) {
    if (!e.hit) return;
    if (!selection.has(e.hit.id)) selectOnly(e.hit);
    openMenu(e.hit, { x: e.clientX, y: e.clientY });
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

  // 致命错误提示：格式不匹配这类问题必须让人一眼看到，
  // 而不是留一张空白画布让人猜。
  function showFatal(text) {
    if (elFatal) {
      elFatal.hidden = false;
      elFatal.textContent = text;
    }
    if (elHudConn) {
      elHudConn.textContent = '格式不匹配';
      elHudConn.className = 'off';
    }
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

      // 先校验格式再装载。
      //
      // 曾经踩过的坑：浏览器加载的是新前端，而服务的却是一个还在
      // 跑旧代码的进程（同一台机上多开/残留），init 里是没有 w/h/img 的
      // 老格式棋子。结果 p.w === undefined -> NaN，一枚都画不出来，
      // 而且**没有任何报错**，只看到空白画布和 NaN 坐标。
      //
      // 静默失败最难查，所以这里宁可显式拒绝并说清原因。
      var list = m.pieces || [];
      if (list.length && typeof list[0].w !== 'number') {
        showFatal('服务端返回的棋子格式与本页前端不匹配（缺少 w/h/img 字段）。'
                + '通常是这台机器上还跑着一个旧版服务进程 —— 请确认访问的端口'
                + '是当前启动的那个，并停掉残留的旧进程后刷新。');
        return;
      }

      pieces.clear();
      selection.clear();
      dragging = null;
      dragStart = null;
      zMax = 0;

      list.forEach(function (p) {
        if (typeof p.z !== 'number') p.z = 0;
        if (p.z > zMax) zMax = p.z;
        // 服务端存的是 TTS 原始坐标，内存里统一用显示坐标。
        // 映射是符号翻转，自逆，所以这里直接乘即可。
        var w = mapPt(p.x, p.y);
        p.x = w.x; p.y = w.y;
        if (!Array.isArray(p.st) || p.st.length < 2) p.st = null;
        p.lk = p.lk ? 1 : 0;
        p.si = p.si | 0;
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

  /* ---------- 右键菜单（桌面右键 / 手机长按） ---------- */

  var menu = global.Menu.create({
    el: document.getElementById('menu'),
    onPick: function (action, piece) { doAction(action, piece); }
  });

  // 对当前选择整体执行的辅助：单选就是长度 1 的批量
  function eachSelected(fn) {
    selectedPieces().forEach(function (p) { fn(p); });
  }

  function openMenu(piece, at) {
    var sel = selectedPieces();
    var n = sel.length;
    var many = n > 1;
    var suffix = many ? '（' + n + ' 枚）' : '';

    // 「切换形态」只在所有选中项都真的有多形态时可用
    var statesOk = sel.length > 0 && sel.every(function (p) {
      return p.st && p.st.length > 1;
    });
    var nextState = 0;
    if (statesOk) {
      // 取第一枚的下一形态作为预览名
      nextState = ((sel[0].si | 0) + 1) % sel[0].st.length;
    }

    var allLocked = sel.length > 0 && sel.every(function (p) { return p.lk; });

    menu.show(piece, [
      { action: 'flip', label: '翻面' + suffix },
      { action: 'rot', label: '旋转 90°' + suffix },
      statesOk
        ? { action: 'state', label: '切换形态' + suffix,
            note: ' → ' + (nextState + 1) + '/' + sel[0].st.length }
        : { action: 'state', label: '切换形态', disabled: true,
            note: sel.length ? ' 该棋子只有一种形态' : '' },
      { sep: true },
      { action: 'lock', label: allLocked ? ('解冻' + suffix) : ('固定（冻结）' + suffix) },
      { action: 'clone', label: '克隆' + suffix },
      { action: 'del', label: '删除' + suffix, danger: true }
    ], at);
  }

  function doAction(action, piece) {
    var sel = selectedPieces();
    if (!sel.length) return;

    switch (action) {
      case 'flip':
        sel.forEach(function (p) {
          if (!p.lk) commit({ k: 'flip', id: p.id, f: p.f ? 0 : 1 });
        });
        break;

      case 'rot':
        sel.forEach(function (p) {
          if (!p.lk) commit({ k: 'rot', id: p.id, r: ((p.r || 0) + 90) % 360 });
        });
        break;

      case 'state':
        sel.forEach(function (p) {
          if (p.lk || !p.st || p.st.length < 2) return;
          var next = ((p.si | 0) + 1) % p.st.length;
          commit({ k: 'state', id: p.id, si: next });
        });
        break;

      case 'lock': {
        // 只要还有一枚没冻，这一下就是「全冻」；全冻了才变「全解冻」
        var allLocked = sel.every(function (p) { return p.lk; });
        sel.forEach(function (p) {
          commit({ k: 'lock', id: p.id, lk: allLocked ? 0 : 1 });
        });
        break;
      }

      case 'clone':
        // 克隆只对第一枚生效（多选克隆会一次冒出一堆，容易失控）；
        // 偏移交给服务端，客户端把显示坐标换回原始坐标后下发
        commit({ k: 'clone', id: sel[0].id, x: sel[0].x + 24, y: sel[0].y + 24 });
        break;

      case 'del':
        // 删除要二次确认：这是唯一不可逆的操作
        if (!global.confirm('删除选中的 ' + sel.length + ' 枚棋子？此操作不可撤销。')) return;
        sel.forEach(function (p) { commit({ k: 'del', id: p.id }); });
        break;
    }
  }

  /* ---------- 设置：LOD 档位 ---------- */

  var elSettings = document.getElementById('settings');
  var elSettingsBtn = document.getElementById('btn-settings');

  elSettingsBtn.addEventListener('click', function () {
    elSettings.hidden = !elSettings.hidden;
    elSettingsBtn.className = elSettings.hidden ? '' : 'on';
  });

  var settings = global.Settings.create({
    el: document.getElementById('lod-levels'),
    elNote: document.getElementById('lod-note'),
    elMap: document.getElementById('map-modes'),
    elMapNote: document.getElementById('map-note'),
    initial: 'mid',
    apply: function (threshold) {
      lodThreshold = threshold;
      board.requestDraw();
    },
    onBudget: function (mb, boards) {
      // LOD 与显存预算必须同步改：关闭 LOD 时同屏贴图会涨到 500+ 张，
      // 预算还卡在 72MB 就会持续抖动（比开着 LOD 更糟）。见 settings.js 注释。
      tex.setBudget(mb, boards);
    },
    onChange: function () {
      board.requestDraw();
    },
    // 位置映射一变：内存里存的是显示坐标，得整体重算。
    // 因为映射是自逆的，先把旧映射换回原始坐标，再套新映射即可。
    onMap: function (sx, sy) {
      var oldX = mapSX, oldY = mapSY;
      mapSX = sx; mapSY = sy;
      if (oldX === sx && oldY === sy) return;

      pieces.forEach(function (p) {
        // 旧显示 -> 原始 -> 新显示（自逆，所以两次都用 mapPt 的同一逻辑）
        var rx = p.x * oldX, ry = p.y * oldY;
        p.x = rx * sx; p.y = ry * sy;
      });
      orderDirty = true;
      board.requestDraw();
      fitPieces();
    }
  });

  /* ---------- 框选开关 ---------- */

  var elMarqueeBtn = document.getElementById('btn-marquee');
  elMarqueeBtn.addEventListener('click', function () {
    var on = !board.isMarquee();
    board.setMarquee(on);
    elMarqueeBtn.className = on ? 'on' : '';
    elMarqueeBtn.textContent = on ? '框选中' : '框选';
  });
  // 桌面端按住 Shift 也能框选，与绘图软件习惯一致（见 board.js）

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
    settings: settings,
    commit: commit,
    bounds: bounds,
    ordered: ordered,
    pick: pick,
    pickAll: pickAll,
    coverClosure: coverClosure,
    lod: function () { return lodThreshold; }
  };
})(window);

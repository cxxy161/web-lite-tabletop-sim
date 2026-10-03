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

  // 房间页只接受邀请码。房间号就是邀请码本身（见 rooms.js），
  // 所以这里沿用原来的 ?room= 参数名，app.js/saves.js 的既有逻辑不用改。
  var ROOM = (qs.get('room') || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);

  // 没有邀请码就直接退回主页 —— 房间页没有「默认房间」这回事了。
  // 以前会静默落到 demo，那样两个人都输错码时会莫名进到同一个房间。
  if (!ROOM) {
    global.location.replace('index.html');
    return;
  }

  // 昵称与身份都来自 localStorage（主页写入）
  var NAME = global.Identity ? global.Identity.getName() : '';
  var ME = global.Identity ? global.Identity.get(ROOM) : null;

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

  // 骰子/标记共用的色板。0 = 用该物品的默认配色。
  var PALETTE_LIST = [
    { v: 0,        name: '默认' },
    { v: 0xc2703f, name: '砖橙' },
    { v: 0xb4453a, name: '红' },
    { v: 0xd9a441, name: '金黄' },
    { v: 0x5e8a4f, name: '绿' },
    { v: 0x3a7bd5, name: '蓝' },
    { v: 0x7a5ea8, name: '紫' },
    { v: 0x4a4437, name: '墨' },
    { v: 0xf2ede1, name: '米白' }
  ];

  /* ---------- 骰子动画 ---------- */

  // id -> {t0, dur}。存在即表示这颗骰子正在滚。
  // 动画结束条目会被删掉，所以「动画中」不需要额外的布尔量。
  var diceAnim = {};
  var pendingAnim = false;     // 本帧还有动画没跑完，需要继续重绘

  function nowMs() {
    return (global.performance && global.performance.now)
      ? global.performance.now() : Date.now();
  }

  // 每颗骰子的固定相位：让它们即便同时掷出也不会整齐划一地转
  function dicePhase(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
    return h;
  }

  // 开一次滚动动画。时长带一点随机，避免多颗骰子完全同步。
  function startRoll(ids) {
    var t0 = nowMs();
    for (var i = 0; i < ids.length; i++) {
      diceAnim[ids[i]] = {
        t0: t0 + i * 40,                       // 略微错开，像依次滚出去
        dur: 760 + (dicePhase(ids[i]) % 260)
      };
    }
    pendingAnim = true;
    board.requestDraw();
  }

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

  // 矩形映射：两个角都映射再归一（只映左上角在负向映射时会错位）
  function mapRect(z) {
    var a = mapPt(z.x, z.y);
    var b = mapPt(z.x + z.w, z.y + z.h);
    var out = {};
    for (var k in z) if (z.hasOwnProperty(k)) out[k] = z[k];
    out.x = Math.min(a.x, b.x);
    out.y = Math.min(a.y, b.y);
    out.w = Math.abs(b.x - a.x);
    out.h = Math.abs(b.y - a.y);
    return out;
  }

  // 服务端给的是原始坐标，进内存前换成显示坐标。
  // **收和发必须成对**：只做一头的话，框和生效范围会镜像。
  function zonesToDisplay(list) {
    return (list || []).map(mapRect);
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
  var elHudTeam = document.getElementById('hud-team');

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
    // 空白处拖动：建区模式下由 ZoneUI 接手，否则返回 false 照旧平移
    onEmptyDragStart: function (wx, wy) {
      if (!global.ZoneUI || !global.ZoneUI.isDrawing()) return false;
      return global.ZoneUI.begin(wx, wy);
    },
    onEmptyDragMove: function (wx, wy) {
      if (global.ZoneUI) global.ZoneUI.update(wx, wy);
    },
    onEmptyDragEnd: function () {
      if (global.ZoneUI) global.ZoneUI.commit();
    },
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

    // 骰子动画先统一推进/清理，**再**去画。
    //
    // 不能把清理写在「画某颗骰子」的分支里：那条路径前面有视口裁剪，
    // 一旦把这颗骰子拖出屏幕（或缩得很小走了别的分支），
    // 清理就永远不会执行 —— 到期条目一直留在 diceAnim 里，
    // pendingAnim 永远为真，于是变成**常驻 rAF 死循环**（手机持续唤醒）。
    // 这类 bug 画面上看不出来，只费电。
    var diceProg = {};
    var diceActive = false;
    var nowT = nowMs();
    for (var dk in diceAnim) {
      if (!diceAnim.hasOwnProperty(dk)) continue;
      var an = diceAnim[dk];
      // 骰子被删掉了 -> 顺手清掉动画
      if (!pieces.has(dk)) { delete diceAnim[dk]; continue; }
      var pr = (nowT - an.t0) / an.dur;
      if (pr >= 1) { delete diceAnim[dk]; continue; }
      diceProg[dk] = pr < 0 ? 0 : pr;
      diceActive = true;
    }
    pendingAnim = diceActive;

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

        // 骰子是**画出来的**，不走贴图 / LOD 那一套。
        // 它们尺寸很小、数量也少，直接矢量绘制比分发贴图更省。
        if (p.ds > 0) {
          // 进度在帧首统一算好（见上面），这里只查表
          var prog = diceProg.hasOwnProperty(p.id) ? diceProg[p.id] : null;
          Dice.draw(g, cx, cy, p.w, p.ds, p.v, prog, dicePhase(p.id), p.c);
          if (p.lk) strokeLock(g, cx - hw, cy - hh, p.w, p.h, s);
          if (selection.has(p.id) && showRing) strokeSel(g, cx - hw, cy - hh, p.w, p.h, s);
          continue;
        }

        // 标记同样是画出来的（方/圆/三角/星/文字框 + 自定义色）
        if (p.sh > 0) {
          Token.draw(g, cx, cy, p.w, p.sh, p.c, p.tx, p.h);
          if (p.lk) strokeLock(g, cx - hw, cy - hh, p.w, p.h, s);
          if (selection.has(p.id) && showRing) strokeSel(g, cx - hw, cy - hh, p.w, p.h, s);
          continue;
        }

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

    // 骰子还在滚 -> 再排一帧。
    // 只在真有动画时续帧，不做常驻 rAF（那会让手机一直保持唤醒）。
    // pendingAnim 由帧首的动画推进统一赋值，这里只管续帧。
    if (pendingAnim) {
      global.requestAnimationFrame(function () { board.requestDraw(); });
    }
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
    // 视野区**也是坐标**（矩形），同样必须换回原始坐标。
    //
    // 漏掉它的后果特别隐蔽：区域用显示坐标存、服务端按原始坐标判定，
    // 而默认映射 pn 是「y 取反」，于是**画出来的框和真正生效的范围
    // 上下镜像** —— 你看着框住了上方一片，实际被挡住的是下方那片。
    // 表现就是「明明框住了，有些东西还是没隐藏（而另一些莫名消失了）」。
    if (op.k === 'zone' && op.zone) {
      var rz = {};
      for (var zk in op.zone) if (op.zone.hasOwnProperty(zk)) rz[zk] = op.zone[zk];
      // 矩形要按「两个角都映射、再归一成左上角 + 正宽高」处理，
      // 不能只映射左上角 —— 负向映射会让左上角跑到右下角去。
      var x1 = op.zone.x, y1 = op.zone.y;
      var x2 = op.zone.x + op.zone.w, y2 = op.zone.y + op.zone.h;
      var a = mapPt(x1, y1), b = mapPt(x2, y2);
      rz.x = Math.min(a.x, b.x);
      rz.y = Math.min(a.y, b.y);
      rz.w = Math.abs(b.x - a.x);
      rz.h = Math.abs(b.y - a.y);
      net.send({ t: 'op', op: { k: 'zone', zone: rz } });
      return;
    }

    // dice / token **也带坐标**，同样必须换回原始坐标再发。
    // 漏掉这一条时：本地按显示坐标保存，服务端按原始坐标广播，
    // 于是同一位置在别人屏幕上（y 符号相反）会镜像到另一侧 ——
    // 自己看着对、别人看着错，属于最难当场发现的一类。
    if (op.k === 'dice' || op.k === 'token') {
      var p2 = mapPt(op.x, op.y);
      var out = { k: op.k, x: p2.x, y: p2.y };
      if (op.k === 'dice') out.ds = op.ds; else out.sh = op.sh;
      if (op.c) out.c = op.c;
      if (typeof op.size === 'number') out.size = op.size;
      if (typeof op.r === 'number') out.r = op.r;
      // 文字框的**内容与初始尺寸**也必须转发。
      // 漏掉时：本地看着有字，服务端存的是空串，一刷新（或别人打开）
      // 就变成一块空牌子 —— 典型的「本机对、别人错」。
      if (typeof op.w === 'number') out.w = op.w;
      if (typeof op.h === 'number') out.h = op.h;
      if (typeof op.tx === 'string') out.tx = op.tx;
      net.send({ t: 'op', op: out });
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

    // 层级调整：服务端回 [{id, z}]。
    //
    // 注意 z 可能**是负数**（置底时会取「比当前最小值再小」），
    // 所以不能沿用 move 那句 `if (it.z > zMax) zMax = it.z` 的假设。
    // zMax 只管「本地乐观计数」，实际顺序由 z 排序决定。
    if (op.k === 'z' && Array.isArray(op.list)) {
      for (var zi = 0; zi < op.list.length; zi++) {
        var zit = op.list[zi];
        var zp = pieces.get(zit.id);
        if (!zp || typeof zit.z !== 'number') continue;
        zp.z = zit.z;
        if (zit.z > zMax) zMax = zit.z;
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

    // 视野区变更
    if (op.k === 'zone') {
      if (global.ZoneUI) {
        global.ZoneUI.setZones(zonesToDisplay(op.zones));
      }
      // 区域变了，背景层要重画
      board.requestBg ? board.requestBg() : board.requestDraw();
      board.requestDraw();
      return;
    }

    // 新标记：服务端回完整棋子对象（原始坐标）
    if (op.k === 'token' && op.piece) {
      var kp = Object.assign({}, op.piece);
      var kw = mapPt(kp.x, kp.y);
      kp.x = kw.x; kp.y = kw.y;
      pieces.set(kp.id, kp);
      if (typeof kp.z === 'number' && kp.z > zMax) zMax = kp.z;
      orderDirty = true;
      return;
    }

    // 新骰子：服务端回完整棋子对象（原始坐标）
    if (op.k === 'dice' && op.piece) {
      var dp = Object.assign({}, op.piece);
      var dw = mapPt(dp.x, dp.y);
      dp.x = dw.x; dp.y = dw.y;
      pieces.set(dp.id, dp);
      if (typeof dp.z === 'number' && dp.z > zMax) zMax = dp.z;
      orderDirty = true;
      // 新加的骰子直接滚一次，省得再点一下
      startRoll([dp.id]);
      return;
    }

    // 掷骰结果：点数以服务端为准，同时触发滚动动画
    if (op.k === 'roll' && Array.isArray(op.list)) {
      var rollIds = [];
      for (var ri = 0; ri < op.list.length; ri++) {
        var it2 = op.list[ri];
        var q2 = pieces.get(it2.id);
        if (!q2) continue;
        q2.v = it2.v | 0;
        if (typeof it2.z === 'number' && it2.z > zMax) zMax = it2.z;
        q2.z = it2.z;
        rollIds.push(q2.id);
      }
      orderDirty = true;
      if (rollIds.length) startRoll(rollIds);
      return;
    }

    if (op.k === 'del') {
      pieces.delete(op.id);
      selection.delete(op.id);
      delete diceAnim[op.id];
      syncHudSel();
      orderDirty = true;
      return;
    }

    var q = pieces.get(op.id);
    if (!q) return;

    if (op.k === 'flip') q.f = op.f ? 1 : 0;
    // 角度保留两位小数：真实资产有 596 枚棋子的朝向是 0.27 这类小数，
    // 用 |0 取整会把它们静默抹平（服务端也是同样精度）。
    else if (op.k === 'rot') q.r = normR(op.r);
    else if (op.k === 'lock') q.lk = op.lk ? 1 : 0;
    else if (op.k === 'edit') {
      if (typeof op.c === 'number') q.c = op.c >>> 0;
      if (op.sh) q.sh = op.sh | 0;
      if (typeof op.w === 'number') q.w = op.w;
      if (typeof op.h === 'number') q.h = op.h;
      if (typeof op.tx === 'string') q.tx = op.tx;
    }
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

    // 冻结的棋子拖不动。
    //
    // 注意这里的条件是「按到的这枚」而不是「选择里是否包含它」：
    // 早期写成 `hit.lk && !selection.has(hit.id)`，意思是「已选中的
    // 冻结棋子允许拖」。但那会导致一个荒谬的结果 ——
    // 冻结的棋子自己不动，**却把它上面压着的棋子全带走了**
    //（因为 coverClosure 只排除冻结项，上面那些没冻的照样进批量）。
    // 用户看到的是「冻着的东西纹丝不动，上面的牌却飞了」。
    // 正确语义：按到冻结物 = 这一次拖动整个不成立。
    if (hit.lk) return;

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

    if (!keepSel) selectOnly(hit);

    // 把压在选中棋子上的也拉进来（需求二）
    var closure = coverClosure(Array.from(selection));

    // 选择里若混着冻结的棋子，这次拖动同样不成立 ——
    // 否则会拖走一半、留下一半，是最难解释的状态。
    // 冻结是「钉在桌上」，钉住的东西不能被整体搬走。
    var hasFrozen = closure.some(function (id) {
      var q = pieces.get(id);
      return q && q.lk;
    });
    if (hasFrozen) return;

    dragging = closure;
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

  // 角度归一：保留**两位**小数，与服务端 / codec 的精度约定一致
  // （场景数据里 r 就是两位小数，如 0.27 / 359.94）
  //
  // 注意不能写成 ((n % 360) + 360) % 360：0.27 先 +360 再取模
  // 会得到 0.2699999999999818（浮点残留），与服务端算出的值不等。
  function normR(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    var m = n % 360;
    if (m < 0) m += 360;
    m = Math.round(m * 100) / 100;
    if (m >= 360) m = 0;
    return m;
  }

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
  // 致命提示。
  //
  // fatal 有两种来源，处理方式不同：
  //   1) 格式不匹配（旧服务进程）：只是提示，可以刷新重试
  //   2) 服务端拒绝连接（身份失效 / 房间没了）：必须回主页，
  //      因为再怎么刷新这个房间页都进不去
  function showFatal(text, backHome) {
    if (elFatal) {
      elFatal.hidden = false;
      elFatal.textContent = text;

      if (backHome) {
        var a = document.createElement('button');
        a.type = 'button';
        a.className = 'fatal-act';
        a.textContent = '返回主页';
        a.addEventListener('click', function () { global.location.href = 'index.html'; });
        elFatal.appendChild(a);
      }
    }
    if (elHudConn) {
      elHudConn.textContent = backHome ? '已被拒绝' : '格式不匹配';
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
         (ME ? '&pid=' + encodeURIComponent(ME.id) + '&token=' + encodeURIComponent(ME.token) : '') +
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
        p.ds = p.ds | 0;
        p.sh = p.sh | 0;
        p.c = p.c >>> 0;
        p.tx = typeof p.tx === 'string' ? p.tx : '';
        pieces.set(p.id, p);
      });

      // 视野区（服务端已按我的队伍过滤过，这里不必再判一次）。
      // **但坐标要换回显示系** —— 服务端存的是原始坐标。
      if (global.ZoneUI) global.ZoneUI.setZones(zonesToDisplay(m.zones));

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
    },

    // 房间元数据（玩家列表 / 队伍）交给 room.js 渲染，
    // 这里只把「我的队伍」反映到 HUD 上。
    onRoom: function (m) {
      if (global.RoomUI) global.RoomUI.update(m);
      var you = m.you || {};
      var t = null;
      (m.room.teams || []).forEach(function (x) { if (x.id === you.teamId) t = x; });
      if (elHudTeam) {
        elHudTeam.textContent = t ? t.name : '旁观';
        elHudTeam.className = t ? ('team-' + t.id) : '';
      }

      if (global.ZoneUI) {
        global.ZoneUI.setTeams(m.room.teams || []);
        global.ZoneUI.setMyTeam(you.teamId || null);
      }

      // 「视野区」按钮只给房主 —— 服务端也会硬拦（非房主发 zone op 被拒），
      // 这里藏起来只是别让人白点。
      var elZb = document.getElementById('btn-zone');
      if (elZb) {
        elZb.hidden = !you.owner;
        if (!you.owner) {
          var bar = document.getElementById('zone-bar');
          if (bar) bar.hidden = true;
        }
      }
    },

    // 可见集差分（双盲）。
    //
    // 服务端发现某枚棋子在你这边「从看得见变成看不见」（或反过来）时
    // 发这条。**必须真的删掉**，不能只是不再收它的 op ——
    // 那样它会永远留在屏幕上，这是双盲最典型的漏法。
    onVis: function (m) {
      var removed = 0;
      (m.remove || []).forEach(function (id) {
        if (pieces.delete(id)) removed++;
        selection.delete(id);
        delete diceAnim[id];
      });
      var added = 0;
      (m.add || []).forEach(function (p) {
        // 服务端给的是原始坐标，转成显示坐标
        var w = mapPt(p.x, p.y);
        p.x = w.x; p.y = w.y;
        pieces.set(p.id, p);
        if (typeof p.z === 'number' && p.z > zMax) zMax = p.z;
        added++;
      });
      if (removed || added) {
        orderDirty = true;
        syncHudSel();
        board.requestDraw();
      }
    },

    // 左下角消息流。服务端只发给在场的人，不存历史。
    onLog: function (m) {
      if (global.Log && m && m.text) global.Log.add(m.text, m.kind);
    },

    // 服务端明确拒绝（身份失效 / 房间不存在）—— 重连也没用，
    // 直接回主页让用户重新加入，而不是对着一个连不上的页面发呆。
    onFatal: function (m) {
      showFatal((m && m.error) || '连接被拒绝', true);
    }
  });

  /* ---------- 工具按钮 ---------- */

  // 工具栏精简后只剩「框选 / 物品 / 原点 / 设置」。
  // 原来的全选、取消、翻面、掷骰、适配、存读档按钮都撤了：
  //   - 全选/取消：Ctrl+A / Esc，以及点空白处取消
  //   - 翻面：棋子菜单
  //   - 掷骰：骰子自己的菜单
  //   - 适配：改由双击空白处触发（见下面的 dblclick）
  //   - 存读档：移进设置面板
  document.getElementById('btn-origin').addEventListener('click', function () {
    board.resetView();
  });

  // 桌面端用双击空白处当作「适配全部」，补上撤掉的按钮
  document.getElementById('fg').addEventListener('dblclick', function (e) {
    var w = board.screenToWorld(e.clientX, e.clientY);
    // 点在有东西上就不算（那是双双击，避免误触）
    if (pick(w.x, w.y)) return;
    fitPieces();
  });

  /* ---------- 键盘 ---------- */

  global.addEventListener('keydown', function (e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

    if (e.key === '0') { board.resetView(); return; }
    if (e.key === 'Escape') { clearSelection(); return; }
    // f = 适配全部（工具栏那个按钮撤了）
    if (e.key === 'f' && !selection.size) { fitPieces(); return; }
    // 删除：Delete / Backspace（和文件管理器一致）。
    // 会走二次确认，与菜单里的删除同一路径。
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!selection.size) return;
      e.preventDefault();
      doAction('del');
      return;
    }
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

    // f = 翻面；**选中的都是骰子时，f = 掷骰**。
    //
    // 为什么不给掷骰单独一个键：之前用 d 和 R，其中 R 与旋转的 r
    // 只差一个 Shift，同一个字母两种含义非常反直觉。
    // 现在按「选中的是什么」决定 f 做什么 —— 桌面上「选中骰子然后
    // 按一下」本来就是最自然的掷骰动作，不需要记第二个键。
    //
    // 翻面**对全部选中项生效**（原来只翻第一枚，而菜单里的「翻面」
    // 是批量，两处行为不一致最容易让人困惑）。
    if (e.key === 'f') {
      e.preventDefault();
      var selList = selectedPieces();
      if (!selList.length) return;

      var allDice = selList.every(function (p) { return p.ds > 0; });
      if (allDice) {
        var rollIds = selList.filter(function (p) { return !p.lk; })
                             .map(function (p) { return p.id; });
        if (rollIds.length) rollDice(rollIds);
        return;
      }

      selList.forEach(function (p) {
        if (!p.lk) commit({ k: 'flip', id: p.id, f: p.f ? 0 : 1 });
      });
      return;
    }

    // r = 旋转 90°，同样对全部选中项生效
    if (e.key === 'r') {
      e.preventDefault();
      selectedPieces().forEach(function (p) {
        if (!p.lk) commit({ k: 'rot', id: p.id, r: normR((p.r || 0) + 90) });
      });
      return;
    }

    // Delete 已在上面处理；其余按键不再拦截
  });

  /* ---------- 右键菜单（桌面右键 / 手机长按） ---------- */

  var menu = global.Menu.create({
    el: document.getElementById('menu'),
    // 第三个参数 value 必须转发 —— 单选列表传目标形态下标、
    // 滑杆传目标角度。漏掉它会让两者都变成 undefined：
    // si 变 0、r 变 0，看起来像「点了没反应」或「全转回 0°」。
    onPick: function (action, piece, value) { doAction(action, piece, value); },
    // 滑杆拖动中的本地预览：只改内存，不发 op（松手才提交）
    onPreview: function (piece, size) {
      var p = pieces.get(piece.id);
      if (!p) return;
      var isItem = (p.ds > 0 || p.sh > 0);
      if (!isItem) {
        // 普通棋子按原比例预览（和服务端算法一致）
        var a = (p.h > 0) ? (p.w / p.h) : 1;
        p.w = size;
        p.h = size / (a || 1);
      } else if (p.sh === Token.TEXT_SHAPE) {
        var k = size / Math.max(p.w, 1);
        p.w = size;
        p.h = Math.max(12, p.h * k);
      } else {
        p.w = p.h = size;
      }
      board.requestDraw();
    }
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
    if (!sel.length) return;

    var allLocked = sel.every(function (p) { return p.lk; });
    var one = sel[0];
    var isDice = sel.every(function (p) { return p.ds > 0; });

    var items = [];

    // ---- 骰子：单独的菜单，棋子那些项对它没意义 ----
    if (isDice) {
      items.push({ action: 'roll', label: '掷骰' + suffix });
      items.push({ sep: true });
      items.push(sizeItem(one));
      items.push(colorItem(one));
      items.push(sizeItem(one));
      layerItems(suffix).forEach(function (x) { items.push(x); });
      items.push({ sep: true });
      items.push({ action: 'lock', label: allLocked ? ('解冻' + suffix) : ('固定（冻结）' + suffix) });
      items.push({ action: 'clone', label: '克隆' + suffix });
      items.push({ action: 'del', label: '删除' + suffix, danger: true });
      menu.show(piece, items, at);
      return;
    }

    // ---- 标记：方/圆/三角/星可切换，也能改色 ----
    var isToken = sel.every(function (p) { return p.sh > 0; });
    if (isToken) {
      items.push({
        radio: true,
        action: 'reshape',
        label: '形状' + (many ? '（统一改）' : ''),
        options: Token.SHAPES.map(function (sh) {
          return { value: sh.id, label: sh.name, note: sh.id === one.sh ? ' 当前' : '' };
        }),
        value: one.sh
      });
      // 文字框才给文字输入
      if (one.sh === Token.TEXT_SHAPE) {
        items.push({
          text: true,
          action: 'text',
          label: '文字' + (many ? '（各枚相同）' : ''),
          value: one.tx || '',
          maxLength: Token.TEXT_MAX,
          placeholder: '输入文字，Enter 应用'
        });
      }
      items.push(sizeItem(one));
      items.push(colorItem(one));
      layerItems(suffix).forEach(function (x) { items.push(x); });
      items.push({ sep: true });
      items.push({ action: 'lock', label: allLocked ? ('解冻' + suffix) : ('固定（冻结）' + suffix) });
      items.push({ action: 'clone', label: '克隆' + suffix });
      items.push({ action: 'del', label: '删除' + suffix, danger: true });
      menu.show(piece, items, at);
      return;
    }

    items.push({ action: 'flip', label: '翻面' + suffix });
    // 大小对所有棋子开放（大板块要缩小、小卡片要放大）。
    // 多选时以第一枚的宽度为起点，各枚按自己的比例缩放。
    items.push(sizeItem(one));

    // 层级
    layerItems(suffix).forEach(function (x) { items.push(x); });

    // ---- 旋转：滑杆支持任意角度，不再是只能 90° 一档 ----
    //
    // 用 range 而不是「再点一次加 90°」，因为卡牌/板块在真实桌面上
    // 经常要摆成任意角度（比如顺着地图的斜线）。
    // 提交时机是 change（松手），拖动过程只更新数字 ——
    // 否则一次拖动会发出上百个 op。
    items.push({
      slider: true,
      action: 'rot',
      label: '旋转',
      min: 0, max: 359, step: 1,
      value: Math.round(one.r || 0),
      unit: '°',
      presets: [0, 90, 180, 270]
    });

    // ---- 形态：**单选列表**，直接点目标形态 ----
    //
    // 之前是「点一次切下一个」，形态多的时候（本模组有 9 形态的对象）
    // 要连点到目标，而且看不见全貌。现在把每个形态列出来直接选。
    var statesOk = sel.every(function (p) { return p.st && p.st.length > 1; });
    if (statesOk) {
      var opts = [];
      for (var i = 0; i < one.st.length; i++) {
        opts.push({
          value: i,
          label: (i + 1) + ' / ' + one.st.length,
          note: i === (one.si | 0) ? ' 当前' : ''
        });
      }
      // 多选时各枚的当前形态可能不同，value 传第一枚的即可
      items.push({
        radio: true,
        action: 'state',
        label: '形态' + (many ? '（各枚按所选序号）' : ''),
        options: opts,
        value: one.si | 0
      });
    } else {
      items.push({
        action: 'state',
        label: '切换形态',
        disabled: true,
        note: sel.some(function (p) { return p.st && p.st.length > 1; })
          ? ' 选中的棋子形态数不一致' : ' 该棋子只有一种形态'
      });
    }

    items.push({ sep: true });
    items.push({ action: 'lock', label: allLocked ? ('解冻' + suffix) : ('固定（冻结）' + suffix) });
    items.push({ action: 'clone', label: '克隆' + suffix });
    items.push({ action: 'del', label: '删除' + suffix, danger: true });

    menu.show(piece, items, at);
  }

  // 菜单里的层级项：置顶 / 置底
  //
  // 不做「输入任意 z」：z 是服务端的全序计数器，
  // 让客户端指定数值等于把全序交出去，两端会打架。
  // 「它不小心跑到最上面了，我要压回最底」这个需求，
  // 两个语义动作就够了。
  function layerItems(suffix) {
    return [
      { action: 'z-top', label: '置顶' + suffix },
      { action: 'z-bottom', label: '置底' + suffix }
    ];
  }

  // 菜单里的大小滑杆
  function sizeItem(one) {
    return {
      size: true,
      action: 'size',
      label: '大小',
      // 上限要罩得住最大的底图板块（实测 w=768），否则拉不满
      min: 8, max: 1600, step: 1,
      // 对数轴：8~1600 是 200 倍跨度，线性轴下常用尺寸
      // 全挤在左边一小段，根本没法微调（见 menu.js 的注释）
      log: true,
      value: Math.round(one.w)
    };
  }

  // 菜单里的色板项
  function colorItem(one) {
    // 注意键名：menu.js 用 `colors` 数组的存在与否来识别色板项，
    // 所以这里只能有一个 colors（早期写成布尔 + 数组两个同名键，
    // 前者被后者覆盖，属于能跑但会误导人的写法）。
    return {
      action: 'tint',
      label: '颜色',
      value: (one.c >>> 0),
      colors: PALETTE_LIST.map(function (c) {
        return { value: c.v, name: c.name, hex: c.v ? Token.intToHex(c.v) : null };
      })
    };
  }

  function doAction(action, piece, value) {
    var sel = selectedPieces();
    if (!sel.length) return;

    switch (action) {
      case 'flip':
        sel.forEach(function (p) {
          if (!p.lk) commit({ k: 'flip', id: p.id, f: p.f ? 0 : 1 });
        });
        break;

      // 滑杆传来的是**目标绝对角度**（不是增量），
      // 所以多选时所有选中项都转到同一个角度。
      case 'rot': {
        var target = normR(Number(value));
        sel.forEach(function (p) {
          if (!p.lk) commit({ k: 'rot', id: p.id, r: target });
        });
        break;
      }

      // 单选列表传来的是目标形态下标，直接设，不再「下一个」
      case 'state': {
        var si = value | 0;
        sel.forEach(function (p) {
          if (p.lk || !p.st || p.st.length < 2) return;
          if (si < 0 || si >= p.st.length) return;
          commit({ k: 'state', id: p.id, si: si });
        });
        break;
      }

      // 改颜色：骰子与标记通用
      case 'tint':
        sel.forEach(function (p) {
          if ((p.ds > 0 || p.sh > 0) && !p.lk) {
            commit({ k: 'edit', id: p.id, c: value >>> 0 });
          }
        });
        break;

      // 改标记形状
      case 'reshape': {
        var sh = value | 0;
        if (!sh) break;
        sel.forEach(function (p) {
          if (p.sh > 0 && !p.lk) commit({ k: 'edit', id: p.id, sh: sh });
        });
        break;
      }

      // 改大小（正方形物品宽高一起变；文字框只改宽度，高度按比例）
      case 'size': {
        var nsz = Number(value);
        if (!isFinite(nsz)) break;
        sel.forEach(function (p) {
          if (p.lk) return;
          var isItem = (p.ds > 0 || p.sh > 0);
          if (!isItem) {
            // 普通棋子（含 1.5:1 的地图板块）按**原比例**缩放，
            // 否则地图会被拉变形。只发 w，服务端按比例算 h。
            commit({ k: 'edit', id: p.id, w: nsz });
          } else if (p.sh === Token.TEXT_SHAPE) {
            var k = nsz / Math.max(p.w, 1);
            commit({ k: 'edit', id: p.id, w: nsz, h: Math.round(p.h * k) });
          } else {
            commit({ k: 'edit', id: p.id, w: nsz, h: nsz });
          }
        });
        break;
      }

      // 文字框内容
      case 'text': {
        var txt = String(value == null ? '' : value).slice(0, Token.TEXT_MAX);
        sel.forEach(function (p) {
          if (p.sh === Token.TEXT_SHAPE && !p.lk) {
            commit({ k: 'edit', id: p.id, tx: txt });
          }
        });
        break;
      }

      // 层级：置顶 / 置底。走服务端的 z op（它维护全序）。
      case 'z-top':
      case 'z-bottom': {
        var ids = sel.filter(function (p) { return !p.lk; }).map(function (p) { return p.id; });
        if (ids.length) {
          commit({ k: 'z', list: ids.map(function (id) { return { id: id }; }),
                   where: action === 'z-top' ? 'top' : 'bottom' });
        }
        break;
      }

      case 'roll': {
        // 冻结的不能进批量：服务端对含冻结项的整批**整体拒绝**，
        // 夹一颗冻结骰子会让其余全掷不动。这里先剔掉。
        var rollable = sel.filter(function (p) { return p.ds > 0 && !p.lk; })
                          .map(function (p) { return p.id; });
        if (rollable.length) rollDice(rollable);
        break;
      }

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

  /* ---------- 骰子 ---------- */

  // 先本地演起来，再等服务端回权威点数。
  //
  // 顺序很重要：等服务端回来才动，网络慢时会有明显迟滞；
  // 先演的话，点数揭晓的瞬间就是服务端回包到达时 —— 观感更好，
  // 而且**结果仍以服务端为准**（回包会覆盖 v）。
  function rollDice(ids) {
    if (!ids.length) return;
    startRoll(ids);
    net.send({ t: 'op', op: { k: 'roll', ids: ids } });
  }

  // 掷出指定面数的骰子，放在**当前视图中心**
  function addDice(sides) {
    var c = board.screenToWorld(board.size.w / 2, board.size.h / 2);
    // 略随机偏移，连加几颗不会完全重叠
    var jx = (Math.random() - 0.5) * 90;
    var jy = (Math.random() - 0.5) * 90;
    commit({ k: 'dice', ds: sides, x: c.x + jx, y: c.y + jy });
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

  /* ---------- 物品面板（拖到桌面放下） ---------- */

  var elItems = document.getElementById('items');
  var elItemsBtn = document.getElementById('btn-items');
  var elItemDice = document.getElementById('item-dice');
  var elItemTokens = document.getElementById('item-tokens');
  var elItemColors = document.getElementById('item-colors');
  var elGhost = document.getElementById('ghost');

  // 当前选中的颜色（0 = 默认配色）。骰子和标记共用同一个色板。
  var itemColor = 0;

  var PALETTE = PALETTE_LIST;

  elItemsBtn.addEventListener('click', function () {
    elItems.hidden = !elItems.hidden;
    elItemsBtn.className = elItems.hidden ? '' : 'on';
  });

  // ---- 色板 ----
  PALETTE.forEach(function (c) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (c.v === itemColor ? ' on' : '');
    b.dataset.color = String(c.v);
    b.title = c.name;
    var hex = c.v ? Token.intToHex(c.v) : '';
    // 「默认」用斜线表示「不指定颜色」
    b.style.background = c.v ? hex : 'transparent';
    if (!c.v) b.textContent = '／';
    b.addEventListener('click', function () {
      itemColor = c.v;
      var all = elItemColors.children;
      for (var i = 0; i < all.length; i++) {
        all[i].className = 'swatch' + (Number(all[i].dataset.color) === itemColor ? ' on' : '');
      }
      // 同时改选中的骰子/标记，方便「先选再改色」
      var sel = selectedPieces();
      var n = 0;
      sel.forEach(function (p) {
        if ((p.ds > 0 || p.sh > 0) && !p.lk) { commit({ k: 'edit', id: p.id, c: itemColor }); n++; }
      });
      if (n) flashNote('已给选中的 ' + n + ' 个物品改色');
    });
    elItemColors.appendChild(b);
  });

  function flashNote(text) {
    var el = document.getElementById('items-note');
    if (!el) return;
    el.textContent = text;
    global.setTimeout(function () {
      el.innerHTML = '选好颜色后，把上面的物品<b>拖到桌面</b>即可放下；直接点也能放到视图中心。';
    }, 2200);
  }

  // ---- 可拖出的物品 ----
  //
  // 交互：从面板按下 -> 出现跟随鼠标的「幽灵」-> 松手在桌面上就放下。
  // 手机上 pointer 事件同样可用（手指拖出去松手）。
  function makeDraggable(btn, spec) {
    var dragging = false;

    btn.addEventListener('pointerdown', function (e) {
      // 点在按钮上就准备拖，但也要允许「只是点一下」（放到视图中心）
      dragging = true;
      btn._start = { x: e.clientX, y: e.clientY };
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    });

    btn.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - btn._start.x, dy = e.clientY - btn._start.y;
      if (!btn._ghostOn && Math.abs(dx) + Math.abs(dy) < 6) return;

      if (!btn._ghostOn) { btn._ghostOn = true; elGhost.hidden = false; }
      paintGhost(spec);
      elGhost.style.left = (e.clientX - 22) + 'px';
      elGhost.style.top = (e.clientY - 22) + 'px';
      e.preventDefault();
    });

    function finish(e) {
      if (!dragging) return;
      dragging = false;
      var wasGhost = btn._ghostOn;
      btn._ghostOn = false;
      elGhost.hidden = true;

      // 幽灵没出现过 = 只是点了一下 -> 放到视图中心
      var wx, wy;
      if (wasGhost) {
        // 松手位置换算成世界坐标。注意面板区域也算「桌面」——
        // 松在面板上等于放弃，避免误放。
        var r = document.getElementById('panel').getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right &&
            e.clientY >= r.top && e.clientY <= r.bottom) return;
        var w = board.screenToWorld(e.clientX, e.clientY);
        wx = w.x; wy = w.y;
      } else {
        var c = board.screenToWorld(board.size.w / 2, board.size.h / 2);
        wx = c.x; wy = c.y;
      }

      dropItem(spec, wx, wy);
    }

    btn.addEventListener('pointerup', finish);
    btn.addEventListener('pointercancel', function () {
      dragging = false; btn._ghostOn = false; elGhost.hidden = true;
    });
  }

  // 幽灵里画一个该物品的缩略图（直接复用画布渲染器）
  function paintGhost(spec) {
    var W = 64, H = 44;
    elGhost.width = W; elGhost.height = H;
    var g = elGhost.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (spec.kind === 'dice') {
      Dice.draw(g, W / 2, H / 2, 32, spec.ds, Math.min(3, spec.ds), null, 5, itemColor);
    } else if (spec.sh === Token.TEXT_SHAPE) {
      // 文字框是横的，幽灵也按横的预览
      Token.draw(g, W / 2, H / 2, 56, spec.sh, itemColor, '文字', 24);
    } else {
      Token.draw(g, W / 2, H / 2, 30, spec.sh, itemColor);
    }
  }

  function dropItem(spec, wx, wy) {
    if (spec.kind === 'dice') {
      commit({ k: 'dice', ds: spec.ds, x: wx, y: wy, c: itemColor });
    } else if (spec.sh === Token.TEXT_SHAPE) {
      // 直接放一块空牌子，**不弹输入框**：
      // 拖出来的动作应该立刻有结果，弹窗会打断手感。
      // 放下后右键菜单里有「文字」一项可以随时改。
      commit({ k: 'token', sh: 5, x: wx, y: wy, c: itemColor });
    } else {
      commit({ k: 'token', sh: spec.sh, x: wx, y: wy, c: itemColor });
    }
    // 放下后自动收起面板，避免挡住刚放的东西
    elItems.hidden = true;
    elItemsBtn.className = '';
  }

  // 骰子 d2..d12
  Dice.SIDES.forEach(function (ds) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'item';
    b.title = '拖到桌面放下 d' + ds;

    // 按钮里直接画一颗小骰子当图标
    var cv = document.createElement('canvas');
    cv.width = 34; cv.height = 34;
    var g = cv.getContext('2d');
    Dice.draw(g, 17, 18, 26, ds, Math.min(3, ds), null, ds, 0);
    b.appendChild(cv);
    b.appendChild(document.createTextNode('d' + ds));

    makeDraggable(b, { kind: 'dice', ds: ds });
    elItemDice.appendChild(b);
  });

  // 标记：方 / 圆 / 三角 / 星 / 文字框
  Token.SHAPES.forEach(function (sh) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'item';
    b.title = '拖到桌面放下' + sh.name + '标记';

    var cv = document.createElement('canvas');
    cv.width = 34; cv.height = 34;
    var g = cv.getContext('2d');
    Token.draw(g, 17, 18, 26, sh.id, 0);
    b.appendChild(cv);
    b.appendChild(document.createTextNode(sh.name));

    makeDraggable(b, { kind: 'token', sh: sh.id });
    elItemTokens.appendChild(b);
  });

  // 「掷骰」动作：双击骰子即可掷（骰子自己的菜单里也有）。
  // 键盘 R 也能掷选中的骰子，补上撤掉的工具栏按钮。

  // 视野区面板发出去的 op 走正常通道（服务端会校验房主身份）
  if (global.ZoneUI) {
    global.ZoneUI.onSend(function (op) { commit(op); });
  }

  /* ---------- 启动 ---------- */  /* ---------- 视野区绘制 ---------- */

  // 画在**背景层**：区域边框只在视变换变化时才需要重画，
  // 而棋子每帧都在动。画在 fg 上会白白增加每帧开销。
  if (global.ZoneUI) {
    // 队伍色到了 / 区域变了都要重画背景层
    global.ZoneUI.onRedraw(function () {
      board.requestBg();
      board.requestDraw();
    });
    board.setBgDrawer(function (g, view) {
      var isOwner = false;
      var st = global.RoomUI && global.RoomUI.state();
      if (st && st.you) isOwner = !!st.you.owner;
      global.ZoneUI.draw(g, view, isOwner);
    });
    board.requestBg();
  }

  /* ---------- 面板折叠 ---------- */

  // 窄屏默认收起，避免左上/右上两块叠在一起（见 panels.js 的文件头）。
  // 两块互为 peer：窄屏上展开一块会自动收起另一块。
  var panelLeft = global.Panels ? global.Panels.create({
    id: 'left', el: '#panel', toggle: '#panel-toggle',
    peer: function () { return panelRight; }
  }) : null;
  var panelRight = global.Panels ? global.Panels.create({
    id: 'right', el: '#players', toggle: '#players-toggle',
    peer: function () { return panelLeft; }
  }) : null;

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
    lod: function () { return lodThreshold; },

    // 诊断 / 测试用：外部直接改 pieces 后必须调它，否则顺序缓存是旧的，
    // pick 会拿不到刚插入的棋子。（产品代码永远走 applyOp，那里会自己标脏。）
    touch: function () { orderDirty = true; board.requestDraw(); },
    color: function () { return itemColor; },
    diceAnim: function () { return diceAnim; }
  };
})(window);

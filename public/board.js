/*
 * board.js —— 双层 Canvas 渲染 + 视变换 + 触控手势
 *
 * 设计约定（这是整个前端的地基）：
 *
 *   1. 坐标一律用「世界坐标」= 网格单位 * cell，不存像素。
 *      像素只在渲染那一刻由视变换算出，因此缩放/分辨率无关。
 *
 *   2. 视变换只有一个： screen = world * s + t
 *                          world  = (screen - t) / s
 *
 *   3. 双层 Canvas：
 *        bg 层 = 底图/网格，只在视变换变化时重绘
 *        fg 层 = 棋子/选中框，内容标脏时重绘
 *      「冷冻底图」就是这个意思 —— 平移缩放之外的时刻 bg 层不动。
 *
 *   4. 不跑常驻 rAF 循环。输入事件里标脏 + requestAnimationFrame 一次，
 *      画完即停。空转的 rAF 会让手机持续保持唤醒，与「CPU 日常接近 0」相悖。
 *
 *   5. 分辨率封顶：canvas 物理像素 = CSS 像素 * min(dpr, cap)。
 *      小屏设备 cap=1.5，其余 cap=2。这是防显存溢出的关键一招。
 */
(function (global) {
  'use strict';

  var MIN_SCALE = 0.08;
  var MAX_SCALE = 6;
  var SLOP = 8;          // 超过这个位移才算拖动/平移，否则算点击
  var TAP_MS = 320;      // 点击判定时限
  var ACTIVE_MARGIN = 48; // 平移时棋盘至少留这么多像素在屏幕内

  // 小屏设备降低 DPR 上限，直接砍掉大半填充率
  var SCREEN_MIN = Math.min(
    global.screen && global.screen.width || 9999,
    global.screen && global.screen.height || 9999
  );
  var DPR_CAP = SCREEN_MIN <= 500 ? 1.5 : 2;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function nowMs() { return global.performance ? performance.now() : Date.now(); }

  function create(opts) {
    var bg = opts.bg;
    var fg = opts.fg;
    var bctx = bg.getContext('2d');
    var fctx = fg.getContext('2d');

    var atlas = opts.atlas || null;
    var cell = opts.cell || 64;
    var cols = opts.cols || 16;
    var rows = opts.rows || 16;

    var drawer = null;    // function(g, view, cell)  世界坐标系下画棋子
    var hitTest = null;   // function(wx, wy) -> 命中对象或 null

    var dpr = 1;
    var size = { w: 0, h: 0 };
    var origin = { x: 0, y: 0 };
    var view = { s: 1, tx: 0, ty: 0 };

    var bgDirty = true, fgDirty = true, raf = 0;

    var pointers = new Map();  // pointerId -> {x,y} 屏幕坐标
    var gest = null;

    /* ---------- 视变换 ---------- */

    function screenToWorld(x, y) {
      return { x: (x - view.tx) / view.s, y: (y - view.ty) / view.s };
    }
    function worldToScreen(x, y) {
      return { x: x * view.s + view.tx, y: y * view.s + view.ty };
    }
    function screenToGrid(x, y) {
      var w = screenToWorld(x, y);
      return { gx: w.x / cell, gy: w.y / cell };
    }

    // 保证棋盘不会被平移到完全看不见
    function clampView() {
      var bw = cols * cell * view.s;
      var bh = rows * cell * view.s;
      var m = ACTIVE_MARGIN;

      if (bw <= size.w - m * 2) view.tx = (size.w - bw) / 2;
      else view.tx = clamp(view.tx, size.w - m - bw, m);

      if (bh <= size.h - m * 2) view.ty = (size.h - bh) / 2;
      else view.ty = clamp(view.ty, size.h - m - bh, m);
    }

    function fit() {
      var pad = 16;
      var s = Math.min(
        (size.w - pad * 2) / (cols * cell),
        (size.h - pad * 2) / (rows * cell)
      );
      view.s = clamp(s, MIN_SCALE, MAX_SCALE);
      view.tx = (size.w - cols * cell * view.s) / 2;
      view.ty = (size.h - rows * cell * view.s) / 2;
      clampView();
      requestBg();
      requestDraw();
    }

    function zoomAt(sx, sy, factor) {
      var s1 = clamp(view.s * factor, MIN_SCALE, MAX_SCALE);
      var k = s1 / view.s;
      view.s = s1;
      view.tx = sx - (sx - view.tx) * k;
      view.ty = sy - (sy - view.ty) * k;
      clampView();
      requestBg();
      requestDraw();
    }

    /* ---------- 脏标记 / 调度（无常驻循环） ---------- */

    function schedule() {
      if (!raf) raf = global.requestAnimationFrame(flush);
    }
    function requestBg() { bgDirty = true; schedule(); }
    function requestDraw() { fgDirty = true; schedule(); }

    function flush() {
      raf = 0;
      if (bgDirty) { bgDirty = false; drawBg(); }
      if (fgDirty) { fgDirty = false; drawFg(); }
    }

    /* ---------- 绘制 ---------- */

    function drawBg() {
      var g = bctx;
      g.clearRect(0, 0, size.w, size.h);

      var cw = cell * view.s;
      var x0 = view.tx, y0 = view.ty;
      var bw = cols * cw, bh = rows * cw;

      // 盘面底色
      g.fillStyle = '#1a1e23';
      g.fillRect(x0, y0, bw, bh);

      // 只画可见范围内的网格线（放大后不必画屏幕外的几百条）
      if (cw >= 4) {
        var i0 = Math.max(0, Math.floor((0 - x0) / cw));
        var i1 = Math.min(cols, Math.ceil((size.w - x0) / cw));
        var j0 = Math.max(0, Math.floor((0 - y0) / cw));
        var j1 = Math.min(rows, Math.ceil((size.h - y0) / cw));

        g.strokeStyle = cw < 10 ? '#232930' : '#2b3138';
        g.lineWidth = 1;
        g.beginPath();
        for (var i = i0; i <= i1; i++) {
          var x = Math.round(x0 + i * cw) + 0.5;
          g.moveTo(x, y0);
          g.lineTo(x, y0 + bh);
        }
        for (var j = j0; j <= j1; j++) {
          var y = Math.round(y0 + j * cw) + 0.5;
          g.moveTo(x0, y);
          g.lineTo(x0 + bw, y);
        }
        g.stroke();
      }

      // 外框
      g.strokeStyle = '#3a434d';
      g.lineWidth = 1;
      g.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, bw, bh);
    }

    function drawFg() {
      var g = fctx;
      g.clearRect(0, 0, size.w, size.h);
      if (!drawer) return;
      g.save();
      g.translate(view.tx, view.ty);
      g.scale(view.s, view.s);
      drawer(g, view, cell);   // 此后的绘制都在世界坐标系里
      g.restore();
    }

    /* ---------- 尺寸 ---------- */

    function resize() {
      dpr = Math.min(global.devicePixelRatio || 1, DPR_CAP);
      size.w = fg.clientWidth || global.innerWidth;
      size.h = fg.clientHeight || global.innerHeight;

      var pw = Math.max(1, Math.round(size.w * dpr));
      var ph = Math.max(1, Math.round(size.h * dpr));
      if (bg.width !== pw || bg.height !== ph) {
        bg.width = pw; bg.height = ph;
        fg.width = pw; fg.height = ph;
      }
      // 设定后统一用 CSS 像素作图，DPR 由 transform 吸收
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      var r = fg.getBoundingClientRect();
      origin.x = r.left; origin.y = r.top;

      requestBg(); requestDraw();
    }

    /* ---------- 手势 ---------- */

    function localXY(e) {
      return { x: e.clientX - origin.x, y: e.clientY - origin.y };
    }
    function firstPointer() {
      var it = pointers.values().next();
      return it.done ? null : it.value;
    }
    function twoPointers() {
      var out = [], it = pointers.values(), n;
      while (!(n = it.next()).done) {
        out.push(n.value);
        if (out.length === 2) break;
      }
      return out.length === 2 ? out : null;
    }

    function rebasePinch() {
      var two = twoPointers();
      if (!two) return;
      var a = two[0], b = two[1];
      gest.m0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      gest.d0 = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
      gest.s0 = view.s;
      gest.t0 = { x: view.tx, y: view.ty };
    }

    function onDown(e) {
      if (e.cancelable) e.preventDefault();
      try { fg.setPointerCapture(e.pointerId); } catch (_) {}

      var p = localXY(e);
      pointers.set(e.pointerId, p);

      if (pointers.size === 1) {
        var w = screenToWorld(p.x, p.y);
        gest = {
          mode: null,                 // null | 'pan' | 'drag' | 'pinch'
          multi: false,
          sx0: p.x, sy0: p.y,
          t0: { x: view.tx, y: view.ty },
          s0: view.s, m0: { x: 0, y: 0 }, d0: 0,
          piece: hitTest ? hitTest(w.x, w.y) : null,
          tStart: nowMs()
        };
        fg.classList.add('grabbing');
      } else if (pointers.size === 2 && gest) {
        // 第二指落下：立刻放弃拖棋子，转缩放
        if (gest.mode === 'drag' && gest.piece && opts.onDragEnd) {
          opts.onDragEnd(gest.piece);
        }
        gest.multi = true;
        gest.mode = 'pinch';
        gest.piece = null;
        rebasePinch();
      }
    }

    function onMove(e) {
      if (!pointers.has(e.pointerId)) return;
      var p = localXY(e);
      pointers.set(e.pointerId, p);
      if (!gest) return;

      /* --- 双指缩放 --- */
      if (pointers.size >= 2) {
        if (gest.mode !== 'pinch') {
          gest.multi = true;
          gest.mode = 'pinch';
          gest.piece = null;
          rebasePinch();
          return;
        }
        var two = twoPointers();
        if (!two || gest.d0 < 1) return;
        var a = two[0], b = two[1];
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        var d = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));

        var s1 = clamp(gest.s0 * (d / gest.d0), MIN_SCALE, MAX_SCALE);
        var k = s1 / gest.s0;
        view.s = s1;
        // 关键：缩放必须同时修正 t，否则画面会朝屏幕左上角「缩过去」
        view.tx = mx - (gest.m0.x - gest.t0.x) * k;
        view.ty = my - (gest.m0.y - gest.t0.y) * k;

        requestBg(); requestDraw();
        return;
      }

      /* --- 单指 --- */
      if (gest.mode === 'pinch') return;   // 等两指都抬起再重开手势

      var dx = p.x - gest.sx0;
      var dy = p.y - gest.sy0;

      if (!gest.mode) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        gest.mode = gest.piece ? 'drag' : 'pan';
        if (gest.mode === 'drag' && opts.onDragStart) {
          var w0 = screenToWorld(gest.sx0, gest.sy0);
          opts.onDragStart(gest.piece, w0.x, w0.y);
        }
      }

      if (gest.mode === 'pan') {
        view.tx = gest.t0.x + dx;
        view.ty = gest.t0.y + dy;
        clampView();
        requestBg(); requestDraw();
      } else if (gest.mode === 'drag' && gest.piece) {
        var w = screenToWorld(p.x, p.y);
        if (opts.onDragMove) opts.onDragMove(gest.piece, w.x, w.y);
        requestDraw();
      }
    }

    function onUp(e) {
      if (!pointers.has(e.pointerId)) return;
      var p = localXY(e);
      pointers.delete(e.pointerId);
      try { fg.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!gest) return;

      // 双指 -> 单指：重设基准，且整段手势不再触发点击
      if (pointers.size === 1) {
        if (gest.mode === 'drag' && gest.piece && opts.onDragEnd) {
          opts.onDragEnd(gest.piece);
        }
        gest.multi = true;
        gest.mode = null;
        gest.piece = null;
        var rest = firstPointer();
        gest.sx0 = rest.x; gest.sy0 = rest.y;
        gest.t0 = { x: view.tx, y: view.ty };
        gest.s0 = view.s;
        gest.tStart = nowMs();
        return;
      }

      if (pointers.size === 0) {
        var wasTap = !gest.mode && !gest.multi &&
                     (nowMs() - gest.tStart) < TAP_MS;

        if (gest.mode === 'drag' && gest.piece && opts.onDragEnd) {
          opts.onDragEnd(gest.piece);
        }
        clampView();
        fg.classList.remove('grabbing');

        var down = { x: gest.sx0, y: gest.sy0 };
        var hit = gest.piece;
        gest = null;

        if (wasTap && opts.onTap) {
          var w = screenToWorld(down.x, down.y);
          opts.onTap({
            sx: down.x, sy: down.y,
            wx: w.x, wy: w.y,
            gx: w.x / cell, gy: w.y / cell,
            hit: hit
          });
        }
        requestBg(); requestDraw();
      }
    }

    /* ---------- 装配 ---------- */

    fg.addEventListener('pointerdown', onDown);
    fg.addEventListener('pointermove', onMove);
    fg.addEventListener('pointerup', onUp);
    fg.addEventListener('pointercancel', onUp);
    fg.addEventListener('lostpointercapture', function (e) {
      if (pointers.has(e.pointerId)) onUp(e);
    });

    // 桌面端：滚轮缩放 + 右键旋转
    fg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = localXY(e);
      zoomAt(p.x, p.y, Math.pow(1.0015, -e.deltaY));
    }, { passive: false });

    fg.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (!opts.onContext) return;
      var p = localXY(e);
      var w = screenToWorld(p.x, p.y);
      // shiftKey 必须显式往下传：调用方用它区分「翻面」和「旋转」，
      // 漏掉的话 shift+右键会退化成普通右键。
      opts.onContext({
        wx: w.x, wy: w.y,
        shiftKey: !!e.shiftKey,
        hit: hitTest ? hitTest(w.x, w.y) : null
      });
    });

    global.addEventListener('resize', resize);
    global.addEventListener('orientationchange', resize);
    global.addEventListener('scroll', function () {
      var r = fg.getBoundingClientRect();
      origin.x = r.left; origin.y = r.top;
    }, { passive: true });

    resize();

    return {
      view: view,
      size: size,
      cell: function () { return cell; },
      cols: function () { return cols; },
      rows: function () { return rows; },
      dpr: function () { return dpr; },
      dprCap: DPR_CAP,

      screenToWorld: screenToWorld,
      worldToScreen: worldToScreen,
      screenToGrid: screenToGrid,
      fit: fit,
      zoomAt: zoomAt,
      resize: resize,

      requestDraw: requestDraw,
      requestBg: requestBg,

      setDrawer: function (fn) { drawer = fn; requestDraw(); },
      setHitTest: function (fn) { hitTest = fn; },
      setAtlas: function (img) { atlas = img; requestDraw(); },
      getAtlas: function () { return atlas; },
      setGrid: function (c, r) { cols = c; rows = r; requestBg(); requestDraw(); },
      setCell: function (c) { cell = c; requestBg(); requestDraw(); }
    };
  }

  global.Board = { create: create, DPR_CAP: DPR_CAP, MIN_SCALE: MIN_SCALE, MAX_SCALE: MAX_SCALE };
})(window);

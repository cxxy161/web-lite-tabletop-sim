/*
 * board.js —— 无限画布渲染 + 视变换 + 触控手势
 *
 * 设计约定（这是整个前端的地基）：
 *
 *   1. 没有网格。物体位置是任意浮点世界坐标，不吸附、不取整。
 *      地图没有边界，平移可以无限继续。
 *
 *   2. 视变换只有一个： screen = world * s + t
 *                          world  = (screen - t) / s
 *
 *   3. 双层 Canvas：
 *        bg 层 = 静态参考物（原点准星），只在视变换变化时重绘
 *        fg 层 = 物体/选中框，内容标脏时重绘
 *
 *   4. 绘制契约（drawFg 设定的坐标系）：
 *        g 已经 scale(view.s)，但 **没有** translate。
 *        因此绘制坐标 = 世界坐标 - (view.ox, view.oy)，
 *        其中 (view.ox, view.oy) 是屏幕左上角对应的世界坐标。
 *
 *      为什么不直接 translate(-tx, -ty) 把世界坐标原样交给 canvas：
 *        无限地图下世界坐标可以很大，若把大数直接丢给 canvas，
 *        部分实现会先降到 float32（约 7 位有效数字），
 *        在 1e7 量级就会出现可见抖动。减去屏幕原点后，
 *        交给 canvas 的永远是屏幕级的小数值，精度问题从根上消失。
 *
 *   5. 不跑常驻 rAF 循环。输入事件里标脏 + requestAnimationFrame 一次，
 *      画完即停。空转的 rAF 会让手机持续保持唤醒。
 *
 *   6. 分辨率封顶：canvas 物理像素 = CSS 像素 * min(dpr, cap)。
 *
 *   7. **本层不知道「棋子」是什么。** 它只报告「在某个世界坐标命中了某个东西」
 *      以及「拖拽产生了多少世界位移」，由调用方决定要移动谁。
 *      多选整体移动就是这样实现的：一次拖拽 = 一个位移量，
 *      调用方把这个位移应用到所有被选中的物体上。
 */
(function (global) {
  'use strict';

  var MIN_SCALE = 0.02;
  var MAX_SCALE = 16;

  var SLOP = 6;           // 超过这个位移才算拖动/平移，否则算点击
  var TAP_MS = 400;       // 点击判定时限
  var LONGPRESS_MS = 420; // 长按判定时限（触屏上加选/减选）
  var ORIGIN_MARK = 14;   // 原点准星的臂长（屏幕像素）

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

    var drawer = null;    // function(g, view)  坐标系见文件头第 4 条
    var hitTest = null;   // function(wx, wy) -> 命中的对象或 null

    var dpr = 1;
    var size = { w: 0, h: 0 };
    var origin = { x: 0, y: 0 };
    var view = { s: 1, tx: 0, ty: 0, ox: 0, oy: 0 };

    var bgDirty = true, fgDirty = true, raf = 0;

    var bgDrawer = null;       // 背景层绘制钩子（视野区用）
    var pointers = new Map();  // pointerId -> {x,y} 屏幕坐标
    var gest = null;

    // 框选矩形（屏幕坐标）。非 null 时 drawFg 会画出来。
    // 只有调用方通过 marqueeEnabled() 打开时才允许触发。
    var marquee = null;
    var marqueeEnabled = false;

    /* ---------- 视变换 ---------- */

    function syncOrigin() {
      view.ox = -view.tx / view.s;
      view.oy = -view.ty / view.s;
    }

    function screenToWorld(x, y) {
      return { x: (x - view.tx) / view.s, y: (y - view.ty) / view.s };
    }
    function worldToScreen(x, y) {
      return { x: x * view.s + view.tx, y: y * view.s + view.ty };
    }

    // 原点回到屏幕正中，缩放复位。
    // 无限地图上平移之后很容易「迷路」，这是唯一的找回方式。
    function resetView() {
      view.s = 1;
      view.tx = size.w / 2;
      view.ty = size.h / 2;
      syncOrigin();
      requestBg();
      requestDraw();
    }

    // 把给定的世界坐标范围铺满屏幕。传 null 等价于 resetView。
    function fitBounds(x0, y0, x1, y1) {
      if (x0 == null) { resetView(); return; }

      var pad = 48;
      var w = Math.max(x1 - x0, 1);
      var h = Math.max(y1 - y0, 1);
      var s = Math.min((size.w - pad * 2) / w, (size.h - pad * 2) / h);

      view.s = clamp(s, MIN_SCALE, MAX_SCALE);
      view.tx = size.w / 2 - ((x0 + x1) / 2) * view.s;
      view.ty = size.h / 2 - ((y0 + y1) / 2) * view.s;
      syncOrigin();
      requestBg();
      requestDraw();
    }

    function zoomAt(sx, sy, factor) {
      var s1 = clamp(view.s * factor, MIN_SCALE, MAX_SCALE);
      var k = s1 / view.s;
      view.s = s1;
      // 关键：缩放必须同时修正 t，否则画面会朝屏幕左上角「缩过去」
      view.tx = sx - (sx - view.tx) * k;
      view.ty = sy - (sy - view.ty) * k;
      syncOrigin();
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
      if (bgDirty) {
        bgDirty = false;
        drawBg();
        if (opts.onView) opts.onView(view);
      }
      if (fgDirty) { fgDirty = false; drawFg(); }
    }

    /* ---------- 绘制 ---------- */

    function drawBg() {
      var g = bctx;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size.w, size.h);

      // 背景层绘制钩子（视野区边框走这里）。
      // **必须在原点准星的 early return 之前调用** ——
      // 准星离屏时会提前返回，把钩子放在后面会导致
      // 「拖到远处后视野区边框消失」。
      if (bgDrawer) {
        g.save();
        g.scale(view.s, view.s);
        bgDrawer(g, view);
        g.restore();
      }

      // 无限地图上没有任何参照物会让人失去方向感，
      // 所以在世界原点画一个极淡的准星 —— 是准星，不是格子。
      var sx = view.tx, sy = view.ty;
      if (sx < -ORIGIN_MARK || sy < -ORIGIN_MARK ||
          sx > size.w + ORIGIN_MARK || sy > size.h + ORIGIN_MARK) return;

      g.strokeStyle = opts.originColor || '#d6cfbe';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(sx) - ORIGIN_MARK + 0.5, Math.round(sy) + 0.5);
      g.lineTo(Math.round(sx) + ORIGIN_MARK + 0.5, Math.round(sy) + 0.5);
      g.moveTo(Math.round(sx) + 0.5, Math.round(sy) - ORIGIN_MARK + 0.5);
      g.lineTo(Math.round(sx) + 0.5, Math.round(sy) + ORIGIN_MARK + 0.5);
      g.stroke();

      g.beginPath();
      g.arc(sx, sy, 3.5, 0, Math.PI * 2);
      g.stroke();
    }

    function drawFg() {
      var g = fctx;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size.w, size.h);

      if (drawer) {
        g.save();
        g.scale(view.s, view.s);   // 不 translate —— 见文件头第 4 条
        drawer(g, view);
        g.restore();
      }

      // 框选矩形画在**所有内容之后**。
      //
      // 原来它画在 drawer 之前，于是桌上任意一枚棋子都会盖住它 ——
      // 框选恰恰是在「一片棋子」上操作的，看不见框等于这个功能废掉。
      // 它画在屏幕坐标系（不随缩放的线宽变化，视觉更稳）。
      if (marquee) {
        var x = Math.min(marquee.x0, marquee.x1);
        var y = Math.min(marquee.y0, marquee.y1);
        var w = Math.abs(marquee.x1 - marquee.x0);
        var h = Math.abs(marquee.y1 - marquee.y0);

        g.save();
        g.fillStyle = 'rgba(194,112,63,.12)';
        g.fillRect(x, y, w, h);
        g.strokeStyle = '#c2703f';
        g.lineWidth = 1;
        g.setLineDash([4, 3]);
        g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
        g.restore();
      }
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
        var hit = hitTest ? hitTest(w.x, w.y) : null;

        gest = {
          mode: null,                 // null | 'pan' | 'drag' | 'pinch'
          multi: false,
          lpFired: false,
          lpTimer: 0,
          sx0: p.x, sy0: p.y,
          w0: { x: w.x, y: w.y },     // 拖拽起点的世界坐标
          t0: { x: view.tx, y: view.ty },
          s0: view.s, m0: { x: 0, y: 0 }, d0: 0,
          hit: hit,
          tStart: nowMs()
        };

        // 长按：触屏上没有 shift，用它来加选/减选。
        // 只有按在东西上才计时 —— 空白处长按没有意义，
        // 而且会挡住「长按空白然后拖动平移」。
        if (hit && opts.onLongPress) {
          var g0 = gest;
          g0.lpTimer = global.setTimeout(function () {
            g0.lpTimer = 0;
            if (gest !== g0 || g0.mode) return;   // 已经变成拖拽/平移了
            g0.lpFired = true;
            opts.onLongPress(g0.hit, { x: g0.sx0, y: g0.sy0 });
          }, LONGPRESS_MS);
        }

        fg.classList.add('grabbing');
      } else if (pointers.size === 2 && gest) {
        // 第二指落下：立刻放弃拖物体，转缩放
        clearLp(gest);
        if (gest.mode === 'drag' && opts.onDragEnd) {
          opts.onDragEnd(gest.hit, gest.last || { x: 0, y: 0 }, true);
        }
        gest.multi = true;
        gest.mode = 'pinch';
        gest.hit = null;
        rebasePinch();
      }
    }

    function clearLp(g) {
      if (g && g.lpTimer) {
        global.clearTimeout(g.lpTimer);
        g.lpTimer = 0;
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
          clearLp(gest);
          if (gest.mode === 'drag' && opts.onDragEnd) {
            opts.onDragEnd(gest.hit, gest.last || { x: 0, y: 0 }, true);
          }
          gest.multi = true;
          gest.mode = 'pinch';
          gest.hit = null;
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
        view.tx = mx - (gest.m0.x - gest.t0.x) * k;
        view.ty = my - (gest.m0.y - gest.t0.y) * k;
        syncOrigin();

        requestBg(); requestDraw();
        return;
      }

      /* --- 单指 --- */
      if (gest.mode === 'pinch') return;   // 等两指都抬起再重开手势

      var dx = p.x - gest.sx0;
      var dy = p.y - gest.sy0;

      if (!gest.mode) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        clearLp(gest);                       // 开始移动 -> 不再算长按
        if (gest.hit) {
          gest.mode = 'drag';
        } else if (opts.onEmptyDragStart &&
                   opts.onEmptyDragStart(gest.w0.x, gest.w0.y) === true) {
          // 调用方接手这次空白拖动（建区模式）。
          // 必须返回 true 才算接住，否则照旧平移 ——
          // 用返回值而不是 boolean 选项，是因为「能不能画」
          // 取决于当时的模式，不该在建立手势时就知道。
          gest.mode = 'empty';
        } else if (marqueeEnabled || e.shiftKey) {
          // 空白处拖动 = 框选。
          // 两种触发：工具栏的「框选」开关（手机用），
          // 或按住 Shift 拖（桌面习惯，和多数绘图软件一致）。
          gest.mode = 'marquee';
          marquee = { x0: gest.sx0, y0: gest.sy0, x1: p.x, y1: p.y };
        } else {
          gest.mode = 'pan';
        }
        if (gest.mode === 'drag' && opts.onDragStart) {
          opts.onDragStart(gest.hit, gest.w0.x, gest.w0.y);
        }
      }

      if (gest.mode === 'empty') {
        var ew = screenToWorld(p.x, p.y);
        if (opts.onEmptyDragMove) opts.onEmptyDragMove(ew.x, ew.y);
        requestBg(); requestDraw();
        return;
      }

      if (gest.mode === 'marquee') {
        marquee.x1 = p.x; marquee.y1 = p.y;
        requestDraw();
        return;
      }

      if (gest.mode === 'pan') {
        view.tx = gest.t0.x + dx;
        view.ty = gest.t0.y + dy;
        syncOrigin();
        requestBg(); requestDraw();
      } else if (gest.mode === 'drag') {
        var w = screenToWorld(p.x, p.y);
        // 只上报「世界位移」，不关心被拖的是谁 ——
        // 多选整体移动靠的就是这个共享的位移量
        var d2 = { x: w.x - gest.w0.x, y: w.y - gest.w0.y };
        gest.last = d2;
        if (opts.onDragMove) opts.onDragMove(gest.hit, w.x, w.y, d2.x, d2.y);
        requestDraw();
      }
    }

    function onUp(e) {
      if (!pointers.has(e.pointerId)) return;
      var p = localXY(e);
      pointers.delete(e.pointerId);
      try { fg.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!gest) return;

      clearLp(gest);

      // 双指 -> 单指：重设基准，且整段手势不再触发点击
      if (pointers.size === 1) {
        if (gest.mode === 'drag' && opts.onDragEnd) {
          opts.onDragEnd(gest.hit, gest.last || { x: 0, y: 0 }, true);
        }
        gest.multi = true;
        gest.mode = null;
        gest.hit = null;
        var rest = firstPointer();
        gest.sx0 = rest.x; gest.sy0 = rest.y;
        gest.t0 = { x: view.tx, y: view.ty };
        gest.s0 = view.s;
        gest.tStart = nowMs();
        return;
      }

      if (pointers.size === 0) {
        // 空白拖动结束（建区）
        if (gest.mode === 'empty') {
          var wasEmpty = true;
          gest = null;
          fg.classList.remove('grabbing');
          if (opts.onEmptyDragEnd) opts.onEmptyDragEnd();
          requestBg(); requestDraw();
          return;
        }

        // 框选结束：把矩形换算成世界坐标交给调用方
        if (gest.mode === 'marquee' && marquee) {
          var a0 = screenToWorld(marquee.x0, marquee.y0);
          var a1 = screenToWorld(marquee.x1, marquee.y1);
          var box = {
            x0: Math.min(a0.x, a1.x), y0: Math.min(a0.y, a1.y),
            x1: Math.max(a0.x, a1.x), y1: Math.max(a0.y, a1.y)
          };
          var additive = gest.multi || !!e.shiftKey;   // shift+框选 = 追加
          marquee = null;
          fg.classList.remove('grabbing');
          gest = null;
          if (opts.onMarquee) opts.onMarquee(box, additive);
          requestBg(); requestDraw();
          return;
        }

        // 长按已经处理过这次按下，抬指时不能再当成点击
        var wasTap = !gest.mode && !gest.multi && !gest.lpFired &&
                     (nowMs() - gest.tStart) < TAP_MS;

        if (gest.mode === 'drag' && opts.onDragEnd) {
          opts.onDragEnd(gest.hit, gest.last || { x: 0, y: 0 }, false);
        }
        fg.classList.remove('grabbing');

        var down = { x: gest.sx0, y: gest.sy0 };
        var hit = gest.hit;
        var shift = !!e.shiftKey;      // 桌面端 shift+点击 = 加选
        gest = null;

        if (wasTap && opts.onTap) {
          var w = screenToWorld(down.x, down.y);
          opts.onTap({
            sx: down.x, sy: down.y,
            wx: w.x, wy: w.y,      // 精确浮点世界坐标，不取整
            shiftKey: shift,
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

    // 桌面端：滚轮缩放 + 右键菜单
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
      // shiftKey 必须显式往下传：调用方用它区分不同操作，
      // 漏掉的话 shift+右键会退化成普通右键。
      opts.onContext({
        wx: w.x, wy: w.y,
        sx: p.x, sy: p.y,          // 局部屏幕坐标，供菜单定位
        clientX: e.clientX, clientY: e.clientY,
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

    syncOrigin();
    resize();

    return {
      view: view,
      size: size,
      dpr: function () { return dpr; },
      dprCap: DPR_CAP,

      screenToWorld: screenToWorld,
      worldToScreen: worldToScreen,
      resetView: resetView,
      fitBounds: fitBounds,
      zoomAt: zoomAt,
      resize: resize,

      requestDraw: requestDraw,
      requestBg: requestBg,

      setDrawer: function (fn) { drawer = fn; requestDraw(); },
      setBgDrawer: function (fn) { bgDrawer = fn; requestBg(); },

      // 打开后：空白处拖动 = 框选；关闭则恢复为平移地图
      setMarquee: function (on) {
        marqueeEnabled = !!on;
        if (!on) { marquee = null; requestDraw(); }
      },
      isMarquee: function () { return marqueeEnabled; },
      setHitTest: function (fn) { hitTest = fn; }
    };
  }

  global.Board = {
    create: create,
    DPR_CAP: DPR_CAP,
    MIN_SCALE: MIN_SCALE,
    MAX_SCALE: MAX_SCALE
  };
})(window);

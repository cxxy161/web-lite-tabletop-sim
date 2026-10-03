/*
 * menu.js —— 棋子右键菜单
 *
 * 桌面：右键弹出。
 * 手机：**没有右键**，所以用**长按**弹出同一个菜单。
 *
 * 项的类型（由 app.js 动态给出，因为「切换形态」只在多形态时才有意义）：
 *   {action, label, note?, disabled?, danger?}         普通项
 *   {sep:true}                                         分隔线
 *   {radio, label, options:[{value,label,note?}], value}  单选列表
 *   {slider, label, min, max, step, value, unit?}       滑杆（用于任意角度旋转）
 */
(function (global) {
  'use strict';

  function create(opts) {
    var el = opts.el;
    var onPick = opts.onPick;       // function(action, piece, value)
    var onPreview = opts.onPreview; // 滑杆拖动中的本地预览（不发 op）
    var open = false;

    function hide() {
      el.hidden = true;
      open = false;
    }

    function addItem(it, piece) {
      if (it.sep) {
        var s = document.createElement('div');
        s.className = 'menu-sep';
        el.appendChild(s);
        return;
      }

      // ---- 单选列表：直接点选目标项，不再「点一次换一下」 ----
      if (it.radio) {
        var grp = document.createElement('div');
        grp.className = 'menu-group';

        var lb = document.createElement('div');
        lb.className = 'menu-label';
        lb.textContent = it.label;
        grp.appendChild(lb);

        var list = document.createElement('div');
        list.className = 'menu-radio';

        it.options.forEach(function (o) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = (o.value === it.value) ? 'on' : '';
          b.dataset.value = String(o.value);

          var t = document.createElement('span');
          t.className = 'radio-mark';
          t.textContent = (o.value === it.value) ? '●' : '○';
          b.appendChild(t);

          var n = document.createElement('span');
          n.textContent = o.label;
          b.appendChild(n);

          if (o.note) {
            var nt = document.createElement('span');
            nt.className = 'menu-note';
            nt.textContent = o.note;
            b.appendChild(nt);
          }

          b.addEventListener('click', function (e) {
            e.stopPropagation();
            hide();
            onPick(it.action, piece, o.value);
          });
          list.appendChild(b);
        });

        grp.appendChild(list);
        el.appendChild(grp);
        return;
      }

      // ---- 滑杆：任意角度旋转 ----
      if (it.slider) {
        var wrap = document.createElement('div');
        wrap.className = 'menu-group';

        var head = document.createElement('div');
        head.className = 'menu-label';

        var val = document.createElement('span');
        val.className = 'menu-val';
        val.textContent = it.value + (it.unit || '');

        head.textContent = it.label + ' ';
        head.appendChild(val);
        wrap.appendChild(head);

        var row = document.createElement('div');
        row.className = 'menu-slider';

        var rng = document.createElement('input');
        rng.type = 'range';
        rng.min = it.min; rng.max = it.max; rng.step = it.step || 1;
        rng.value = it.value;
        rng.addEventListener('input', function () {
          val.textContent = rng.value + (it.unit || '');
        });
        // 拖动过程只预览数值，松手才提交 —— 否则一次拖动会发上百个 op
        rng.addEventListener('change', function () {
          onPick(it.action, piece, Number(rng.value));
        });
        row.appendChild(rng);

        // 几个常用角度，省得拖
        var quick = document.createElement('div');
        quick.className = 'menu-quick';
        (it.presets || []).forEach(function (p) {
          var q = document.createElement('button');
          q.type = 'button';
          q.textContent = p + '°';
          q.addEventListener('click', function (e) {
            e.stopPropagation();
            hide();
            onPick(it.action, piece, p);
          });
          quick.appendChild(q);
        });
        row.appendChild(quick);

        wrap.appendChild(row);
        el.appendChild(wrap);
        return;
      }

      // ---- 大小滑杆 ----
      if (it.size) {
        var sw = document.createElement('div');
        sw.className = 'menu-group';

        var sh2 = document.createElement('div');
        sh2.className = 'menu-label';
        var sv = document.createElement('span');
        sv.className = 'menu-val';
        sv.textContent = Math.round(it.value) + 'px';
        sh2.textContent = it.label + ' ';
        sh2.appendChild(sv);
        sw.appendChild(sh2);

        var srow = document.createElement('div');
        srow.className = 'menu-slider';
        var srng = document.createElement('input');
        srng.type = 'range';

        // **对数轴**。
        //
        // 物品尺寸跨度很大（8 ~ 1600，200 倍）。线性轴上的话，
        // 全部实用尺寸（几十到两三百像素）挤在左边一小段里，
        // 想从 40 调到 60 得跟像素级的手抖较劲；
        // 而右边一大半行程只对应「巨大」那几个值。
        //
        // 对数轴下，滑杆每一格代表相同的**倍率**而不是相同的像素数，
        // 放大和缩小的手感一致。
        //
        // 做法：滑杆本身走 0..1000 的「位置」，再换算成实际值
        //   value = min * (max/min)^(pos/1000)
        var LOG = !!it.log;
        var SPAN = 1000;
        var lo = it.min, hi = it.max;

        function posToVal(pos) {
          if (!LOG) return Number(pos);
          return lo * Math.pow(hi / lo, Number(pos) / SPAN);
        }
        function valToPos(val) {
          if (!LOG) return Number(val);
          var v = Math.max(lo, Math.min(hi, Number(val)));
          return Math.round(SPAN * Math.log(v / lo) / Math.log(hi / lo));
        }

        srng.min = LOG ? 0 : it.min;
        srng.max = LOG ? SPAN : it.max;
        srng.step = LOG ? 1 : (it.step || 1);
        srng.value = valToPos(it.value);

        var label = function (v) { return Math.round(v) + 'px'; };
        sv.textContent = label(it.value);

        srng.addEventListener('input', function () {
          var v = posToVal(srng.value);
          sv.textContent = label(v);
          // 实时预览：直接改本地的 w/h，不发 op（松手才发）
          if (opts.onPreview) opts.onPreview(piece, v);
        });
        srng.addEventListener('change', function () {
          onPick(it.action, piece, Math.round(posToVal(srng.value)));
        });
        srow.appendChild(srng);
        sw.appendChild(srow);
        el.appendChild(sw);
        return;
      }

      // ---- 文字输入（文字框标记用） ----
      if (it.text) {
        var tw = document.createElement('div');
        tw.className = 'menu-group';

        var tl = document.createElement('div');
        tl.className = 'menu-label';
        tl.textContent = it.label;
        tw.appendChild(tl);

        var inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'menu-input';
        inp.value = it.value == null ? '' : it.value;
        inp.maxLength = it.maxLength || 200;
        inp.placeholder = it.placeholder || '';
        // 允许换行输入：文字框是多行的
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            hide();
            onPick(it.action, piece, inp.value);
          }
          e.stopPropagation();     // 别让棋盘抢走退格/方向键
        });
        tw.appendChild(inp);

        var row2 = document.createElement('div');
        row2.className = 'menu-quick';
        var ok = document.createElement('button');
        ok.type = 'button';
        ok.textContent = '应用';
        ok.addEventListener('click', function (e) {
          e.stopPropagation();
          hide();
          onPick(it.action, piece, inp.value);
        });
        row2.appendChild(ok);
        tw.appendChild(row2);

        el.appendChild(tw);
        return;
      }

      // ---- 色板：给骰子/标记换色 ----
      if (it.colors) {
        var cw = document.createElement('div');
        cw.className = 'menu-group';

        var cl = document.createElement('div');
        cl.className = 'menu-label';
        cl.textContent = it.label;
        cw.appendChild(cl);

        var row = document.createElement('div');
        row.className = 'color-row';
        it.colors.forEach(function (c) {
          var cb = document.createElement('button');
          cb.type = 'button';
          cb.className = 'swatch' + (c.value === it.value ? ' on' : '');
          cb.title = c.name || '';
          if (c.value) cb.style.background = c.hex;
          else cb.textContent = '／';
          cb.addEventListener('click', function (e) {
            e.stopPropagation();
            hide();
            onPick(it.action, piece, c.value);
          });
          row.appendChild(cb);
        });
        cw.appendChild(row);
        el.appendChild(cw);
        return;
      }

      // ---- 普通项 ----
      var b2 = document.createElement('button');
      b2.type = 'button';
      b2.textContent = it.label;
      if (it.note) {
        var n2 = document.createElement('span');
        n2.className = 'menu-note';
        n2.textContent = it.note;
        b2.appendChild(n2);
      }
      if (it.disabled) b2.disabled = true;
      if (it.danger) b2.className = 'danger';
      b2.addEventListener('click', function (e) {
        e.stopPropagation();
        hide();
        onPick(it.action, piece);
      });
      el.appendChild(b2);
    }

    /**
     * items: 上述任意类型混合的数组
     * at:    {x, y} 屏幕坐标（自动避免超出视口）
     */
    function show(piece, items, at) {
      el.innerHTML = '';
      items.forEach(function (it) { addItem(it, piece); });

      el.hidden = false;
      open = true;

      // 先显示再量尺寸，然后夹到视口内
      var r = el.getBoundingClientRect();
      var vw = global.innerWidth, vh = global.innerHeight;
      var x = at.x, y = at.y;
      if (x + r.width > vw - 6) x = Math.max(6, vw - r.width - 6);
      if (y + r.height > vh - 6) y = Math.max(6, vh - r.height - 6);
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    }

    function isOpen() { return open; }

    // 点别处 / Esc 关掉。
    // 注意滑杆拖动时不能关：pointerdown 落在菜单内部，由 contains 判掉。
    global.addEventListener('pointerdown', function (e) {
      if (open && !el.contains(e.target)) hide();
    }, true);
    global.addEventListener('keydown', function (e) {
      if (open && e.key === 'Escape') { e.stopPropagation(); hide(); }
    }, true);
    global.addEventListener('blur', hide);

    return { show: show, hide: hide, isOpen: isOpen };
  }

  global.Menu = { create: create };
})(window);

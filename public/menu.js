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

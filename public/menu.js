/*
 * menu.js —— 棋子右键菜单
 *
 * 桌面：右键弹出。
 * 手机：**没有右键**，所以用**长按**弹出同一个菜单。
 *   （长按原本是「加选/减选」，现在改成弹菜单；
 *     加选改由「框选」和菜单里的「选中同类」承担 ——
 *     见 app.js 的交互说明。）
 *
 * 菜单项由调用方（app.js）动态给出，因为「切换形态」这一项
 * 只在棋子真的有多形态时才该出现。
 */
(function (global) {
  'use strict';

  function create(opts) {
    var el = opts.el;                 // 容器
    var onPick = opts.onPick;         // function(action, piece)
    var open = false;

    function hide() {
      el.hidden = true;
      open = false;
    }

    /**
     * items: [{action, label, note?, disabled?, danger?}]
     * at:    {x, y} 屏幕坐标（会自动避免超出视口）
     */
    function show(piece, items, at) {
      el.innerHTML = '';

      items.forEach(function (it) {
        if (it.sep) {
          var s = document.createElement('div');
          s.className = 'menu-sep';
          el.appendChild(s);
          return;
        }
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.label;
        if (it.note) {
          var n = document.createElement('span');
          n.className = 'menu-note';
          n.textContent = it.note;
          b.appendChild(n);
        }
        if (it.disabled) b.disabled = true;
        if (it.danger) b.className = 'danger';
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          hide();
          onPick(it.action, piece);
        });
        el.appendChild(b);
      });

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

    // 点别处 / 滚动 / Esc 都关掉
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

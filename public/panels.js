/*
 * panels.js —— 左右两块面板的折叠
 *
 * 为什么需要：手机竖屏（390px 宽）上，左上角的 HUD 是一整行 nowrap，
 * 会把面板撑到 calc(100vw - 16px) 也就是满宽，而右上角的玩家列表
 * 从 170px 处开始 —— 两块完全叠在一起。
 *
 * 规则：
 *   1. 手机（窄屏）默认收起，桌面默认展开。首次访问时按屏宽决定，
 *      之后记住用户的选择（localStorage）。
 *   2. 窄屏上**展开一块会自动收起另一块** —— 否则一展开又叠上了，
 *      折叠功能等于白做。
 *   3. 折叠是"视觉收起"，与 hidden 无关：玩家面板在还没进房间时
 *      用 hidden 整个隐藏，那是另一回事，不要混在一起。
 */
(function (global) {
  'use strict';

  var NARROW = 560;          // 与 CSS 里的手机断点保持一致
  var KEY = 'webtts.panel.';

  function isNarrow() {
    return global.innerWidth < NARROW;
  }

  function lsGet(k) { try { return global.localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { global.localStorage.setItem(k, v); } catch (_) {} }

  function create(spec) {
    var el = document.querySelector(spec.el);
    var btn = document.querySelector(spec.toggle);
    if (!el || !btn) return null;

    var key = KEY + spec.id;
    var api = { el: el, collapsed: false };

    function paint() {
      if (api.collapsed) el.classList.add('collapsed');
      else el.classList.remove('collapsed');
      btn.setAttribute('aria-expanded', api.collapsed ? 'false' : 'true');
      if (spec.onChange) spec.onChange(api.collapsed);
    }

    api.set = function (on, remember) {
      api.collapsed = !!on;
      if (remember !== false) lsSet(key, api.collapsed ? '1' : '0');
      paint();
    };

    api.toggle = function () { api.set(!api.collapsed); };

    // 初始状态：有记录就照记录，没记录则窄屏收起
    var saved = lsGet(key);
    api.collapsed = saved === '1' || (saved === null && isNarrow());
    paint();

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      api.toggle();
      // 窄屏上展开我就收起别人，避免刚解决的重叠又回来
      if (!api.collapsed && isNarrow() && spec.peer) {
        var other = spec.peer();
        if (other && !other.collapsed) other.set(true, false);
      }
    });

    return api;
  }

  global.Panels = {
    NARROW: NARROW,
    isNarrow: isNarrow,
    create: create
  };
})(window);

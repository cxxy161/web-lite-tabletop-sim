/*
 * color.js —— 颜色小工具（骰子与标记共用）
 *
 * 只做一件事：给定一个基准色，推出配套的描边色与文字色。
 * 自定义颜色的物品如果描边/内文写死，换色之后就会脏得没法看
 *（浅色配白描边、深色配黑字之类），所以这三色必须一起算。
 */
(function (global) {
  'use strict';

  var HEX = /^#?([0-9a-fA-F]{6})$/;

  // 归一成 '#rrggbb'（小写）。非法输入返回 fallback。
  function norm(v, fallback) {
    if (typeof v !== 'string') return fallback || '';
    var m = HEX.exec(v.trim());
    if (!m) return fallback || '';
    return '#' + m[1].toLowerCase();
  }

  function rgb(hex) {
    var h = norm(hex, '#000000').slice(1);
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16)
    ];
  }

  function toHex(r, g, b) {
    var f = function (x) {
      x = Math.max(0, Math.min(255, Math.round(x)));
      return (x < 16 ? '0' : '') + x.toString(16);
    };
    return '#' + f(r) + f(g) + f(b);
  }

  // 明暗调整：f < 1 变暗，f > 1 变亮
  function shade(hex, f) {
    var c = rgb(hex);
    return toHex(c[0] * f, c[1] * f, c[2] * f);
  }

  function mix(hex, other, t) {
    var a = rgb(hex), b = rgb(other);
    return toHex(a[0] + (b[0] - a[0]) * t,
                 a[1] + (b[1] - a[1]) * t,
                 a[2] + (b[2] - a[2]) * t);
  }

  // 感知亮度（0..1），用来决定内文该用深色还是浅色
  function lum(hex) {
    var c = rgb(hex);
    return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  }

  global.ColorUtil = {
    norm: norm,
    shade: shade,
    mix: mix,
    lum: lum,
    rgb: rgb,
    toHex: toHex
  };
})(window);

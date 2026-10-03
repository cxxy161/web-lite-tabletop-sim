/*
 * token.js —— 小标记（方形 / 圆形 / 三角形 / 星形）
 *
 * 标记和骰子一样**就是棋子**，只是多两个字段：
 *   sh = 形状（0 = 非标记，1 方 2 圆 3 三角 4 星）
 *   c  = 颜色（0xRRGGBB 整数，0 = 用主题默认色）
 * 于是它同样白拿棋子的同步、层叠序、拖动、克隆、删除、冻结、存档往返。
 *
 * 为什么颜色存整数而不是 '#rrggbb' 字符串：
 * 存档的行是**纯数字列式数组**（见 codec.js）。塞字符串要另开一张
 * 字典表去重，而颜色的取值本来就很有限，直接存整数最省。
 */
(function (global) {
  'use strict';

  var SHAPES = [
    { id: 1, name: '方形' },
    { id: 2, name: '圆形' },
    { id: 3, name: '三角形' },
    { id: 4, name: '星形' }
  ];

  var DEFAULT_COLOR = 0xc2703f;      // 与主题强调色一致

  function intToHex(v) {
    if (!v) return null;
    return '#' + ('000000' + (v >>> 0).toString(16)).slice(-6);
  }

  function hexToInt(hex) {
    var m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
    if (!m) return 0;
    return parseInt(m[1], 16);
  }

  // 星形的内半径系数：0.382 是正五角星的标准比例
  function starPoints() {
    var out = [];
    for (var i = 0; i < 10; i++) {
      var r = (i % 2 === 0) ? 1 : 0.382;
      var a = -Math.PI / 2 + i * Math.PI / 5;
      out.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return out;
  }

  function points(shape) {
    switch (shape) {
      case 1:   // 方形
        return [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      case 3:   // 三角形
        return [[0, -1], [0.87, 0.5], [-0.87, 0.5]];
      case 4:   // 星形
        return starPoints();
      default:
        return null;   // 圆形走 arc
    }
  }

  function radiusOf(shape) {
    // 方形的顶点在角上（半径 √2 倍边长），缩一下让四种形状视觉等大
    if (shape === 1) return 0.72;
    return 1;
  }

  function path(g, shape, cx, cy, r) {
    g.beginPath();
    if (shape === 2 || !points(shape)) { g.arc(cx, cy, r, 0, Math.PI * 2); return; }
    var pts = points(shape);
    var k = r * radiusOf(shape);
    for (var i = 0; i < pts.length; i++) {
      var x = cx + pts[i][0] * k, y = cy + pts[i][1] * k;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
  }

  /**
   * @param colorInt 0 表示用默认色
   */
  function draw(g, cx, cy, size, shape, colorInt) {
    var CU = global.ColorUtil;
    var base = intToHex(colorInt) || intToHex(DEFAULT_COLOR);
    var r = size / 2;

    // 落影：和骰子一致，让标记看起来是「放在桌上」而不是贴上去的
    g.save();
    g.globalAlpha = 0.18;
    g.fillStyle = '#5a4e3c';
    g.beginPath();
    if (g.ellipse) g.ellipse(cx, cy + r * 0.92, r * 0.82, r * 0.26, 0, 0, Math.PI * 2);
    else g.arc(cx, cy + r * 0.92, r * 0.6, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // 厚度：先画一层偏移的暗色
    var edge = CU ? CU.shade(base, 0.72) : base;
    g.save();
    g.fillStyle = edge;
    g.translate(0, r * 0.10);
    path(g, shape, cx, cy, r * 0.94);
    g.fill();
    g.restore();

    // 正面
    g.fillStyle = base;
    path(g, shape, cx, cy, r * 0.94);
    g.fill();
    g.lineWidth = Math.max(1, r * 0.10);
    g.strokeStyle = edge;
    g.stroke();

    // 高光：左上角一小片亮色，避免纯色块显得死板
    g.save();
    path(g, shape, cx, cy, r * 0.94);
    g.clip();
    var grd = g.createLinearGradient(cx - r, cy - r, cx + r * 0.4, cy + r * 0.4);
    grd.addColorStop(0, 'rgba(255,255,255,.42)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.restore();
  }

  global.Token = {
    SHAPES: SHAPES,
    DEFAULT_COLOR: DEFAULT_COLOR,
    isToken: function (p) { return !!(p && p.sh > 0); },
    draw: draw,
    intToHex: intToHex,
    hexToInt: hexToInt
  };
})(window);

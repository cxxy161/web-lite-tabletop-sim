/*
 * token.js —— 小标记（方形 / 圆形 / 三角形 / 星形）
 *
 * 标记和骰子一样**就是棋子**，只是多三个字段：
 *   sh = 形状（0 = 非标记，1 方 2 圆 3 三角 4 星 5 文字框）
 *   c  = 颜色（0xRRGGBB 整数，0 = 用主题默认色）
 *   tx = 文字框内容（只有形状 5 用得上）
 *
 * **不画落影**：桌面上会摆很多标记，一片影子会让画面变脏。
 * 极简风格靠「描边 + 一点厚度」区分层次就够了。
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
    { id: 4, name: '星形' },
    { id: 5, name: '文字框' }
  ];

  var TEXT_SHAPE = 5;
  var TEXT_MAX = 200;          // 与服务端的上限一致

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

  // 文字框的圆角矩形路径
  function roundRect(g, x, y, w, h, rad) {
    var rr = Math.min(rad, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.lineTo(x + w - rr, y);
    if (g.quadraticCurveTo) {
      g.quadraticCurveTo(x + w, y, x + w, y + rr);
      g.lineTo(x + w, y + h - rr);
      g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
      g.lineTo(x + rr, y + h);
      g.quadraticCurveTo(x, y + h, x, y + h - rr);
      g.lineTo(x, y + rr);
      g.quadraticCurveTo(x, y, x + rr, y);
    } else {
      g.lineTo(x + w, y); g.lineTo(x + w, y + h);
      g.lineTo(x, y + h); g.lineTo(x, y);
    }
    g.closePath();
  }

  // 把文字按宽度折行。**中英混排都按字符量算**：
  // 精确测量需要 ctx.measureText，但那个要在有 ctx 时才算，
  // 而折行结果影响字号、字号又影响折行 —— 会绕成循环。
  // 用「CJK 算 1 个宽、其余算 0.55 个宽」的近似足够排版用。
  function wrap(text, charsPerLine) {
    var out = [];
    var lines = String(text).split('\n');

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (!line) { out.push(''); continue; }

      var cur = '', w = 0;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        var cw = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
        if (w + cw > charsPerLine && cur) { out.push(cur); cur = ch; w = cw; }
        else { cur += ch; w += cw; }
      }
      if (cur) out.push(cur);
    }
    return out.length ? out : [''];
  }

  function drawText(g, cx, cy, w, h, base, text, edge) {
    var CU = global.ColorUtil;
    var pad = Math.min(w, h) * 0.12;
    var iw = Math.max(1, w - pad * 2);
    var ih = Math.max(1, h - pad * 2);

    // 文字色由底色亮度决定（深底浅字 / 浅底深字）
    var ink = CU ? (CU.lum(base) > 0.55 ? CU.shade(base, 0.30) : '#fffdf8') : '#4a4437';

    g.save();
    // 背景 + 描边
    roundRect(g, cx - w / 2, cy - h / 2, w, h, Math.min(w, h) * 0.16);
    g.fillStyle = base;
    g.fill();
    g.lineWidth = Math.max(1, Math.min(w, h) * 0.05);
    g.strokeStyle = edge;
    g.stroke();
    g.clip();

    var txt = String(text == null ? '' : text).slice(0, TEXT_MAX);

    // 先按「一行放得下」估字号，再据折行数缩小到高度装得下
    var approx = 0;
    for (var i = 0; i < txt.length; i++) {
      approx += /[\u3000-\u9fff\uff00-\uffef]/.test(txt[i]) ? 1 : 0.55;
    }
    var chars = Math.max(approx, 1);
    var fs = Math.min(ih, iw / chars * 1.6);
    var lines, lh;

    // 迭代几次让字号与折行收敛（通常两轮就稳）
    for (var k = 0; k < 4; k++) {
      lh = fs * 1.22;
      var perLine = Math.max(1, iw / (fs * 0.92));
      lines = wrap(txt, perLine);
      var need = lines.length * lh;
      if (need <= ih || fs <= 4) break;
      fs *= Math.sqrt(ih / need) * 0.98;
    }

    lines = wrap(txt, Math.max(1, iw / ((fs || 8) * 0.92)));
    lh = (fs || 8) * 1.22;

    g.fillStyle = ink;
    g.font = (fs || 8).toFixed(1) + 'px -apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    var total = lines.length * lh;
    var y0 = cy - total / 2 + lh / 2;
    for (var j = 0; j < lines.length; j++) {
      g.fillText(lines[j], cx, y0 + j * lh);
    }
    g.restore();
  }

  /**
   * @param w        宽度（世界单位）
   * @param h        高度，省略则与 w 相同（骰子与方形类标记都是正方形）
   * @param colorInt 0 表示用默认色
   * @param text     仅文字框使用
   *
   * 注意这个函数收到的尺寸可能是**长方形**（文字框就是横的），
   * 所以内部统一用 w/h，不要退回单一 size。
   */
  function draw(g, cx, cy, w, shape, colorInt, text, h) {
    var CU = global.ColorUtil;
    var base = intToHex(colorInt) || intToHex(DEFAULT_COLOR);
    if (h == null) h = w;
    var r = w / 2;

    // ---- 文字框：一块带底的圆角牌，不做厚度 ----
    if (shape === TEXT_SHAPE) {
      var edgeT = CU ? CU.shade(base, 0.72) : base;
      drawText(g, cx, cy, w, h, base, text, edgeT);
      return;
    }

    // 不做落影：桌面上叠着几十个标记时，一片影子会让画面变脏。
    // 极简风格靠「描边 + 一点厚度」区分层次就够了。
    var edge = CU ? CU.shade(base, 0.72) : base;

    // 厚度：只在下方偏移一点点，暗示这是一枚实体片子
    g.save();
    g.fillStyle = edge;
    g.translate(0, r * 0.07);
    path(g, shape, cx, cy, r * 0.94);
    g.fill();
    g.restore();

    // 正面
    g.fillStyle = base;
    path(g, shape, cx, cy, r * 0.94);
    g.fill();
    g.lineWidth = Math.max(1, r * 0.09);
    g.strokeStyle = edge;
    g.stroke();
  }

  global.Token = {
    SHAPES: SHAPES,
    TEXT_SHAPE: TEXT_SHAPE,
    TEXT_MAX: TEXT_MAX,
    DEFAULT_COLOR: DEFAULT_COLOR,
    isToken: function (p) { return !!(p && p.sh > 0); },
    draw: draw,
    intToHex: intToHex,
    hexToInt: hexToInt
  };
})(window);

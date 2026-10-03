/*
 * dice.js —— 实体骰子渲染
 *
 * 骰子**就是棋子**，只是多两个字段（见服务器 ds/v）：
 *   ds = 面数（0 表示这枚不是骰子），v = 当前点数
 * 这样它能白拿棋子已有的同步、层叠序、拖动、克隆、删除、存档往返。
 *
 * 结果的权威性：**点数由服务端随机**（见 room.js 的 dice/roll op）。
 * 客户端只负责把动画演到那个结果上 —— 若是客户端各摇各的，
 * 同一张桌上的两个人会看到不同的点数。
 *
 * 视觉上做了三件让它「像实物」的事：
 *   1. 落影（ellipse）随抛起高度缩放，给一个高度感；
 *   2. 骰身有一层暗色厚度（先画偏移的深色多边形，再画正面），
 *      不是一张平贴纸；
 *   3. 滚动阶段快速自转 + 数值闪烁，末段急停并回弹，
 *      而不是「匀速转然后瞬间出现答案」。
 */
(function (global) {
  'use strict';

  var SIDES = [2, 4, 6, 10, 12];

  // 各面数的形状与配色。颜色刻意压低饱和度，跟米白主题不打架。
  var STYLE = {
    2:  { shape: 'coin',   tint: '#e8e2d4', edge: '#b9ac93', ink: '#6b6252' },
    4:  { shape: 'tri',    tint: '#f0e3dc', edge: '#c29483', ink: '#8d5240' },
    6:  { shape: 'square', tint: '#f4f1e8', edge: '#a99d86', ink: '#4a4437' },
    10: { shape: 'kite',   tint: '#e4e9ec', edge: '#8fa3b0', ink: '#3f5461' },
    12: { shape: 'pent',   tint: '#e9ece1', edge: '#98a882', ink: '#4d5c3c' }
  };

  function styleOf(sides) {
    return STYLE[sides] || STYLE[6];
  }

  // 多边形顶点（单位半径），各形状的点分布
  function points(shape) {
    switch (shape) {
      case 'tri':
        return [[0, -1], [0.87, 0.5], [-0.87, 0.5]];
      case 'square':
        // 45°/135°/225°/315° 的顶点 == 边水平/竖直的正方形
        return [[0.707, -0.707], [0.707, 0.707], [-0.707, 0.707], [-0.707, -0.707]];
      case 'kite':
        return [[0, -1], [0.78, -0.12], [0, 0.96], [-0.78, -0.12]];
      case 'pent':
        return [[0, -1], [0.951, -0.309], [0.588, 0.809], [-0.588, 0.809], [-0.951, -0.309]];
      default:
        return null;   // coin 用圆
    }
  }

  function pathOf(g, shape, cx, cy, r, rot) {
    var pts = points(shape);
    g.beginPath();
    if (!pts) { g.arc(cx, cy, r, 0, Math.PI * 2); return; }

    var cos = Math.cos(rot), sin = Math.sin(rot);
    for (var i = 0; i < pts.length; i++) {
      var x = pts[i][0] * r, y = pts[i][1] * r;
      var rx = x * cos - y * sin, ry = x * sin + y * cos;
      if (i === 0) g.moveTo(cx + rx, cy + ry);
      else g.lineTo(cx + rx, cy + ry);
    }
    g.closePath();
  }

  // d6 的点数用「孔」表示（比写数字更像实物）
  var PIPS = {
    1: [[0, 0]],
    2: [[-1, -1], [1, 1]],
    3: [[-1, -1], [0, 0], [1, 1]],
    4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
    5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
    6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]]
  };

  /**
   * @param prog 0..1 的滚动进度；null 或 >=1 表示已停稳
   * @param seed 每颗骰子一个固定值，让它们的旋转相位不同
   */
  function draw(g, cx, cy, size, sides, value, prog, seed) {
    var st = styleOf(sides);
    var r = size / 2;
    var rolling = (prog != null && prog < 1);

    var spin = 0, scale = 1, lift = 0;

    if (rolling) {
      // 末段急停：用 (1-ease) 让角速度快速衰减到 0
      var ease = 1 - Math.pow(1 - prog, 3);
      spin = (1 - ease) * Math.PI * (8 + (seed % 5));
      // 抛起再落下（单次抛物），落回时略微压扁 -> 有重量感
      lift = Math.sin(Math.PI * prog) * r * 0.85;
      scale = 1 + Math.sin(Math.PI * Math.min(prog / 0.8, 1)) * 0.16;
      if (prog > 0.86) {
        // 落地压缩回弹
        var k = (prog - 0.86) / 0.14;
        scale *= 1 - Math.sin(k * Math.PI) * 0.10;
      }
    }

    var dy = -lift;                    // 抛起时整体上移
    var s = scale;

    // ---- 落影：随高度缩小、变淡 ----
    var liftK = lift / (r * 0.85 || 1);        // 0..1
    g.save();
    g.globalAlpha = 0.20 * (1 - liftK * 0.65);
    g.fillStyle = '#5a4e3c';
    g.beginPath();
    var shw = r * (0.86 - liftK * 0.28);
    var shh = r * (0.30 - liftK * 0.10);
    if (g.ellipse) g.ellipse(cx, cy + r * 0.94, shw, shh, 0, 0, Math.PI * 2);
    else g.arc(cx, cy + r * 0.94, shw * 0.7, 0, Math.PI * 2);
    g.fill();
    g.restore();

    var bx = cx, by = cy + dy;

    g.save();

    // ---- 骰身厚度：先画一层偏移的深色 ----
    var th = r * 0.10;
    g.fillStyle = st.edge;
    pathOf(g, st.shape, bx + th, by + th, r * s, spin);
    g.fill();

    // ---- 正面 ----
    g.fillStyle = st.tint;
    pathOf(g, st.shape, bx, by, r * s, spin);
    g.fill();
    g.lineWidth = Math.max(1, r * 0.045);
    g.strokeStyle = st.edge;
    g.stroke();

    // ---- 高光：左下到右上的一道淡渐变，避免死板 ----
    g.save();
    g.globalAlpha = 0.28;
    var grd = g.createLinearGradient(bx - r * s, by - r * s, bx + r * s, by + r * s);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.5, 'rgba(255,255,255,0)');
    grd.addColorStop(1, 'rgba(120,105,85,.30)');
    g.fillStyle = grd;
    pathOf(g, st.shape, bx, by, r * s, spin);
    g.fill();
    g.restore();

    // ---- 点数 ----
    // 滚动中用「闪烁的点数」而不是固定值 —— 停下才揭晓
    var shown = value;
    if (rolling) {
      // 用进度做伪随机，保证同一帧内稳定（不然会闪得看不清）
      var flick = Math.floor(prog * 60) + seed;
      shown = 1 + (flick * 7919) % sides;
    }

    g.fillStyle = st.ink;
    g.strokeStyle = st.ink;

    if (sides === 6) {
      var pipR = r * s * 0.095;
      var off = r * s * 0.30;
      var list = PIPS[shown] || PIPS[1];
      var cos = Math.cos(spin), sin = Math.sin(spin);
      for (var i = 0; i < list.length; i++) {
        var px = list[i][0] * off, py = list[i][1] * off;
        var rx = px * cos - py * sin, ry = px * sin + py * cos;
        g.beginPath();
        g.arc(bx + rx, by + ry, pipR, 0, Math.PI * 2);
        g.fill();
      }
    } else {
      // 其它面数直接写数字（更易读，实物也常这么印）
      var fs = r * s * (sides === 10 ? 0.72 : (sides === 12 ? 0.62 : 0.78));
      g.save();
      g.font = 'bold ' + fs.toFixed(1) + 'px -apple-system,"Segoe UI",Roboto,sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      // 旋转得厉害时数字跟着转会很乱，所以数字始终正立
      g.fillText(String(shown), bx, by + fs * 0.04);
      g.restore();
    }

    g.restore();
  }

  global.Dice = {
    SIDES: SIDES,
    draw: draw,
    isDice: function (p) { return !!(p && p.ds > 0); }
  };
})(window);

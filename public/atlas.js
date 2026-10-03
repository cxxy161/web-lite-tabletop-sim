/*
 * atlas.js —— 棋子图集（占位版）
 *
 * 真实资源到位前的占位实现：在离屏 canvas 上画一张 512x256 的图集，
 * 排布约定与将来的 atlas.png 完全一致，替换只需改图集来源。
 *
 * 图集约定：8 列 x 4 行，每格 64x64
 *   第 0~1 行 -> 正面，索引 0..15（棋子种类 k）
 *   第 2~3 行 -> 背面，索引 16..31
 *   索引 = (k % 16) + (f ? 16 : 0)
 *
 * 配色按「米白桌面」调整：低饱和、明度中等偏深，
 * 保证在米白底上看得清，同时不像纯色块那么刺眼。
 */
(function (global) {
  'use strict';

  var CELL = 64;
  var COLS = 8;
  var ROWS = 4;
  var FRONT = 16;          // 正面种类数 = ROWS/2 * COLS

  var PALETTE = [
    '#9d4b3f', '#a86a33', '#8f7a35', '#6b7a3a',
    '#4f7346', '#3d7069', '#3a6b7a', '#415d80',
    '#4c5480', '#5d5180', '#70487a', '#7d4560',
    '#7a4a52', '#6d5a44', '#5c636b', '#77706a'
  ];

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawFront(g, x, y, color, label) {
    var p = 3, s = CELL - p * 2;

    // 极淡的落影，让棋子在米白底上有一点厚度感（纯 CSS 风格的克制）
    g.fillStyle = 'rgba(90,78,60,.16)';
    roundRect(g, x + p, y + p + 1.5, s, s, 10);
    g.fill();

    g.fillStyle = color;
    roundRect(g, x + p, y + p, s, s, 10);
    g.fill();

    // 内描边：米白底上需要一点边界，否则边缘发虚
    g.strokeStyle = 'rgba(255,252,245,.30)';
    g.lineWidth = 1.5;
    roundRect(g, x + p + 1, y + p + 1, s - 2, s - 2, 9);
    g.stroke();

    g.fillStyle = '#fdfaf3';
    g.font = 'bold 27px -apple-system,"Segoe UI",Roboto,sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, x + CELL / 2, y + CELL / 2 + 1);
  }

  function drawBack(g, x, y) {
    var p = 3, s = CELL - p * 2;

    g.fillStyle = 'rgba(90,78,60,.16)';
    roundRect(g, x + p, y + p + 1.5, s, s, 10);
    g.fill();

    g.fillStyle = '#cfc6b4';
    roundRect(g, x + p, y + p, s, s, 10);
    g.fill();

    g.strokeStyle = 'rgba(120,105,80,.55)';
    g.lineWidth = 1.5;
    roundRect(g, x + p + 1, y + p + 1, s - 2, s - 2, 9);
    g.stroke();

    // 中心菱形，翻面时肉眼可辨
    g.strokeStyle = '#a99c85';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x + CELL / 2, y + CELL / 2 - 11);
    g.lineTo(x + CELL / 2 + 11, y + CELL / 2);
    g.lineTo(x + CELL / 2, y + CELL / 2 + 11);
    g.lineTo(x + CELL / 2 - 11, y + CELL / 2);
    g.closePath();
    g.stroke();
  }

  function build() {
    var c = document.createElement('canvas');
    c.width = COLS * CELL;
    c.height = ROWS * CELL;
    var g = c.getContext('2d');
    var half = ROWS / 2;

    for (var k = 0; k < FRONT; k++) {
      var cx = (k % COLS) * CELL;
      var cy = Math.floor(k / COLS) * CELL;
      drawFront(g, cx, cy, PALETTE[k % PALETTE.length], String(k + 1));
      drawBack(g, cx, cy + half * CELL);
    }
    return c;
  }

  global.Atlas = {
    CELL: CELL,
    COLS: COLS,
    ROWS: ROWS,
    FRONT: FRONT,
    build: build,

    // 棋子 -> 图集格子索引
    indexOf: function (k, f) {
      var i = ((k | 0) % FRONT + FRONT) % FRONT;
      return i + (f ? FRONT : 0);
    },

    // 预留：换成真实 atlas.png 时用
    load: function (src) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = reject;
        img.src = src;
      });
    }
  };
})(window);

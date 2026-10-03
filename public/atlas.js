/*
 * atlas.js —— 棋子图集（占位版）
 *
 * 真实资源到位前的占位实现：在离屏 canvas 上画一张 512x256 的图集，
 * 排布约定与将来的 atlas.png 完全一致，替换只需改 Board 的 atlas 来源。
 *
 * 图集约定：8 列 x 4 行，每格 64x64
 *   第 0~1 行 -> 正面，索引 0..15（棋子种类 k）
 *   第 2~3 行 -> 背面，索引 16..31
 *   索引 = (k % 16) + (f ? 16 : 0)
 */
(function (global) {
  'use strict';

  var CELL = 64;
  var COLS = 8;
  var ROWS = 4;
  var FRONT = 16;          // 正面种类数 = ROWS/2 * COLS

  var PALETTE = [
    '#c0392b', '#d35400', '#b7950b', '#7d8f1c',
    '#4f8a2b', '#27865a', '#1f8a8a', '#2472a4',
    '#2f5fa8', '#4a45a8', '#6c3fa8', '#8e3f9e',
    '#a33f7a', '#a83f56', '#8d6e3a', '#5b6b76'
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
    g.fillStyle = color;
    roundRect(g, x + p, y + p, s, s, 10);
    g.fill();

    g.strokeStyle = 'rgba(0,0,0,.30)';
    g.lineWidth = 2;
    roundRect(g, x + p + 1, y + p + 1, s - 2, s - 2, 9);
    g.stroke();

    g.fillStyle = '#fff';
    g.font = 'bold 28px -apple-system,"Segoe UI",Roboto,sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, x + CELL / 2, y + CELL / 2 + 1);
  }

  function drawBack(g, x, y) {
    var p = 3, s = CELL - p * 2;
    g.fillStyle = '#313841';
    roundRect(g, x + p, y + p, s, s, 10);
    g.fill();

    g.strokeStyle = '#454e59';
    g.lineWidth = 2;
    roundRect(g, x + p + 1, y + p + 1, s - 2, s - 2, 9);
    g.stroke();

    // 中心菱形，翻面时肉眼可辨
    g.strokeStyle = '#5a6672';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x + CELL / 2, y + CELL / 2 - 12);
    g.lineTo(x + CELL / 2 + 12, y + CELL / 2);
    g.lineTo(x + CELL / 2, y + CELL / 2 + 12);
    g.lineTo(x + CELL / 2 - 12, y + CELL / 2);
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

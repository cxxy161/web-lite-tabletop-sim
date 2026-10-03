/*
 * log.js —— 左下角消息流
 *
 * 只显示**在场期间**收到的消息（服务端不存历史，见 server/index.js 的 emit）。
 * 中途加入的人看不到之前发生了什么 —— 这是明确的取舍，
 * 换来的是不需要一份存储与淘汰逻辑。
 *
 * 交互上一件事必须做对：**淡出**。桌面上摆几十枚棋子时，
 * 一串永久驻留的提示会把棋盘盖住。所以消息到点自己消失，
 * 鼠标移上去会暂停（不然正读到一半就没了）。
 */
(function (global) {
  'use strict';

  var MAX_ROWS = 6;          // 同时最多显示几条，超了挤掉最旧的
  var TTL_MS = 9000;         // 每条存活时长
  var FADE_MS = 700;         // 淡出动画时长

  var el = document.getElementById('log');
  if (!el) return;

  var rows = [];
  var hover = false;

  // 每种消息一个颜色，扫一眼就知道是「有人来了」还是「有人被踢了」
  var KIND_CLASS = {
    join: 'join',
    leave: 'leave',
    team: 'team',
    kick: 'kick',
    warn: 'warn',
    info: ''
  };

  function now() {
    return (global.performance && global.performance.now)
      ? global.performance.now() : Date.now();
  }

  function prune() {
    // 超出条数就立刻移除最旧的（带淡出）
    while (rows.length > MAX_ROWS) {
      remove(rows[0], true);
    }
  }

  function remove(rec, now_) {
    if (rec.gone) return;
    rec.gone = true;
    var i = rows.indexOf(rec);
    if (i >= 0) rows.splice(i, 1);

    if (now_) {
      // 立刻移除（超量时用）
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
      return;
    }

    rec.el.className += ' out';
    global.setTimeout(function () {
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
      // 空了就把容器收起来：留着会挡住左下角的地图，
      // 而且它是 pointer-events 可点的（悬停暂停），空容器会白吃点击。
      if (!rows.length && !el.children.length) el.hidden = true;
    }, FADE_MS);
  }

  // 每 500ms 扫一遍到期项。不用 setTimeout 逐条排 ——
  // 鼠标悬停要能暂停，逐条排的定时器暂停/恢复很啰嗦。
  global.setInterval(function () {
    if (hover) {
      // 悬停时把「已到期的」续着，离开后重新计时
      rows.forEach(function (r) {
        if (!r.gone) r.deadline = now() + TTL_MS;
      });
      return;
    }
    var t = now();
    rows.slice().forEach(function (r) {
      if (!r.gone && t >= r.deadline) remove(r, false);
    });
  }, 500);

  el.addEventListener('pointerenter', function () { hover = true; });
  el.addEventListener('pointerleave', function () { hover = false; });

  function add(text, kind) {
    if (!text) return;

    var div = document.createElement('div');
    div.className = 'log-row ' + (KIND_CLASS[kind] || '');

    var t = document.createElement('span');
    t.className = 'log-text';
    t.textContent = text;
    div.appendChild(t);

    el.appendChild(div);
    el.hidden = false;

    var rec = { el: div, deadline: now() + TTL_MS, gone: false };
    rows.push(rec);

    // 入场动画：先量一帧让它从 0 高度展开，避免整块跳动
    global.requestAnimationFrame(function () { div.className += ' in'; });

    prune();
  }

  function clearAll() {
    rows.slice().forEach(function (r) { remove(r, true); });
    el.hidden = true;
  }

  global.Log = {
    add: add,
    clear: clearAll,
    // 供阶段 4 之外的模块借用（比如复制邀请码的提示）
    toast: function (text) { add(text, 'info'); }
  };

  // room.js 的 toast 走这里
  global.__roomToast = function (text) { add(text, 'info'); };
})(window);

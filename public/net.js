/*
 * net.js —— 原生 WebSocket 客户端
 *
 * 刻意不做的事：不做本地预测/回滚、不做 CRDT。
 * 因为 op 全是「绝对赋值」（move 是设坐标不是加位移），本地可以先乐观应用，
 * 服务端带 seq 回显时重复应用一次同样无害 —— 幂等让 demo 阶段完全不需要回滚。
 */
(function (global) {
  'use strict';

  function create(opts) {
    var url = opts.url;
    var ws = null;
    var closed = false;
    var backoff = 500;
    var outbox = [];

    var api = {
      // 回调默认空实现，再由 opts 覆盖。
      // 这里必须显式接过来：opts 是调用方唯一的注入点，
      // 漏掉这一步的表现是「连上了、但画面永远是空的」。
      onOpen: null,
      onClose: null,
      onInit: null,
      onOp: null,
      onPeer: null,

      send: function (obj) {
        var s = JSON.stringify(obj);
        if (ws && ws.readyState === 1) ws.send(s);
        else if (outbox.length < 64) outbox.push(s);   // 断线期间的少量操作先攒着
      },

      ready: function () { return !!ws && ws.readyState === 1; },

      close: function () {
        closed = true;
        if (ws) { try { ws.close(); } catch (_) {} }
      }
    };

    if (opts.onOpen) api.onOpen = opts.onOpen;
    if (opts.onClose) api.onClose = opts.onClose;
    if (opts.onInit) api.onInit = opts.onInit;
    if (opts.onOp) api.onOp = opts.onOp;
    if (opts.onPeer) api.onPeer = opts.onPeer;

    function open() {
      var sock;
      try {
        sock = new WebSocket(url);
      } catch (_) {
        retry();
        return;
      }
      ws = sock;

      sock.onopen = function () {
        backoff = 500;
        if (api.onOpen) api.onOpen();
        while (outbox.length) sock.send(outbox.shift());
      };

      sock.onmessage = function (e) {
        var m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.t === 'init' && api.onInit) api.onInit(m);
        else if (m.t === 'op' && api.onOp) api.onOp(m);
        else if (m.t === 'peer' && api.onPeer) api.onPeer(m.n);
      };

      sock.onclose = function () {
        if (api.onClose) api.onClose();
        if (!closed) retry();
      };

      sock.onerror = function () {
        try { sock.close(); } catch (_) {}
      };
    }

    function retry() {
      if (closed) return;
      setTimeout(open, backoff);
      backoff = Math.min(Math.round(backoff * 1.7), 8000);
    }

    open();
    return api;
  }

  global.Net = create;
})(window);

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
    var closed = false;         // 调用方主动关的
    var fatallyClosed = false;  // 服务端拒绝（身份失效 / 房间不存在），不再重试
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
      onRoom: null,       // 房间元数据（玩家列表 / 队伍）
      onLog: null,        // 消息流（谁进来/离开/换队/被踢）
      onFatal: null,      // 服务端拒绝连接（身份失效 / 房间不存在）

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
    if (opts.onRoom) api.onRoom = opts.onRoom;
    if (opts.onLog) api.onLog = opts.onLog;
    if (opts.onFatal) api.onFatal = opts.onFatal;

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
        if (m.t === 'fatal') fatallyClosed = true;
        if (m.t === 'init' && api.onInit) api.onInit(m);
        else if (m.t === 'op' && api.onOp) api.onOp(m);
        else if (m.t === 'peer' && api.onPeer) api.onPeer(m.n);
        else if (m.t === 'room' && api.onRoom) api.onRoom(m);
        else if (m.t === 'log' && api.onLog) api.onLog(m);
        else if (m.t === 'fatal' && api.onFatal) api.onFatal(m);
      };

      sock.onclose = function () {
        if (api.onClose) api.onClose();
        // fatal（身份失效 / 房间没了）之后重连也连不上，
        // 继续重试只会无限刷请求。交给上层把用户送回主页。
        if (!closed && !fatallyClosed) retry();
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

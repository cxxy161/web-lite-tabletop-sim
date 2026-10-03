/*
 * identity.js —— 玩家身份与本地存储（主页 / 房间页共用）
 *
 * 存三样东西：
 *   webtts.name            昵称（跨房间共用，下次自动填）
 *   webtts.id.<邀请码>     该房间里的 playerId
 *   webtts.token.<邀请码>  该房间里的凭证
 *
 * **按房间分别存身份**：同一个人可以同时在两个房间里有不同身份，
 * 用同一份会互相覆盖，进第二个房间时把第一个房间的身份顶掉。
 *
 * token 是服务端认人的唯一凭据，丢了就只能当新玩家重新加入
 *（队伍会被重置）。所以这里出错一律回落到「没有身份」，
 * 让调用方走重新加入的流程，而不是把半截数据当身份用。
 */
(function (global) {
  'use strict';

  var K_NAME = 'webtts.name';
  var K_ID = 'webtts.id.';
  var K_TOKEN = 'webtts.token.';
  var MAX_NAME = 20;
  var CODE_RE = /^[0-9A-Z]{4,8}$/;

  // localStorage 在隐私模式 / 某些老浏览器里会直接抛异常，
  // 所以每次访问都包一层，失败就当作「没有存储」。
  function lsGet(k) {
    try { return global.localStorage.getItem(k); } catch (_) { return null; }
  }
  function lsSet(k, v) {
    try { global.localStorage.setItem(k, v); } catch (_) {}
  }
  function lsDel(k) {
    try { global.localStorage.removeItem(k); } catch (_) {}
  }

  function normCode(raw) {
    return String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
  }

  function validCode(raw) {
    return CODE_RE.test(normCode(raw));
  }

  function cleanName(raw) {
    return String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_NAME);
  }

  function getName() { return lsGet(K_NAME) || ''; }
  function setName(v) { var s = cleanName(v); if (s) lsSet(K_NAME, s); return s; }

  function get(code) {
    var c = normCode(code);
    if (!validCode(c)) return null;
    var id = lsGet(K_ID + c), token = lsGet(K_TOKEN + c);
    if (!id || !token) return null;
    return { id: id, token: token };
  }

  function set(code, playerId, token) {
    var c = normCode(code);
    if (!validCode(c) || !playerId || !token) return false;
    lsSet(K_ID + c, String(playerId));
    lsSet(K_TOKEN + c, String(token));
    return true;
  }

  function clear(code) {
    var c = normCode(code);
    lsDel(K_ID + c);
    lsDel(K_TOKEN + c);
  }

  // 带身份的 fetch：统一塞那两个头，免得各调用点自己拼
  function api(path, opts) {
    var o = opts || {};
    var code = o.code ? normCode(o.code) : '';
    var id = o.playerId, token = o.token;
    if (code && (!id || !token)) {
      var saved = get(code);
      if (saved) { id = saved.id; token = saved.token; }
    }

    var headers = Object.assign({}, o.headers || {});
    if (id) headers['X-Player-Id'] = id;
    if (token) headers['X-Player-Token'] = token;

    // **把 code 自动塞进 body**。
    //
    // 服务端每个房间 API 都要 body.code 才能定位房间，而调用点很容易
    // 只记得「我要带身份」（于是传 code 让这里去取 token）却忘了
    // 把它也写进 body —— 那会得到一个 404「房间不存在」，
    // 但看起来又像是路由问题，非常容易查错方向。
    // 统一在这里补，调用点就不必重复。
    var body = o.body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (code && body.code == null) {
        body = Object.assign({}, body, { code: code });
      }
    }

    if (body) headers['Content-Type'] = 'application/json';

    return global.fetch(path, {
      method: o.method || 'GET',
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      // 服务端用 403 表示「身份无效」，这时要把本地那份清掉，
      // 否则会一直拿着一个无效身份重试，永远进不去。
      if (r.status === 403 && code) clear(code);
      return r.json().then(function (d) {
        return { ok: r.ok, status: r.status, d: d };
      }, function () {
        return { ok: r.ok, status: r.status, d: { error: '响应不是 JSON' } };
      });
    });
  }

  global.Identity = {
    MAX_NAME: MAX_NAME,
    normCode: normCode,
    validCode: validCode,
    cleanName: cleanName,
    getName: getName,
    setName: setName,
    get: get,
    set: set,
    clear: clear,
    api: api
  };
})(window);

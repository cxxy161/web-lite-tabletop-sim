/*
 * home.js —— 主页：设昵称、建房、加入
 *
 * 刻意做得很薄：这里只负责「拿到身份」，然后跳转到房间页。
 * 房间页自己会用 localStorage 里的身份去连 WS。
 *
 * 支持两种直接进入的方式：
 *   1. /room.html?room=XXXXXX        邀请码在 URL 里
 *   2. /?code=XXXXXX                 带 code 参数到主页，自动填好邀请码
 * 手机上朋友发的多半是一个链接，所以这两种都要能用。
 */
(function (global) {
  'use strict';

  var I = global.Identity;

  var elNick = document.getElementById('nick');
  var elCode = document.getElementById('code');
  var elRoomName = document.getElementById('roomname');
  var elMsg = document.getElementById('home-msg');
  var btnCreate = document.getElementById('btn-create');
  var btnJoin = document.getElementById('btn-join');

  // 昵称：上次用过的自动填上
  elNick.value = I.getName();

  // URL 里带 code 就预填（方便分享链接）
  var qs = new URLSearchParams(global.location.search);
  if (qs.get('code')) elCode.value = I.normCode(qs.get('code'));
  if (qs.get('room')) elCode.value = I.normCode(qs.get('room'));

  function msg(text, kind) {
    elMsg.textContent = text || '';
    elMsg.className = 'home-msg' + (kind ? ' ' + kind : '');
  }

  function needName() {
    var n = I.cleanName(elNick.value);
    if (!n) { msg('先给自己起个昵称', 'err'); elNick.focus(); return null; }
    I.setName(n);
    return n;
  }

  function busy(on) {
    btnCreate.disabled = on;
    btnJoin.disabled = on;
    btnCreate.textContent = on ? '请稍候…' : '创建并进入';
    btnJoin.textContent = on ? '请稍候…' : '加入';
  }

  // 进房间：把身份存好再跳转。
  // **先存后跳**，否则房间页拿不到身份会当新玩家重新加入。
  function enter(code, playerId, token) {
    I.set(code, playerId, token);
    global.location.href = 'room.html?room=' + encodeURIComponent(code);
  }

  btnCreate.addEventListener('click', function () {
    var name = needName();
    if (!name) return;
    busy(true);
    msg('创建中…');

    I.api('/api/room/create', {
      method: 'POST',
      body: { name: name, roomName: I.cleanName(elRoomName.value) }
    }).then(function (r) {
      busy(false);
      if (!r.ok) { msg(r.d.error || '创建失败', 'err'); return; }
      enter(r.d.code, r.d.playerId, r.d.token);
    }).catch(function (e) {
      busy(false);
      msg('创建失败：' + e.message, 'err');
    });
  });

  function doJoin() {
    var name = needName();
    if (!name) return;

    var code = I.normCode(elCode.value);
    if (!I.validCode(code)) { msg('邀请码应为 6 位字母数字', 'err'); elCode.focus(); return; }

    busy(true);
    msg('加入中…');

    // 带上本地可能已有的身份 —— 服务端认了就是「刷新重连」，
    // 不认（换了房间/被踢过）就按新玩家加入。
    var saved = I.get(code);
    I.api('/api/room/join', {
      method: 'POST',
      body: {
        code: code,
        name: name,
        playerId: saved ? saved.id : undefined,
        token: saved ? saved.token : undefined
      }
    }).then(function (r) {
      busy(false);
      if (!r.ok) { msg(r.d.error || '加入失败', 'err'); return; }
      enter(r.d.code, r.d.playerId, r.d.token);
    }).catch(function (e) {
      busy(false);
      msg('加入失败：' + e.message, 'err');
    });
  }

  btnJoin.addEventListener('click', doJoin);

  // 邀请码输入框回车 = 加入；昵称框回车 = 跳到邀请码框
  elCode.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doJoin(); }
  });
  elNick.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      (elCode.value ? doJoin() : elRoomName.focus());
    }
  });
  elRoomName.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); btnCreate.click(); }
  });

  // 输入时自动大写邀请码，省得手机上切键盘
  elCode.addEventListener('input', function () {
    var v = I.normCode(elCode.value);
    if (v !== elCode.value) elCode.value = v;
  });

  // 焦点：有邀请码就直接落在邀请码框（少一次点击），否则落在昵称
  if (qs.get('code') || qs.get('room')) elCode.focus();
  else elNick.focus();
})(window);

/*
 * room.js —— 右上角玩家列表 + 我的队伍
 *
 * 数据来源是服务端的 {t:'room'} 广播（见 server/index.js 的 broadcastRoomState）。
 * 那条消息是**逐连接发的**，因为每人的 `you` 不同；房间与玩家列表则相同。
 *
 * 权限的现实（重要）：
 *   房主操作（改别人队伍、踢人）在**服务端**校验，客户端这里只是
 *   把入口藏起来。光靠这里藏是没用的 —— 但服务端那道校验是硬的。
 *   所以「房主能做的事」在两端各写一次，不是重复劳动：
 *   前者是体验，后者是权限。
 */
(function (global) {
  'use strict';

  var I = global.Identity;

  var el = document.getElementById('players');
  var elRoom = document.getElementById('pl-room');
  var elCode = document.getElementById('pl-code');
  var elList = document.getElementById('pl-list');
  var elTeams = document.getElementById('pl-teams');

  var CODE = I ? I.normCode(new URLSearchParams(global.location.search).get('room')) : '';
  var state = null;      // 最近一次 { room, you }
  var onChange = null;   // 外部回调（HUD 要显示队伍）

  /* ---------- 渲染 ---------- */

  function teamOf(id) {
    if (!state || !state.room.teams) return null;
    for (var i = 0; i < state.room.teams.length; i++) {
      if (state.room.teams[i].id === id) return state.room.teams[i];
    }
    return null;
  }

  function render() {
    if (!state) return;
    var me = state.you || {};
    var isOwner = !!me.owner;

    elRoom.textContent = state.room.name || '房间';
    elCode.textContent = state.room.code || CODE;

    elList.innerHTML = '';
    state.room.players.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'pl-row' + (p.online ? '' : ' off') +
                      (p.id === me.id ? ' me' : '');

      var dot = document.createElement('span');
      dot.className = 'pl-dot';
      row.appendChild(dot);

      var nm = document.createElement('span');
      nm.className = 'pl-name';
      nm.textContent = p.name + (p.id === me.id ? '（我）' : '');
      row.appendChild(nm);

      var t = teamOf(p.teamId);
      if (t) {
        var tag = document.createElement('span');
        tag.className = 'pl-tag ' + t.id;
        tag.textContent = t.name;
        row.appendChild(tag);
      }

      if (p.owner) {
        var ow = document.createElement('span');
        ow.className = 'pl-tag owner';
        ow.textContent = '房主';
        row.appendChild(ow);
      } else if (!p.online) {
        var off = document.createElement('span');
        off.className = 'pl-tag';
        off.textContent = '离线';
        row.appendChild(off);
      }

      // 房主可以改别人的队伍 / 踢人（不能对自己）
      if (isOwner && p.id !== me.id) {
        var act = document.createElement('span');
        act.className = 'pl-act';

        var bk = document.createElement('button');
        bk.type = 'button';
        bk.textContent = '踢出';
        bk.className = 'kick';
        bk.addEventListener('click', function (e) {
          e.stopPropagation();
          if (global.confirm('把「' + p.name + '」踢出房间？')) kick(p.id);
        });
        act.appendChild(bk);
        row.appendChild(act);
      }

      // 点玩家行 = 房主循环给他换队（比弹菜单快，手机上尤其）
      if (isOwner && p.id !== me.id) {
        row.title = '点击更换队伍';
        row.style.cursor = 'pointer';
        row.addEventListener('click', function () { cycleTeam(p); });
      }

      elList.appendChild(row);
    });

    renderTeams(me);
  }

  // 「我的队伍」分段按钮：旁观 + 各队
  function renderTeams(me) {
    elTeams.innerHTML = '';

    var opts = [{ id: null, name: '旁观' }].concat(
      (state.room.teams || []).map(function (t) { return { id: t.id, name: t.name }; })
    );

    opts.forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.name;
      b.className = (me.teamId || null) === o.id ? 'on' : '';
      b.addEventListener('click', function () {
        if ((me.teamId || null) === o.id) return;
        setMyTeam(o.id);
      });
      elTeams.appendChild(b);
    });
  }

  /* ---------- 操作 ---------- */

  function call(path, body) {
    return I.api(path, { method: 'POST', code: CODE, body: body })
      .then(function (r) {
        if (!r.ok) { toast(r.d.error || '操作失败'); return null; }
        return r.d;
      });
  }

  function setMyTeam(teamId) {
    call('/api/room/team', { targetId: state.you.id, teamId: teamId });
  }

  function cycleTeam(p) {
    // 旁观 -> 红 -> 蓝 -> 旁观
    var order = [null].concat((state.room.teams || []).map(function (t) { return t.id; }));
    var idx = order.indexOf(p.teamId || null);
    var next = order[(idx + 1) % order.length];
    call('/api/room/team', { targetId: p.id, teamId: next });
  }

  function kick(id) {
    call('/api/room/kick', { targetId: id });
  }

  function toast(text) {
    // 现在先借 HUD 的位置显示；阶段 4 会做正式的消息流
    if (global.__roomToast) global.__roomToast(text);
  }

  /* ---------- 对外 ---------- */

  global.RoomUI = {
    // 由 app.js 在收到 {t:'room'} 时调用
    update: function (msg) {
      state = msg;
      if (el) el.hidden = false;
      render();
      if (onChange) onChange(state);
    },
    state: function () { return state; },
    onChange: function (fn) { onChange = fn; },
    code: function () { return CODE; }
  };

  // 复制邀请码：点一下房间名旁的码就能复制，方便发给朋友
  if (elCode) {
    elCode.addEventListener('click', function () {
      var text = state ? state.room.code : CODE;
      if (global.navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('邀请码已复制'); },
                                                 function () { toast('邀请码：' + text); });
      } else {
        toast('邀请码：' + text);
      }
    });
  }
})(window);

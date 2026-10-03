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

      // 房主：点这一行弹出该玩家的操作菜单。
      //
      // 原来是「点一下轮流换队」，**问题很大**：一屋子里所有人都
      // 盯着屏幕，房主点两下就把某人的队伍从红切到蓝、再切到旁观，
      // 中间状态全被看见了；而且想指定「到某一队」得点几次全凭运气。
      // 改成菜单后是「看一眼、选一下」，一步到位、也不泄露过程。
      if (isOwner && p.id !== me.id) {
        row.title = '点击管理 ' + p.name;
        row.style.cursor = 'pointer';
        row.addEventListener('click', function () { openPlayerMenu(p, row); });
      }

      elList.appendChild(row);
    });

    renderTeams(me);
  }

  /**
   * 「我的队伍」——**只读显示**，不可点击。
   *
   * 队伍由房主分配（服务端硬校验，自己改也会被拒）。
   * 这里不再渲染成可点的按钮，否则点下去只会得到一个 403，
   * 让人以为是坏了。
   */
  function renderTeams(me) {
    elTeams.innerHTML = '';
    var cur = me.teamId || 'none';

    (state.room.teams || []).forEach(function (t) {
      var b = document.createElement('span');
      b.className = 'pl-team-chip' + (t.id === cur ? ' on' : '');
      b.textContent = t.name;
      if (t.color) b.style.color = t.color;
      elTeams.appendChild(b);
    });

    var hint = document.createElement('span');
    hint.className = 'pl-team-hint';
    hint.textContent = state.you && state.you.owner ? '（点玩家可分配）' : '（由房主分配）';
    elTeams.appendChild(hint);
  }

  /* ---------- 操作 ---------- */

  function call(path, body) {
    return I.api(path, { method: 'POST', code: CODE, body: body })
      .then(function (r) {
        if (!r.ok) { toast(r.d.error || '操作失败'); return null; }
        return r.d;
      });
  }

  var menuEl = null;

  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
  }

  /**
   * 玩家管理菜单：分配队伍 + 踢出。
   *
   * 用自建的小浮层而不是复用棋子的 #menu —— 那个是「对棋子操作」的，
   * 混进玩家操作会让两边的状态纠缠（比如菜单开着时换了选择）。
   */
  function openPlayerMenu(p, anchorRow) {
    closeMenu();

    menuEl = document.createElement('div');
    menuEl.className = 'pl-menu';

    var head = document.createElement('div');
    head.className = 'pl-menu-head';
    head.textContent = p.name;
    menuEl.appendChild(head);

    var cur = p.teamId || 'none';
    (state.room.teams || []).forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pl-menu-item' + (t.id === cur ? ' on' : '');
      b.textContent = (t.id === cur ? '● ' : '○ ') + t.name;
      if (t.color) {
        var dot = document.createElement('span');
        dot.className = 'pl-menu-dot';
        dot.style.background = t.color;
        b.insertBefore(dot, b.firstChild);
      }
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMenu();
        if (t.id !== cur) call('/api/room/team', { targetId: p.id, teamId: t.id });
      });
      menuEl.appendChild(b);
    });

    var sep = document.createElement('div');
    sep.className = 'menu-sep';
    menuEl.appendChild(sep);

    var kick = document.createElement('button');
    kick.type = 'button';
    kick.className = 'pl-menu-item danger';
    kick.textContent = '踢出房间';
    kick.addEventListener('click', function (e) {
      e.stopPropagation();
      closeMenu();
      if (global.confirm('把「' + p.name + '」踢出房间？')) kickPlayer(p.id);
    });
    menuEl.appendChild(kick);

    // 定位到那一行下方
    var r = anchorRow.getBoundingClientRect();
    menuEl.style.left = Math.max(6, Math.min(r.left, global.innerWidth - 150)) + 'px';
    menuEl.style.top = (r.bottom + 2) + 'px';
    document.body.appendChild(menuEl);
  }

  function kickPlayer(id) {
    call('/api/room/kick', { targetId: id });
  }

  function toast(text) {
    // 现在先借 HUD 的位置显示；阶段 4 会做正式的消息流
    if (global.__roomToast) global.__roomToast(text);
  }

  // 点别处 / Esc 关掉玩家菜单
  global.addEventListener('pointerdown', function (e) {
    if (!menuEl) return;
    if (menuEl.contains(e.target)) return;
    closeMenu();
  }, true);
  global.addEventListener('keydown', function (e) {
    if (menuEl && e.key === 'Escape') { e.stopPropagation(); closeMenu(); }
  }, true);

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

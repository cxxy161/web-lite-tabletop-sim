/*
 * zoneui.js —— 视野区的绘制与编辑（房主）
 *
 * 边界说明：区域数据来自服务端（`init.zones` / `zone` op），
 * 而服务端已按队伍过滤过 —— 所以这里**只管画**，
 * 不需要（也不应该）再做一次可见性判断。重复判断只会让两处规则长歪。
 *
 * 绘制放在 bg 层（静态层）：区域边框只在视变换变化时需要重画，
 * 而棋子每帧都在动。画在 fg 上会白白增加每帧开销。
 */
(function (global) {
  'use strict';

  // 兜底色：只在区域没有指定队伍（或队伍色缺失）时用。
  var MODE_COLOR = {
    hide: '#b4453a',
    blind: '#8a7bb5'
  };

  /**
   * 区域的颜色 = **被授权队伍的颜色**。
   *
   * 纯红（按模式上色）的话，一屏几个区域根本分不清哪个属于谁；
   * 用队伍色一眼就知道「这块是红方的」。没有授权队伍时（对所有人
   * 都遮挡）才回落到模式色，并用虚线区分。
   */
  function colorOf(z) {
    var ids = z.see || [];
    for (var i = 0; i < ids.length; i++) {
      for (var j = 0; j < teams.length; j++) {
        if (teams[j].id === ids[i] && teams[j].color) return teams[j].color;
      }
    }
    return MODE_COLOR[z.mode] || '#b4453a';
  }

  // 把队伍色转成淡填充用的 rgba
  function tint(hex, alpha) {
    var m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
    if (!m) return 'rgba(180,69,58,' + alpha + ')';
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  var elBtn = document.getElementById('btn-zone');
  var elBar = document.getElementById('zone-bar');
  var elModes = document.getElementById('zone-modes');
  var elTeams = document.getElementById('zone-teams');
  var elHint = document.getElementById('zone-hint');
  var elList = document.getElementById('zone-list');

  var zones = [];          // 服务端给的、已过滤的区域
  var teams = [];          // 房间队伍
  var drafting = null;     // 正在画的矩形（世界坐标）
  var drawMode = false;    // 是否处于「拖拽画区」状态

  var mode = 'hide';
  // 「谁能看见这块区」。
  //
  // 留空 = 对**所有队伍**遮挡（只有上帝视角的 `spec` 看得穿）。
  // 这不是默认想要的，所以下面会自动预选一支队伍 —— 但**只在
  // 自己的队伍是一支真正的对战方（红/蓝）时**才预选：
  // 早期无条件预选自己的队伍，于是刚进房间（默认「未入座」）就
  // 建区的人，区被默认成「只有未入座能看见」= 挡住红蓝双方所有人，
  // 画完一看东西全没了。
  var see = [];
  var seeTouched = false;   // 用户手动选过之后，就不再自动接管

  // 能作为「授权对象」展示的队伍。`spec`（上帝视角）不需要授权
  //（它本来就看得见全部），列出来只会让人困惑。
  function grantableTeams() {
    return teams.filter(function (t) { return t.id !== 'spec'; });
  }

  /* ---------- 对外数据同步 ---------- */

  function setZones(list) {
    zones = Array.isArray(list) ? list : [];
    renderList();
    if (onRedraw) onRedraw();
  }

  function setTeams(list) {
    teams = Array.isArray(list) ? list : [];
    autoPick();
    renderTeamPicker();
    // 区域的颜色来自队伍色，所以队伍到了要重画一次。
    // （init 里 zones 可能先于 room 消息到达，那时颜色只能回落，
    //   不重画的话会一直显示成兜底色。）
    if (onRedraw) onRedraw();
    renderList();
  }

  var onRedraw = null;

  var myTeamId = null;
  function setMyTeam(id) {
    myTeamId = id || null;
    autoPick();
    renderTeamPicker();
  }

  /**
   * 预选「可见队伍」。
   *
   * 只在两条件下自动接管：用户没手动选过、且自己确实在一支对战方里。
   * 在「未入座」或「旁观」时不预选 —— 那时没有合理的默认，
   * 留给用户自己选（`commit` 会拦住空选择并给出提示）。
   */
  function autoPick() {
    if (seeTouched) return;
    if (myTeamId !== 'red' && myTeamId !== 'blue') { see = []; return; }
    if (!teams.some(function (t) { return t.id === myTeamId; })) { see = []; return; }
    see = [myTeamId];
  }

  /* ---------- 绘制 ---------- */

  // 由 app.js 的 bg 层 drawer 调用。传入 canvas ctx + 视变换。
  function draw(g, view, isOwner) {
    if (!zones.length && !drafting) return;

    var ox = view.ox, oy = view.oy;
    var s = view.s;

    zones.forEach(function (z) {
      var x = (z.x - ox), y = (z.y - oy);
      var color = colorOf(z);

      g.save();
      // 填充用很淡的一层，避免挡住下面的棋子
      g.fillStyle = tint(color, z.mode === 'blind' ? 0.12 : 0.09);
      g.fillRect(x, y, z.w, z.h);

      // 描边在屏幕坐标里保持恒定粗细（除以 s 抵消 scale）
      g.strokeStyle = color;
      g.lineWidth = 2 / Math.max(s, 0.02);
      g.setLineDash([8 / Math.max(s, 0.02), 5 / Math.max(s, 0.02)]);
      g.strokeRect(x, y, z.w, z.h);
      g.setLineDash([]);

      // 名字：缩放太小时不画（会糊成一团）
      if (s > 0.12) {
        var fs = Math.max(11, 13) / s;
        g.font = fs.toFixed(0) + 'px -apple-system,"Segoe UI",Roboto,sans-serif';
        g.fillStyle = color;
        g.textBaseline = 'bottom';
        g.fillText(z.name + (isOwner ? '' : ''), x + 4 / s, y - 3 / s);
      }
      g.restore();
    });

    // 正在拖拽的草稿
    if (drafting) {
      var dx = Math.min(drafting.x0, drafting.x1) - ox;
      var dy = Math.min(drafting.y0, drafting.y1) - oy;
      var dw = Math.abs(drafting.x1 - drafting.x0);
      var dh = Math.abs(drafting.y1 - drafting.y0);
      // 草稿用「即将生效」的颜色 —— 即当前选中的队伍色，
      // 这样画的时候就知道它会是什么颜色。
      var dc = MODE_COLOR[mode] || '#b4453a';
      for (var di = 0; di < see.length; di++) {
        for (var dj = 0; dj < teams.length; dj++) {
          if (teams[dj].id === see[di] && teams[dj].color) dc = teams[dj].color;
        }
      }

      g.save();
      g.fillStyle = tint(dc, 0.12);
      g.fillRect(dx, dy, dw, dh);
      g.strokeStyle = dc;
      g.lineWidth = 2 / Math.max(s, 0.02);
      g.setLineDash([6 / Math.max(s, 0.02), 4 / Math.max(s, 0.02)]);
      g.strokeRect(dx, dy, dw, dh);
      g.restore();
    }
  }

  /* ---------- 编辑界面 ---------- */

  function buildSeg(el, items, current, onPick) {
    el.innerHTML = '';
    items.forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.name;
      b.className = o.id === current ? 'on' : '';
      b.addEventListener('click', function () { onPick(o.id); });
      el.appendChild(b);
    });
  }

  function renderTeamPicker() {
    if (!elTeams) return;
    buildSeg(elTeams, grantableTeams(), see[0] || null, function (id) {
      // 单选：一个区域先只支持「一个队伍可见」，需要多队时再放开
      see = see[0] === id ? [] : [id];
      seeTouched = true;          // 用户表态了，之后不再自动接管
      renderTeamPicker();
    });
  }

  function renderModes() {
    if (!elModes) return;
    buildSeg(elModes, [
      { id: 'hide', name: '看不见' },
      { id: 'blind', name: '看得见背面' }
    ], mode, function (id) { mode = id; renderModes(); });
  }

  function renderList() {
    if (!elList) return;
    elList.innerHTML = '';
    if (!zones.length) {
      var e = document.createElement('div');
      e.className = 'set-note';
      e.textContent = '还没有视野区。';
      elList.appendChild(e);
      return;
    }
    zones.forEach(function (z) {
      var row = document.createElement('div');
      row.className = 'zone-row';

      var nm = document.createElement('span');
      nm.className = 'zone-name';
      nm.textContent = z.name;
      row.appendChild(nm);

      var tag = document.createElement('span');
      tag.className = 'zone-tag ' + z.mode;
      tag.textContent = z.mode === 'hide' ? '仅 ' + seeNames(z.see) : seeNames(z.see) + ' 见背面';
      // 标签也染上队伍色，和画布上的框对应起来
      var tc = colorOf(z);
      tag.style.background = tint(tc, 0.16);
      tag.style.color = tc;
      row.appendChild(tag);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'zone-del';
      del.textContent = '删除';
      del.addEventListener('click', function () { send({ k: 'zone', del: true, id: z.id }); });
      row.appendChild(del);

      elList.appendChild(row);
    });
  }

  function seeNames(ids) {
    if (!ids || !ids.length) return '无人';
    return ids.map(function (id) {
      var t = teams.filter(function (x) { return x.id === id; })[0];
      return t ? t.name : id;
    }).join('/');
  }

  function setHint(text) {
    if (elHint) elHint.textContent = text;
  }

  /* ---------- 与 app.js 的接口 ---------- */

  var sendFn = null;

  function send(op) {
    if (sendFn) sendFn(op);
  }

  function setDraw(on) {
    drawMode = !!on;
    if (elBtn) elBtn.className = drawMode ? 'on' : '';
    if (elBtn) elBtn.textContent = drawMode ? '画区中…' : '视野区';
    setHint(drawMode
      ? '在桌面上拖出一个矩形，松手即建区'
      : '点「画区」后在桌面上拖出矩形');
  }

  global.ZoneUI = {
    setZones: setZones,
    setTeams: setTeams,
    setMyTeam: setMyTeam,
    onRedraw: function (fn) { onRedraw = fn; },
    draw: draw,
    isDrawing: function () { return drawMode; },
    onSend: function (fn) { sendFn = fn; },

    // 拖拽回调由 board.js 转到 app.js，再由 app.js 转进来
    begin: function (wx, wy) {
      if (!drawMode) return false;
      drafting = { x0: wx, y0: wy, x1: wx, y1: wy };
      return true;
    },
    update: function (wx, wy) {
      if (!drafting) return;
      drafting.x1 = wx; drafting.y1 = wy;
    },
    commit: function () {
      if (!drafting) return;
      var d = drafting;
      drafting = null;

      var x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
      var w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      // 太小当作误触，不当成一次建区（否则会留下看不见的小区域）
      if (w < 20 || h < 20) { setHint('矩形太小，已忽略'); return; }

      // **没选可见队伍就不建**。
      // 空 see 的含义是「对所有人遮挡」（只有旁观看得穿），
      // 这几乎不会是本意 —— 建出来会发现连自己都看不见，
      // 而且要排查很久。宁可拦住并说清楚。
      if (!see.length) {
        setHint('请先选「可见队伍」再画区');
        return;
      }

      send({
        k: 'zone',
        zone: {
          x: x, y: y, w: w, h: h,
          see: see.slice(), mode: mode,
          // 名字带上队伍，一屏几个区时列表里能一眼分清
          name: seeNames(see) + (mode === 'hide' ? '禁视' : '盲视')
        }
      });
      setDraw(false);
      setHint('已建区');
    },
    cancel: function () { drafting = null; }
  };

  /* ---------- 面板交互 ---------- */

  if (elBtn && elBar) {
    elBtn.addEventListener('click', function () {
      var open = elBar.hidden;
      elBar.hidden = !open;
      elBtn.className = open ? 'on' : '';
      if (!open) setDraw(false);
    });
  }

  var elDraw = document.getElementById('zone-draw');
  if (elDraw) {
    elDraw.addEventListener('click', function () {
      setDraw(!drawMode);
    });
  }

  renderModes();
  renderTeamPicker();
  renderList();
})(window);

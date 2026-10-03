/*
 * saves.js —— 存档读档 UI（base64 复制输出，不落文件）
 *
 * 走 HTTP 而不是 WebSocket：导出/导入是一问一答的请求，
 * 而且 base64 字符串可能几万字符，塞进 WS 会顶到 maxPayload。
 *
 * 「导入」是把整份存档替换掉当前盘面 —— 服务端会广播新的全量快照，
 * 所以这里不需要自己做任何本地状态处理，等 init 回来就行。
 */
(function (global) {
  'use strict';

  var qs = new URLSearchParams(global.location.search);
  // 房间号就是邀请码（见 server/rooms.js）。这里必须和 app.js 用同一种归一，
  // 否则会出现「棋盘连的是 A、存档导出的是 B」这种诡异的不同步。
  var ROOM = (qs.get('room') || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);

  var dlg = document.getElementById('saves');
  var ta = document.getElementById('saves-text');
  var msg = document.getElementById('saves-msg');
  var btnExport = document.getElementById('btn-export');
  var btnImport = document.getElementById('btn-import');
  var btnCopy = document.getElementById('btn-copy');
  var btnClose = document.getElementById('btn-close');

  function open(mode) {
    dlg.hidden = false;
    setMsg('');
    if (mode === 'export') doExport();
    else { ta.value = ''; ta.focus(); }
  }

  function close() {
    dlg.hidden = true;
    ta.value = '';
    setMsg('');
  }

  function setMsg(text, kind) {
    msg.textContent = text || '';
    msg.className = kind || '';
  }

  function doExport() {
    setMsg('导出中…');
    fetch('/api/save?room=' + encodeURIComponent(ROOM))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { setMsg('导出失败：' + d.error, 'err'); return; }
        ta.value = d.data;
        setMsg('已导出 ' + d.count + ' 枚棋子，'
             + Math.round(d.bytes / 1024) + ' KB（base64）· 全选复制即可', 'ok');
        ta.focus();
        ta.select();
      })
      .catch(function (e) { setMsg('导出失败：' + e.message, 'err'); });
  }

  function doImport() {
    var v = ta.value.trim();
    if (!v) { setMsg('请先粘贴存档内容', 'err'); return; }

    setMsg('导入中…');
    fetch('/api/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: ROOM, data: v })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || res.d.error) {
          setMsg('导入失败：' + ((res.d && res.d.error) || '未知错误'), 'err');
          return;
        }
        setMsg('已载入 ' + res.d.count + ' 枚棋子，盘面已同步给所有客户端', 'ok');
      })
      .catch(function (e) { setMsg('导入失败：' + e.message, 'err'); });
  }

  function doCopy() {
    if (!ta.value) { setMsg('还没有内容', 'err'); return; }
    ta.select();
    var done = function () { setMsg('已复制到剪贴板', 'ok'); };

    if (global.navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(done, function () {
        // 非 https / 老浏览器下 clipboard API 不可用，退回 execCommand
        try { document.execCommand('copy'); done(); }
        catch (_) { setMsg('复制失败，请手动全选复制', 'err'); }
      });
    } else {
      try { document.execCommand('copy'); done(); }
      catch (_) { setMsg('复制失败，请手动全选复制', 'err'); }
    }
  }

  btnExport.addEventListener('click', doExport);
  btnImport.addEventListener('click', doImport);
  btnCopy.addEventListener('click', doCopy);
  btnClose.addEventListener('click', close);

  document.getElementById('btn-saves').addEventListener('click', function () { open('export'); });
  document.getElementById('btn-load').addEventListener('click', function () { open('import'); });

  // Esc 关掉面板；但别抢走棋盘自己的 Esc（取消选择）
  global.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !dlg.hidden) {
      e.stopPropagation();
      close();
    }
  }, true);

  global.__saves = { open: open, close: close };
})(window);

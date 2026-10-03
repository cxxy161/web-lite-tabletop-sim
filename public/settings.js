/*
 * settings.js —— 画质设置（LOD 档位 + 面板 UI）
 *
 * 为什么 LOD 要做成可调：
 *   默认的 LOD 阈值（屏幕长边 < 18px 就不加载贴图、改画色块）
 *   是为低配手机做的显存保护，但在高配机上显得过于激进 ——
 *   稍微缩小一点就全是色块，观感损失明显。
 *   所以给一个从「最省显存」到「完全不要 LOD」的档位，
 *   由使用者按自己的机器决定。
 *
 * 三档的实测代价（本模组 778 枚棋子，1200x900 视口）：
 *
 *   档位        LOD阈值   全场景视图需贴图   最坏解码显存
 *   省显存        32px         16 张           39 MB
 *   均衡          18px         16 张           62 MB
 *   关闭           0px        514 张          113 MB
 *
 * 注意「全场景视图」那一列：开着 LOD 时几乎全是色块（16 张），
 * 关掉之后 514 张全要加载。但此时小卡牌在屏幕上只有 7.8px，
 * 画贴图和画色块肉眼没有差别 —— 所以「关闭 LOD」换来的观感提升
 * 只在你放大到能看清卡面时才体现，缩到全图时纯属浪费。
 *
 * 因此关闭 LOD 时会**同时把显存预算放大**（见 applyLod）：
 * 否则 113MB 的需求撞上 72MB 的预算会持续抖动
 *（每张都「可见」→ 谁也淘汰不掉 → 下帧全重载），比开着 LOD 更糟。
 */
(function (global) {
  'use strict';

  // threshold: 屏幕长边低于此值就不加载贴图（0 = 完全不启用 LOD）
  // budgetMB / boards: 对应的显存预算
  var LEVELS = [
    { id: 'low',   name: '省显存', threshold: 32, budgetMB: 48,  boards: 2,
      note: '贴图最省，缩小时很快转色块' },
    { id: 'mid',   name: '均衡',   threshold: 18, budgetMB: 72,  boards: 3,
      note: '默认。低端手机的安全档' },
    { id: 'high',  name: '清晰',   threshold: 8,  budgetMB: 110, boards: 4,
      note: '多留贴图，显存换观感' },
    { id: 'off',   name: '关闭 LOD', threshold: 0, budgetMB: 200, boards: 20,
      note: '任何缩放都画真贴图；全图视图最费显存（约 113MB）' }
  ];

  var KEY = 'webtts.lod';
  var KEY_MAP = 'webtts.map';
  // 映射的「世代」标记。轴符号约定变更时递增，
  // 用来对已存在 localStorage 里的旧选择做一次性迁移。
  var KEY_MAPV = 'webtts.mapv';
  var MAP_VERSION = 2;

  // 位置映射候选。TTS 存档给出的是 (posX, posZ)，映射到 2D 画布
  // 有 4 种可能的轴符号组合。**这四种在纯数学推不唯一**（透视缩略图
  // 信噪比太低，我算出来最好的一组相关性只有 0.08），所以做成可切换，
  // 由用户在真实画面上直接看哪个对。
  //
  //   id      x 轴    y 轴   说明
  //   pp      +posX   +posZ
  //   pn      +posX   -posZ
  //   np      -posX   +posZ
  //   nn      -posX   -posZ   （= 绕场景中心 180°）
  var MAPS = [
    { id: 'pp', name: 'x+ y+', sx: 1,  sy: 1 },
    { id: 'pn', name: 'x+ y-', sx: 1,  sy: -1 },
    { id: 'np', name: 'x- y+', sx: -1, sy: 1 },
    { id: 'nn', name: 'x- y-', sx: -1, sy: -1 }
  ];

  function byId(id) {
    for (var i = 0; i < LEVELS.length; i++) {
      if (LEVELS[i].id === id) return LEVELS[i];
    }
    return null;
  }

  function mapById(id) {
    for (var i = 0; i < MAPS.length; i++) {
      if (MAPS[i].id === id) return MAPS[i];
    }
    return null;
  }

  function create(opts) {
    var apply = opts.apply;            // function(threshold)
    var onBudget = opts.onBudget;      // function(mb, boards)
    var onChange = opts.onChange;
    var elWrap = opts.el;
    var elNote = opts.elNote;

    var current = byId(opts.initial) || byId('mid');

    function persist(level) {
      try { global.localStorage.setItem(KEY, level.id); } catch (_) {}
    }

    function restore() {
      try {
        var v = global.localStorage.getItem(KEY);
        var l = v && byId(v);
        if (l) current = l;
      } catch (_) {}
    }

    function applyLevel(level, silent) {
      current = level;
      // LOD 阈值与显存预算必须一起改，理由见文件头
      if (apply) apply(level.threshold);
      if (onBudget) onBudget(level.budgetMB, level.boards);
      persist(level);

      if (elWrap) {
        var btns = elWrap.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          btns[i].className = (btns[i].dataset.lod === level.id) ? 'on' : '';
        }
      }
      if (elNote) {
        elNote.textContent = level.threshold
          ? (level.note + '（屏幕长边 < ' + level.threshold + 'px 时转色块）')
          : level.note;
      }
      if (!silent && onChange) onChange(level);
    }

    function build() {
      if (!elWrap) return;
      elWrap.innerHTML = '';
      LEVELS.forEach(function (lv) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = lv.name;
        b.dataset.lod = lv.id;
        b.addEventListener('click', function () { applyLevel(lv); });
        elWrap.appendChild(b);
      });
    }

    restore();
    build();
    applyLevel(current, true);   // silent：初始化时不触发 onChange

    /* ---------- 位置映射 ---------- */

    var elMap = opts.elMap;
    var elMapNote = opts.elMapNote;
    var onMap = opts.onMap;
    var curMap = mapById(opts.initialMap) || mapById('pn');

    function applyMap(m, silent) {
      curMap = m;
      try { global.localStorage.setItem(KEY_MAP, m.id); } catch (_) {}
      if (elMap) {
        var bs = elMap.querySelectorAll('button');
        for (var i = 0; i < bs.length; i++) {
          bs[i].className = (bs[i].dataset.map === m.id) ? 'on' : '';
        }
      }
      if (elMapNote) {
        elMapNote.textContent = m.id === 'pp'
          ? 'TTS 原始符号。若整幅场景反了，依次试右边三个'
          : 'x' + (m.sx > 0 ? '+' : '−') + '  y' + (m.sy > 0 ? '+' : '−');
      }
      if (onMap) onMap(m.sx, m.sy);
    }

    function buildMap() {
      if (!elMap) return;
      elMap.innerHTML = '';
      MAPS.forEach(function (m) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = m.name;
        b.dataset.map = m.id;
        b.addEventListener('click', function () { applyMap(m); });
        elMap.appendChild(b);
      });
    }

    // ---- 一次性迁移：把上下镜像补上 ----
    //
    // 第 1 代的轴符号约定少了一次上下镜像，表现是「卡片本身正了，
    // 但卡片之间的相对位置整体上下颠倒」。这里对**已存的映射选择**
    // 翻转 y 符号，而不是重置成某个固定值 —— 这样无论使用者
    // 之前手动选的是哪一档，都只是被镜像一次，不会被抹掉他的选择。
    //
    // 翻转 y 在 4 个候选之间是一个对合（自己就是自己的逆）：
    //   pp(+,+) <-> pn(+,-)      np(-,+) <-> nn(-,-)
    try {
      var mv = global.localStorage.getItem(KEY_MAP);

      var ver = 0;
      try { ver = parseInt(global.localStorage.getItem(KEY_MAPV), 10) || 0; } catch (_) {}

      if (ver < MAP_VERSION) {
        var oldM = mv && mapById(mv);
        if (oldM) {
          // 保留 x 符号，翻转 y 符号
          var flipped = null;
          for (var fi = 0; fi < MAPS.length; fi++) {
            if (MAPS[fi].sx === oldM.sx && MAPS[fi].sy === -oldM.sy) {
              flipped = MAPS[fi];
              break;
            }
          }
          if (flipped) {
            try { global.localStorage.setItem(KEY_MAP, flipped.id); } catch (_) {}
            mv = flipped.id;
          }
        }
        try { global.localStorage.setItem(KEY_MAPV, String(MAP_VERSION)); } catch (_) {}
      }

      var mm = mv && mapById(mv);
      if (mm) curMap = mm;
    } catch (_) {}

    buildMap();
    applyMap(curMap, true);

    return {
      levels: LEVELS,
      maps: MAPS,
      current: function () { return current; },
      set: function (id) { var l = byId(id); if (l) applyLevel(l); },
      threshold: function () { return current.threshold; },
      setMap: function (id) { var m = mapById(id); if (m) applyMap(m); },
      map: function () { return curMap; }
    };
  }

  global.Settings = {
    create: create, LEVELS: LEVELS, MAPS: MAPS,
    KEY: KEY, KEY_MAP: KEY_MAP, KEY_MAPV: KEY_MAPV, MAP_VERSION: MAP_VERSION
  };
})(window);

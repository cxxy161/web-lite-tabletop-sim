/*
 * texture.js —— 贴图加载 + LRU 缓存
 *
 * 为什么需要这一层：
 *   真实资产有 1003 张贴图（13MB WebP）。全部解码成 RGBA 位图后
 *   约 290MB —— 低配手机会直接崩。所以**只能按需加载**：
 *   只保留「当前可见 + 一圈余量」的贴图，其余 LRU 淘汰。
 *
 * 淘汰的对象是**解码后的 Image 对象**，不是文件。
 * 浏览器自己的 HTTP 缓存负责文件那一层（贴图按内容哈希命名，
 * 服务端给了 immutable 长缓存），我们只需要管住显存这一层。
 *
 * 关键取舍：被淘汰的贴图如果马上又被需要，会重新触发一次解码。
 *
 * 所以容量必须 **大于同屏可能出现的最多贴图数**，否则会出现抖动：
 * 每个贴图都是「本帧可见」→ refs>0 → 谁也淘汰不掉 →
 * 下一帧又全都重载，缓存变成纯开销。
 *
 * 但**不能只按张数计**. 实测《大洋落日》：
 *   小棋子贴图 192×192×4B ≈ 147KB
 *   地图板块     1024×680×4B ≈ 2.8MB  —— 一张顶 19 张小图
 * 只限 512 张时，累积 13 张底图就吃掉 36MB，
 * 总峰值实测 112MB —— 对老手机仍然危险。
 *
 * 所以改成**按解码字节数限量**，并且给底图单独一个更小的名额。
 * 这才是真正控制显存的旋钮；单纯调小张数只会换来抖动。
 *
 * 实测本模组最坏情况（s≈0.5，同屏约 460 枚超 LOD、唯一贴图 384 张）：
 *   小图约 384×147KB ≈ 56MB
 * 预算取小图 72MB / 底图 3 张，峰值约 65MB，安全。
 */
(function (global) {
  'use strict';

  var MAX_ITEMS = 640;                       // 张数硬上限（防病态数据）
  var BUDGET_SMALL = 72 * 1024 * 1024;       // 小图字节预算
  var BUDGET_BOARD = 3;                      // 底图最多驻留几张（每张约 2.8MB）
  var BOARD_PX = 1000;                       // 长边超过这个像素算底图

  function create(opts) {
    var base = (opts && opts.base) || 'assets/';
    var whiteSrc = (opts && opts.white) || 'assets/white.webp';

    var map = new Map();      // id -> rec
    var white = null;
    var pending = 0;
    var smallBytes = 0;       // 小图占用（字节）
    var boardCount = 0;       // 底图张数
    var onReady = (opts && opts.onReady) || null;

    // 预算可调：LOD 关闭时同屏贴图数会暴涨（全场景视图 514 张 / 113MB），
    // 若仍卡在 72MB 就会出现「每张都可见 -> 谁也淘汰不掉 -> 下帧全重载」
    // 的抖动，比开着 LOD 更糟。所以预算必须跟着 LOD 档位一起放大。
    var budgetSmall = BUDGET_SMALL;
    var budgetBoard = BUDGET_BOARD;

    // 未加载完时先按小图估算，加载后按真实尺寸修正
    var ASSUME_BYTES = 192 * 192 * 4;

    /* 白色占位：先加载好，任何贴图没就绪时都用它顶上 */
    var wi = new Image();
    wi.onload = function () { white = wi; };
    wi.src = whiteSrc;

    function touch(rec) {
      // Map 的迭代顺序 = 插入顺序，删了再插就是「最近使用」
      map.delete(rec.id);
      map.set(rec.id, rec);
    }

    // 加载完成后按真实解码尺寸记账。必须在 onload 里做 ——
    // 加载前拿不到 naturalWidth，只能按小图预估。
    function account(rec) {
      var w = rec.img.naturalWidth || 0;
      var h = rec.img.naturalHeight || 0;
      rec.bytes = w && h ? w * h * 4 : ASSUME_BYTES;
      rec.board = Math.max(w, h) >= BOARD_PX;

      if (rec.board) boardCount++;
      else smallBytes += rec.bytes;
    }

    function release(rec) {
      if (rec.board) boardCount--;
      else if (rec.ready) smallBytes -= rec.bytes;

      // 还在加载中就要把 pending 减回来。只把 onload 置空就删记录的话，
      // 计数永远收不回来 —— 表现是 pending 一路涨到几千，进度完全失真。
      if (!rec.ready && !rec.error) pending--;

      rec.img.onload = null;
      rec.img.onerror = null;
      rec.img.src = '';       // 断引用，让 GC 回收解码位图
      map.delete(rec.id);
    }

    function overBudget() {
      return map.size > MAX_ITEMS ||
             smallBytes > budgetSmall ||
             boardCount > budgetBoard;
    }

    function evict() {
      if (!overBudget()) return;
      // 从最旧的开始淘汰，跳过本帧还被引用的。
      //
      // 必须按「字节」判满而不是按张数：底图一张 2.8MB 顶 19 张小图，
      // 只数张数的话，11 张离屏底图（30MB）会因为 size 没超上限
      // 而永远赖在缓存里 —— 这正是早期实测峰值 112MB 的来源。
      for (var it = map.keys(), n = it.next(); !n.done; n = it.next()) {
        if (!overBudget()) break;
        var rec = map.get(n.value);
        if (rec.refs > 0) continue;   // 本帧可见，不能动
        release(rec);
      }
    }

    var api = {
      /**
       * 取一张贴图。立即返回 {img, ready}：
       *   ready=false 时 img 是白色占位，调用方照常画，不必等。
       * 这正是低端机需要的：平移过程中永远不阻塞，缺图先显示白块。
       */
      get: function (id) {
        if (!id) return { img: white, ready: false };

        var rec = map.get(id);
        if (rec) {
          touch(rec);
          return { img: rec.ready ? rec.img : white, ready: rec.ready };
        }

        rec = {
          id: id, img: new Image(), ready: false, error: false, refs: 0,
          bytes: ASSUME_BYTES, board: false
        };
        rec.img.onload = function () {
          rec.ready = true;
          pending--;
          account(rec);
          evict();                  // 底图可能是刚发现的大块头，立刻重算预算
          if (onReady) onReady();
        };
        rec.img.onerror = function () {
          rec.error = true;
          pending--;
          // 加载失败就不再重试，否则会反复打到 404
          rec.ready = false;
          if (onReady) onReady();
        };
        rec.img.src = base + id + '.webp';
        map.set(id, rec);
        pending++;
        evict();

        return { img: white, ready: false };
      },

      /**
       * 每帧结束时调用，报告这一帧用到了哪些贴图。
       * LRU 靠这个把「本帧可见」钉住不被淘汰。
       */
      markFrame: function (ids) {
        // 先清零，再给本帧用到的计数
        map.forEach(function (r) { r.refs = 0; });
        for (var i = 0; i < ids.length; i++) {
          var r = map.get(ids[i]);
          if (r) r.refs = 1;
        }
        evict();
      },

      stats: function () {
        var ready = 0, err = 0;
        map.forEach(function (r) { if (r.ready) ready++; if (r.error) err++; });
        return {
          cached: map.size,
          ready: ready,
          error: err,
          pending: pending,
          boards: boardCount,
          smallMB: Math.round(smallBytes / 1048576 * 10) / 10,
          white: !!white
        };
      },

      // 供诊断/压测使用
      ids: function () { return Array.from(map.keys()); },

      // 调整显存预算（LOD 档位切换时调用）。调小会立刻触发淘汰。
      setBudget: function (mbSmall, boards) {
        budgetSmall = Math.max(8, mbSmall) * 1024 * 1024;
        budgetBoard = Math.max(1, boards | 0);
        evict();
      },

      budget: function () {
        return {
          smallMB: Math.round(budgetSmall / 1048576),
          boards: budgetBoard
        };
      },

      clear: function () {
        map.forEach(function (r) { r.img.onload = null; r.img.src = ''; });
        map.clear();
        smallBytes = 0;
        boardCount = 0;
        pending = 0;
      }
    };

    return api;
  }

  global.Texture = {
    create: create,
    MAX_ITEMS: MAX_ITEMS,
    BUDGET_SMALL: BUDGET_SMALL,
    BUDGET_BOARD: BUDGET_BOARD,
    BOARD_PX: BOARD_PX
  };
})(window);

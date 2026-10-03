/*
 * room.js —— 房间状态：权威副本 + seq 分配 + 防抖落盘
 *
 * 这里只做三件事，绝不越界：
 *   1. 分配单调递增的 seq   <- 纯中继之所以能保证多端一致，全靠这一条
 *   2. 维护权威状态副本
 *   3. 防抖落盘
 *
 * 刻意不做：任何规则/合法性判定。这是纯沙盒桌面（readme 的定位）。
 *
 * 棋子形状：
 *   { id, x, y, r, f, w, h, img, bimg, z }
 *   x/y 是任意浮点世界坐标（棋子中心），地图无边界，服务端不钳制范围。
 *   w/h 是这枚棋子自己的世界尺寸 —— 真实资产里 scale 从 0.6 到 15（差 25 倍），
 *   底图板块还是 1.5:1 的长方形，所以不能像早期 demo 那样全局写死一个边长。
 *   img/bimg 是贴图资产 id（正面/背面），f 决定画哪一张。
 *
 * 层叠序 z：每个被移动过的棋子拿到递增 z，绘制按 z 升序，
 * 于是「最后放的在最上面」。z 必须由服务端分配 —— 让客户端自己发，
 * 两端对「谁更晚」的判断会不一致，重叠时的上下关系会各画各的。
 *
 * 关于「seq 为什么不能省」：op 幂等让本地可以先乐观应用、服务端回显重复应用无害；
 * 但「幂等」不等于「有序」——客户端各自编号时两端应用顺序会不同，画面就撕裂了。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SAVE_DEBOUNCE_MS = 5000;
const MAX_BATCH = 2048;          // 单次批量移动上限，防畸形包

class Room {
  constructor(id, opts) {
    this.id = id;
    this.opts = opts || {};

    this.seq = 0;
    this.zSeq = 0;
    this.clients = new Set();
    this.pieces = new Map();
    this.scene = '';             // 当前场景 slug
    this.label = '';

    this.dir = this.opts.dir || path.join(__dirname, '..', 'data');
    this.file = path.join(this.dir, 'room-' + id + '.json');

    this._timer = null;
    this._writing = false;
    this._pending = false;

    // 优先恢复上次的房间状态；没有就装载场景
    if (!this._restore()) this.loadScene(this.opts.scene);
  }

  /* ---------- 场景装载 ---------- */

  /**
   * 用一份棋子数组替换当前盘面。
   * pieces 来自：场景 JSON（构建期产物）或存档解码（用户粘贴）。
   * 两种来源走同一条路径，避免两套装载逻辑各自长歪。
   */
  loadPieces(pieces, meta) {
    this.pieces.clear();
    this.seq = 0;
    this.zSeq = 0;

    for (const p of pieces) {
      const q = {
        id: p.id,
        x: p.x,
        y: p.y,
        r: p.r || 0,
        f: p.f ? 1 : 0,
        w: p.w,
        h: p.h,
        img: p.img,
        bimg: p.bimg || p.img,
        z: typeof p.z === 'number' ? p.z : 0
      };
      this.pieces.set(q.id, q);
      if (q.z > this.zSeq) this.zSeq = q.z;
    }

    this.scene = (meta && meta.scene) || '';
    this.label = (meta && meta.label) || '';

    this.save();
    return this.pieces.size;
  }

  loadScene(slug) {
    const store = this.opts.scenes;
    if (!store) return 0;

    let use = slug;
    if (!use || !store.has(use)) use = store.defaultSlug();
    if (!use) return 0;                    // 没跑过资产管线，空房间

    const scene = store.load(use);
    return this.loadPieces(scene.pieces.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      r: p.r,
      f: p.f,
      w: p.w,
      h: p.h,
      img: p.img,
      bimg: p.bimg,
      z: p.z
    })), { scene: use, label: store.label(use) || scene.name });
  }

  /* ---------- 持久化 ---------- */

  _restore() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.pieces) || !d.pieces.length) return false;

      // 磁盘上的老格式（没有 w/h/img）直接丢弃重载场景 ——
      // demo 阶段的房间数据没有保留价值，不值得写迁移代码
      if (typeof d.pieces[0].w !== 'number' || typeof d.pieces[0].img !== 'string') {
        return false;
      }

      this.seq = d.seq | 0;
      this.scene = d.scene || '';
      this.label = d.label || '';
      this.pieces = new Map(d.pieces.map((p) => [p.id, p]));

      let maxZ = 0;
      this.pieces.forEach((p) => {
        if (typeof p.z !== 'number') p.z = 0;
        if (p.z > maxZ) maxZ = p.z;
      });
      this.zSeq = maxZ;
      return true;
    } catch (_) {
      return false;
    }
  }

  snapshot() {
    return {
      seq: this.seq,
      scene: this.scene,
      label: this.label,
      pieces: Array.from(this.pieces.values())
    };
  }

  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush();
    }, SAVE_DEBOUNCE_MS);
    if (this._timer.unref) this._timer.unref();
  }

  _flush() {
    if (this._writing) { this._pending = true; return; }
    this._writing = true;

    const tmp = this.file + '.tmp';
    const body = JSON.stringify(this.snapshot());

    fs.mkdir(this.dir, { recursive: true }, (err) => {
      if (err) { this._writing = false; return; }
      fs.writeFile(tmp, body, (err2) => {
        if (err2) { this._writing = false; return; }
        fs.rename(tmp, this.file, () => {
          this._writing = false;
          if (this._pending) { this._pending = false; this._flush(); }
        });
      });
    });
  }

  flushNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._flush();
  }

  /* ---------- 校验 ---------- */

  // 严格要求 number 且有限。不能用 Number(v)：
  // JSON 里 NaN 会序列化成 null，而 Number(null) === 0，
  // 一个 NaN 坐标会被静默当成 (0,0) 收下（Number('')/Number([]) 同理）。
  static _finite(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /* ---------- op ---------- */

  applyOp(op) {
    if (!op || typeof op !== 'object') return null;

    switch (op.k) {
      case 'move': {
        const list = op.list;
        if (!Array.isArray(list) || list.length === 0) return null;
        if (list.length > MAX_BATCH) return null;

        // 先全量校验再落地。一项不合法就整批拒绝 ——
        // 否则会出现「一半棋子动了、一半没动」的撕裂状态。
        const clean = [];
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (!it || typeof it !== 'object') return null;
          const p = this.pieces.get(it.id);
          if (!p) return null;
          if (!Room._finite(it.x) || !Room._finite(it.y)) return null;
          clean.push({ id: it.id, x: it.x, y: it.y });
        }

        // 层叠序按 list 顺序分配：靠后的更晚上去
        const out = [];
        for (let i = 0; i < clean.length; i++) {
          const p = this.pieces.get(clean[i].id);
          p.x = clean[i].x;
          p.y = clean[i].y;
          p.z = ++this.zSeq;
          out.push({ id: p.id, x: p.x, y: p.y, z: p.z });
        }

        this.seq++;
        this.save();
        return { k: 'move', list: out };
      }

      case 'flip': {
        const p = this.pieces.get(op.id);
        if (!p) return null;
        p.f = op.f ? 1 : 0;
        this.seq++;
        this.save();
        return { k: 'flip', id: p.id, f: p.f, z: p.z };
      }

      case 'rot': {
        const p = this.pieces.get(op.id);
        if (!p) return null;
        p.r = (((Number(op.r) | 0) % 360) + 360) % 360;
        this.seq++;
        this.save();
        return { k: 'rot', id: p.id, r: p.r, z: p.z };
      }

      default:
        return null;
    }
  }
}

class RoomStore {
  constructor(opts) {
    this.opts = opts || {};
    this.rooms = new Map();
  }

  get(id) {
    let r = this.rooms.get(id);
    if (!r) {
      r = new Room(id, this.opts);
      this.rooms.set(id, r);
    }
    return r;
  }

  flushAll() {
    this.rooms.forEach((r) => r.flushNow());
  }
}

module.exports = { Room, RoomStore, SAVE_DEBOUNCE_MS, MAX_BATCH };

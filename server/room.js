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
const CLONE_OFFSET = 24;         // 克隆体的默认偏移（世界单位）

// 骰子：面数白名单 + 各面数的世界边长。
// 尺寸差异纯为观感 —— 数据上它们和棋子没有区别。
const DICE_SIDES = [2, 4, 6, 10, 12];
const DICE_SIZE = { 2: 44, 4: 46, 6: 48, 10: 52, 12: 56 };

// 标记：形状白名单 + 世界边长。和骰子一样，只是为了观感有区分。
const TOKEN_SHAPES = [1, 2, 3, 4];     // 方 / 圆 / 三角 / 星
const TOKEN_SIZE = 40;

class Room {
  constructor(id, opts) {
    this.id = id;
    this.opts = opts || {};

    this.seq = 0;
    this.zSeq = 0;
    this.cloneSeq = 0;         // 克隆 id 分配器
    this.diceSeq = 0;          // 骰子 id 分配器
    this.tokenSeq = 0;         // 标记 id 分配器
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
    this.cloneSeq = 0;

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
        z: typeof p.z === 'number' ? p.z : 0,
        lk: p.lk ? 1 : 0,          // 冻结：不可拖动/翻面/旋转
        si: p.si | 0,              // 当前形态索引（st 的下标）
        st: Array.isArray(p.st) && p.st.length ? p.st : null,
        ds: DICE_SIDES.indexOf(p.ds | 0) >= 0 ? (p.ds | 0) : 0,   // 面数，0=非骰子
        v: p.v | 0,                // 当前点数
        sh: TOKEN_SHAPES.indexOf(p.sh | 0) >= 0 ? (p.sh | 0) : 0, // 标记形状，0=非标记
        c: p.c >>> 0               // 自定义颜色（0xRRGGBB，0=默认）
      };
      this.pieces.set(q.id, q);
      if (q.z > this.zSeq) this.zSeq = q.z;
      // 从 id 里恢复分配器，避免重载后再加骰子撞 id
      if (q.ds) {
        const m = /^d(\d+)_/.exec(q.id);
        if (m) { const n = parseInt(m[1], 10); if (n > this.diceSeq) this.diceSeq = n; }
      }
      if (q.sh) {
        const mk = /^k(\d+)_/.exec(q.id);
        if (mk) { const n = parseInt(mk[1], 10); if (n > this.tokenSeq) this.tokenSeq = n; }
      }
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
    // 直接展开场景棋子，不要在这里手写字段白名单 ——
    // 手挑字段会静默丢掉后加的字段（st 形态、lk 冻结就是这么丢的：
    // loadPieces 认得它们，但这里没传进去，表现是「形态切换全部失败」
    // 却不报任何错）。需要过滤就在 loadPieces 里统一做。
    return this.loadPieces(scene.pieces, {
      scene: use,
      label: store.label(use) || scene.name
    });
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
      this.cloneSeq = d.cloneSeq | 0;
      this.diceSeq = d.diceSeq | 0;
      this.tokenSeq = d.tokenSeq | 0;
      return true;
    } catch (_) {
      return false;
    }
  }

  snapshot() {
    return {
      seq: this.seq,
      cloneSeq: this.cloneSeq,
      diceSeq: this.diceSeq,
      tokenSeq: this.tokenSeq,
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

  // 颜色归一成 0xRRGGBB 整数。0 = 用默认色。
  //
  // 存整数而不是 '#rrggbb'：存档的行是纯数字列式数组（见 codec.js），
  // 塞字符串要另开字典表，而颜色取值本来就有限，整数最省。
  // 非法输入一律回落到 0（默认色），不抛错 ——
  // 颜色只是外观，不值得为它拒绝整个操作。
  static _color(v) {
    if (v == null) return 0;
    if (typeof v === 'string') {
      const m = /^#?([0-9a-fA-F]{6})$/.exec(v.trim());
      return m ? (parseInt(m[1], 16) >>> 0) : 0;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      const n = Math.floor(v);
      if (n <= 0) return 0;
      return (n & 0xffffff) >>> 0;
    }
    return 0;
  }

  // 角度归一：保留两位小数，与 codec / 前端一致（见 codec.js 的 normR）
  static _normR(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    let m = n % 360;
    if (m < 0) m += 360;
    m = Math.round(m * 100) / 100;
    if (m >= 360) m = 0;
    return m;
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
          // 冻结的棋子不可移动。在服务端拦，而不是只靠前端不拖 ——
          // 前端只是「不去拖」，服务端才是权威；跳过它会让整批
          // 悄悄少动一枚，不如显式拒绝让客户端知道自己过时了。
          if (p.lk) return null;
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
        if (!p || p.lk) return null;
        p.f = op.f ? 1 : 0;
        this.seq++;
        this.save();
        return { k: 'flip', id: p.id, f: p.f, z: p.z };
      }

      case 'rot': {
        const p = this.pieces.get(op.id);
        if (!p || p.lk) return null;
        // 保留**两位**小数，与场景数据 / codec 的精度一致。
        // **不能用 |0 或 Math.round**：真实资产里有 0.27 / 359.94
        // 这类朝向（rotY 换算的余数），取整会静默抹平它们。
        //
        // 也不能写成 ((n % 360) + 360) % 360：0.27 先 +360 再取模
        // 会得到 0.2699999999999818（浮点残留）。先归一非负、再取整。
        const n = Number(op.r);
        if (!Number.isFinite(n)) return null;
        let m = n % 360;
        if (m < 0) m += 360;
        m = Math.round(m * 100) / 100;
        if (m >= 360) m = 0;
        p.r = m;
        this.seq++;
        this.save();
        return { k: 'rot', id: p.id, r: p.r, z: p.z };
      }

      // 冻结 / 解冻。注意这是**唯一允许作用于已冻结棋子的 op** ——
      // 否则一旦冻上就再也解不开了。
      case 'lock': {
        const p = this.pieces.get(op.id);
        if (!p) return null;
        p.lk = op.lk ? 1 : 0;
        p.z = ++this.zSeq;
        this.seq++;
        this.save();
        return { k: 'lock', id: p.id, lk: p.lk, z: p.z };
      }

      // 切换形态。st 是形态数组（st[0] = 存档里的原始形态），
      // si 是当前形态下标；宽高随形态变（不同形态尺寸可能不同）。
      case 'state': {
        const p = this.pieces.get(op.id);
        if (!p || p.lk) return null;
        if (!p.st || p.st.length < 2) return null;
        const si = op.si | 0;
        if (si < 0 || si >= p.st.length) return null;
        p.si = si;
        p.img = p.st[si].img;
        p.bimg = p.st[si].bimg || p.st[si].img;
        p.w = p.st[si].w;
        p.h = p.st[si].h;
        p.z = ++this.zSeq;
        this.seq++;
        this.save();
        return {
          k: 'state', id: p.id, si: p.si,
          img: p.img, bimg: p.bimg, w: p.w, h: p.h, z: p.z
        };
      }

      // 克隆：复制一枚棋子，原样搬到偏移位置，压在最上层并立即选中。
      // 新 id 由服务端分配（客户端各发各的会撞 id）。
      case 'clone': {
        const src = this.pieces.get(op.id);
        if (!src) return null;

        const id = 'c' + (++this.cloneSeq) + '_' + src.id;
        if (this.pieces.has(id)) return null;

        const p = {
          id,
          x: Room._finite(op.x) ? op.x : src.x + CLONE_OFFSET,
          y: Room._finite(op.y) ? op.y : src.y + CLONE_OFFSET,
          r: src.r, f: src.f,
          w: src.w, h: src.h,
          img: src.img, bimg: src.bimg,
          z: ++this.zSeq,
          lk: 0,                      // 克隆出来的是解冻的
          si: src.si | 0,
          st: src.st ? src.st.map((s) => ({ img: s.img, bimg: s.bimg, w: s.w, h: s.h })) : null,
          ds: src.ds | 0,
          v: src.v | 0,
          sh: src.sh | 0,
          c: src.c >>> 0
        };
        this.pieces.set(id, p);

        this.seq++;
        this.save();
        return { k: 'clone', piece: p, from: src.id };
      }

      case 'del': {
        const p = this.pieces.get(op.id);
        if (!p) return null;
        this.pieces.delete(op.id);
        this.seq++;
        this.save();
        return { k: 'del', id: op.id };
      }

      // 加一颗骰子。骰子**就是棋子**，只是多两个字段：
      //   ds = 面数（0/缺省 = 非骰子），v = 当前点数
      // 这样它白拿棋子已有的同步、层叠序、拖动、克隆、删除、存档往返。
      case 'dice': {
        const sides = DICE_SIDES.indexOf(op.ds | 0) >= 0 ? (op.ds | 0) : 0;
        if (!sides) return null;
        if (!Room._finite(op.x) || !Room._finite(op.y)) return null;

        const id = 'd' + (++this.diceSeq) + '_' + sides;
        if (this.pieces.has(id)) return null;

        const size = DICE_SIZE[sides] || 48;
        const p = {
          id,
          x: op.x, y: op.y,
          r: 0, f: 0,
          w: size, h: size,
          img: 'white', bimg: 'white',      // 骰子是画出来的，不用贴图
          z: ++this.zSeq,
          lk: 0, si: 0, st: null,
          ds: sides,
          v: 1,
          sh: 0,
          c: Room._color(op.c)
        };
        this.pieces.set(id, p);

        this.seq++;
        this.save();
        return { k: 'dice', piece: p };
      }

      // 加一个标记（方/圆/三角/星），同样就是棋子。
      // 它是「指示物」性质 —— 桌游里常用来标目标点、范围、状态。
      case 'token': {
        const shape = TOKEN_SHAPES.indexOf(op.sh | 0) >= 0 ? (op.sh | 0) : 0;
        if (!shape) return null;
        if (!Room._finite(op.x) || !Room._finite(op.y)) return null;

        const id = 'k' + (++this.tokenSeq) + '_' + shape;
        if (this.pieces.has(id)) return null;

        const sz = Room._finite(op.size) ? Math.max(8, Math.min(400, op.size)) : TOKEN_SIZE;
        const p = {
          id,
          x: op.x, y: op.y,
          r: Room._finite(op.r) ? Room._normR(op.r) : 0,
          f: 0,
          w: sz, h: sz,
          img: 'white', bimg: 'white',   // 标记是画出来的
          z: ++this.zSeq,
          lk: 0, si: 0, st: null,
          ds: 0, v: 0,
          sh: shape,
          c: Room._color(op.c)
        };
        this.pieces.set(id, p);

        this.seq++;
        this.save();
        return { k: 'token', piece: p };
      }

      // 改颜色 / 改形状。骰子与标记都用它，方块和骰子都能换色。
      case 'tint': {
        const p = this.pieces.get(op.id);
        if (!p || p.lk) return null;
        if (!p.ds && !p.sh) return null;         // 只对骰子/标记有效

        let changed = false;
        if (op.c != null) { p.c = Room._color(op.c); changed = true; }
        if (op.sh != null && p.sh) {
          const ns = TOKEN_SHAPES.indexOf(op.sh | 0) >= 0 ? (op.sh | 0) : 0;
          if (ns) { p.sh = ns; changed = true; }
        }
        if (!changed) return null;

        p.z = ++this.zSeq;
        this.seq++;
        this.save();
        return { k: 'tint', id: p.id, c: p.c, sh: p.sh, z: p.z };
      }

      // 掷骰。**点数由服务端随机** —— 若让客户端各摇各的，
      // 同一张桌上的两个人会看到不同的点数，那就不是骰子了。
      case 'roll': {
        const ids = Array.isArray(op.ids) ? op.ids : (op.id ? [op.id] : null);
        if (!ids || !ids.length || ids.length > MAX_BATCH) return null;

        // 先全量校验再落地（和 move 一样的理由：不要出现摇了一半）
        for (let i = 0; i < ids.length; i++) {
          const p = this.pieces.get(ids[i]);
          if (!p || !p.ds || p.lk) return null;
        }

        const out = [];
        for (let i = 0; i < ids.length; i++) {
          const p = this.pieces.get(ids[i]);
          p.v = 1 + Math.floor(Math.random() * p.ds);
          p.z = ++this.zSeq;
          out.push({ id: p.id, v: p.v, z: p.z, ds: p.ds });
        }

        this.seq++;
        this.save();
        return { k: 'roll', list: out };
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

module.exports = {
  Room, RoomStore, SAVE_DEBOUNCE_MS, MAX_BATCH, CLONE_OFFSET,
  DICE_SIDES, DICE_SIZE, TOKEN_SHAPES, TOKEN_SIZE
};

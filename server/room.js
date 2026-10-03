/*
 * room.js —— 房间状态：权威副本 + seq 分配 + 防抖落盘
 *
 * 这里只做三件事，绝不越界：
 *   1. 分配单调递增的 seq   <- 纯中继之所以能保证多端一致，全靠这一条
 *   2. 维护权威状态副本
 *   3. 5 秒防抖、原子写盘
 *
 * 刻意不做：任何规则/合法性判定。这是纯沙盒桌面（readme 的定位）。
 *
 * 坐标：棋子位置是任意浮点世界坐标（棋子的中心），地图无边界。
 * 服务端**不**对坐标做任何范围钳制 —— 钳制就等于给无限地图偷偷加了边界。
 *
 * 层叠序 z：每个被移动过的棋子拿到一个递增的 z，绘制时按 z 升序画，
 * 于是「最后放的最在上面」。z 必须由服务端分配 —— 如果让客户端自己发，
 * 两端对「谁更晚」的判断会不一致，重叠时的上下关系就会各画各的。
 *
 * 关于「seq 为什么不能省」：如果让客户端自己编号，两个客户端并发操作时
 * 到达顺序不同，两端最终画面就会撕裂。服务端串行编号后广播，
 * 全序是白送的，于是这版 demo 完全不需要 OT / CRDT / 回滚。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SAVE_DEBOUNCE_MS = 5000;
const MAX_BATCH = 1024;          // 单次批量移动的上限，防止畸形包

class Room {
  constructor(id, opts) {
    this.id = id;

    this.seq = 0;
    this.zSeq = 0;               // 层叠序分配器
    this.clients = new Set();
    this.pieces = new Map();

    this.dir = (opts && opts.dir) || path.join(__dirname, '..', 'data');
    this.file = path.join(this.dir, 'room-' + id + '.json');

    this._timer = null;
    this._writing = false;
    this._pending = false;

    if (!this._restore()) this._seed();
  }

  /* ---------- 初始布局 ---------- */
  //
  // 无限地图上没有「盘面」这回事，所以布局是以世界原点为中心的两块阵地，
  // 坐标可正可负（这正是无边界地图该有的样子）。
  // 12 列 * 9 行 * 2 = 216 枚，满足 readme 的 200+ 棋子压力。
  //
  // 中间留一条 2 行的空地带：全填满的话棋子就没有可拖拽的余地。
  //
  // 注意：种子坐标都是整数，浮点链路真正的考验在用户拖拽
  //（落点由屏幕坐标反解，必然是任意小数）。
  _seed() {
    const SP = 72;                     // 棋子间距（世界单位）
    const COLS = 12, SIDE = 9, GAP = 2;

    let k = 0;
    for (let band = 0; band < 2; band++) {
      for (let row = 0; row < SIDE; row++) {
        const y = band === 0
          ? -(GAP * SP) / 2 - (SIDE - row - 1) * SP
          : (GAP * SP) / 2 + row * SP;

        for (let col = 0; col < COLS; col++) {
          const x = (col - (COLS - 1) / 2) * SP;
          const id = 'p' + band + '_' + row + '_' + col;
          this.pieces.set(id, { id, x, y, r: 0, f: 0, k: k % 16, z: k });
          k++;
        }
      }
    }
    this.zSeq = k - 1;
  }

  /* ---------- 持久化 ---------- */

  _restore() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.pieces)) return false;

      this.seq = d.seq | 0;
      this.pieces = new Map(d.pieces.map((p) => [p.id, p]));

      // z 是老数据里可能缺的字段，补一个并重算分配器
      let maxZ = 0;
      this.pieces.forEach((p, i) => {
        if (typeof p.z !== 'number') p.z = i;
        if (p.z > maxZ) maxZ = p.z;
      });
      this.zSeq = maxZ;

      return this.pieces.size > 0;
    } catch (_) {
      return false;   // 文件不存在 / 损坏 -> 重新播种
    }
  }

  snapshot() {
    return {
      seq: this.seq,
      pieces: Array.from(this.pieces.values())
    };
  }

  // 5 秒防抖：连续操作只落盘一次，且写临时文件后 rename（原子替换）
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

  // 必须严格要求是 number 且有限。
  // 不能用 Number(v) 这种宽松写法：JSON 里 NaN 会序列化成 null，
  // 而 Number(null) === 0，于是一个 NaN 坐标会被静默当成 (0,0) 收下。
  // 同理 Number('') / Number([]) 也都是 0。
  static _finite(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /* ---------- op ---------- */

  // 返回归一化后的 op；不认识 / 不合法的返回 null（不分配 seq）
  //
  // move 走批量形式（单枚移动就是长度为 1 的批量）。
  // 统一成一种形状，省掉「单枚 / 多枚」两套代码路径，
  // 也让多选拖拽天然复用同一条链路。
  applyOp(op) {
    if (!op || typeof op !== 'object') return null;

    switch (op.k) {
      case 'move': {
        const list = op.list;
        if (!Array.isArray(list) || list.length === 0) return null;
        if (list.length > MAX_BATCH) return null;

        // 先全量校验再落地。有一项不合法就整批拒绝 ——
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

        // 层叠序按 list 顺序分配：数组里靠后的更晚上去
        const out = [];
        for (let i = 0; i < clean.length; i++) {
          const it = clean[i];
          const p = this.pieces.get(it.id);
          p.x = it.x;
          p.y = it.y;
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

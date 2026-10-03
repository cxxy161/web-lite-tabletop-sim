/*
 * room.js —— 房间状态：权威副本 + seq 分配 + 防抖落盘
 *
 * 这里只做三件事，绝不越界：
 *   1. 分配单调递增的 seq   <- 纯中继之所以能保证多端一致，全靠这一条
 *   2. 维护权威状态副本
 *   3. 5 秒防抖、原子写盘
 *
 * 刻意不做：任何规则/合法性判定。这是纯沙盒桌面（README 的定位）。
 *
 * 关于「seq 为什么不能省」：如果让客户端自己编号，两个客户端并发操作时
 * 到达顺序不同，两端最终画面就会撕裂。服务端串行编号后广播，
 * 全序是白送的，于是这版 demo 完全不需要 OT / CRDT / 回滚。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SAVE_DEBOUNCE_MS = 5000;

class Room {
  constructor(id, opts) {
    this.id = id;
    this.cell = (opts && opts.cell) || 64;
    this.cols = (opts && opts.cols) || 12;
    this.rows = (opts && opts.rows) || 20;

    this.seq = 0;
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
  // 军棋式布局：上下两块「本方阵地」，中间留一条空地带（前线）。
  // 12 列 * 9 行 * 2 = 216 枚，满足 README 的 200+ 棋子压力；
  // 中间 2 行（24 格）留空 —— 这点很重要，全填满的话
  // 「点击空格落子」这条交互就永远走不到。
  // 所以 rows 必须是 9 + 2 + 9 = 20，不能是 18。
  _seed() {
    const mid = 2;
    const side = Math.floor((this.rows - mid) / 2);
    let k = 0;

    for (let band = 0; band < 2; band++) {
      const y0 = band === 0 ? 0 : this.rows - side;
      for (let y = y0; y < y0 + side; y++) {
        for (let x = 0; x < this.cols; x++) {
          const id = 'p' + (y * this.cols + x);
          this.pieces.set(id, { id, x, y, r: 0, f: 0, k: k++ % 16 });
        }
      }
    }
  }

  /* ---------- 持久化 ---------- */

  _restore() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.pieces)) return false;

      this.seq = d.seq | 0;
      this.cell = d.cell || this.cell;
      this.cols = d.cols || this.cols;
      this.rows = d.rows || this.rows;
      this.pieces = new Map(d.pieces.map((p) => [p.id, p]));
      return this.pieces.size > 0;
    } catch (_) {
      return false;   // 文件不存在 / 损坏 -> 重新播种
    }
  }

  snapshot() {
    return {
      cell: this.cell,
      cols: this.cols,
      rows: this.rows,
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

  /* ---------- op ---------- */

  // 返回分配好 seq 的广播包；不合法（不认识的 op / 不存在的棋子）返回 null
  applyOp(op) {
    if (!op || typeof op !== 'object') return null;

    const p = this.pieces.get(op.id);
    if (!p) return null;

    switch (op.k) {
      case 'move': {
        const x = Number(op.x);
        const y = Number(op.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        p.x = x; p.y = y;
        break;
      }
      case 'flip':
        p.f = op.f ? 1 : 0;
        break;

      case 'rot':
        p.r = (((Number(op.r) | 0) % 360) + 360) % 360;
        break;

      default:
        return null;
    }

    this.seq++;
    this.save();
    return { kind: op.k, id: op.id, x: p.x, y: p.y, r: p.r, f: p.f };
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

module.exports = { Room, RoomStore, SAVE_DEBOUNCE_MS };

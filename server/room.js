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
  // 无限地图上没有「盘面」这回事，所以布局是以世界原点为中心的两块阵地，
  // 坐标可正可负（这正是无边界地图该有的样子）。
  // 12 列 * 9 行 * 2 = 216 枚，满足 readme 的 200+ 棋子压力。
  //
  // 中间留一条 2 行的空地带：全填满的话
  // 「点击空白落子」这条交互就永远走不到。
  //
  // 注意：种子坐标都是整数，浮点链路真正的考验在用户拖拽
  //（落点由屏幕坐标反解，必然是任意小数）。
  _seed() {
    const SP = 72;                     // 棋子间距（世界单位）
    const COLS = 12, SIDE = 9, GAP = 2;

    let k = 0;
    for (let band = 0; band < 2; band++) {
      // 上阵地：GAP/2 行留空；下阵地：镜像
      for (let row = 0; row < SIDE; row++) {
        const y = band === 0
          ? -(GAP * SP) / 2 - (SIDE - row - 1) * SP
          : (GAP * SP) / 2 + row * SP;

        for (let col = 0; col < COLS; col++) {
          const x = (col - (COLS - 1) / 2) * SP;
          const id = 'p' + band + '_' + row + '_' + col;
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
      this.pieces = new Map(d.pieces.map((p) => [p.id, p]));
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

  /* ---------- op ---------- */

  // 返回归一化后的 op；不认识 / 不合法的返回 null（不分配 seq）
  applyOp(op) {
    if (!op || typeof op !== 'object') return null;

    const p = this.pieces.get(op.id);
    if (!p) return null;

    switch (op.k) {
      case 'move': {
        const x = op.x;
        const y = op.y;
        // 必须严格要求是 number 且有限。
        // 不能用 Number(op.x) 这种宽松写法：JSON 里 NaN 会序列化成 null，
        // 而 Number(null) === 0，于是一个 NaN 坐标会被静默当成 (0,0) 收下。
        // 同理 Number('') / Number([]) 也都是 0。
        // 只要求有限数、不钳制范围 —— 地图无边界。
        if (typeof x !== 'number' || typeof y !== 'number') return null;
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

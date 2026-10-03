/*
 * rooms.js —— 房间注册表（房间元数据 + 玩家身份）
 *
 * 职责边界（重要）：
 *   本文件只管「房间是谁的、有谁、谁是房主」，
 *   **完全不碰盘面**。盘面棋子仍然在 room.js 里、单独存成 data/<code>.json。
 *
 * 为什么分两份存：
 *   盘面快照（778 枚棋子 ~100KB）几乎每次拖动都会重写；
 *   房间元数据（几个人、什么队）几分钟才动一次。
 *   塞在一起会让「加个人」这种小操作也要重写整个盘面。
 *   代价是两份文件的一致性没保证 —— 但它们的生命周期本来就不同：
 *   房间没了盘面可以不删，盘面坏了也不影响能不能进房间。
 *
 * 身份模型：
 *   服务端发 playerId + token，客户端存 localStorage 用于重连。
 *   **token 绝不出现在任何广播里** —— 玩家列表要广播给全房间，
 *   里面带上 token 就等于把「冒充房主」的钥匙发给所有人。
 *   对外只暴露 id / name / team / online / owner。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAVE_DEBOUNCE_MS = 2000;
const MAX_PLAYERS = 24;          // 单房间人数上限
const MAX_NAME = 20;
const MAX_ROOM_NAME = 24;
const OFFLINE_GRACE_MS = 60000;  // 断线保留 60s（刷新页面能回到原队伍）
const CODE_LEN = 6;
const CODE_TRIES = 200;          // 生成邀请码时的去重尝试次数

// 易混字符去掉：0/O、1/I/l —— 邀请码是要口头念 / 手输的
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/* ---------- 工具 ---------- */

function randId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function randToken() {
  return crypto.randomBytes(24).toString('hex');
}

// 邀请码：只从无歧义字符里取，长度 6（约 300 万种组合）
function randCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return s;
}

// 邀请码归一：大写、去掉用户可能顺手打的分隔符
function normCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, CODE_LEN);
}

function cleanName(raw, fallback) {
  let s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')   // 控制字符会破坏终端与 UI
    .trim()
    .slice(0, MAX_NAME);
  return s || fallback;
}

function cleanRoomName(raw, fallback) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_ROOM_NAME);
  return s || fallback;
}

/* ---------- 玩家 ---------- */

function makePlayer(name, isOwner) {
  return {
    id: randId('p_'),
    token: randToken(),
    name: cleanName(name, '玩家'),
    teamId: null,
    owner: !!isOwner,
    online: false,
    joinedAt: Date.now(),
    lastSeen: Date.now()
  };
}

// 对外可见的玩家信息。**不要加 token / lastSeen**。
function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    teamId: p.teamId || null,
    owner: !!p.owner,
    online: !!p.online
  };
}

/* ---------- 房间 ---------- */

class RoomMeta {
  constructor(code, opts) {
    this.opts = opts || {};
    this.dir = this.opts.dir || path.join(__dirname, '..', 'data');
    this.file = path.join(this.dir, 'rooms.json');

    this.code = code;
    this.name = '';
    this.ownerId = null;
    this.createdAt = Date.now();
    this.players = new Map();      // id -> player
    this.teams = [
      { id: 'red', name: '红方', color: '#b4453a' },
      { id: 'blue', name: '蓝方', color: '#3a7bd5' }
    ];
    this._timer = null;
  }

  /* ---- 序列化 ---- */

  toJSON() {
    return {
      code: this.code,
      name: this.name,
      ownerId: this.ownerId,
      createdAt: this.createdAt,
      teams: this.teams,
      // token 必须落盘（重连要用），但只在磁盘上，不进任何广播
      players: Array.from(this.players.values())
    };
  }

  static fromJSON(d, opts) {
    const r = new RoomMeta(d.code, opts);
    r.name = cleanRoomName(d.name, '');
    r.ownerId = d.ownerId || null;
    r.createdAt = d.createdAt || Date.now();
    if (Array.isArray(d.teams) && d.teams.length) r.teams = d.teams;

    (d.players || []).forEach((p) => {
      if (!p || !p.id) return;
      r.players.set(p.id, {
        id: p.id,
        token: p.token || randToken(),
        name: cleanName(p.name, '玩家'),
        teamId: p.teamId || null,
        owner: !!p.owner,
        // 进程重启后没人连着，一律先标离线；真的连上会置回 true
        online: false,
        joinedAt: p.joinedAt || Date.now(),
        lastSeen: p.lastSeen || Date.now()
      });
    });
    return r;
  }

  /* ---- 玩家 ---- */

  addPlayer(name) {
    if (this.players.size >= MAX_PLAYERS) return null;
    // 第一个进来的人是房主
    const isOwner = !this.ownerId;
    const p = makePlayer(name, isOwner);
    if (isOwner) this.ownerId = p.id;
    this.players.set(p.id, p);
    this.save();
    return p;
  }

  get(id) {
    return this.players.get(id) || null;
  }

  // 校验身份：id + token 都对才认。这是所有「需要权限」的操作的前提。
  auth(id, token) {
    const p = this.players.get(String(id || ''));
    if (!p) return null;
    if (!token || typeof token !== 'string') return null;
    // 定长比较，避免时序侧信道（本地小工具其实无所谓，但顺手写了）
    const a = Buffer.from(p.token);
    const b = Buffer.from(String(token));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return p;
  }

  isOwner(id) {
    return !!id && id === this.ownerId;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return false;
    this.players.delete(id);
    // 房主走了 -> 移交给最早加入的在线玩家（见 ownerOf）
    if (this.ownerId === id) this.ownerId = null;
    this.reassignOwner();
    this.save();
    return true;
  }

  /**
   * 房主移交：**最早加入的在线玩家**（joinedAt 最小），平手按 id 字典序。
   *
   * 为什么要按 id 兜底：同毫秒加入是可能的，不加这条两端会算出不同的
   * 房主，于是出现「两个人都以为自己是房主」的分裂。
   *
   * **只在「人真的被移出列表」时调用**（removePlayer / sweepOffline）。
   * 掉线本身**不移交** —— 否则房主刷新一下页面就会丢房主身份。
   * 断线有 60s 宽限期，人真走了才由 sweepOffline 移除并触发交接。
   */
  reassignOwner() {
    // 现任房主还在名册里就维持现状（哪怕他此刻是离线状态）
    if (this.ownerId && this.players.has(this.ownerId)) return this.ownerId;

    const list = Array.from(this.players.values())
      .filter((p) => p.online)
      .sort((a, b) => (a.joinedAt - b.joinedAt) || (a.id < b.id ? -1 : 1));

    if (!list.length) {
      // 没有在线的人了：房主位空着，房间留着，谁回来谁当。
      // 注意**不能**把 ownerId 指给一个离线玩家 —— 那会让
      // 「房主」这个身份挂在一个不在场的人身上，权限没人能行使、
      // 又挡住了后来者接手。
      this.ownerId = null;
      this.players.forEach((p) => { p.owner = false; });
      return null;
    }

    // 清掉旧标记，保证全局只有一个 owner 位
    this.players.forEach((p) => { p.owner = false; });
    list[0].owner = true;
    this.ownerId = list[0].id;
    return this.ownerId;
  }

  setTeam(id, teamId) {
    const p = this.players.get(id);
    if (!p) return false;
    if (teamId != null && !this.teams.some((t) => t.id === teamId)) return false;
    p.teamId = teamId || null;
    p.lastSeen = Date.now();
    this.save();
    return true;
  }

  setOnline(id, on) {
    const p = this.players.get(id);
    if (!p) return false;
    p.online = !!on;
    p.lastSeen = Date.now();
    if (on) {
      // 上线时补一次交接：房里可能只剩「离线房主 + 我」，
      // 这时该由我来接手（否则房主位被一个不在场的人占着）。
      if (this.ownerId && !this.players.has(this.ownerId)) this.reassignOwner();
    }
    // 掉线**不移交**：断线有 60s 宽限期，刷新页面不该丢房主。
    // 真正的交接发生在 sweepOffline 把人移出列表时。
    this.save();
    return true;
  }

  setName(id, name) {
    const p = this.players.get(id);
    if (!p) return false;
    p.name = cleanName(name, p.name);
    this.save();
    return true;
  }

  // 超过宽限期还没回来的，从列表里清掉
  sweepOffline(now) {
    const t = now || Date.now();
    let removed = 0;
    this.players.forEach((p) => {
      if (!p.online && t - p.lastSeen > OFFLINE_GRACE_MS) {
        this.players.delete(p.id);
        if (this.ownerId === p.id) this.ownerId = null;
        removed++;
      }
    });
    if (removed) { this.reassignOwner(); this.save(); }
    return removed;
  }

  publicState() {
    return {
      code: this.code,
      name: this.name,
      ownerId: this.ownerId,
      teams: this.teams,
      players: Array.from(this.players.values()).map(publicPlayer)
    };
  }

  /* ---- 落盘 ---- */

  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._store.flushNow();
    }, SAVE_DEBOUNCE_MS);
    if (this._timer.unref) this._timer.unref();
  }
}

/* ---------- 注册表 ---------- */

class RoomRegistry {
  constructor(opts) {
    this.opts = opts || {};
    this.dir = this.opts.dir || path.join(__dirname, '..', 'data');
    this.file = path.join(this.dir, 'rooms.json');
    this.byCode = new Map();       // code -> RoomMeta
    this._timer = null;
    this._writing = false;
    this._pending = false;
    this._load();
  }

  _load() {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      return;                    // 没有文件 = 全新部署，正常
    }
    const list = Array.isArray(d) ? d : (d && d.rooms) || [];
    list.forEach((raw) => {
      if (!raw || !raw.code) return;
      const r = RoomMeta.fromJSON(raw, this.opts);
      r._store = this;
      this.byCode.set(r.code, r);
    });
  }

  get(code) {
    return this.byCode.get(normCode(code)) || null;
  }

  has(code) {
    return this.byCode.has(normCode(code));
  }

  /**
   * 建房。邀请码是随机生成的，要查重。
   * 用尽尝试次数还没找到空位就报错 —— 而不是硬塞一个可能重复的。
   */
  create(opts) {
    const o = opts || {};
    let code = null;
    for (let i = 0; i < CODE_TRIES; i++) {
      const c = randCode();
      if (!this.byCode.has(c)) { code = c; break; }
    }
    if (!code) return null;

    const r = new RoomMeta(code, this.opts);
    r._store = this;
    r.name = cleanRoomName(o.name, '') || (cleanName(o.ownerName, '玩家') + ' 的房间');
    this.byCode.set(code, r);

    const owner = r.addPlayer(o.ownerName);
    if (!owner) { this.byCode.delete(code); return null; }

    this.flushNow();
    return { room: r, player: owner };
  }

  remove(code) {
    const c = normCode(code);
    if (!this.byCode.has(c)) return false;
    this.byCode.delete(c);
    this.flushNow();
    return true;
  }

  all() {
    return Array.from(this.byCode.values());
  }

  /* ---- 落盘：整张表一起写 ---- */

  flushNow() {
    const tmp = this.file + '.tmp';
    const body = JSON.stringify({
      v: 1,
      rooms: this.all().map((r) => r.toJSON())
    });

    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
    try {
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[rooms] 落盘失败', e.message);
    }
  }

  // 定期清掉超时的离线玩家
  startSweeper(intervalMs) {
    const t = setInterval(() => {
      let n = 0;
      this.byCode.forEach((r) => { n += r.sweepOffline(); });
      if (n) console.log(`[rooms] 清理离线玩家 ${n} 名`);
    }, intervalMs || 15000);
    if (t.unref) t.unref();
    return t;
  }
}

module.exports = {
  RoomRegistry, RoomMeta,
  normCode, cleanName, cleanRoomName, publicPlayer,
  MAX_PLAYERS, OFFLINE_GRACE_MS, CODE_LEN
};

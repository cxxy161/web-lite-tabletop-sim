/*
 * scene.js —— 场景（TTS 存档转换产物）的加载与索引
 *
 * 场景 JSON 由 tools/build_assets.py 生成，放在 public/scenes/ 下，
 * 通过静态服务直接发给浏览器（可缓存）。
 *
 * 这里只负责「读文件 + 缓存 + 选默认」，不做任何坐标换算 ——
 * 换算已经在构建期做完了，运行时不该再有第二份映射逻辑。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCENES_DIR = path.join(__dirname, '..', 'public', 'scenes');

class SceneStore {
  constructor(dir) {
    this.dir = dir || SCENES_DIR;
    this._catalog = null;
    this._cache = new Map();
  }

  list() {
    if (!this._catalog) {
      try {
        this._catalog = JSON.parse(
          fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')
        );
      } catch (_) {
        this._catalog = [];      // 没跑过资产管线就是空目录，不该崩
      }
    }
    return this._catalog;
  }

  has(slug) {
    return this.list().some((s) => s.slug === slug);
  }

  // 默认选棋子最多的那个（内容最完整）
  defaultSlug() {
    const l = this.list();
    if (!l.length) return null;
    return l.reduce((a, b) => (b.count > a.count ? b : a)).slug;
  }

  label(slug) {
    const s = this.list().find((x) => x.slug === slug);
    return s ? cleanLabel(s.label) : '';
  }

  load(slug) {
    if (this._cache.has(slug)) return this._cache.get(slug);
    const d = JSON.parse(
      fs.readFileSync(path.join(this.dir, slug + '.json'), 'utf8')
    );
    this._cache.set(slug, d);
    return d;
  }
}

module.exports = { SceneStore, SCENES_DIR };

// 去掉存档名开头/结尾的杂散符号（"-初设"、"初设1" 这类脏值）
function cleanLabel(s) {
  return String(s || '').replace(/^[-–—_\s]+/, '').trim().slice(0, 32);
}

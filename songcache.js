#!/usr/bin/env node
'use strict';
/**
 * songcache.js —— 歌曲「歌名|歌手 → rid」永久缓存（v1.7.11）。
 *
 * 用户 2026-11-14 拍板：「歌曲也和有声书一样走服务器 rid 缓存吧」。
 * 背景：R1 收藏 357 条里 322 条没绑源（rid/url 全空），device 单点播放
 * 五路全空直接 ERR「还没配上源」。此前 rid 只写回 device 本地 fav.json，
 * 换设备 / 重装就丢。现在统一挂服务端：
 *
 *   ① 永久性：搜到过的 rid 落盘 files/song_cache.json（原子写+防抖），
 *      重启 / 换设备都吃同一份 —— 与 ab_cache.json 同款精神。
 *   ② 按需：只有真点 / 真播某首（device play_fav_one / fav_resolve）才进来，
 *      **绝不批量预搜几百条收藏**（上游风控红线，同有声书）。
 *   ③ 负缓存：精确搜不到记 10 分钟窗口，反复点不反复空搜；
 *      窗口过后用户再点会重试（上游可能已补）。
 *   ④ key = normQ(title) + '|' + normQ(artist)：artist 为空也能存（纯歌名）。
 *
 * 搜索本身不在这层做 —— 由 server.js 的 /api/song/resolve 编排
 * （查缓存 → 未命中单次 lxSearchAll → 歌手闸筛选 → put / markFail）。
 */
const fs = require('fs');
const path = require('path');

const FILE = process.env.SONG_CACHE_FILE || path.join(__dirname, 'files', 'song_cache.json');
const DEFAULT_LIMIT = 5000;   // 缓存上限（用户可改，存进 json 的 limit 字段）
const SAVE_MS = 1500;         // 写盘防抖
const FAIL_WINDOW = 10 * 60 * 1000;   // 负缓存窗口：10 分钟

let data = null;
let timer = null;

const blank = () => ({ ver: 1, songs: {}, fail: {} });
const now = () => Date.now();

/** 查询词归一化（与 abookcache.normQ 同款思路，按歌名/歌手裁剪分隔集合） */
function normQ(q) {
  return String(q || '').toLowerCase()
    .replace(/[\s\u3000·|｜《》<>「」【】\[\]()（）,，.。_\-—:：'"！!？?]+/g, '');
}

/** 稳定键：normQ(title)|normQ(artist)。artist 可空。 */
function keyOf(title, artist) {
  return normQ(title) + '|' + normQ(artist);
}

function load() {
  if (data) return data;
  data = blank();
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && j.songs && typeof j.songs === 'object') {
      data = { ver: 1, songs: j.songs, fail: (j.fail && typeof j.fail === 'object') ? j.fail : {},
               limit: Number(j.limit) || DEFAULT_LIMIT };
    }
  } catch { /* 首次运行 / 文件损坏：从空开始 */ }
  return data;
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(load()));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.log('[songcache] 写缓存失败（不影响播放）: ' + e.message);
  }
}

function touch() {
  if (timer) return;
  timer = setTimeout(flush, SAVE_MS);
  if (timer.unref) timer.unref();
}

/** ★ v1.7.12：上限可自定义（存 json 的 limit 字段）。改小立刻淘汰超出的旧条目。 */
function getLimit() {
  return Number(load().limit) || DEFAULT_LIMIT;
}

function setLimit(n) {
  const v = Math.max(50, Math.min(50000, Math.round(Number(n) || DEFAULT_LIMIT)));
  load().limit = v;
  evict();
  touch();
  return v;
}

function evict() {
  const d = data;
  const lim = getLimit();
  const ks = Object.keys(d.songs);
  if (ks.length <= lim) return;
  // 「超出的按顺序删除旧的」：最久没播的先走（lastPlay 没有就看入库时间 at）
  ks.sort((a, b) => {
    const x = d.songs[a] || {}, y = d.songs[b] || {};
    return (x.lastPlay || x.at || 0) - (y.lastPlay || y.at || 0);
  });
  for (let i = 0; i < ks.length - lim; i++) delete d.songs[ks[i]];
}

/** 命中返回 {key,title,artist,source,rid,at,hits,...}（引用直读，调用方别改） */
function get(key) {
  if (!key) return null;
  const s = load().songs[key];
  return (s && s.rid) ? s : null;
}

/** 记一条解析结果（rid 必须非空；title/artist 存**搜索结果里的真名**）。 */
function put(entry) {
  if (!entry || !entry.rid) return null;
  const d = load();
  const key = entry.key || keyOf(entry.title, entry.artist);
  if (!normQ(key.split('|')[0])) return null;   // 没有歌名的条目不收
  const prev = d.songs[key];
  d.songs[key] = {
    key,
    title: String(entry.title || '').slice(0, 200),
    artist: String(entry.artist || '').slice(0, 200),
    source: String(entry.source || 'kw').slice(0, 16),
    rid: String(entry.rid).slice(0, 64),
    album: String(entry.album || '').slice(0, 200),
    kind: String(entry.kind || '').slice(0, 16),
    at: prev ? prev.at : now(),
    hits: prev ? (prev.hits || 0) : 0,
    lastPlay: prev ? prev.lastPlay : 0,
  };
  delete d.fail[key];          // 成功解析撤掉负缓存
  evict();
  touch();
  return d.songs[key];
}

/** 播过记一笔（LRU 与排障用，纯内存） */
function markPlay(key) {
  const s = get(key);
  if (!s) return;
  s.hits = (Number(s.hits) || 0) + 1;
  s.lastPlay = now();
}

/** 精确搜不到记负缓存（10 分钟窗口） */
function markFail(key) {
  if (!key) return;
  load().fail[key] = now();
  touch();
}

/** 窗口内落空过？ */
function recentFail(key) {
  if (!key) return false;
  const t = load().fail[key];
  return !!t && (now() - t) < FAIL_WINDOW;
}

/** ★ v1.7.12：分页列表（按入库时间倒序，新的在前）；q 过滤歌名/歌手/rid。 */
function list(page, size, q) {
  const d = load();
  let arr = Object.values(d.songs);
  const raw = String(q || '').trim();
  const nq = normQ(raw);
  if (nq) {
    arr = arr.filter(s =>
      normQ(s.title).indexOf(nq) >= 0
      || normQ(s.artist).indexOf(nq) >= 0
      || String(s.rid || '').indexOf(raw) >= 0);
  }
  arr.sort((a, b) => (b.at || 0) - (a.at || 0));
  const total = arr.length;
  const sz = Math.max(10, Math.min(200, Math.round(Number(size) || 50)));
  const pages = Math.max(1, Math.ceil(total / sz));
  const p = Math.min(Math.max(1, Math.round(Number(page) || 1)), pages);
  const start = (p - 1) * sz;
  return {
    ok: true, total, page: p, size: sz, pages, limit: getLimit(),
    items: arr.slice(start, start + sz).map(s => Object.assign({}, s)),
  };
}

/** ★ v1.7.12：批量删除（Web 管理页用）。keys 非法项忽略，返回实际删除数。 */
function del(keys) {
  const d = load();
  if (!Array.isArray(keys)) return 0;
  let n = 0;
  for (const k of keys) {
    const key = String(k || '');
    if (key && d.songs[key]) { delete d.songs[key]; n++; }
    if (key) delete d.fail[key];
  }
  if (n) touch();
  return n;
}

/** ★ v1.7.12：全部清空（连负缓存一起）。 */
function clearAll() {
  const d = load();
  const n = Object.keys(d.songs).length;
  d.songs = {};
  d.fail = {};
  touch();
  return n;
}

function stats() {
  const d = load();
  const songs = Object.values(d.songs);
  return {
    ver: 1,
    file: path.basename(FILE),
    shared: true,
    ttl: null,
    limit: getLimit(),
    songs: songs.length,
    failing: Object.keys(d.fail).length,
    episodes: songs.length,
    items: songs.slice(0, 20).map(s => ({
      key: s.key, title: s.title, artist: s.artist,
      source: s.source, rid: s.rid, hits: s.hits || 0,
    })),
  };
}

function _reset() {
  if (timer) { clearTimeout(timer); timer = null; }
  data = null;
}

module.exports = {
  FILE, DEFAULT_LIMIT, normQ, keyOf,
  load, flush, _reset, get, put, markPlay, markFail, recentFail,
  getLimit, setLimit, list, del, clearAll, stats,
};

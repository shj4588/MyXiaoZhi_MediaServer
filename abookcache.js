#!/usr/bin/env node
'use strict';
/**
 * abookcache.js —— 在线有声书「整本索引」永久缓存（v1.6.9）
 *
 * 设计目标（用户 2026-11-13 定稿）：
 *   ① **永久性**：albumId / source / rid / 集表这类元数据基本不变，不做 TTL、不自动过期。
 *      进程重启、容器升级、隔几天再听，都直接吃磁盘上的同一份，不再回源重搜。
 *   ② **变了才改**：回源后先算内容指纹 sig（集数 + ep + rid + source）；
 *      sig 没变 ⇒ 一个字节都不写、不 bump 版本；只有展示字段变了才轻更新；
 *      真的增删集 / 换 rid 才 rev++ 并记 changedAt。
 *   ③ **播不了才重搜**：只有取链失败累计到阈值、整本取链全空、或显式 fresh=1
 *      才会打 stale 标记并回源。一次网络抖动不会毁掉 2101 集的缓存。
 *   ④ **多设备共享**：缓存挂在服务端 files/ab_cache.json，与 devId 无关；
 *      所有设备（R1 / AlphaPi / 未来的设备）读的是同一份内存态 + 同一份文件。
 *      多设备同时 miss 用 once() 单飞，只回源一次，避免惊群把上游打限流。
 *
 * ⚠️ **不缓存直链**：url 是 resolveUrl() 现取的、会过期（CDN 鉴权 / 防盗链），
 *    落盘反而会变成「播不了」。这里只存 rid，播放时照旧走 /r/<source>/<rid> 或
 *    resolveUrl() 的 30 分钟内存缓存。lazyUrl() 生成的地址也是每次按 selfBase 现算。
 *
 * 数据结构（files/ab_cache.json）：
 *   { ver:1, books:{
 *       "<source>|<albumId>": {
 *         key, book, narrator, albumId, source,
 *         aliases:[归一化查询词],           // 「搜过」的书名别名，供下次 search 直接命中
 *         count, total, preview:[前3集标题],
 *         list:[{ep,title,rid,duration,source}],
 *         sig, dsig, rev, at, changedAt,    // 内容指纹 / 展示指纹 / 修订号
 *         stale, fails, bad:{ep:次数}, lastFail, lastFailReason,
 *         hits, lastHit, lastPlay, lastEp  // 命中与「播过」统计（仅用于 LRU 与排障）
 *       }}}
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.AB_CACHE_FILE || path.join(__dirname, 'files', 'ab_cache.json');
const MAX_BOOKS = 200;        // 容量保护：超了按 lastPlay/at 淘汰最久没听的（不是过期）
const MAX_EPS = 120000;       // 总集数上限，防止几十本 2000+ 集的书把文件撑爆
const SAVE_MS = 1500;         // 写盘防抖（和 history.json 一致）
const BAD_LIMIT = 3;          // 累计 3 次取链失败才判「播不了」
const BAD_EP_KINDS = 2;       // 或 2 个不同集都取不到链
const ALIAS_MAX = 8;
const GAP_FILL_MAX = 300;     // 相邻集号断档超过这个不补。v1.7.20 由 30 放宽：实测遮天
                              // 2640→2730 断掉 ~90 集（上游列表真缺），30 的旧上限把整段
                              // 藏成「静默跳号」，用户看不见也没法点着单点救援。放宽后
                              // 大断档照常生成占位行（可见 / 可点 / 按需救援，绝不批量回源）；
                              // 误救风险由 v1.7.20 跨书终审闸兜底。真·换季重编号（断档 >300）
                              // 仍不补。总量仍受 MAX_MISSING / MAX_EPS 双闸保护
const MAX_MISSING = 5000;     // 一本书最多补多少个缺集占位。实测：仙逆断档 1032、遮天 633
                              // —— 500 的旧上限直接把整本放弃补洞了（missing=0）；占位行
                              // 每条 ~100 字节，总量仍受 MAX_EPS=120000 总闸保护
const GAPV = 4;               // 缺集补洞算法版本：迁移完成才盖这个章。
                              // ⚠ 教训：v2 时代 MAX_MISSING 触顶「没补成也盖章」，
                              //   后来放宽上限迁移直接被 gv=2 跳过 —— 现在 truncated 不盖章

let data = null;              // 内存态（= 多设备共享的 L1）
let timer = null;
let ridIndex = null;          // source|rid → {key, ep}，供 /r/ 失败时反查是哪本书
const pending = new Map();    // 单飞：同一 key 的回源只跑一次

const blank = () => ({ ver: 1, books: {} });
const now = () => Date.now();

/** 查询词归一化：小写 + 去空白/分隔/书名号，用于别名命中 */
function normQ(q) {
  return String(q || '').toLowerCase()
    .replace(/[\s\u3000·|｜《》<>「」【】\[\]()（）,，.。_\-—:：'"]+/g, '');
}

/** 稳定键：source|albumId（albumId 缺失时退化为书名，保证同名不同源不串） */
function keyOf(source, albumId, book) {
  const s = String(source || 'kw').trim() || 'kw';
  const a = String(albumId || '').trim();
  return s + '|' + (a || String(book || '').trim() || '(未命名)');
}

function load() {
  if (data) return data;
  data = blank();
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && j.books && typeof j.books === 'object') data = { ver: 1, books: j.books };
  } catch { /* 首次运行 / 文件损坏：从空开始，不影响播放 */ }
  ridIndex = null;
  migrateGaps();
  migratePoison();
  return data;
}

/** v1.7.0 一次性迁移：升级前缓存的书没有缺集占位 —— 读进来补一遍并落盘。
 *  gv=补洞算法版本：v2 起 ep=0 条目不再阻断。旧记录（无 gv）与 gv<2 都重补，
 *  防止第一版「全本 ep>0 才补」漏掉的书永远缺占位。不动 sig/rev/changedAt
 *  （书目内容没变，只是展示补洞），1.5s 防抖写盘。 */
function migrateGaps() {
  const d = data;
  let n = 0;
  for (const rec of Object.values(d.books)) {
    if (Number(rec.gv) >= GAPV || !Array.isArray(rec.list) || !rec.list.length) continue;
    const g = fillGaps(rec.list);
    if (g.missing) {
      rec.list = g.list;
      rec.total = g.list.length;
      rec.count = g.list.length;
      rec.missing = g.missing;
      n++;
    }
    if (!g.truncated) rec.gv = GAPV;   // 被上限截断的不盖章，下次启动重试
  }
  if (n) { console.log('[abcache] 迁移：' + n + ' 本书补了缺集占位'); touch(); }
}

/** ★ v1.7.20 一次性清理跨书毒行：救援曾把「别的书的同号集」写进本书
 *  （实测：圣墟 3373/3374 进了遮天 —— albumId 不同、标题不沾书名，
 *  设备/Web 点了播的是别的书）。判定与 rescueEp 终审同口径：记档专辑与
 *  本书 albumId 都在且相等 → 保留（设备回传的兜底标题行靠这个豁免）；
 *  否则标题必须沾书名。毒记档 + 对应列表行（rescued 同号）一并删，
 *  total/count/missing 重算；不动 sig/rev/changedAt。每次启动都跑（幂等、极便宜）。 */
function migratePoison() {
  const d = data;
  let n = 0;
  for (const rec of Object.values(d.books)) {
    if (!rec || !Array.isArray(rec.list) || !rec.list.length) continue;
    if (!rec.rescued || typeof rec.rescued !== 'object') continue;
    const recAlb = String(rec.albumId || '');
    const bad = new Set();
    for (const [epK, c] of Object.entries(rec.rescued)) {
      const candAlb = String((c && c.albumId) || '');
      const same = !!(candAlb && recAlb && candAlb === recAlb);
      if (!same && !titleHitsBook(rec, c && c.title)) bad.add(Number(epK) || 0);
    }
    if (!bad.size) continue;
    for (const ep of bad) delete rec.rescued[String(ep)];
    const before = rec.list.length;
    rec.list = rec.list.filter(x => !(x && x.rescued && bad.has(Number(x.ep) || 0)));
    if (rec.list.length !== before) {
      rec.total = rec.list.length;
      rec.count = rec.list.length;
      rec.missing = rec.list.filter(x => !!x.missing || !String(x.rid || '').trim()).length;
      ridIndex = null;
      n += before - rec.list.length;
      console.log('[abcache] 迁移：清跨书毒行 ' + (before - rec.list.length)
        + ' 行（ep ' + Array.from(bad).join(',') + '）：' + (rec.book || ''));
    }
  }
  if (n) touch();
}

/** 原子写：tmp + rename，断电也不会留半截 JSON */
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(load()));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.log('[abcache] 写缓存失败（不影响播放）: ' + e.message);
  }
}

function touch() {
  if (timer) return;
  timer = setTimeout(flush, SAVE_MS);
  if (timer.unref) timer.unref();
}

function reindex() {
  const d = load();
  const m = new Map();
  for (const [k, b] of Object.entries(d.books)) {
    for (const e of (Array.isArray(b.list) ? b.list : [])) {
      const rid = String(e.rid || '');
      if (!rid) continue;
      m.set(String(e.source || b.source || 'kw') + '|' + rid, { key: k, ep: e.ep || 0 });
    }
  }
  ridIndex = m;
  return m;
}

/** 内容指纹：集数 + 每集 (ep,rid,source)。标题改文案不算「书目变了」 */
function sigOf(list) {
  const h = crypto.createHash('sha1');
  h.update(String(list.length) + '\x00');
  for (const e of list) {
    h.update(String(e.ep || 0) + '\x01' + String(e.rid || '') + '\x02'
      + String(e.source || '') + '\x03');
  }
  return h.digest('hex').slice(0, 16);
}

/** 展示指纹：标题 + 时长。只影响界面文字，不 bump rev */
function dsigOf(list) {
  const h = crypto.createHash('sha1');
  for (const e of list) h.update(String(e.title || '') + '\x01' + String(e.duration || '') + '\x02');
  return h.digest('hex').slice(0, 16);
}

/**
 * v1.7.0 缺集占位：集号连续处断档的（如 110 → 114）插入 {missing:true} 占位行。
 * 占位行 rid=''（没有音频可取），**落进缓存本体** ⇒ ab_cache.json 里就有这集，
 * R1 / AlphaPi / 网页共享同一份缓存，都能看到「这集上游没有」。
 *
 * 规则（v2，实测修正）：只看 ep>0 的条目找断档；个别集号没解析出来（ep=0，
 * 常见于番外/序章）**不阻断**补洞 —— 仙逆 2200 集里有 2 个 ep=0，第一版
 * 「全本 ep>0 才补」的规则被它们拦成 missing=0，实测翻车后改成：
 * 占位行插在原顺序中「集号 = 断档起点」那一条的后面（不重排整表，
 * ep=0 条目留在原位）。断档 > GAP_FILL_MAX 集不补（多半是换季重编号）。
 */
function fillGaps(list) {
  const rows = Array.isArray(list) ? list : [];
  const fail = { list: rows, missing: 0, truncated: false };
  if (!rows.length || rows.length > MAX_EPS) return fail;
  const pos = rows.filter(e => Number(e.ep) > 0).sort((a, b) => a.ep - b.ep);
  if (pos.length < 2) return fail;
  const have = new Set(pos.map(e => e.ep));
  const after = new Map();          // 断档起点 ep → 要补的 ep 数组
  let total = 0;
  for (let i = 1; i < pos.length; i++) {
    const a = pos[i - 1].ep, b = pos[i].ep;
    if (b - a > 1 && b - a <= GAP_FILL_MAX) {
      const arr = [];
      for (let e = a + 1; e < b; e++) if (!have.has(e)) arr.push(e);
      if (!arr.length) continue;
      total += arr.length;
      if (total > MAX_MISSING) return { list: rows, missing: 0, truncated: true };  // 坏数据保护
      after.set(a, (after.get(a) || []).concat(arr));
    }
  }
  if (!after.size) return fail;
  const out = [];
  const placed = new Set();         // 同一断档在原表出现多次时只补一次
  let n = 0;
  for (const e of rows) {
    out.push(e);
    const gaps = after.get(Number(e.ep));
    if (gaps) {
      for (const ep of gaps) {
        if (placed.has(ep) || have.has(ep)) continue;
        placed.add(ep);
        out.push({ ep, title: '（缺集 · 上游没有第 ' + ep + ' 集）', rid: '', duration: '', source: '', missing: true });
        n++;
      }
    }
  }
  return { list: out, missing: n, truncated: false };
}

/** ★ v1.7.0 跨专辑救回：把 rec.rescued 里的救援行铺回集表。
 *  - 占位行（missing）→ 换成救援行（上游当初漏抓、但换词搜得到的那集）；
 *  - 上游自己有了真集 → 丢弃救援行（真集永远优先）；
 *  - 上游列表里根本没有该集号（截断没补到占位）→ 追加救援行。
 *  返回 { list, applied, dropped }。 */
const epCmp = (a, b) => (Number(a.ep) > 0 ? a.ep : 1e9) - (Number(b.ep) > 0 ? b.ep : 1e9)
  || String(a.title).localeCompare(String(b.title), 'zh-Hans-CN', { numeric: true });

function applyRescued(rescued, list) {
  const m = (rescued && typeof rescued === 'object') ? rescued : null;
  if (!m) return { list: list.slice(), applied: 0, dropped: 0 };   // ★ v1.7.19 恒新数组（下游补回不动上游原表）
  let applied = 0, dropped = 0;
  const out = [];
  for (const x of list) {
    const r = (Number(x.ep) > 0) ? m[Number(x.ep)] : null;
    if (!r) { out.push(x); continue; }
    // ★ v1.7.10：同 rescueEp 口径 —— 历史脏占位行（rid:'' 但没打 missing）也要能接受救援记档，
    //   否则 putFull 刷新后救援结果被当成「上游真集」丢弃，救回的集又变回缺集。
    const xMiss = !!x.missing || !String(x.rid || '').trim();
    if (!xMiss) { dropped++; out.push(x); continue; }   // 上游真集优先：真集保留、救援行退场
    out.push(Object.assign({}, r));
    applied++;
  }
  const have = new Set(out.map(x => Number(x.ep) || 0));
  let added = 0;
  for (const [epS, r] of Object.entries(m)) {
    const epN = Number(epS) || 0;
    if (epN && !have.has(epN)) { out.push(Object.assign({}, r)); added++; }
  }
  if (added) out.sort(epCmp);
  return { list: out, applied: applied + added, dropped };
}

/** ★ v1.7.20 标题是否沾书名（跨书救援终审用）：书名 / 剥段短名 / 别名任一命中即算。
 *  匹配是双向包含（标题可能只写短名，书名可能带「丨多人剧丨…」长段）。
 *  空书名 / 空标题一律不算命中（无法判断就从严）。 */
function titleHitsBook(rec, title) {
  const t = String(title || '').replace(/\s+/g, '');
  if (!t) return false;
  const names = [];
  const push = (s) => { const v = String(s || '').replace(/\s+/g, ''); if (v) names.push(v); };
  push(rec.book);
  const seg = (s) => String(s || '').split(/[|｜+＋·]/)[0].trim();
  const b0 = seg(rec.book);
  if (b0 && b0 !== String(rec.book || '').trim()) push(b0);
  for (const a of (rec.aliases || [])) { push(a); const ah = seg(a); if (ah && ah !== a.trim()) push(ah); }
  for (const n of names) {
    if (t.indexOf(n) >= 0 || n.indexOf(t) >= 0) return true;
    const nh = seg(n);
    if (nh && nh.length >= 2 && (t.indexOf(nh) >= 0 || nh.indexOf(t) >= 0)) return true;
  }
  return false;
}

/** ★ v1.7.0 救回一集：把回源搜到的真集写进 rec —— 占位行原地替换、missing 重算、
 *  rec.rescued[ep] 记档（putFull 刷新时经 applyRescued 自动铺回，救援不会因刷新丢失）。
 *  不 bump rev：书目主体没变，只是把当初漏抓的集找回来了。 */
function rescueEp(source, albumId, book, ep, entry) {
  const rec = getFull(source, albumId, book, book || '');
  if (!rec || !Array.isArray(rec.list) || !rec.list.length) return { ok: false, error: '书不在缓存里' };
  const epN = Number(ep) || 0;
  if (!epN) return { ok: false, error: '集号无效' };
  const e = {
    ep: epN,
    title: String(entry.title || ''),
    rid: String(entry.rid || ''),
    duration: String(entry.duration || ''),
    source: String(entry.source || rec.source || 'kw'),
    albumId: String(entry.albumId || ''),
    rescued: true,               // UI 据此显示「补」角标（同专辑补回也标，便于辨识）
  };
  if (!e.rid) return { ok: false, error: '候选没有 rid，不能救' };
  // ★ v1.7.20 跨书终审：候选专辑对不上且标题不沾书名 → 拒绝。
  //  （实测翻车：设备点播遮天「第3373集」，精确词搜索把**圣墟**的同号集救了进来
  //    —— 集号对上就放行，用户点这两集播的是另一部书。albumId 双方都有且相等
  //    → 直接信任（设备回传同专辑行标题可以是兜底文案）；否则标题必须沾书名，
  //    跨专辑同名书的合法救援不受影响（标题都带着书名）。）
  const candAlb = String(e.albumId || '');
  const recAlb = String(rec.albumId || '');
  const albTrusted = !!(candAlb && recAlb && candAlb === recAlb);
  if (!albTrusted && !titleHitsBook(rec, e.title)) {
    return { ok: false, error: '候选是别的书（专辑不符且标题不沾书名），拒绝救援' };
  }
  // ★ 先校验目标行确实是占位，再写记档 —— 否则被拒绝的救援也会污染 rec.rescued
  //  （实测翻车：对非占位行的救援返回失败，但记档已被覆盖成坏 rid，刷新后把真集顶掉）。
  const cur = rec.list.find(x => (Number(x.ep) || 0) === epN);
  // ★ v1.7.10：v1.6.x 遗留占位行只有「（缺集 · 上游没有第 N 集）」文案 + rid:''，
  //   **没有 missing 字段**。只认 cur.missing 会把 server.js 好不容易触发的救援在这里
  //   二次拒掉（实测：点了还是灰的）。与 server.js 同口径：无 rid 即缺集。
  const curMiss = !!cur && (!!cur.missing || !String(cur.rid || '').trim());
  if (cur && !curMiss) return { ok: false, error: '这集上游本来就有，无需救援' };
  if (!rec.rescued || typeof rec.rescued !== 'object') rec.rescued = {};
  rec.rescued[epN] = { ep: e.ep, title: e.title, rid: e.rid, duration: e.duration,
                       source: e.source, albumId: e.albumId, rescued: true };
  const list = rec.list.slice();
  let patched = false;
  for (let i = 0; i < list.length; i++) {
    if ((Number(list[i].ep) || 0) === epN) {
      list[i] = e;
      patched = true;
      break;
    }
  }
  if (!patched) list.push(e);    // 没有占位行（截断场景）就追加
  list.sort(epCmp);
  rec.list = list;
  rec.total = list.length;
  rec.count = list.length;
  // ★ v1.7.10：与救援判定同口径重算剩余缺集数（历史脏行没打 missing 也要算进去）。
  rec.missing = list.filter(x => !!x.missing || !String(x.rid || '').trim()).length;
  rec.at = rec.at || now();
  ridIndex = null;
  touch();
  return { ok: true, rec, entry: e };
}

/** v1.7.7 只读反查：rid 属于哪本书哪一集（/r/ 播放记录落 history、回传补真标题用）。
 *  不写任何状态；返回 {key, book, ep, narrator, albumId, title, rescued} 或 null。 */
function bookByRid(source, rid) {
  if (!rid) return null;
  if (!ridIndex) reindex();
  const s = String(source || 'kw');
  const f = ridIndex.get(s + '|' + rid) || ridIndex.get('kw|' + rid);
  if (!f) return null;
  const rec = load().books[f.key];
  if (!rec) return null;
  const e = (rec.list || []).find(x => (Number(x.ep) || 0) === f.ep);
  return { key: f.key, book: rec.book || '', ep: f.ep,
           narrator: rec.narrator || '', albumId: rec.albumId || '',
           title: String((e && e.title) || ''), rescued: !!(e && e.rescued) };
}

/** v1.7.7 补齐回传条目的真标题/时长/专辑：设备救援回传时若 siGet 没有暂存，
 *  先落「第 N 集（设备救援回传）」兜底标题；这里事后用精确词搜索按 rid 对上号
 *  的结果补齐。只认兜底标题的条目 —— 真名落定后不可再被覆盖。 */
function patchRescueMeta(src, rid, epN, info) {
  if (!rid || !(Number(epN) > 0) || !info || !String(info.title || '').trim()) return null;
  const epN2 = Number(epN);
  for (const r of Object.values(load().books)) {
    const e = (r.list || []).find(x => (Number(x.ep) || 0) === epN2);
    if (!e || String(e.rid) !== String(rid)) continue;
    if (!/（设备救援回传）$/.test(String(e.title || ''))) return null;  // 已是真名
    e.title = String(info.title).trim();
    if (info.duration) e.duration = String(info.duration);
    if (info.album) e.album = String(info.album);
    if (info.albumId && !e.albumId) e.albumId = String(info.albumId);
    const rr = r.rescued && r.rescued[epN2];
    if (rr) {
      rr.title = e.title;
      if (info.duration) rr.duration = e.duration;
      if (info.album) rr.album = String(info.album);
    }
    touch();
    return { ok: true, key: r.key, ep: epN2 };
  }
  return null;
}

function addAlias(rec, nq) {
  if (!nq) return;
  if (!Array.isArray(rec.aliases)) rec.aliases = [];
  if (rec.aliases.indexOf(nq) < 0) rec.aliases.unshift(nq);
  if (rec.aliases.length > ALIAS_MAX) rec.aliases.length = ALIAS_MAX;
}

/** ★ v1.7.6 设备救援回传：R1 点缺集时会自己搜到 rid 直接 /r/ 播放（title 还带着
 *  占位文案「（缺集 · 上游没有第 N 集）」）—— 把这个结果学回缓存，所有设备 / Web
 *  下次拉集表就是真集，不用每台设备各自重新搜一遍。
 *  选书规则：该集号在书里确实是占位 + 主播吻合 + 设备搜到的 albumId 与书相同
 *  （score 权重：albumId 吻合 +4 > 主播吻合 +2 > 同源 +1），挑最高分的那本。
 *  info 是设备救援搜索时服务端 siPut 暂存的原始结果（真标题/专辑），尽量带上。
 *  返回 {ok, key, book, ep} 或 null（没有占位可填就不动）。 */
function rescueFromPlay(src, rid, epN, artist, info) {
  if (!rid || !(Number(epN) > 0)) return null;
  const epN2 = Number(epN);
  let best = null, bestScore = -1;
  for (const r of Object.values(load().books)) {
    const e = (r.list || []).find(x => (Number(x.ep) || 0) === epN2);
    if (!e || !e.missing) continue;                    // 没占位不碰（真集不顶掉）
    let sc = 1;
    const na = String(r.narrator || ''), aa = String(artist || '');
    if (aa && na && (na.indexOf(aa) >= 0 || aa.indexOf(na) >= 0)) sc += 2;
    const ia = String((info && info.albumId) || '');
    if (ia && String(r.albumId || '') === ia) sc += 4; // 设备搜到的就是这本书的专辑
    if (String(r.source || 'kw') === String(src || 'kw')) sc += 1;
    if (sc > bestScore) { bestScore = sc; best = r; }
  }
  if (!best) return null;
  const entry = {
    ep: epN2,
    // 兜底标题带书名（裸「第 N 集」在别本书里会重名）——真名等 siGet 暂存或事后精确词补
    title: String((info && info.title) || (best.book + ' 第 ' + epN2 + ' 集（设备救援回传）')),
    rid: String(rid),
    duration: String((info && info.duration) || ''),
    source: String(src || best.source || 'kw'),
    albumId: String((info && info.albumId) || best.albumId || ''),
    album: String((info && info.album) || ''),
  };
  const rr = rescueEp(best.source, best.albumId, best.book, epN2, entry);
  if (rr && rr.ok) return { ok: true, key: best.key, book: best.book, ep: epN2 };
  return null;
}

/** 容量保护：按「最近播过 / 最近整理」淘汰，绝不因为时间久就淘汰 */
function evict() {
  const d = load();
  const keys = Object.keys(d.books);
  let n = keys.length;
  let total = keys.reduce((s, k) => s + ((d.books[k].list || []).length), 0);
  if (n <= MAX_BOOKS && total <= MAX_EPS) return 0;
  const order = keys.slice().sort((a, b) =>
    ((d.books[a].lastPlay || d.books[a].at || 0) - (d.books[b].lastPlay || d.books[b].at || 0)));
  let cut = 0;
  for (const k of order) {
    if (n <= MAX_BOOKS && total <= MAX_EPS) break;
    total -= (d.books[k].list || []).length;
    delete d.books[k];
    n--; cut++;
  }
  if (cut) ridIndex = null;
  return cut;
}

function ensure(key, seed) {
  const d = load();
  let rec = d.books[key];
  if (!rec) {
    rec = d.books[key] = Object.assign({
      key, aliases: [], hits: 0, rev: 0, at: now(), list: [],
    }, seed || {});
  }
  return rec;
}

/**
 * ① 「搜过」：把 /api/ab/search 按本汇总的轻量结果写进缓存。
 *    只补摘要（书名/主播/albumId/source/集数/预览/别名），**不动已有整本集表**。
 *    空结果不写（上游偶发限流，别把抖动固化成永久「查不到」）。
 */
function putSearch(q, src, books) {
  const list = Array.isArray(books) ? books : [];
  if (!list.length) return 0;
  const d = load();
  const nq = normQ(q);
  let n = 0;
  for (const b of list) {
    const k = keyOf(b.source || src, b.albumId, b.book);
    const rec = ensure(k);
    rec.book = String(b.book || rec.book || '');
    rec.narrator = String(b.narrator || rec.narrator || '');
    rec.albumId = String(b.albumId || rec.albumId || '');
    rec.source = String(b.source || src || 'kw');
    if (Number(b.count) > 0) rec.count = Number(b.count);
    rec.preview = Array.isArray(b.preview) && b.preview.length
      ? b.preview.slice(0, 3) : (rec.preview || []);
    addAlias(rec, nq);
    n++;
  }
  if (n) { evict(); touch(); }
  return n;
}

/**
 * ② 「整理过」：整本集表落盘。**变了才改** ——
 *    sig 相同 ⇒ 不写盘、不 bump rev、不重置时间；
 *    dsig 不同 ⇒ 只更新展示字段；
 *    sig 不同 ⇒ rev++、changedAt、清 stale/失败计数。
 */
function putFull(full) {
  if (!full || !Array.isArray(full.list) || !full.list.length) return null;
  const plain = full.list.map(e => ({
    ep: Number(e.ep) || 0,
    title: String(e.title || ''),
    rid: String(e.rid || ''),
    duration: String(e.duration || ''),
    source: String(e.source || full.source || 'kw'),
  }));
  // 缺集补洞：占位行在 sig/dsig 之前插入 —— 上游同样的断档刷新后 sig 不变，不会误判「书目变了」
  const gapped = fillGaps(plain);
  const k = keyOf(full.source, full.albumId, full.book);
  const rec = ensure(k);
  // ★ v1.7.1 防降级（实测翻车）：上游对重复查询会吐**截断缓存**（2101→2000→200），
  //   整本重搜这次没吐全时，旧表里本来是真的集在新表里成了占位行 —— 直接替换
  //   rec.list 就把好集降级成「缺」。合并规则：新表占位行的集号若在旧表里有真集
  //   （非 missing、有 rid）→ 旧真集优先补回去；上游真集 / 救援行照旧优先。
  const oldList = Array.isArray(rec.list) ? rec.list : null;
  if (oldList && oldList.length) {
    const oldReal = new Map();
    for (const o of oldList) {
      const oe = Number(o.ep) || 0;
      if (oe > 0 && !o.missing && o.rid && !oldReal.has(oe)) oldReal.set(oe, o);
    }
    if (oldReal.size) {
      for (let i = 0; i < gapped.list.length; i++) {
        const x = gapped.list[i];
        if (!x.missing) continue;
        const o = oldReal.get(Number(x.ep) || 0);
        if (o) gapped.list[i] = Object.assign({}, o, { ep: Number(x.ep) || o.ep });
      }
    }
  }
  // ★ 救回的集重新铺回去（上游自己补了真集就丢弃）；sig/dsig 按「上游原样+占位」算，
  //   救援行不参与指纹 —— 上游重取的比对依旧稳定，救援也不会因刷新丢失。
  const overlaid = applyRescued(rec.rescued, gapped.list);
  const list = overlaid.list;
  // ★ v1.7.19 防降级补全（占位行保护管不到的场景）：上游截断连「集号」都不吐时，
  //   旧真集在新表里**整行缺席** —— v1.7.1 只保护「新表里存在的占位行」，缺席的真集
  //   会被 rec.list 整表替换丢掉。有声书专辑只增不删，旧表真集在新表没有对应行
  //   ⇒ 视为上游残缺，原样补回；新表真集永远优先（有行就不动）。与救援行一样
  //   不参与 sig/dsig 指纹（补回发生在指纹计算之后，刷新比对依旧稳定）。
  if (oldList && oldList.length) {
    const newEps = new Set(list.map(x => Number(x.ep) || 0).filter(e => e > 0));
    const back = [];
    for (const o of oldList) {
      const oe = Number(o.ep) || 0;
      if (oe > 0 && !o.missing && String(o.rid || '').trim() && !newEps.has(oe)) back.push(o);
    }
    if (back.length) {
      for (const o of back) list.push(Object.assign({}, o));
      list.sort(epCmp);
      console.log('[abcache] 防降级补回 ' + back.length + ' 集（上游重拉残缺，旧真集恢复）：'
        + (full.book || rec.book || ''));
    }
  }
  const sig = sigOf(gapped.list);
  const dsig = dsigOf(gapped.list);
  const wasStale = !!rec.stale;
  const changed = rec.sig !== sig;
  const prevTotal = Number(rec.total || 0) || 0;

  rec.book = String(full.book || rec.book || '');
  rec.narrator = String(full.narrator || rec.narrator || '');
  rec.albumId = String(full.albumId || rec.albumId || '');
  rec.source = String(full.source || 'kw');
  addAlias(rec, normQ(full.q));
  addAlias(rec, normQ(rec.book));

  if (!changed && rec.dsig === dsig) {
    // 完全没变：只把「待重搜」标记撤掉（回源成功即算修好），其余一个字节不动
    if (wasStale) { rec.stale = false; rec.fails = 0; rec.bad = {}; touch(); }
    return { rec, changed: false, unchanged: true };
  }

  rec.list = list;
  rec.total = list.length;
  rec.count = list.length;
  // ★ v1.7.10：与救援判定同口径 —— 历史脏占位行（无 missing 但 rid:''）也要计入缺集数
  rec.missing = list.filter(x => !!x.missing || !String(x.rid || '').trim()).length;   // 叠加救援后剩余的占位数
  rec.gv = gapped.truncated ? (Number(rec.gv) || 0) : GAPV;  // 补洞被上限截断时不盖章，迁移会重试
  rec.preview = list.slice(0, 3).map(e => e.title);
  rec.dsig = dsig;
  rec.stale = false;
  rec.fails = 0;
  rec.bad = {};
  if (changed) {
    if (prevTotal) rec.prevTotal = prevTotal;
    rec.sig = sig;
    rec.rev = (Number(rec.rev) || 0) + 1;
    rec.changedAt = now();
  }
  rec.at = rec.at || now();
  ridIndex = null;
  evict();
  touch();
  return { rec, changed, unchanged: false, rev: rec.rev };
}

/** ③ 「搜过」的命中：按别名 / 书名找书，返回记录数组（按匹配度、命中数、最近播放排序） */
function search(q) {
  const nq = normQ(q);
  if (nq.length < 2) return [];
  const d = load();
  const out = [];
  // ★ v1.7.20 别名部分匹配加长度比闸门（两边短的那侧 / 长的那侧 ≥ 0.6 才算命中）。
  //  实测翻车：琅琊榜的缓存别名「光合积木」（此前搜主播留下的）把「凡人修仙传 光合积木」
  //  整个查询部分吸走 —— cache-only 应答直接返回一本不相干的书，真搜永远不回源。
  //  短别名（主播名等）只配精确命中（score 3）或短查询（如搜「遮天有声」走 score 2 书名）。
  const ratio = (a, b) => Math.min(a.length, b.length) / Math.max(a.length, b.length);
  for (const rec of Object.values(d.books)) {
    const al = Array.isArray(rec.aliases) ? rec.aliases : [];
    const bn = normQ(rec.book);
    let score = 0;
    if (al.indexOf(nq) >= 0) score = 3;
    else if (bn && (bn.indexOf(nq) >= 0 || nq.indexOf(bn) >= 0)) score = 2;
    else if (al.some(a => a && a.length >= 2 && ratio(a, nq) >= 0.6
        && (a.indexOf(nq) >= 0 || nq.indexOf(a) >= 0))) score = 1;
    if (!score) continue;
    out.push({ rec, score });
  }
  out.sort((a, b) => (b.score - a.score)
    || ((b.rec.hits || 0) - (a.rec.hits || 0))
    || ((b.rec.lastPlay || b.rec.at || 0) - (a.rec.lastPlay || a.rec.at || 0)));
  return out.map(x => x.rec);
}

/** 摘要视图（与 /api/ab/search 的 books[] 契约一致，附带缓存诊断字段） */
function asBook(rec) {
  const list = Array.isArray(rec.list) ? rec.list : [];
  return {
    book: rec.book || '', narrator: rec.narrator || '',
    albumId: rec.albumId || '', source: rec.source || 'kw',
    count: list.length || Number(rec.total || rec.count || 0) || 0,
    missing: rec.missing || 0,
    preview: (Array.isArray(rec.preview) && rec.preview.length)
      ? rec.preview.slice(0, 3) : list.slice(0, 3).map(e => e.title),
    cached: true, rev: rec.rev || 0, stale: !!rec.stale,
  };
}

/** 按 albumId 找（忽略 source）：不同设备可能传 kw / all，但同一 albumId 就是同一本书 */
function findByAlbum(albumId) {
  if (!albumId) return null;
  const a = String(albumId);
  return Object.values(load().books).find(r => String(r.albumId || '') === a) || null;
}

/** ④ 取整本：albumId 精确命中优先，否则退回查询词模糊匹配。stale 的也返回，由调用方决定回源 */
function getFull(source, albumId, book, q) {
  const d = load();
  let rec = albumId ? (d.books[keyOf(source, albumId, book)] || findByAlbum(albumId)) : null;
  if (!rec || !Array.isArray(rec.list) || !rec.list.length) {
    rec = search(q || book || albumId || '').find(r => Array.isArray(r.list) && r.list.length) || null;
  }
  return rec;
}

/** 集表视图（与 /api/ab/episodes 内部 full 的契约一致；url 由调用方现算，不落盘） */
function asFull(rec) {
  return {
    key: rec.key, book: rec.book || '', narrator: rec.narrator || '',
    albumId: rec.albumId || '', source: rec.source || 'kw',
    total: rec.list.length, list: rec.list,
    missing: rec.missing || 0,
    rev: rec.rev || 0,
  };
}

function hit(key) {
  const rec = load().books[key];
  if (!rec) return;
  rec.hits = (Number(rec.hits) || 0) + 1;
  rec.lastHit = now();
  // 命中数只是排障统计，纯内存累加即可 —— 不为了它每 1.5s 刷一次盘。
  // 真正需要持久化的变更（整理 / 失效 / 播放标记）各自会 touch()。
}

/** ⑤ 「播过」：/r/<source>/<rid> 取链成功时记一笔，供 LRU 与排障 */
function markRidPlay(source, rid) {
  if (!rid) return null;
  if (!ridIndex) reindex();
  const s = String(source || 'kw');
  const f = ridIndex.get(s + '|' + rid) || ridIndex.get('kw|' + rid);
  if (!f) return null;
  const rec = load().books[f.key];
  if (!rec) return null;
  const write = now() - (Number(rec.lastPlay) || 0) > 60000;
  rec.lastPlay = now();
  rec.lastEp = f.ep;
  if (write) touch();          // 每本书最多 60s 落一次「播过」，避免连播刷盘
  return { key: f.key, ep: f.ep };
}

/** 直接按书名/专辑标记播过（apBookItems 拿到直链后不走 /r/，用它） */
function markBookPlay(source, albumId, book, ep) {
  const rec = load().books[keyOf(source, albumId, book)] || findByAlbum(albumId);
  if (!rec) return null;
  const write = now() - (Number(rec.lastPlay) || 0) > 60000;
  rec.lastPlay = now();
  if (ep) rec.lastEp = ep;
  if (write) touch();
  return { key: rec.key, ep: ep || 0 };
}

/** ⑥ 「播不了」：单集取链失败。累计到阈值才把整本标 stale，避免一次抖动毁掉全书缓存 */
function badEp(source, rid, reason) {
  if (!rid) return null;
  if (!ridIndex) reindex();
  const s = String(source || 'kw');
  const f = ridIndex.get(s + '|' + rid) || ridIndex.get('kw|' + rid);
  if (!f) return null;
  const rec = load().books[f.key];
  if (!rec) return null;
  rec.bad = rec.bad || {};
  const ep = String(f.ep || 0);
  rec.bad[ep] = (Number(rec.bad[ep]) || 0) + 1;
  rec.fails = (Number(rec.fails) || 0) + 1;
  rec.lastFail = now();
  rec.lastFailReason = String(reason || '').slice(0, 120);
  const kinds = Object.keys(rec.bad).length;
  if (rec.fails >= BAD_LIMIT || kinds >= BAD_EP_KINDS) rec.stale = true;
  touch();
  return { key: rec.key, ep: f.ep, fails: rec.fails, stale: !!rec.stale };
}

/** 整本取链全空 ⇒ 强信号，立即标 stale（apBookItems 在线书分支） */
function failBook(source, albumId, book, reason) {
  const rec = load().books[keyOf(source, albumId, book)] || findByAlbum(albumId);
  if (!rec) return null;
  rec.fails = (Number(rec.fails) || 0) + 1;
  rec.stale = true;
  rec.lastFail = now();
  rec.lastFailReason = String(reason || '').slice(0, 120);
  touch();
  return { key: rec.key, stale: true, fails: rec.fails };
}

/** 显式刷新前的标记（fresh=1 也走这里，refresh 成功后 putFull 会清掉） */
function markRefresh(key, reason) {
  const rec = load().books[key] || findByAlbum(key);
  if (!rec) return;
  rec.stale = true;
  rec.lastFail = now();
  rec.lastFailReason = String(reason || 'fresh').slice(0, 120);
  touch();
}

/**
 * ⑦ 单飞：多设备同时请求同一本 miss 的书，只让第一个真回源，其余共享同一个 Promise。
 *    Node 单进程内 data 是单例，所以刷新结果对所有设备立即可见。
 */
function once(key, fn) {
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    try { return await fn(); }
    finally { pending.delete(key); }
  })();
  pending.set(key, p);
  return p;
}

function clear(key) {
  if (key) {
    const d = load();
    const had = !!d.books[key];
    delete d.books[key];
    ridIndex = null;
    flush();
    return { ok: true, cleared: had ? 1 : 0 };
  }
  const n = Object.keys(load().books).length;
  data = blank();
  ridIndex = null;
  flush();
  return { ok: true, cleared: n };
}

/** v1.7.0：按 key 直读整本（**纯缓存，绝不回源**）—— Web 书架点开书目用。
 *  书架是「看缓存了什么」的只读视图，打开 2000+ 集的书也不该惊动上游；
 *  真要重搜走 /api/ab/episodes（那边带 stale 判断与单飞）。 */
function byKey(key) {
  const rec = load().books[String(key || '')];
  return (rec && Array.isArray(rec.list) && rec.list.length) ? asFull(rec) : null;
}

/** ★ v1.7.25 按书名精确命中（normQ 归一化后全等，不走别名模糊匹配）：
 *   给 /ap/play 的「书名撞歌名」兜底用 —— 小智 LLM 有时把「继续播放凡人修仙传」
 *   路由成 play_song（曲库点歌），曲库上游能搜出一堆同名同人歌，书永远续不上。
 *   q 在书架里精确命中 ⇒ 它其实是一本已缓存的书，服务端直接转 book 续播。 */
function byTitle(q) {
  const n = normQ(q);
  if (!n) return null;
  const rec = Object.values(load().books)
    .find(r => normQ(r.book) === n && Array.isArray(r.list) && r.list.length);
  return rec ? asBook(rec) : null;
}

function stats() {
  const rs = Object.values(load().books);
  return {
    ver: 1,
    file: path.basename(FILE),
    shared: true,
    ttl: null,                       // 永久缓存，无过期时间
    books: rs.length,
    indexed: rs.filter(r => Array.isArray(r.list) && r.list.length).length,
    episodes: rs.reduce((n, r) => n + ((r.list || []).length), 0),
    stale: rs.filter(r => r.stale).length,
    revs: rs.reduce((n, r) => n + (Number(r.rev) || 0), 0),
    hits: rs.reduce((n, r) => n + (Number(r.hits) || 0), 0),
    items: rs.map(r => ({
      key: r.key, book: r.book || '', narrator: r.narrator || '',
      albumId: r.albumId || '', source: r.source || 'kw',
      total: (r.list || []).length,
      missing: r.missing || 0,
      preview: (Array.isArray(r.preview) && r.preview.length)
        ? r.preview.slice(0, 3) : (r.list || []).slice(0, 3).map(e => e.title),
      rev: r.rev || 0, hits: r.hits || 0,
      stale: !!r.stale, fails: r.fails || 0,
      at: r.at || 0, changedAt: r.changedAt || 0, lastPlay: r.lastPlay || 0,
      lastEp: r.lastEp || 0,
    })),
  };
}

/** 测试用：丢掉内存态，强制下次从磁盘重读（模拟容器重启 / 多实例共享卷） */
function _reset() {
  if (timer) { clearTimeout(timer); timer = null; }
  data = null;
  ridIndex = null;
  pending.clear();
}

module.exports = {
  FILE, MAX_BOOKS, MAX_EPS, BAD_LIMIT, BAD_EP_KINDS, GAP_FILL_MAX,
  normQ, keyOf, sigOf, dsigOf, fillGaps,
  load, flush, _reset, once, findByAlbum,
  putSearch, putFull, search, asBook, getFull, asFull, byKey, byTitle,
  rescueEp, applyRescued, rescueFromPlay, bookByRid, patchRescueMeta,
  hit, markRidPlay, markBookPlay, badEp, failBook, markRefresh,
  clear, stats,
};

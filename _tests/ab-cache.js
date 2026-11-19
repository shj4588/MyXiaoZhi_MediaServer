'use strict';
/**
 * 在线书目永久缓存（abookcache.js）纯逻辑回归 —— 不联网、不转码、不碰真实 files/。
 *
 *   node _tests/ab-cache.js
 *
 * 覆盖：
 *   ① 搜过 / 整理过即命中，别名归一化能找回来
 *   ② **永久性**：_reset() 模拟重启后仍从磁盘同一份命中，无 TTL
 *   ③ **变了才改**：内容指纹没变不写盘、不 bump rev；增集才 rev++ 并记 prevTotal
 *   ④ **播不了才重搜**：单集失败累计才 stale；整本取链全空立即 stale；回源成功清 stale
 *   ⑤ **多设备共享**：同一文件被两次「冷启动」读到同一份；once() 单飞只回源一次
 *   ⑥ 播过标记按 rid 反查；清缓存；原子写无 tmp 残留
 *   ⑦ require server.js 不监听端口，MS_VER / abcache 出口正常
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'ab-cache-test-' + process.pid + '.json');
const HIST = path.join(os.tmpdir(), 'ab-cache-hist-' + process.pid + '.json');
process.env.AB_CACHE_FILE = TMP;
process.env.HIST_FILE = HIST;
try { fs.unlinkSync(TMP); } catch { /* 本来就没有 */ }
try { fs.unlinkSync(HIST); } catch { /* 本来就没有 */ }

const C = require('../abookcache');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b });

const L3 = [
  { ep: 1, title: '第1集 引子', rid: 'r1', duration: '100', source: 'kw' },
  { ep: 2, title: '第2集 黑暗森林', rid: 'r2', duration: '200', source: 'kw' },
  { ep: 3, title: '第3集 死神永生', rid: 'r3', duration: '300', source: 'kw' },
];
const L4 = L3.concat([{ ep: 4, title: '第4集 归零', rid: 'r4', duration: '400', source: 'kw' }]);
const full = extra => Object.assign({
  book: '三体', narrator: '光合积木', albumId: 'A123', source: 'kw', q: '三体',
  list: L3,
}, extra || {});
const KEY = C.keyOf('kw', 'A123', '三体');

async function main() {
  console.log('\n== ① 搜过 / 整理过 ==');
  ok(C.putSearch('三体 有声', 'kw', [{
    book: '三体', narrator: '光合积木', albumId: 'A123', source: 'kw',
    count: 3, preview: ['第1集 引子'],
  }]) === 1, '搜过的结果写入缓存');
  eq(C.search('三体').map(r => r.key), [KEY], '别名归一化后能命中（"三体 有声" → "三体"）');
  eq(C.normQ(' 三体·有声 '), '三体有声', '查询词归一化');
  eq(C.search('三').length, 0, '单字查询不误命中');
  const r1 = C.putFull(full());
  ok(r1.changed === true && r1.rev === 1, '首次整理 rev=1', r1);
  ok(C.getFull('kw', 'A123', '', '三体').list.length === 3, '整本集表可取回');
  eq(C.asBook(C.getFull('kw', 'A123', '', '三体')).count, 3, '摘要视图 count=3');

  console.log('\n== ② 永久性（重启后仍是同一份）==');
  C.flush();
  const rawBefore = fs.readFileSync(TMP, 'utf8');
  C._reset();
  const after = C.getFull('kw', 'A123', '', '三体');
  ok(after && after.list.length === 3, '_reset 模拟重启后仍命中磁盘同一份');
  eq(after.rev, 1, 'rev 不因重启重置');
  ok(C.stats().ttl === null && C.stats().shared === true, 'stats 标明无 TTL / 多设备共享');
  ok(!!C.getFull('all', 'A123', '', ''), '不同设备传不同 source 仍命中同一本');

  console.log('\n== ③ 变了才改 ==');
  const r2 = C.putFull(full());
  ok(r2.unchanged === true, '内容未变 → unchanged，不写盘', r2);
  eq(fs.readFileSync(TMP, 'utf8'), rawBefore, '磁盘文件一个字节都没动');
  eq(C.getFull('kw', 'A123', '', '三体').rev, 1, 'rev 仍是 1');
  const r3 = C.putFull(full({ list: L4 }));
  ok(r3.changed === true && r3.rev === 2, '新增一集 → rev=2', r3);
  const rec4 = C.getFull('kw', 'A123', '', '三体');
  eq(rec4.prevTotal, 3, '记下变更前集数');
  ok(rec4.changedAt > 0, '记下 changedAt');
  const r3b = C.putFull(full({ list: L4.map(e => Object.assign({}, e, { title: e.title + '（修订）' })) }));
  ok(r3b.changed === false && !r3b.unchanged, '只改标题 → 轻更新但不 bump rev');
  eq(C.getFull('kw', 'A123', '', '三体').rev, 2, 'rev 仍是 2');

  console.log('\n== ④ 播不了才重搜 ==');
  const b1 = C.badEp('kw', 'r1', 'HTTP 502');
  ok(b1 && b1.fails === 1 && !b1.stale, '第 1 次取链失败不判整本失效', b1);
  const b2 = C.badEp('kw', 'r2', 'HTTP 502');
  ok(b2 && b2.stale === true, '两个不同集都失败 ⇒ 整本标 stale', b2);
  ok(C.getFull('kw', 'A123', '', '三体').stale === true, 'stale 可被 episodes 路由读到');
  const sameList = C.getFull('kw', 'A123', '', '三体').list.map(e => Object.assign({}, e));
  const rFix = C.putFull(full({ list: sameList }));
  ok(rFix.unchanged === true, '回源后内容其实没变 → 仍不写盘', rFix);
  ok(C.getFull('kw', 'A123', '', '三体').stale === false, '回源成功清掉 stale');
  eq(C.getFull('kw', 'A123', '', '三体').fails, 0, '失败计数清零');
  const fb = C.failBook('kw', 'A123', '三体', '整本取链全空');
  ok(fb && fb.stale === true, '整本取链全空立即 stale');

  console.log('\n== ⑤ 多设备共享 + 单飞 ==');
  let calls = 0;
  const fetchOnce = async () => {
    calls++;
    await new Promise(r => setTimeout(r, 20));
    return { from: 'upstream' };
  };
  const rs = await Promise.all([
    C.once('full:' + KEY, fetchOnce),
    C.once('full:' + KEY, fetchOnce),
    C.once('full:' + KEY, fetchOnce),
  ]);
  ok(calls === 1, '3 个设备同时 miss 只回源 1 次', { calls });
  eq(rs.map(x => x.from), ['upstream', 'upstream', 'upstream'], '三个请求共享同一个结果');
  C.flush();
  C._reset();
  const other = C.getFull('kw', 'A123', '', '三体');
  ok(other && other.list.length === 4, '另一台设备冷启动读到同一份 4 集索引');

  console.log('\n== ⑥ 播过 / 清缓存 / 原子写 ==');
  const played = C.markRidPlay('kw', 'r3');
  ok(played && played.ep === 3, '按 rid 反查到书的第 3 集');
  ok(C.getFull('kw', 'A123', '', '三体').lastPlay > 0, '记下 lastPlay（LRU 依据）');
  C.flush();
  ok(!fs.existsSync(TMP + '.tmp'), '原子写无 tmp 残留');
  ok(JSON.parse(fs.readFileSync(TMP, 'utf8')).books[KEY], '落盘 JSON 可解析且含该书');
  ok(C.clear(KEY).cleared === 1, '按 key 清一本');
  ok(C.getFull('kw', 'A123', '', '三体') === null, '清完后不再命中');
  C.putFull(full({ list: L4 }));
  ok(C.clear().cleared === 1, 'all=1 全清');
  eq(C.stats().books, 0, '全清后 0 本');

  console.log('\n== ⑦ server.js 集成 ==');
  const S = require('../server.js');
  ok(parseInt(String(S.MS_VER).split('.')[1], 10) >= 7, '版本号已升到 1.7.x 及以后：' + S.MS_VER);
  ok(!!S.abcache, '测试出口暴露 abcache');
  eq(S.abcache.FILE, C.FILE, 'server 与测试指向同一份缓存文件');

  console.log('\n== ⑧ v1.7.0 书架：byKey 纯缓存直读 ==');
  C.putFull(full({ list: L4 }));
  const bk = C.byKey(KEY);
  ok(!!bk, 'byKey 命中已整理的书');
  ok(bk.total === L4.length && Array.isArray(bk.list) && bk.list.length === L4.length,
    'byKey 返回整本集表（total 与 list 对齐）');
  ok(bk.book === '三体' && bk.key === KEY, 'byKey 带书名与 key');
  ok(C.byKey('kw|不存在的书') === null, 'byKey miss 返回 null');
  ok(C.byKey('') === null, 'byKey 空 key 返回 null（不抛错）');
  const st = C.stats().items.find(x => x.key === KEY);
  ok(!!st && typeof st.narrator === 'string' && Array.isArray(st.preview),
    'stats.items 带 narrator 与 preview（书架卡片字段）');
  ok(typeof st.lastEp === 'number', 'stats.items 带 lastEp（书架「听到第几集」）');
  C.clear();
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  try { fs.unlinkSync(HIST); } catch { /* ignore */ }
  console.log('\n== ⑨ v1.7.0 缺集占位：fillGaps / putFull / 迁移 ==');
  // 纯函数：110 → 114 断档补 111/112/113 占位
  const gapList = [
    { ep: 110, title: '第110集', rid: 'g110', duration: '', source: 'kw' },
    { ep: 114, title: '第114集', rid: 'g114', duration: '', source: 'kw' },
  ];
  const g = C.fillGaps(gapList);
  eq(g.missing, 3, '110→114 断档补 3 个占位');
  eq(g.list.length, 5, '补位后总行数 5');
  ok(g.list.filter(e => e.missing).map(e => e.ep).join(',') === '111,112,113',
    '占位行 ep 为 111/112/113');
  ok(g.list.every(e => !e.missing || e.rid === ''), '占位行 rid 为空（没有音频）');
  // 连续集号不补
  eq(C.fillGaps([{ ep: 1, title: '', rid: 'a' }, { ep: 2, title: '', rid: 'b' }]).missing, 0,
    '连续集号不补占位');
  // 断档 > GAP_FILL_MAX 不补（换季重编号保护）
  eq(C.fillGaps([{ ep: 1, title: '', rid: 'a' }, { ep: 1 + C.GAP_FILL_MAX + 5, title: '', rid: 'b' }]).missing, 0,
    '断档超过 GAP_FILL_MAX 不补');
  // v1.7.20：GAP_FILL_MAX 30→300 —— 35 断档（旧上限会跳过）照常补占位（遮天 2640→2730 实测）
  eq(C.fillGaps([{ ep: 1, title: '', rid: 'a' }, { ep: 36, title: '', rid: 'b' }]).missing, 34,
    '断档 35（≤300）照常补占位');
  // ep=0（集号没解析出来，常见于番外）**不阻断**补洞 —— v2 实测修正
  const mixed = C.fillGaps([
    { ep: 1, title: '第1集', rid: 'a' },
    { ep: 0, title: '番外', rid: 'x0' },
    { ep: 4, title: '第4集', rid: 'b' },
  ]);
  eq(mixed.missing, 2, 'ep=0 条目不阻断补洞（1→4 补 2、3）');
  ok(mixed.list.map(e => e.ep).join(',') === '1,2,3,0,4',
    '占位紧跟断档起点之后；ep=0（番外）不重排、不阻断');
  // 断档起点重复出现时只补一次
  const dup = C.fillGaps([
    { ep: 110, title: '', rid: 'a' }, { ep: 114, title: '', rid: 'b' },
    { ep: 110, title: '(重发)', rid: 'c' }, { ep: 114, title: '', rid: 'd' },
  ]);
  eq(dup.missing, 3, '同一断档重复出现只补一次');
  // putFull 集成：断档集表落盘后 rec.missing 记数、占位进缓存
  C.putFull(full({ list: gapList }));
  const st9 = C.stats().items.find(x => x.key === KEY);
  eq(st9.missing, 3, 'stats.items 带 missing 计数');
  const fk = C.byKey(KEY);
  eq(fk.missing, 3, 'byKey/asFull 响应带 missing');
  ok(fk.list.some(e => e.missing && e.ep === 111), '缓存 list 里有 111 占位（所有设备共享可见）');
  // sig 稳定性：同样的断档集表再 putFull 一次不应 bump rev
  const revBefore = C.byKey(KEY).rev;
  C.putFull(full({ list: gapList.slice() }));
  eq(C.byKey(KEY).rev, revBefore, '同样断档再整理不 bump rev（sig 把占位算进去且稳定）');
  // 迁移：模拟旧格式缓存文件（无 gapped 标记）→ load 后自动补洞
  C.clear();
  fs.writeFileSync(TMP, JSON.stringify({ ver: 1, books: {
    [KEY]: { key: KEY, book: '三体', narrator: '光合积木', albumId: 'A123', source: 'kw',
      total: 2, count: 2, list: gapList.slice(), at: Date.now() },
  } }));
  C._reset();
  const stM = C.stats().items.find(x => x.key === KEY);
  eq(stM && stM.missing, 3, '旧格式缓存 load 时自动迁移补洞');
  ok(C.byKey(KEY).list.some(e => e.missing && e.ep === 112), '迁移后的 list 含 112 占位');
  C.clear();
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  try { fs.unlinkSync(HIST); } catch { /* ignore */ }
  console.log('\n== ⑩ v1.7.0 缺集救援：rescueEp / applyRescued / 刷新不丢 ==');
  // 基础数据：110→114 断档（111/112/113 占位）
  C.putFull(full({ list: gapList }));
  eq(C.byKey(KEY).missing, 3, '救援前置：3 个占位在缓存');
  // rescueEp：占位原地换真集
  const rq1 = C.rescueEp('kw', 'A123', '三体', 111,
    { ep: 111, title: '第111集 古神之地', rid: 'r111', duration: '08:01', source: 'kw', albumId: 'A123' });
  ok(rq1.ok, 'rescueEp 成功');
  ok(rq1.entry.rescued === true, '救援行带 rescued 标记');
  const fk10 = C.byKey(KEY);
  eq(fk10.missing, 2, '救援后 missing 3→2');
  const e111 = fk10.list.find(e => e.ep === 111);
  eq(e111.rid, 'r111', '占位行已被真集替换');
  ok(!e111.missing && e111.rescued, '111 不再是占位、带 rescued');
  // 重复救援：上游本来就有（非占位）→ 拒绝
  const rq2 = C.rescueEp('kw', 'A123', '三体', 111,
    { ep: 111, title: 'x', rid: 'r2', duration: '', source: 'kw', albumId: 'A123' });
  ok(!rq2.ok && /无需救援/.test(rq2.error), '对非占位行救援会被拒绝');
  // 刷新不丢：同样断档上游集表再 putFull（sig 不变路径），救援行仍在
  C.putFull(full({ list: gapList.slice() }));
  ok(C.byKey(KEY).list.some(e => e.ep === 111 && e.rid === 'r111'), 'sig 不变的刷新后救援行仍在');
  // 刷新不丢（变更路径）：上游集数变了一点（sig 变），救援行重新铺回
  const gapList2 = gapList.concat([{ ep: 115, title: '第115集', rid: 'g115', duration: '', source: 'kw' }]);
  C.putFull(full({ list: gapList2 }));
  ok(C.byKey(KEY).list.some(e => e.ep === 111 && e.rid === 'r111'),
    '上游变更（rev++）后 applyRescued 把救援行铺回');
  // 上游自己补了真集 → 救援行让位
  const gapList3 = gapList.concat([
    { ep: 111, title: '第111集 官方补', rid: 'g111x', duration: '', source: 'kw' },
    { ep: 115, title: '第115集', rid: 'g115', duration: '', source: 'kw' },
  ]);
  C.putFull(full({ list: gapList3 }));
  const e111b = C.byKey(KEY).list.find(e => e.ep === 111);
  eq(e111b.rid, 'g111x', '上游有了真集时真集优先，救援行退场');
  ok(!e111b.rescued, '退场后 111 不再带 rescued');
  // applyRescued 纯函数：上游列表根本没有该集号（截断场景）→ 追加救援行
  const ar = C.applyRescued({ 111: { ep: 111, title: 't', rid: 'r', duration: '', source: 'kw', rescued: true } },
    [{ ep: 110, title: '', rid: 'a' }, { ep: 114, title: '', rid: 'b' }]);
  eq(ar.list.length, 3, '上游截断缺该集号时救援行被追加');
  eq(ar.applied, 1, '追加计入 applied');
  C.clear();
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  try { fs.unlinkSync(HIST); } catch { /* ignore */ }
  console.log('\n== ⑪ v1.7.1 防降级：上游吐截断缓存时旧真集优先 ==');
  // 实测翻车：整本重搜这次上游只吐了 110/114（重复查询截断 2101→200），
  // 旧表里 111/112/113 本来是真的 → 直接替换 rec.list 就把好集降级成「缺」。
  const real114 = [
    { ep: 110, title: '第110集', rid: 'a110', duration: '', source: 'kw' },
    { ep: 111, title: '第111集', rid: 'a111', duration: '', source: 'kw' },
    { ep: 112, title: '第112集', rid: 'a112', duration: '', source: 'kw' },
    { ep: 113, title: '第113集', rid: 'a113', duration: '', source: 'kw' },
    { ep: 114, title: '第114集', rid: 'a114', duration: '', source: 'kw' },
  ];
  C.putFull(full({ list: real114 }));
  eq(C.byKey(KEY).missing, 0, '前置：整本 5 集全真，missing=0');
  // 上游这次吐截断：只有 110/114
  C.putFull(full({ list: [real114[0], real114[4]] }));
  const fk11 = C.byKey(KEY);
  eq(fk11.missing, 0, '截断重搜后旧真集不被降级（missing 仍 0）');
  eq(fk11.list.find(e => e.ep === 112).rid, 'a112', '112 仍是旧真集 rid');
  eq(fk11.list.length, 5, '集表仍是 5 行');
  // 旧表里带 rescued 标记的真集被铺回时保留角标
  const rq11 = C.rescueEp('kw', 'A123', '三体', 115,
    { ep: 115, title: '第115集 补', rid: 'x115', duration: '', source: 'kw', albumId: 'A123' });
  ok(rq11.ok, '追加救援 115（截断场景 push）');
  C.putFull(full({ list: real114 }));   // 上游恢复全量但没 115 → 115 由 applyRescued 追加
  const e115 = C.byKey(KEY).list.find(e => e.ep === 115);
  ok(e115 && e115.rid === 'x115' && e115.rescued, '115 救援行在恢复全量刷新后仍在');
  // 上游真集（新表非占位）优先于旧表 —— 旧真集只用来填「新表占位」，不顶掉上游更新
  C.putFull(full({ list: [
    { ep: 110, title: '第110集', rid: 'a110', duration: '', source: 'kw' },
    { ep: 111, title: '第111集 官方重传', rid: 'new111', duration: '', source: 'kw' },
    { ep: 114, title: '第114集', rid: 'a114', duration: '', source: 'kw' },
  ] }));
  const e111c = C.byKey(KEY).list.find(e => e.ep === 111);
  eq(e111c.rid, 'new111', '上游新真集优先，不被旧真集顶掉');
  eq(C.byKey(KEY).list.find(e => e.ep === 112).rid, 'a112', '112 占位仍被旧真集补回');
  C.clear();
  // == ⑪b v1.7.19 防降级补全：集号整行缺席的截断场景 ==
  // 实测翻车（遮天重搜）：上游截断连「集号」都不吐（断档 > GAP_FILL_MAX 连占位都
  // 没给），旧表真集整行消失 —— v1.7.1 的占位行保护只覆盖「新表里存在的行」。
  console.log('\n== ⑪b v1.7.19 防降级补全（缺席集号） ==');
  const oldFull = [
    { ep: 1, title: '第1集', rid: 'd1', duration: '', source: 'kw' },
    { ep: 2, title: '第2集', rid: 'd2', duration: '', source: 'kw' },
    { ep: 3, title: '第3集', rid: 'd3', duration: '', source: 'kw' },
    { ep: 4, title: '第4集', rid: 'd4', duration: '', source: 'kw' },
    { ep: 5, title: '第5集', rid: 'd5', duration: '', source: 'kw' },
    { ep: 400, title: '第400集', rid: 'd400', duration: '', source: 'kw' },
  ];
  C.putFull(full({ list: oldFull }));
  eq(C.byKey(KEY).missing, 0, '前置：1..5 + 400 全真（5→400 断档 395 > GAP_FILL_MAX=300 不补占位）');
  eq(C.byKey(KEY).list.length, 6, '前置：集表 6 行');
  // 上游重拉残缺：只吐 1 和 400（2/3/4 整号缺席）
  C.putFull(full({ list: [oldFull[0], oldFull[5]] }));
  const fk11b = C.byKey(KEY);
  eq(fk11b.missing, 0, '缺席集号的旧真集被补回（missing 仍 0）');
  eq(fk11b.list.length, 6, '集表恢复 6 行');
  eq(fk11b.list.find(e => e.ep === 3).rid, 'd3', '3 号集仍是旧真集 rid');
  // 再刷一次（同样残缺）不 bump rev —— 补回不参与指纹，sig 稳定
  const rev11b = C.byKey(KEY).rev;
  C.putFull(full({ list: [oldFull[0], oldFull[5]] }));
  eq(C.byKey(KEY).rev, rev11b, '同样残缺再拉：sig 不变不 bump rev');
  // 上游真集有行就优先：新表给了新 rid 的 2 号 → 不被旧真集顶掉
  C.putFull(full({ list: [
    { ep: 1, title: '第1集', rid: 'd1', duration: '', source: 'kw' },
    { ep: 2, title: '第2集 官方重传', rid: 'nd2', duration: '', source: 'kw' },
    { ep: 400, title: '第400集', rid: 'd400', duration: '', source: 'kw' },
  ] }));
  eq(C.byKey(KEY).list.find(e => e.ep === 2).rid, 'nd2', '上游新真集优先');
  eq(C.byKey(KEY).list.find(e => e.ep === 4).rid, 'd4', '4 号缺席仍由旧真集补回');
  // server.js 救援闸门：整行缺席（!tgt）也要触发救援（遮天重搜实测翻车）
  const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(srvSrc.includes("const tgtMiss = !tgt || (!!tgt.missing || !String(tgt.rid || '').trim());"),
    'episodes ep=N 救援闸门覆盖整行缺席（!tgt 也救）');
  C.clear();
  // == ⑫ v1.7.6 设备救援回传 rescueFromPlay ==
  // 实测：R1 点缺集自己搜 rid 直接 /r/ 播成功，但结果不回传 —— 服务端缓存还灰着。
  console.log('\n== ⑫ v1.7.6 设备救援回传 ==');
  // 用真实断档 1↔3 让 fillGaps 插 ep2 占位（手写 missing 会被 putFull 规范化剥掉）
  C.putFull(full({ list: [
    { ep: 1, title: '第1集', rid: 'b1', duration: '', source: 'kw' },
    { ep: 3, title: '第3集', rid: 'b3', duration: '', source: 'kw' },
  ] }));
  eq(C.byKey(KEY).missing, 1, '前置：fillGaps 插了 1 个占位');
  ok(!C.rescueFromPlay('kw', 'x9', 1, '曲中人有故事', null), '真集不回传顶掉（无占位返回 null）');
  const bp12 = C.rescueFromPlay('kw', 'x2', 2, '曲中人有故事',
    { title: '第2集 真标题', albumId: 'A123', album: '遮天', duration: '3600' });
  ok(bp12 && bp12.ok && bp12.key === KEY, '占位集回传成功并指到正确的书');
  const e12 = C.byKey(KEY).list.find(e => e.ep === 2);
  ok(e12 && e12.rid === 'x2' && e12.rescued && e12.title === '第2集 真标题', '回传条目带真标题与 rescued 标记');
  eq(C.byKey(KEY).missing, 0, '回传后 missing 归零');
  ok(!C.rescueFromPlay('kw', 'y7', 99, '某人', null), '没有书有该集占位 → null');
  C.clear();
  // == ⑬ v1.7.7 bookByRid 反查 + 兜底标题补真名 ==
  // 实测：设备救援回传时 siGet 无暂存 → 落了「第 N 集（设备救援回传）」兜底标题。
  console.log('\n== ⑬ v1.7.7 bookByRid + patchRescueMeta ==');
  C.putFull({ source: 'kw', albumId: 'B9', book: '凡人修仙传', narrator: '光合积木',
              total: 2, list: [
    { ep: 1, title: '第1集', rid: 'c1', duration: '', source: 'kw' },
    { ep: 3, title: '第3集', rid: 'c3', duration: '', source: 'kw' },
  ] });
  const KEY13 = C.keyOf('kw', 'B9', '凡人修仙传');
  eq(C.byKey(KEY13).missing, 1, '前置：凡人修仙传插 1 个占位');
  const bf13 = C.rescueFromPlay('kw', 'c2x', 2, '光合积木', null);
  ok(bf13 && bf13.ok, '无暂存回传 → 落兜底标题');
  eq(C.byKey(KEY13).list.find(e => e.ep === 2).title, '凡人修仙传 第 2 集（设备救援回传）', '兜底标题落盘（带书名）');
  const bb13 = C.bookByRid('kw', 'c2x');
  ok(bb13 && bb13.ep === 2 && bb13.book === '凡人修仙传'
     && /（设备救援回传）$/.test(bb13.title), 'bookByRid 反查 + 识别兜底标题');
  ok(!C.bookByRid('kw', 'nope'), '未知 rid → null');
  const pk13 = C.patchRescueMeta('kw', 'c2x', 2,
    { title: '凡人修仙传 第2集 真名', duration: '1800', album: '凡人修仙传|完结' });
  ok(pk13 && pk13.ok, '补真标题');
  eq(C.byKey(KEY13).list.find(e => e.ep === 2).title, '凡人修仙传 第2集 真名', '真名已落盘');
  ok(!C.patchRescueMeta('kw', 'c2x', 2, { title: '再改一次' }), '真名不再被覆盖');
  C.clear();

  console.log('\n== ⑭ v1.7.10 历史缺集脏行：无 missing 字段 / rid 为空也能救援 ==');
  // 真机实测：v1.6.x 遗留的 ab_cache.json 里占位行只有「（缺集 · 上游没有第 N 集）」
  // 文案 + rid:''，**没有 missing 字段**，磁盘 missing 还是 0。v1.7.9 只认 missing
  // ⇒ server.js 不触发救援、rescueEp 又二次拒掉 ⇒ 点了永远还是灰的。
  C.flush();
  C._reset();
  const KEY14 = C.keyOf('kw', 'A123', '三体');
  fs.writeFileSync(TMP, JSON.stringify({ ver: 1, books: {
    [KEY14]: {
      key: KEY14, book: '三体', narrator: '光合积木', albumId: 'A123', source: 'kw',
      aliases: ['三体'], count: 3, total: 3, preview: [], gv: 3,
      list: [
        { ep: 1, title: '第1集', rid: 'r1', duration: '', source: 'kw' },
        { ep: 2, title: '（缺集 · 上游没有第 2 集）', rid: '', duration: '', source: 'kw' },
        { ep: 3, title: '第3集', rid: 'r3', duration: '', source: 'kw' },
      ],
      sig: 'dirty', dsig: 'dirty', rev: 6, at: Date.now(), missing: 0,
      stale: false, fails: 0, bad: {}, hits: 0,
    },
  } }));
  C._reset();
  const f14 = C.byKey(KEY14);
  const e14 = f14.list.find(x => x.ep === 2);
  ok(!!e14 && !e14.missing && e14.rid === '', '前置：脏占位行无 missing / rid 为空');
  eq(f14.missing, 0, '磁盘 missing=0 正是线上「显示缺集却救不了」的现象');
  // ① 缓存层 rescueEp 不得因「没打 missing」二次拒绝
  const rq14 = C.rescueEp('kw', 'A123', '三体', 2,
    { ep: 2, title: '第2集 真名', rid: 'r2real', duration: '1800', source: 'kw', albumId: 'A123' });
  ok(rq14 && rq14.ok, 'v1.7.10 rescueEp 接受历史脏占位行');
  eq(C.byKey(KEY14).list.find(x => x.ep === 2).rid, 'r2real', '脏占位行被真集原地替换');
  eq(C.byKey(KEY14).missing, 0, '救援后按新口径重算 missing');
  // ② applyRescued 刷新铺回时也不能把脏行当成「上游真集」丢掉救援结果
  const ar14 = C.applyRescued(
    { 2: { ep: 2, title: '第2集', rid: 'r2b', duration: '', source: 'kw', rescued: true } },
    [{ ep: 1, title: '第1集', rid: 'r1' },
     { ep: 2, title: '（缺集 · 上游没有第 2 集）', rid: '' },
     { ep: 3, title: '第3集', rid: 'r3' }]);
  eq(ar14.applied, 1, 'applyRescued 对脏占位行也铺回救援行');
  eq(ar14.list.find(x => x.ep === 2).rid, 'r2b', '刷新后脏行拿到救援 rid');
  eq(ar14.dropped, 0, '没有把脏行误判成上游真集');
  C.clear();

  // == ⑫ v1.7.20 跨书毒行：rescueEp 终审 + 启动迁移清理 ==
  // 背景（实测翻车）：设备点播遮天「第3373集」，精确词搜索把**圣墟**的同号集
  // 救进了遮天缓存（专辑不符、标题不沾书名）—— 用户点了播的是别的书。
  console.log('\n== ⑫ v1.7.20 跨书毒行（圣墟 3373 进遮天） ==');
  C.putFull(full({ book: '遮天', albumId: 'ZT1', narrator: '曲中人有故事', q: '遮天' }));
  const KEY20 = C.keyOf('kw', 'ZT1', '遮天');
  // ① 跨书候选（专辑不符 + 标题不沾书名）→ 终审拒绝（ep=4 缺席行，rescueEp 支持追加）
  const xg20 = C.rescueEp('kw', 'ZT1', '遮天', 4,
    { ep: 4, title: '圣墟 第4集 诸界英杰俯首1', rid: 'SX4', duration: '06:35', source: 'kw', albumId: 'SX1' });
  ok(xg20 && xg20.ok === false, '跨书候选（专辑不符+标题不沾书名）被终审拒绝');
  // ② 跨专辑但标题沾书名（同名书另一版本）→ 照旧放行
  const zg20 = C.rescueEp('kw', 'ZT1', '遮天', 4,
    { ep: 4, title: '遮天 第4集 归零（曲中人版）', rid: 'ZT4b', duration: '06:00', source: 'kw', albumId: 'ZT9' });
  ok(zg20 && zg20.ok === true, '跨专辑但标题沾书名的候选照旧放行');
  eq(C.byKey(KEY20).list.find(x => x.ep === 4).rid, 'ZT4b', '合法跨专辑救援已写入');
  // ③ 模拟历史脏数据（毒记档 + 毒列表行 + 同专辑设备回传行），_reset 重载 → 迁移清理
  C.flush();
  const raw20 = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  const r20 = raw20.books[KEY20];
  r20.rescued['3373'] = { ep: 3373, title: '圣墟 第3373集 诸界英杰俯首1', rid: 'SX3373', duration: '06:35', source: 'kw', albumId: 'SX1', rescued: true };
  r20.list.push({ ep: 3373, title: '圣墟 第3373集 诸界英杰俯首1', rid: 'SX3373', duration: '06:35', source: 'kw', rescued: true });
  r20.rescued['262'] = { ep: 262, title: '第 262 集（设备救援回传）', rid: 'DV262', duration: '05:00', source: 'kw', albumId: 'ZT1', rescued: true };
  r20.list.push({ ep: 262, title: '第 262 集（设备救援回传）', rid: 'DV262', duration: '05:00', source: 'kw', albumId: 'ZT1', rescued: true });
  fs.writeFileSync(TMP, JSON.stringify(raw20));
  C._reset();
  const r20b = C.byKey(KEY20);
  ok(r20b && !!r20b.list, '_reset 重载后书记录还在（迁移已跑）');
  ok(!r20b.list.find(x => Number(x.ep) === 3373), '毒行 3373（圣墟）被启动迁移清掉');
  ok(!r20b.rescued || !r20b.rescued['3373'], '毒记档 3373 一并删除');
  ok(r20b.list.find(x => Number(x.ep) === 262 && x.rid === 'DV262'), '同专辑设备回传行（兜底标题）保留');
  ok(r20b.list.find(x => Number(x.ep) === 4 && x.rid === 'ZT4b'), '合法救援行（标题沾书名）保留');
  eq(r20b.total, r20b.list.length, 'total 与清理后的列表一致');
  C.clear();

  // == ⑬ v1.7.20 搜索缓存别名「吸词」==
  // 实测翻车：琅琊榜的缓存别名「光合积木」（此前搜主播留下的）把「凡人修仙传 光合积木」
  // 整个查询部分吸走 —— cache-only 应答返回不相干的书，真搜永远不回源。
  console.log('\n== ⑬ v1.7.20 搜索别名吸词 ==');
  C.putSearch('光合积木', 'kw', [{ book: '琅琊榜', narrator: '光合积木', albumId: 'LB1', source: 'kw', count: 2, preview: ['第1集'] }]);
  eq(C.search('凡人修仙传 光合积木').map(r => r.book), [], '短别名不再吸走长查询（长度比 < 0.6 不命中）');
  eq(C.search('光合积木').map(r => r.book), ['琅琊榜'], '精确别名命中照旧（score 3）');
  eq(C.search('琅琊榜之风起长林').map(r => r.book), ['琅琊榜'], '书名部分匹配照旧（score 2）');
  C.clear();
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  try { fs.unlinkSync(HIST); } catch { /* ignore */ }
  console.log('\n' + (fail ? '✗' : '✓') + ' 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

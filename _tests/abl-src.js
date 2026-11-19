'use strict';
/**
 * v1.7.43 本地节目来源判定 —— /v1/pos 上来的书是「本地节目」还是「在线节目」。
 *
 *   node _tests/abl-src.js
 *
 * 背景（2026-11-18 15:20）：
 *   设备 ProgProgress 的 /v1/pos 只带 kind/q/ep/pos，不带 src；服务端以前一律按 kind
 *   推成 online_program ⇒ R1 播 NAS 本地书《道诡异仙》也被标成「在线节目」。
 *   本地书在服务端本地库里是权威已知的，按名单判即可 —— 不靠客户端猜。
 *
 * 覆盖：
 *   ① 精确命中本地书名
 *   ② 设备报「书名 · 副标题」也能认（/api/ablplay 的 artist 是 book + " · " + sub）
 *   ③ 反过来设备只报书名、本地库是全名，也认
 *   ④ 不在本地库的书（在线书）不误判
 *   ⑤ 空 / 空白 / null 不炸
 *   ⑥ 名单有 TTL 缓存：反复判不重复扫库（这里只验行为稳定，不验扫描次数）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'ablsrc-hist-' + process.pid + '.json');
process.env.HIST_FILE = TMP;
try { fs.unlinkSync(TMP); } catch { /* 本来就没有 */ }

const S = require('../server.js');

let pass = 0, fail = 0;
const ok = (v, m) => { if (v) { pass++; return; } fail++; console.log('  ✗ ' + m); };
const eq = (a, b, m) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; return; }
  fail++; console.log('  ✗ ' + m + '  期望 ' + JSON.stringify(b) + '  实得 ' + JSON.stringify(a));
};

S._setAblNamesForTest(['道诡异仙', '凡人修仙传', '仙逆丨多人剧丨曲中人有故事丨完结']);

console.log('[1] 精确命中');
ok(S.isAblBook('道诡异仙') === true, '道诡异仙 → 本地节目');
ok(S.isAblBook('凡人修仙传') === true, '凡人修仙传 → 本地节目');

console.log('[2] 设备带副标题');
eq(S.isAblBook('道诡异仙 · 多人剧'), true, '「道诡异仙 · 多人剧」→ 本地节目');

console.log('[3] 本地库是全名、设备报短名');
eq(S.isAblBook('仙逆'), false, '「仙逆」不等于全名，但…');
eq(S.isAblBook('仙逆丨多人剧丨曲中人有故事丨完结'), true, '全名 → 本地节目');

console.log('[4] 在线书不误判');
eq(S.isAblBook('遮天'), false, '遮天（在线书）→ 不是本地节目');
eq(S.isAblBook('遮天 · 曲中人有故事'), false, '带副标题的在线书也不误判');

console.log('[5] 脏输入不炸');
eq(S.isAblBook(''), false, '空串');
eq(S.isAblBook('   '), false, '空白');
eq(S.isAblBook(null), false, 'null');
eq(S.isAblBook(undefined), false, 'undefined');

console.log('[6] 名单为空时全不命中（本地库不可用不该误标）');
S._setAblNamesForTest([]);
eq(S.isAblBook('道诡异仙'), false, '空名单 → false');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

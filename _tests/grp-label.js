'use strict';
/**
 * v1.7.41 书级记录的「分组信息」—— 同书分属不同组时，Web 侧要能区分。
 *
 *   node _tests/grp-label.js
 *
 * 背景（2026-11-18 14:35，R1 被移成独立组）：
 *   /api/history 的 books 每条只带 grp id（'default' / 'solo:98BB9936CD6B'），
 *   前端只有具名组的名字映射 ⇒ 两条《遮天》都显示不出组，分不清哪条是独立分组的。
 *
 * 覆盖：
 *   ① 默认组 → '默认组'
 *   ② solo:<devId> → '独立 · <设备名>'（没有设备名就只写「独立」）
 *   ③ 具名组 → 组名；组被删掉后退化成 gid，不炸
 *   ④ histBooksSnapshot 每条都带 grpName，且两条同名书分得开
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'grplabel-hist-' + process.pid + '.json');
const DGT = path.join(os.tmpdir(), 'grplabel-dg-' + process.pid + '.json');
process.env.HIST_FILE = TMP;
process.env.DG_FILE = DGT;
try { fs.unlinkSync(TMP); } catch { /* 本来就没有 */ }
try { fs.unlinkSync(DGT); } catch { /* 本来就没有 */ }

const S = require('../server.js');

let pass = 0, fail = 0;
const eq = (a, b, m) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; return; }
  fail++; console.log('  ✗ ' + m + '  期望 ' + JSON.stringify(b) + '  实得 ' + JSON.stringify(a));
};
const ok = (v, m) => { if (v) { pass++; return; } fail++; console.log('  ✗ ' + m); };

const R1 = 'AAAA11112222';

function reset() {
  const h = S.histLoad();
  h.devices = { [R1]: { name: 'R1-CD6B', list: [], seen: Date.now() } };
  h.books = {};
  S.histFlush();
  const d = S.dgLoad();
  d.groups = {};
  S.dgFlush();
}

console.log('\n[1] 默认组 / 独立 / 具名组 的可读名');
reset();
eq(S.dgGrpName('default'), '默认组', '默认组');
eq(S.dgGrpName(S.DG_DEFAULT), '默认组', 'DG_DEFAULT 常量同口径');
eq(S.dgGrpName('solo:' + R1), '独立 · R1-CD6B', '独立组带设备名');
eq(S.dgGrpName('solo:NOTEXIST01'), '独立', '查不到设备名就只写「独立」');
{
  const d = S.dgLoad();
  d.groups['g_living'] = { name: '客厅', devs: [], createdAt: 1 };
  S.dgFlush();
}
eq(S.dgGrpName('g_living'), '客厅', '具名组用组名');
eq(S.dgGrpName('g_gone'), 'g_gone', '组已不存在时退化成 gid，不抛错');
eq(S.dgGrpName(''), '默认组', '空值按默认组');

console.log('\n[2] 同一本书在两个组 ⇒ 两条记录都带 grpName，能区分');
reset();
S.histBookSave({ book: '遮天', q: '遮天', kind: 'book', ep: 15, pos: 163, dev: R1 });          // 无组 ⇒ solo
S.histBookSave({ book: '遮天', q: '遮天', kind: 'book', ep: 15, pos: 36, grp: 'default', dev: 'STEMX' });
const bs = S.histBooksSnapshot().filter(x => x.book === '遮天');
eq(bs.length, 2, '两条《遮天》（分组隔离，各一条）');
const solo = bs.filter(x => String(x.grp).indexOf('solo:') === 0)[0] || {};
const dflt = bs.filter(x => x.grp === 'default')[0] || {};
eq(solo.grpName, '独立 · R1-CD6B', '独立那条标明是 R1 独立组');
eq(dflt.grpName, '默认组', '默认组那条标明默认组');
ok(solo.grpName !== dflt.grpName, '两条的组标签不同 ⇒ 前端分得开');

console.log('\n[3] 具名组的书级记录也带组名');
reset();
{
  const d = S.dgLoad();
  d.groups['g_living'] = { name: '客厅', devs: [R1], createdAt: 1 };
  S.dgFlush();
}
S.histBookSave({ book: '凡人修仙传', q: '凡人修仙传', kind: 'book', ep: 3, pos: 20, dev: R1 });
const b2 = S.histBooksSnapshot().filter(x => x.book === '凡人修仙传')[0] || {};
eq(b2.grp, 'g_living', '进度落在设备所在组');
eq(b2.grpName, '客厅', '组名直出');

console.log('\n[4] 按组过滤的快照（设备端 /v1/history?dev=）也带 grpName');
reset();
S.histBookSave({ book: '遮天', q: '遮天', kind: 'book', ep: 1, pos: 10, dev: R1 });
S.histBookSave({ book: '遮天', q: '遮天', kind: 'book', ep: 2, pos: 20, grp: 'default', dev: 'STEMX' });
const only = S.histBooksSnapshot('solo:' + R1);
eq(only.length, 1, '只出该组的一条');
eq(only[0].grpName, '独立 · R1-CD6B', '过滤后仍带组名');

console.log('\n=== ' + (fail ? '有 ' + fail + ' 项失败' : '全部通过') + '（' + pass + ' 项）===\n');
process.exit(fail ? 1 : 0);

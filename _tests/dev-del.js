'use strict';
/**
 * v1.7.58 删除设备（连同记录）—— Web「设备分组 → 全部设备」右侧 ✕ 的服务端实现。
 *
 *   node _tests/dev-del.js
 *
 * 背景：只删 history.devices[id] 会留下两处残迹，删完看着像没删干净：
 *   ① 分组里还挂着这个名字 —— 组显示「N 台」，展开只有 N-1 个成员，点不到也删不掉；
 *   ② 设备独立成组时，书级进度存在 books 的 `g:solo:<dev>|书名|作者` 键里，与 devices
 *      是两套存储，不删就永远留在 history.json 当幽灵记录。
 *
 * 覆盖：
 *   ① 组内设备：移出所有组 + 删 devices[id] + **组内共享进度保留** + 它自己的 solo 残留删掉
 *   ② 不存在的设备：幂等（0/0），不抛错、不写坏文件
 *   ③ 缺 id / 空串：空返回，不动任何数据
 *   ④ ip-* 伪设备（网页/匿名桶）也能删
 *   ⑤ 删完 dgSnapshot 里看不到它；同组其他设备仍在
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'devdel-hist-' + process.pid + '.json');
const DGT = path.join(os.tmpdir(), 'devdel-dg-' + process.pid + '.json');
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
const STEM = 'BBBB33334444';
const WEB = 'ip-192.168.2.77';

function seed() {
  const h = S.histLoad();
  h.devices = {
    [R1]: { name: 'R1-EEFF', ip: '192.168.2.5', seen: Date.now(),
      list: [{ kind: 'book', book: '遮天', ep: 3, pos: 10 }] },
    [STEM]: { name: 'AlphaPi-STM', ip: '192.168.2.9', seen: Date.now(), list: [] },
    [WEB]: { name: '网页', seen: Date.now(), list: [] },
  };
  h.books = {
    ['g:solo:' + R1 + '|遮天|辰东']: { book: '遮天', ep: 3, pos: 10, grp: 'solo:' + R1 },
    ['g:g_living|凡人修仙传|忘语']: { book: '凡人修仙传', ep: 2, pos: 20, grp: 'g_living' },
  };
  S.histFlush();
  const d = S.dgLoad();
  d.groups = {
    default: { name: '默认组', devs: [], createdAt: 1, system: true },
    g_living: { name: '客厅', devs: [R1, STEM], createdAt: 2 },
  };
  S.dgFlush();
}

console.log('\n[1] 删组内设备：移出组 + 删设备记录 + 保留组内共享进度 + 删它的 solo 残留');
seed();
{
  const r = S.devDelete(R1);
  eq(r.outGroups, 1, '从 1 个组移出');
  eq(r.hadDev, true, '设备记录确实存在过');
  eq(r.books, 1, '删掉 1 条独立组书级进度');
  const h = S.histLoad();
  ok(!h.devices[R1], 'devices 里没有 R1 了');
  ok(!!h.devices[STEM], '同组的 STEM 不受影响');
  ok(!h.books['g:solo:' + R1 + '|遮天|辰东'], 'solo 组书级进度已删');
  ok(!!h.books['g:g_living|凡人修仙传|忘语'], '组内共享进度**保留**（那是全组的）');
  eq(S.dgLoad().groups.g_living.devs, [STEM], '组里只剩 STEM');
  eq(S.dgLoad().groups.g_living.name, '客厅', '组本身保留（不是删组）');
}

console.log('\n[2] 不存在的设备：幂等，0/0，不抛错');
{
  const r = S.devDelete('ZZZZ99998888');
  eq([r.outGroups, r.hadDev, r.books], [0, false, 0], '什么都没删');
  ok(!!S.histLoad().devices[STEM], '现有设备没被误删');
}

console.log('\n[3] 缺 id / 空串：不做任何事');
{
  eq(S.devDelete('').dev, '', '空串返回空');
  eq(S.devDelete(null).dev, '', 'null 也返回空');
  eq(Object.keys(S.histLoad().devices).length, 2, '设备数没变（STEM + 网页）');
}

console.log('\n[4] ip-* 伪设备也能删');
{
  const r = S.devDelete(WEB);
  eq([r.hadDev, r.outGroups], [true, 0], '删掉网页桶，本来就不在任何组');
  ok(!S.histLoad().devices[WEB], 'devices 里没有 ip- 桶了');
}

console.log('\n[5] 删完 dgSnapshot 里看不到它');
{
  const snap = S.dgSnapshot();
  const ids = (snap.devices || []).map(x => x.id);
  ok(ids.indexOf(R1) < 0 && ids.indexOf(WEB) < 0, 'R1 与网页桶都不在快照里');
  ok(ids.indexOf(STEM) >= 0, 'STEM 还在');
  const g = (snap.groups || []).filter(x => x.id === 'g_living')[0] || {};
  eq(g.count, 1, '客厅组显示 1 台（不是残留的 2 台）');
}

try { fs.unlinkSync(TMP); } catch { /* 忽略 */ }
try { fs.unlinkSync(DGT); } catch { /* 忽略 */ }

console.log('\n=== ' + (fail ? '有 ' + fail + ' 项失败' : '全部通过') + '（' + pass + ' 项）===\n');
process.exit(fail ? 1 : 0);

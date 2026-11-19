'use strict';
/**
 * v1.7.39 播放记录防跳 —— histDevTouch 的「同一场收听两路错标上报」合并规则。
 *
 *   node _tests/dev-record-merge.js
 *
 * 实测背景（2026-11-18 13:30，R1 听「遮天 第4集」）：
 *   device ProgProgress 每 15s 报 ep=4（正确），player 网页每 8s 报 ep=1（集号残留），
 *   两路 pos 几乎相同（96 / 99）⇒ 旧规则（ep 必须相等才合并）在列表里留两条，
 *   轮流刷新 ⇒ 播放记录在「第1集」「第4集」之间来回跳。
 *
 * 覆盖：
 *   ① ep 不同但 pos 接近（同一播放位置被错标）⇒ 合并成一条，ep 跟随最新
 *   ② 正常换集（上一集收尾 pos=315 → 新集 pos=0）⇒ 照旧新建，记录流水不变
 *   ③ 不同书 ⇒ 新建
 *   ④ 超过 3 分钟窗口 ⇒ 新建（换时段再听不该被折叠）
 *   ⑤ 同书同 ep 前进 ⇒ 合并（老行为不回归）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'dev-merge-hist-' + process.pid + '.json');
const DGT = path.join(os.tmpdir(), 'dev-merge-dg-' + process.pid + '.json');
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

const DEV = 'AAAA11112222';
const DEV2 = 'BBBB33334444';

function reset() {
  const d = S.histLoad();
  d.devices = {};
  d.books = {};
  S.histFlush();
}
const list = id => (S.histLoad().devices[id] || { list: [] }).list;
const push = (rec) => S.histDevTouch(DEV, 'R1-TEST', rec);
const bookRec = (ep, pos, extra) => Object.assign({
  kind: 'book', q: '遮天', book: '遮天', ep: ep, pos: pos, title: '遮天 第' + ep + '集',
}, extra || {});

console.log('\n[1] ep 不同但 pos 接近（同一位置被两路错标）⇒ 合并');
reset();
push(bookRec(4, 99));
push(bookRec(1, 96));            // 网页残留的 ep=1 + 同一播放位置
eq(list(DEV).length, 1, '只有一条记录（不再同书双条）');
eq(list(DEV)[0].ep, 1, 'ep 跟随最新上报');
eq(list(DEV)[0].pos, 96, 'pos 跟随最新上报');
push(bookRec(4, 115));           // 下一拍 ep=4 又回来
eq(list(DEV).length, 1, '来回交替仍然只有一条');
eq(list(DEV)[0].ep, 4, 'ep 再次跟随最新');

console.log('\n[1b] 两路秒数差 67s（实测网页那路 POS_SEC 会滞后）⇒ 照样合并');
reset();
push(bookRec(5, 227));
push(bookRec(1, 160));           // 位置没回退（160+30 ≥ 227）⇒ 同一次播放的错标
eq(list(DEV).length, 1, '秒数有偏差也合并');
eq(list(DEV)[0].ep, 1, 'ep 跟随最新');

console.log('\n[2] 正常换集（上一集收尾 → 新集从头）⇒ 仍新建');
reset();
push(bookRec(3, 315));
push(bookRec(4, 0));
eq(list(DEV).length, 2, '换集新建一条（记录流水不变）');
eq(list(DEV)[0].ep, 4, '最新一条是第 4 集');
eq(list(DEV)[1].ep, 3, '上一条保留第 3 集');

console.log('\n[3] 不同书 ⇒ 各自一条');reset();
push(bookRec(4, 50));
push({ kind: 'book', q: '凡人修仙传', book: '凡人修仙传', ep: 1, pos: 52, title: '凡人修仙传 第1集' });
eq(list(DEV).length, 2, '换书新建');
eq(list(DEV)[0].q, '凡人修仙传', '最新一条是新书');

console.log('\n[4] 超过 3 分钟窗口 ⇒ 不折叠');
reset();
push(bookRec(1, 96));
{
  const d = S.histLoad();
  d.devices[DEV].list[0].ts = Date.now() - 4 * 60 * 1000;   // 假装是 4 分钟前那条
  S.histFlush();
}
push(bookRec(1, 100));
eq(list(DEV).length, 2, '换时段再听留两条');

console.log('\n[5] 同书同 ep 前进 ⇒ 合并（老行为不回归）');
reset();
push(bookRec(4, 50));
push(bookRec(4, 65));
eq(list(DEV).length, 1, '同集推进合并');
eq(list(DEV)[0].pos, 65, 'pos 更新');

console.log('\n[6] 不同设备互不影响');
reset();
push(bookRec(4, 50));
S.histDevTouch(DEV2, 'STEM-TEST', bookRec(1, 51));
eq(list(DEV).length, 1, '设备 A 一条');
eq(list(DEV2).length, 1, '设备 B 一条');
eq(list(DEV2)[0].ep, 1, '设备 B 自己的集号');

console.log('\n[8] 集尾播完（fin）结算 ⇒ 并进当前条（不再新建 pos=0 假记录）');
reset();
push(bookRec(6, 8));                                   // 起播
push(bookRec(6, 0, { done: true, fin: true }));        // 本集听完（结算常带 pos=0）
eq(list(DEV).length, 1, '结算并进当前条，不新建第二条');
ok(list(DEV)[0].done, '这条被标成已播完');
eq(list(DEV)[0].pos, 8, '结算的 pos=0 不抹掉实时位置');
const finPos = list(DEV)[0].pos;
push(bookRec(6, 20));                                  // 集尾之后同集的上报（同集续报）
eq(list(DEV).length, 1, '不再新建（不会每 8 秒刷一条）');
eq(list(DEV)[0].pos, finPos, '播完的位置不被改写');
ok(list(DEV)[0].done, '播完标记保留');

console.log('\n[9] ★v1.7.40 结算落成 done 后，新一集实时上报 ⇒ 复活并跟着走');
reset();
push(bookRec(12, 0, { done: true, fin: true }));       // 结算落下的 pos=0 done（旧版本遗留形态）
push(bookRec(13, 172));                                // 新一集（device 按队列项报 ep=13）
eq(list(DEV).length, 1, '不新建第二条（仍然只有一条同书记录）');
eq(list(DEV)[0].ep, 13, 'ep 前进到真实在播集');
eq(list(DEV)[0].pos, 172, '时间跟着走（不再停在上一集的 0）');
ok(!list(DEV)[0].done, 'done 被撤销（复活成在播）');
push(bookRec(13, 250));
eq(list(DEV)[0].pos, 250, '后续上报继续推进');

console.log('\n[10] 迟到的旧集结算 ⇒ 不把设备快照拉回旧集');
reset();
push(bookRec(13, 250));
push(bookRec(12, 0, { done: true }));                  // 上一集的结算晚到
eq(list(DEV)[0].ep, 13, 'ep 保持 13');
eq(list(DEV)[0].pos, 250, 'pos 保持真实进度');
ok(!list(DEV)[0].done, '不会因为旧集结算就把在播条目标成完成');

console.log('\n[11] 真换集（新集从头）⇒ 新建，不受复活规则影响');
reset();
push(bookRec(13, 320));
push(bookRec(14, 6));                                  // 位置大幅回退 ⇒ 判定新一集
eq(list(DEV).length, 2, '新集新条目');
eq(list(DEV)[0].ep, 14, '顶部是第 14 集');
eq(list(DEV)[1].pos, 320, '上一集位置原样保留');

console.log('\n=== ' + (fail ? '有 ' + fail + ' 项失败' : '全部通过') + '（' + pass + ' 项）===\n');
process.exit(fail ? 1 : 0);

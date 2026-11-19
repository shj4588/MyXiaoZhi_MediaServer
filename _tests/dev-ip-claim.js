'use strict';
/**
 * v1.7.42：R1 播本地节目（/m/ 直链）不带 dev MAC 时，按来源 IP 反查已登记设备。
 *
 *   node _tests/dev-ip-claim.js
 *
 * 背景（2026-11-18 15:01，R1 试播本地书《道诡异仙》）：
 *   ablocal 生成的 /m/ 直链是相对路径、不带 ?dev=<MAC>（只有在线 /r/ 那路由 device 自己加）
 *   ⇒ devIdOf 落到 IP 兜底 ⇒ 播放记录显示成「ip-192.168.2.5 / 网页 / 未报 MAC 的设备」。
 *
 * 覆盖：
 *   ① /m/ 匿名请求 + 来源 IP 命中已登记设备 → 认成该设备 MAC
 *   ② 未知 IP → 仍走 ip-* 兜底（网页用户不受影响）
 *   ③ URL ?dev= / header MAC 仍然最高优先级
 *   ④ 多台设备同 IP → 取最近活跃的那台
 *   ⑤ ip-* / unk 这类伪设备记录不参与反查（否则自己认自己）
 *   ⑥ x-forwarded-for 也参与反查
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'devip-hist-' + process.pid + '.json');
const DGT = path.join(os.tmpdir(), 'devip-dg-' + process.pid + '.json');
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

const R1 = '98BB9936CD6B';
const STEM = '3C84278973A8';

function req(url, headers, remote) {
  return { url: url || '/m/book/a.mp3', headers: headers || {}, socket: { remoteAddress: remote || '192.168.2.5' } };
}

function seed(devs) {
  const h = S.histLoad();
  h.devices = devs;
  h.books = {};
  S.histFlush();
}

console.log('\n[1] /m/ 匿名拉流 + 来源 IP 命中设备 → 认回 MAC');
seed({
  [R1]: { name: 'R1-CD6B', ip: '192.168.2.5', seen: 1794985000000, list: [] },
  'ip-192.168.2.5': { name: '网页 / 未报 MAC 的设备', ip: '192.168.2.5', seen: 1794985000000, list: [] },
});
eq(S.devIdOf(req('/m/book/道诡异仙/01.mp3')), R1, '本地节目匿名拉流认回 R1');
eq(S.devByIp('192.168.2.5'), R1, 'devByIp 直接查询');

console.log('\n[2] 未知 IP → 仍走 ip-* 兜底（网页用户不受影响）');
eq(S.devIdOf(req('/m/book/a.mp3', {}, '192.168.2.15')), 'ip-192.168.2.15', '陌生 IP 保持网页桶');
eq(S.devIdOf(req('/m/book/a.mp3', {}, '192.168.2.15'), {}), 'ip-192.168.2.15', '同上（显式 headers）');

console.log('\n[3] URL ?dev= 与 header MAC 仍是最高优先级');
eq(S.devIdOf(req('/m/a.mp3?dev=' + STEM, {}, '192.168.2.5')), STEM, 'URL dev 优先于 IP 反查');
eq(S.devIdOf(req('/m/a.mp3?dev=' + STEM, { 'x-dev-mac': 'AAAA11112222' }, '192.168.2.5')),
  'AAAA11112222', 'header MAC 优先于 URL dev');

console.log('\n[4] 多台设备同 IP → 取最近活跃的');
seed({
  [R1]: { name: 'R1-CD6B', ip: '192.168.2.5', seen: 1794985000000, list: [] },
  [STEM]: { name: 'STEM', ip: '192.168.2.5', seen: 1794985100000, list: [] },
});
eq(S.devByIp('192.168.2.5'), STEM, '最近活跃那台胜出');

console.log('\n[5] 伪设备（ip-* / unk）不参与反查，避免自己认自己');
seed({
  'ip-192.168.2.5': { name: '网页 / 未报 MAC 的设备', ip: '192.168.2.5', seen: 1794985200000, list: [] },
  unk: { name: 'unk', ip: '192.168.2.5', seen: 1794985200000, list: [] },
});
eq(S.devByIp('192.168.2.5'), '', '只有 ip-*/unk 时反查为空');
eq(S.devIdOf(req('/m/a.mp3')), 'ip-192.168.2.5', '仍然落到网页桶');

console.log('\n[6] x-forwarded-for 也参与反查');
seed({ [R1]: { name: 'R1-CD6B', ip: '192.168.2.5', seen: 1794985300000, list: [] } });
eq(S.devIdOf(req('/m/a.mp3', { 'x-forwarded-for': '192.168.2.5, 10.0.0.1' })), R1, '转发头第一跳命中设备');

console.log('\n[7] 空 / 缺参不炸');
eq(S.devByIp(''), '', '空 IP 返回空串');
eq(S.devByIp('10.9.9.9'), '', '没登记过的 IP 返回空串');

console.log('\n=== ' + (fail ? '有 ' + fail + ' 项失败' : '全部通过') + '（' + pass + ' 项）===\n');
process.exit(fail ? 1 : 0);

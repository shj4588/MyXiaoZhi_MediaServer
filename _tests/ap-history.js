'use strict';
/**
 * 播放记录 / 设备识别 / 续播查表 的纯逻辑回归（不联网、不转码、不碰真实 files/）。
 *
 *   node _tests/ap-history.js
 *
 * 覆盖：
 *   ① devIdOf：MAC 头（带冒号/小写/非法字符）归一化；没头时退化 ip-<地址>
 *   ② histStart/histEnd：位置 = 续播起点 + 实际送出秒数；负数/NaN 归零
 *   ③ histResume：同一本书（关键词部分匹配）能找回来；换一本书不误命中；只认 book
 *   ④ 每台设备最多留 60 条；快照按最近活跃排序、列表裁 20 条
 *   ⑤ 落盘再重读，内容一致（原子写的 tmp+rename 路径也走一遍）
 *   ⑥ v1.7.13 P1 书级共享：books 共享表写入 / 跨设备续播 / 谁新听谁 / fin 下一集 / 落盘重读
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'ap-hist-test-' + process.pid + '.json');
const DGT = path.join(os.tmpdir(), 'ap-grp-test-' + process.pid + '.json');
process.env.HIST_FILE = TMP;
process.env.DG_FILE = DGT;
try { fs.unlinkSync(TMP); } catch { /* 本来就没有 */ }
try { fs.unlinkSync(DGT); } catch { /* 本来就没有 */ }

// ★ v1.7.38：设备分组 —— 把下面跨设备续播用例用到的 MAC 都放进「默认组」，
//   等价于旧版的「全设备共享」；分组隔离另见用例 [14]。必须放在 fresh() 之前
//   （DG_FILE 在 require 时读取，dgLoad 首次调用时加载）。
const TEST_DEVS = ['AAAA11112222', 'BBBB22223333', 'F09E9ECB6FBC', '98BB9936CD6B',
  'CCCC55556666', 'DDDD77778888', 'EEEE99990000', 'FFFF11112222', 'AAAA33334444'];
fs.writeFileSync(DGT, JSON.stringify({
  ver: 1,
  groups: { default: { name: '默认组', system: true, createdAt: 1, devs: TEST_DEVS.slice() } },
}));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b });

const req = (mac, ip) => ({
  headers: mac ? { 'x-dev-mac': mac, 'x-dev-name': 'STEM-客厅' } : {},
  socket: { remoteAddress: ip || '192.168.2.104' },
  url: '/ap/play',
});

function fresh() {
  delete require.cache[require.resolve('../server.js')];
  return require('../server.js');
}

console.log('\n[1] 设备识别');
{
  const S = fresh();
  eq(S.devIdOf(req('f0:9e:9e:cb:6f:bc')), 'F09E9ECB6FBC', 'MAC 归一化成 12 位大写');
  eq(S.devIdOf(req('3c-84-27-89-73-a8')), '3C84278973A8', '连字符也能认');
  eq(S.devIdOf(req('')), 'ip-192.168.2.104', '没报 MAC → ip-<地址>');
  eq(S.devIdOf({ headers: {}, socket: { remoteAddress: '::ffff:10.0.0.9' } }), 'ip-10.0.0.9',
    'IPv4-mapped 地址去掉 ::ffff:');
  ok(S.devIdOf(req('abc')) === 'ip-192.168.2.104', 'MAC 太短（<8 位）不认，退回 IP');
}

console.log('\n[2] 起播 / 结算');
{
  const S = fresh();
  const r1 = req('F0:9E:9E:CB:6F:BC');
  const e = S.histStart(r1, {
    kind: 'book', q: '三体', book: '地球往事Ⅰ', ep: 12, off: 300, title: '第12集',
  });
  ok(e.id && e.ts > 0, '起播立刻有一条记录');
  eq(e.pos, 0, '刚起播 pos=0');
  S.histEnd(e, 61.4);
  eq(e.pos, 361.4, 'pos = 起点 300s + 实际 61.4s');
  eq(e.done, true, '标记 done');

  const e2 = S.histStart(r1, { kind: 'song', q: '周杰伦', title: '晴天' });
  S.histEnd(e2, -5);
  eq(e2.pos, 0, '负秒数归零，不会变成负进度');
  const e3 = S.histStart(r1, { kind: 'radio', q: '中国之声', title: 'CNR-1 中国之声' });
  S.histEnd(e3, undefined);
  eq(e3.pos, 0, 'undefined 秒数同样归零');

  const snap = S.histSnapshot();
  eq(snap.count, 1, '一台 MAC 只算一台设备');
  eq(snap.devices[0].name, 'STEM-客厅', '设备名取固件上报的 X-Dev-Name');
  eq(snap.devices[0].list[0].kind, 'radio', '最近的排在最前');
}

console.log('\n[3] 续播查表');
{
  const S = fresh();
  const r1 = req('F0:9E:9E:CB:6F:BC');
  const e = S.histStart(r1, { kind: 'book', q: '三体', book: '地球往事Ⅰ', ep: 12, off: 0 });
  S.histEnd(e, 734);
  const hit = S.histResume(r1, '三体');
  ok(!!hit && hit.ep === 12, '说「三体」能找回第 12 集', hit && hit.ep);
  ok(!!S.histResume(r1, '地球往事'), '按书名部分匹配也能命中');
  ok(S.histResume(r1, '鬼吹灯') === null, '换一本书不误命中');
  // ★ v1.7.13 P1 书级共享：跨设备只认「书级共享表」（/ap/pos 与起播会同步进去）；
  //   老数据（只有本机记录、没同步过共享表）对其他设备仍不可见 —— 兼容不惊变。
  ok(S.histResume(req('3C:84:27:89:73:A8'), '三体') === null, '共享表为空时其他设备仍看不到（兼容老数据）');

  // 歌不算书：不能拿歌曲关键词去续播
  const s = S.histStart(r1, { kind: 'song', q: '三体主题曲', title: '三体主题曲' });
  S.histEnd(s, 100);
  ok(!!S.histResume(r1, '三体'), '只扫 book 条目，歌曲不干扰');
}

console.log('\n[4] 条数上限 / 快照裁剪');
{
  const S = fresh();
  const r1 = req('AAAA11112222');
  for (let i = 0; i < 70; i++) {
    const e = S.histStart(r1, { kind: 'song', q: 'q' + i, title: 't' + i });
    S.histEnd(e, i);
  }
  const snap = S.histSnapshot();
  eq(snap.devices[0].list.length, 20, '快照只给最近 20 条');
  eq(snap.devices[0].list[0].title, 't69', '最新的在最前');
  // 内存里保留 60 条
  const dev = S.histLoad().devices['AAAA11112222'];
  eq(dev.list.length, 60, '每台设备内存里最多 60 条');
}

console.log('\n[5] 落盘 / 重读');
{
  const S = fresh();
  const r1 = req('AAAA11112222');
  const e = S.histStart(r1, { kind: 'book', q: '三体', book: '地球往事Ⅰ', ep: 7, off: 120 });
  S.histEnd(e, 240);
  S.histFlush();
  ok(fs.existsSync(TMP), '写盘生成了 history.json');
  ok(!fs.existsSync(TMP + '.tmp'), '没有残留 .tmp（rename 成功）');
  const onDisk = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  ok(onDisk.ver === 1 && Object.keys(onDisk.devices).length === 1, '落盘内容结构正确', onDisk);
  eq(onDisk.devices.AAAA11112222.last.pos, 360, '落盘的播放位置 = 120 + 240');

  const S2 = fresh();           // 重新加载模块 = 重新读盘
  const snap2 = S2.histSnapshot();
  ok(snap2.count === 1 && snap2.devices[0].list[0].ep === 7, '重启后记录还在', snap2);
  ok(S2.histResume(r1, '三体').pos === 360, '重启后续播点还是 360s');
}

console.log('\n[6] 自动续播：这集真播完 → 下次从下一集开头');
{
  const S = fresh();
  const r1 = req('BBBB33334444');
  // ① 中途断连（没有 reason）绝不能当成"播完"，否则整本书被跳过一集
  const e = S.histStart(r1, { kind: 'book', q: '凡人修仙传', book: '凡人修仙传', ep: 5 });
  S.histEnd(e, 678);
  ok(!e.fin, '没有 reason 的结算不算"播完"');
  const rm1 = S.histResume(r1, '凡人修仙传');
  eq([rm1.ep, rm1.pos], [5, 678], '中途断连 ⇒ 还是第 5 集、位置保留');

  // ② ffmpeg 自己走完 = 这一集听完
  const e2 = S.histStart(r1, { kind: 'book', q: '凡人修仙传', book: '凡人修仙传', ep: 5 });
  S.histEnd(e2, 690, { reason: 'eof:0' });
  ok(e2.fin === true, 'ffmpeg 自己走完 ⇒ fin');
  const rm2 = S.histResume(r1, '凡人修仙传');
  eq([rm2.ep, rm2.pos, rm2.off, rm2.nextEp], [6, 0, 0, true], '下次续播 = 第 6 集开头（不再回放末尾 10s）');

  // ③ 设备主动断开（切歌/说停）也不算播完
  const e3 = S.histStart(r1, { kind: 'book', q: '凡人修仙传', book: '凡人修仙传', ep: 6 });
  S.histEnd(e3, 400, { reason: 'client-close' });
  ok(!e3.fin, '设备自己断开（client-close）不算播完');
  eq(S.histResume(r1, '凡人修仙传').ep, 6, 'client-close ⇒ 仍在第 6 集');
}

console.log('\n[7] v1.6.3 设备上报的位置才是权威（字节数在本地文件上完全失真）');
{
  const S = fresh();
  const r = req('CCCC55556666');

  // ① 设备这条流：onEnd 的字节数不许写 pos（实测 ss=600 只读 5 秒，字节却等于整集 77 秒）
  const e = S.histStart(r, {
    kind: 'book', q: '凡人修仙传', book: '凡人修仙传', ep: 3, off: 600, pos: 600, dur: 900,
  });
  S.histEnd(e, 77.6, { reason: 'eof:0', trustBytes: false });
  eq(e.pos, 600, 'AlphaPi 流：onEnd 不动 pos（起播点先顶上）');
  ok(!e.fin, 'AlphaPi 流：onEnd 不许判"播完"（只有设备能说）');

  // ② 设备上报绝对位置：625 就是 625，不能再加起播点 600
  e.pos = 600;
  const abs = 625;
  e.pos = Math.min(abs, e.dur);       // 等价于 /ap/pos 的处理
  e.devsync = true;
  eq(e.pos, 625, '设备上报是"集内绝对位置"，不叠加起播点');

  // ③ 设备说了"本集播完" ⇒ 下次续播下一集；随后 onEnd 再来也不许改
  e.fin = true; e.paused = true;
  S.histEnd(e, 2400, { reason: 'eof:0' });
  eq([e.pos, e.fin], [625, true], 'devsync 之后 onEnd 完全无效');
  eq([S.histResume(r, '凡人修仙传').ep, S.histResume(r, '凡人修仙传').nextEp], [4, true],
    '设备报 fin ⇒ 下次续播第 4 集开头');

  // ④ 旧版污染数据（pos 贴到集尾甚至超出时长）⇒ 当成本集听完，不许 -ss 到文件外
  const S2 = fresh();
  const r2 = req('DDDD77778888');
  const bad = S2.histStart(r2, {
    kind: 'book', q: '凡人修仙传', book: '凡人修仙传', ep: 2, off: 0, pos: 999, dur: 899,
  });
  bad.pos = 999; bad.done = true;
  const rm = S2.histResume(r2, '凡人修仙传');
  eq([rm.ep, rm.nextEp, rm.off], [3, true, 0], 'pos ≥ 时长-3 ⇒ 视为听完，续下一集');

  // ⑤ 没有任何历史 ⇒ null（调用方退回本地库 lastEp）
  eq(S2.histResume(r2, '不存在的书'), null, '查不到就返回 null');
}

console.log('\n[8] v1.6.4 断电兜底：设备一条上报都没发出来时不许整段丢掉');
{
  const S = fresh();
  const r = req('EEEE99990000');

  // ① 听 40 分钟后被拔电：socket 不再消费 → ffmpeg 被背压停住 → 空闲看门狗 20s 后杀。
  //    字节数早就等于整集（ffmpeg 转本地文件远快于实时），必须被墙钟钳住。
  const e = S.histStart(r, {
    kind: 'book', q: '凡人修仙传', book: '凡人修仙传', ep: 7, off: 0, pos: 0, dur: 3000,
  });
  S.histEnd(e, 3000, { reason: '空闲 20000ms 无数据', trustBytes: false, wall: 2421 });
  eq([Math.round(e.pos), e.est], [2400, 'wall'], '断电：按 wall−20s 估位置，不用失真字节数');
  ok(!e.fin, '断电兜底不许判"播完"（下次还要继续这一集）');
  const rm = S.histResume(r, '凡人修仙传');
  eq([rm.ep, Math.round(rm.pos)], [7, 2400], '续播仍在这一集，位置≈断电前');

  // ② 设备发过心跳（/ap/pos?beat=1）⇒ 心跳值才是权威，墙钟兜底必须让位
  const S2 = fresh();
  const r2 = req('FFFF11112222');
  const e2 = S2.histStart(r2, {
    kind: 'book', q: '三体', book: '三体', ep: 2, off: 0, pos: 0, dur: 3000,
  });
  e2.pos = 1800; e2.devsync = true;     // ← 最后一次 30s 心跳写到这里
  S2.histEnd(e2, 3000, { reason: '空闲 20000ms 无数据', trustBytes: false, wall: 3000 });
  eq(e2.pos, 1800, '有心跳时以心跳为准，墙钟兜底不许覆盖');

  // ③ wall 比字节数还小（几秒转完整集、连接随后就断）⇒ 取较小值，别记成整集
  const S3 = fresh();
  const r3 = req('AAAA33334444');
  const e3 = S3.histStart(r3, {
    kind: 'book', q: '明朝那些事儿', book: '明朝那些事儿', ep: 1, off: 0, pos: 0, dur: 3000,
  });
  S3.histEnd(e3, 3000, { reason: 'eof:0', trustBytes: false, wall: 6 });
  eq(Math.round(e3.pos), 5, 'wall 只有 6s ⇒ 位置按 5s 记，不按整集');
}

try { fs.unlinkSync(TMP); } catch { /* ignore */ }

console.log('\n[9] 位置是否到集尾（apFinSane；v1.6.6 起只用于决定是否校正 pos）');
{
  const S = fresh();
  ok(S.apFinSane(true, 824, 828) === true, 'pos 离集尾 4s ⇒ 到尾');
  ok(S.apFinSane(true, 828, 828) === true, '正好在集尾 ⇒ 到尾');
  ok(S.apFinSane(true, 410, 828) === false, '410/828 ⇒ 没到尾');
  ok(S.apFinSane(true, 0, 0) === true, '不知道时长 ⇒ 不校正');
  ok(S.apFinSane(false, 500, 828) === false, 'fin=0 不适用');
}

console.log('\n[10] fin 不再被 pos 拦（v1.6.6：真播完一定能跳下一集）');
{
  const S = fresh();
  const e = { ep: 6, dur: 828, pos: 602, fin: false, done: false, paused: false };
  const r = S.apApplyPos(e, 602, true);
  ok(r.fin === true && r.corrected === true, 'pos=602/828 偏小 ⇒ 校正但不否定 fin');
  ok(e.fin === true && e.done === true && e.paused === true, 'fin/done/paused 全部落库');
  eq(e.pos, 828, '位置校正到集尾 828s');
  const e2 = { ep: 7, dur: 828, pos: 824, fin: false };
  const r2 = S.apApplyPos(e2, 824, true);
  ok(r2.corrected === false && e2.fin === true, 'pos 已到尾 ⇒ 不校正，fin 照记');
  eq(e2.pos, 824, '原位置保持');
  const e3 = { ep: 8, dur: 0, pos: 100, fin: false };
  S.apApplyPos(e3, 100, true);
  ok(e3.fin === true, '在线书 dur 未知 ⇒ 仍信设备 fin');
  eq(e3.pos, 100, 'dur 未知时不动位置');
  const e4 = { ep: 9, dur: 828, pos: 300, fin: false };
  S.apApplyPos(e4, 300, false);
  ok(e4.fin === false && e4.done === undefined, 'fin=0 ⇒ 不写任何收场字段');
}

console.log('\n[11] 集尾起点夹值（v1.6.8：dur-3，不是 dur-30）');
{
  const S = fresh();
  eq(S.apSeekClamp(769, 771), 768, '769/771 ⇒ 只倒回 1s（旧逻辑会夹到 741）');
  eq(S.apSeekClamp(741, 771), 741, '集尾前的正常起点不动');
  eq(S.apSeekClamp(900, 771), 768, '远超集尾 ⇒ 768，仍留 3s 音频不会零字节');
  eq(S.apSeekClamp(720, 771), 720, '用户「跳到第十二分钟」不受影响');
  eq(S.apSeekClamp(10, 2), 0, '极短集 ⇒ 0，不产生负偏移');
  eq(S.apSeekClamp(-5, 771), 0, '负数 ⇒ 0');
  eq(S.apSeekClamp(769, 0), 769, 'dur 未知（在线书）⇒ 不夹');
}

console.log('\n[8] v1.7.13 P1 书级共享：换台设备接着听');
{
  const S = fresh();
  const rA = req('AAAA11112222');
  const rB = req('BBBB22223333');
  // ① 设备 A 在听（模拟 /ap/pos 同步进书级共享表）
  S.histBookSave({ book: '三体', q: '三体', ep: 30, pos: 600, dur: 1500, title: '第30集', dev: 'AAAA11112222' });
  const rb = S.histResume(rB, '三体');
  ok(!!rb && rb.shared === true, 'B 无本机记录 ⇒ 直接吃书级共享', rb && rb.shared);
  eq([rb.ep, Math.round(rb.pos)], [30, 600], 'B 从 A 最近听的位置接着播');
  ok(!S.histResume(rB, '鬼吹灯'), '没听过的书不吃共享');

  // ② A 自己也有本机记录时：谁新听谁（A 刚起播 ⇒ 本机记录更新）
  const eA = S.histStart(rA, { kind: 'book', q: '三体', book: '三体', ep: 12, off: 0 });
  S.histEnd(eA, 100);
  const rm = S.histResume(rA, '三体');
  eq([rm.ep, Math.round(rm.pos)], [12, 100], 'A 本机记录更新 ⇒ A 用自己的（不受共享表旧值拖走）');

  // ③ 共享表记了「本集听完」⇒ 另一台设备从下一集开头
  S.histBookSave({ book: '三体', q: '三体', ep: 30, pos: 1500, dur: 1500, fin: true, dev: 'AAAA11112222' });
  const rb2 = S.histResume(rB, '三体');
  eq([rb2.ep, rb2.pos, rb2.nextEp], [31, 0, true], 'B 听到共享 fin ⇒ 从第 31 集开头');

  // ④ 快照给 Web：书级进度按最近上报倒序
  const books = S.histBooksSnapshot();
  ok(books.length >= 1 && books[0].book === '三体', 'histBooksSnapshot 有书级条目', books.length);
  ok(books[0].fin === true && books[0].dev === 'AAAA11112222', '快照带 fin / 最后收听的设备');

  // ⑤ 落盘再重读：books 字段跟着走，跨重启仍可换设备续播
  S.histFlush();
  const onDisk = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  ok(onDisk.books && onDisk.books['g:default|三体'], 'books 字段落盘（v1.7.38 起键带组前缀）');
  const S2 = fresh();
  const rb3 = S2.histResume(rB, '三体');
  ok(!!rb3 && rb3.nextEp === true, '重启后 B 仍能吃共享续播');
}


console.log('\n[7] v1.7.27 P1 收尾：song/radio 共享表 + kind 过滤 + stream 补位置');
{
  const S = fresh();
  const rA = req('AAAA11112222');
  const rB = req('BBBB22223333');

  // ① song 写共享表（ep=第几首 1 基），song 续播返回 idx（0 基）
  S.histBookSave({ book: '周杰伦精选', q: '周杰伦精选', kind: 'song', ep: 3, pos: 0,
    fin: false, title: '七里香', tracks: ['七里香', '晴天'], dev: 'AAAA11112222' });
  const rs = S.histResumeShared('周杰伦精选', 'song');
  ok(!!rs && rs.kind === 'song' && rs.idx === 2, 'song 共享命中：ep=3 → idx=2', rs);
  ok(rs && rs.title === '七里香', 'song 共享带 title');
  // ② book 读端不吃 song 条目（防串台）
  ok(S.histResumeShared('周杰伦精选', 'book') === null, 'book 查询不命中 song 条目');

  // ③ radio 落共享表（ep=0）
  S.histBookSave({ book: '中国之声', q: '中国之声', kind: 'radio', ep: 0, pos: 0,
    fin: false, title: '中国之声', dev: 'BBBB22223333' });
  ok(!!S.histResumeShared('中国之声', 'radio'), 'radio 共享命中');
  ok(S.histResumeShared('中国之声', 'book') === null, 'book 查询不命中 radio 条目');

  // ④ 直链 stream 记录补位置：/r/ 起播事实 → /v1/pos 反查补 pos/fin
  const se = S.histStart(rA, { kind: 'book', q: '遮天', book: '遮天', ep: 260,
    title: '第260集', source: 'kw', rid: '95769', dur: 0 });
  se.stream = true;
  const bf = S.histBackfillStream('AAAA11112222', { q: '遮天', ep: 260, pos: 512, dur: 900, fin: false });
  ok(!!bf && bf.pos === 512 && bf.dur === 900, 'stream 记录补上 pos/dur', bf);
  ok(bf && bf.devsync === true && bf.bf === 1, '补过的记录带 devsnc/bf 标记');
  const bf2 = S.histBackfillStream('AAAA11112222', { q: '遮天', ep: 260, pos: 899, fin: true });
  ok(!!bf2 && bf2.fin === true && bf2.done === true, 'fin 上报也补进 stream 记录');
  // ⑤ 集号对不上不补（避免把 A 集的位置写到 B 集头上）
  S.histStart(rB, { kind: 'book', q: '遮天', book: '遮天', ep: 5, title: '第5集' }).stream = true;
  ok(S.histBackfillStream('BBBB22223333', { q: '遮天', ep: 6, pos: 100 }) === null,
    '集号不同不补');
  // ⑥ 共享表书名同名歌/书互不干扰（键 kind 前缀）
  S.histBookSave({ book: '平凡的世界', q: '平凡的世界', ep: 8, pos: 300, fin: false, dev: 'AAAA11112222' });
  const rbk = S.histResumeShared('平凡的世界', 'book');
  ok(rbk && rbk.ep === 8 && rbk.pos === 300, 'book 条目照常读写（无 kind 键前缀兼容历史）');
  const rsd = S.histResume(rA, '周杰伦精选', 'song');
  ok(!!rsd && rsd.kind === 'song' && rsd.idx === 2, 'histResume 透传 wantKind=song');
}

console.log('\n[12] v1.7.28 直链补位置的 IP 兜底（stream 记录在 ip-* 名下，/v1/pos 报的是 MAC）');
{
  const S = fresh();
  // ① R1 的 /r/ 直链：无 MAC 头 → stream 记录落在 ip-192.168.2.5 名下
  const se = S.histStart(req('', '192.168.2.5'), { kind: 'book', q: '仙逆', book: '仙逆',
    ep: 202, title: '第202集', source: 'kw', rid: '95769', dur: 0 });
  se.stream = true;
  // ② /v1/pos 带 body.devId（MAC），请求来自同一 IP → 兜底命中补位置
  const posReq = { headers: {}, socket: { remoteAddress: '192.168.2.5' }, url: '/v1/pos' };
  const bf = S.histBackfillStreamAuto('98BB9936CD6B', posReq,
    { q: '仙逆', ep: 202, pos: 175, dur: 800, fin: false });
  ok(!!bf && bf.pos === 175 && bf.dur === 800, 'MAC 查不到 → 按来源 ip- 兜底补上 pos/dur', bf);
  ok(bf && bf.bf === 1 && bf.devsync === true, '兜底补的记录同样带 bf/devsync 标记');
  // ③ IP 也不同（真·别的设备）→ 不补
  const farReq = { headers: {}, socket: { remoteAddress: '10.0.0.88' }, url: '/v1/pos' };
  ok(S.histBackfillStreamAuto('98BB9936CD6B', farReq, { q: '仙逆', ep: 202, pos: 300 }) === null,
    '来源 IP 对不上 stream 记录归属 ⇒ 不补');
  // ④ body.devId 本来就能命中时直接命中，不绕兜底
  const se2 = S.histStart(req('98BB9936CD6B'), { kind: 'song', q: '周杰伦精选', ep: 3 });
  se2.stream = true;
  const bf2 = S.histBackfillStreamAuto('98BB9936CD6B',
    { headers: { 'x-dev-mac': '98BB9936CD6B' }, socket: { remoteAddress: '192.168.2.5' } },
    { q: '周杰伦精选', pos: 60 });
  ok(!!bf2 && bf2.pos === 60, 'MAC 直接命中（song 无 ep 门）⇒ 不走兜底', bf2);
}

console.log('\n[13] v1.7.29 共享表 dur 不跨集继承（R1 播 ep17 13:23 被误判「已听完」跳 ep18）');
{
  const S = fresh();
  // ① stem 报 ep16 带 dur=799（R1 换设备前最后一次带时长的上报）
  S.histBookSave({ book: '凡人修仙传', q: '凡人修仙传', ep: 16, pos: 504,
    dur: 799, fin: false, dev: 'F09E9ECB6FBC' });
  // ② R1 接着播 ep17，不带 dur（R1 没有可靠集时长源）—— dur 必须清零，不许继承 799
  S.histBookSave({ book: '凡人修仙传', q: '凡人修仙传', ep: 17, pos: 803,
    fin: false, dev: '98BB9936CD6B' });
  const r1 = S.histResumeShared('凡人修仙传', 'book');
  ok(r1 && r1.ep === 17 && r1.pos === 803 && !(r1.dur > 0 && r1.pos >= r1.dur - 3),
    '换集后 dur=0：pos=803 不再被旧 dur=799 误判成「已听完」', r1);
  ok(r1 && !r1.nextEp, 'nextEp 不触发（ep17 还没听完）');
  // ③ 同集后续不带 dur 的周期报不抹掉带 dur 报写下的值
  S.histBookSave({ book: '凡人修仙传', q: '凡人修仙传', ep: 17, pos: 810,
    dur: 850, fin: false, dev: 'F09E9ECB6FBC' });
  S.histBookSave({ book: '凡人修仙传', q: '凡人修仙传', ep: 17, pos: 815,
    fin: false, dev: '98BB9936CD6B' });
  const r2 = S.histResumeShared('凡人修仙传', 'book');
  ok(r2 && r2.dur === 850 && r2.pos === 815, '同集：无 dur 上报保住已有 dur，pos 正常推进', r2);
  // ④ 真·听完（fin）照常跳下一集
  S.histBookSave({ book: '凡人修仙传', q: '凡人修仙传', ep: 17, pos: 0,
    fin: true, dev: '98BB9936CD6B' });
  const r3 = S.histResumeShared('凡人修仙传', 'book');
  ok(r3 && r3.ep === 18 && r3.pos === 0 && r3.nextEp === true, '显式 fin=1 照常 nextEp → ep18', r3);
}

console.log('\n[14] v1.7.38 设备分组：同组共享 / 异组隔离 / 未分组独立');
{
  const S = fresh();
  // ① 未分组设备 = 独立组，看不到默认组的共享进度
  const rOut = req('111122223333');
  ok(S.devGroupId('111122223333') === 'solo:111122223333', '未分组设备 → solo 独立组');
  ok(S.histResume(rOut, '三体') === null, '独立组看不到默认组的书级进度');

  // ② 把它加进默认组 → 立刻可见（同组共享）
  S.dgLoad().groups.default.devs.push('111122223333');
  S.dgFlush();
  const S2 = fresh();
  ok(S2.devGroupId('111122223333') === 'default', '加入后 → 默认组');
  ok(!!S2.histResume(rOut, '三体'), '同组设备能看到共享进度');

  // ③ 建新组并把它挪过去 → 新组没有这本书的进度，默认组仍在
  const d = S2.dgLoad();
  d.groups.g_test = { name: '卧室', devs: ['111122223333'], createdAt: 2 };
  d.groups.default.devs = d.groups.default.devs.filter(x => x !== '111122223333');
  S2.dgFlush();
  const S3 = fresh();
  ok(S3.devGroupId('111122223333') === 'g_test', 'devGroupId 命中显式组');
  ok(S3.histResume(rOut, '三体') === null, '换到新组后与默认组隔离');
  ok(!!S3.histResumeShared('三体', 'book', 'default'), '默认组自己的进度不受影响');
  ok(S3.histResumeShared('三体', 'book', 'g_test') === null, '新组查不到默认组的进度');

  // ④ 匿名读（识别不出设备）退回全组 —— 保证 R1 现行 /v1/resume 续播不断
  const anon = { headers: {}, socket: { remoteAddress: '172.18.0.1' }, url: '/v1/resume?q=x' };
  ok(S3.reqGroupId(anon) === null, '匿名请求不按组过滤（R1 续播兼容）');
  ok(!!S3.histResumeShared('三体', 'book'), '不传组 → 全组取最新（旧行为）');
}

console.log('\n[15] v1.7.38 dgInit 迁移：旧 books 键加默认组前缀');
{
  const S = fresh();
  const d = S.histLoad();
  d.books['旧书无组键'] = { book: '旧书无组键', q: '旧书无组键', kind: 'book', ep: 5, pos: 100, at: 1 };
  S.histFlush();
  S.dgInit();
  const d2 = S.histLoad();
  const nk = 'g:default|旧书无组键';
  ok(!d2.books['旧书无组键'], '旧键已删除（不再残留在全局）');
  ok(!!d2.books[nk] && d2.books[nk].grp === 'default', '迁到 g:default|旧书无组键 且带 grp');
  eq([d2.books[nk].ep, d2.books[nk].pos], [5, 100], '迁移保留原 ep/pos');
}

try { fs.unlinkSync(DGT); } catch { /* ignore */ }

console.log('\n=== ' + (fail ? '有 ' + fail + ' 项失败' : '全部通过') + '（' + pass + ' 项）===\n');
process.exit(fail ? 1 : 0);

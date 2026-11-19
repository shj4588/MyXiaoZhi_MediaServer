'use strict';
/**
 * v1.7.31 播放记录来源五分类 的纯逻辑回归（不联网、不转码、不碰真实 files/）。
 *
 *   node _tests/src-label.js
 *
 * 覆盖：
 *   ① 五类标签映射：英文码 ⇄ 中文标签，未知返回空（绝不猜成在线音乐）
 *   ② srcOf / withSrc：起播入口显式 src 优先；老记录按 kind 兜底
 *   ③ radioMatchUrl：权威电台表的精确 / 解码 / 去 query / 本机代理地址 匹配
 *   ④ srcFromUrl：电台、本地节目/音乐、在线节目/音乐 的判定
 *   ⑤ 落盘记录：histStart / histBookSave 写 src+srcLabel，快照对老记录补标签
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'src-label-test-' + process.pid + '.json');
process.env.HIST_FILE = TMP;
try { fs.unlinkSync(TMP); } catch { /* 本来就没有 */ }

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b });

function fresh() {
  delete require.cache[require.resolve('../server.js')];
  return require('../server.js');
}
const req = {
  headers: { 'x-dev-mac': 'AA:BB:CC:DD:EE:FF', 'x-dev-name': 'R1-TEST' },
  socket: { remoteAddress: '192.168.2.5' },
  url: '/ap/play',
};

console.log('\n[1] 五类标签映射');
{
  const S = fresh();
  eq(Object.keys(S.SRC_LABELS).sort(),
    ['local_music', 'local_program', 'online_music', 'online_program', 'radio'].sort(),
    '五类英文码齐全');
  eq(S.SRC_LABELS.online_music, '在线音乐', '在线音乐');
  eq(S.SRC_LABELS.online_program, '在线节目', '在线节目');
  eq(S.SRC_LABELS.local_music, '本地音乐', '本地音乐');
  eq(S.SRC_LABELS.local_program, '本地节目', '本地节目');
  eq(S.SRC_LABELS.radio, '广播电台', '广播电台');
  eq(S.srcNorm('广播电台'), 'radio', '中文标签能反向归一');
  eq(S.srcNorm('online_program'), 'online_program', '英文码原样接受');
  eq(S.srcNorm('随便写的'), '', '未知标签不猜');
  eq(S.srcNorm(''), '', '空标签保持空');
}

console.log('\n[2] srcOf / withSrc');
{
  const S = fresh();
  eq(S.srcOf({ kind: 'radio', live: true }), 'radio', '电台起播 → 广播电台');
  eq(S.srcOf({ kind: 'book' }), 'online_program', '书默认 → 在线节目');
  eq(S.srcOf({ kind: 'book', local: true }), 'local_program', '本地书 → 本地节目');
  eq(S.srcOf({ kind: 'book', source: 'abl' }), 'local_program', 'via=abl 的书 → 本地节目');
  eq(S.srcOf({ kind: 'song' }), 'online_music', '歌默认 → 在线音乐');
  eq(S.srcOf({ kind: 'song', local: true }), 'local_music', '本地歌 → 本地音乐');
  eq(S.srcOf({ kind: 'unknown' }), '', '未知 kind 不硬标');
  const w = S.withSrc({ kind: 'song', q: '晴天' }, '本地音乐');
  eq(w.src, 'local_music', '显式中文标签覆盖 kind 推断');
  eq(w.srcLabel, '本地音乐', '同时补齐中文标签');
  eq(w.q, '晴天', '原字段不丢');
  eq(S.withSrc({ kind: 'book' }, '瞎写').src, 'online_program', '显式值不认识时退回 kind');
}

console.log('\n[3] 权威电台表匹配');
{
  const S = fresh();
  const rp = require('../radioproxy');
  const list = [
    { name: '中国之声', url: 'http://example.com/live/cnr.mp3' },
    { name: 'AsiaFM', url: 'https://radio.asia.fm/64k.mp3' },
  ];
  ok(!!S.radioMatchUrl('http://example.com/live/cnr.mp3', list), '精确 URL 命中');
  ok(!!S.radioMatchUrl('http://example.com/live/cnr.mp3?t=123', list), '多了 query 也命中');
  ok(!!S.radioMatchUrl('HTTPS://RADIO.ASIA.FM/64K.MP3/', list), '大小写 / 末尾斜杠不敏感');
  ok(!S.radioMatchUrl('http://example.com/live/other.mp3', list), '别的流不误认成电台');
  ok(!S.radioMatchUrl('', list), '空地址不认');
  const proxied = '/radio/' + rp.encTarget('http://example.com/live/cnr.mp3');
  ok(!!S.radioMatchUrl(proxied, list), '本机 /radio/<b64> 代理地址能解回原始流');
}

console.log('\n[4] srcFromUrl 判定');
{
  const S = fresh();
  const radios = [{ name: '中国之声', url: 'http://example.com/live/cnr.mp3' }];
  const books = [{ book: '仙逆', source: 'kw', list: [{ ep: 1, rid: '29965186' }] }];
  let r = S.srcFromUrl('http://example.com/live/cnr.mp3', '', radios, books);
  eq([r.src, r.radio, r.via], ['radio', true, 'radio-list'], '电台流 → 广播电台');
  r = S.srcFromUrl('http://192.168.2.14:8100/m/有声书/仙逆-第3集-questions.m4a', '', radios, books);
  eq(r.src, 'local_program', '带「第N集」的 /m/ → 本地节目');
  r = S.srcFromUrl('http://192.168.2.14:8100/m/music/晴天.mp3', '', radios, books);
  eq(r.src, 'local_music', '普通 /m/ → 本地音乐');
  r = S.srcFromUrl('http://192.168.2.14:8100/r/kw/29965186', '', radios, books);
  eq(r.src, 'online_program', 'rid 命中缓存书 → 在线节目');
  r = S.srcFromUrl('http://192.168.2.14:8100/r/kw/99999999', '', radios, books);
  eq(r.src, 'online_music', 'rid 不在书缓存 → 在线音乐');
  r = S.srcFromUrl('', '仙逆', radios, books);
  eq(r.src, 'online_program', '只有书名时按缓存匹配 → 在线节目');
  r = S.srcFromUrl('', '', radios, books);
  eq(r.src, '', '啥都没有时留空，不乱标');
}

console.log('\n[5] 记录落盘与快照兼容');
{
  const S = fresh();
  const e = S.histStart(req, { kind: 'radio', q: '中国之声', title: '中国之声', src: 'radio' });
  eq(e.src, 'radio', '起播落 radio');
  eq(e.srcLabel, '广播电台', '起播落中文标签');
  S.histBookSave({ book: '仙逆', q: '仙逆', ep: 3, pos: 12, dev: 'R1', src: 'local_program' });
  const snap = S.histSnapshot();
  eq(snap.devices[0].list[0].srcLabel, '广播电台', '/api/history 设备记录带中文标签');
  const books = S.histBooksSnapshot().filter(x => x.book === '仙逆');
  eq(books.length && books[0].srcLabel, '本地节目', '/v1/history 书级记录带中文标签');
  // 老记录（无 src）读端兜底
  const d = S.histLoad();
  d.devices['OLD'] = { name: 'OLD', list: [{ kind: 'song', q: '晴天', title: '晴天' }], last: null };
  S.histFlush();
  const old = S.histSnapshot().devices.find(x => x.id === 'OLD');
  eq(old.list[0].srcLabel, '在线音乐', '老记录读端按 kind 补标签');
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

/**
 * v1.7.36 回归：stream 播放记录「真播才落」判据（纯函数，不联网、不碰 history.json）。
 * 覆盖：探活/预取只拿几 KB ⇒ 不落；真播拉够字节 ⇒ 落；阈值可覆盖/异常回退默认。
 */
const S = require('../server.js');

let pass = 0, fail = 0;
function eq(got, want, name) {
  if (got === want) { pass++; }
  else { fail++; console.error('FAIL ' + name + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
}
const DEF = 256 * 1024;

// 1. 探活/预取：几 KB 就断 ⇒ 不落
eq(S.shouldCommitPlay(0, DEF), false, '0 字节（HEAD）不落');
eq(S.shouldCommitPlay(512, DEF), false, '512B 探测不落');
eq(S.shouldCommitPlay(4 * 1024, DEF), false, '4KB 格式探测不落');
eq(S.shouldCommitPlay(64 * 1024, DEF), false, '64KB 预取不落');
eq(S.shouldCommitPlay(255 * 1024, DEF), false, '差 1KB 到阈值仍不落');
// 2. 真播：拉够字节 ⇒ 落
eq(S.shouldCommitPlay(256 * 1024, DEF), true, '恰好阈值落');
eq(S.shouldCommitPlay(300 * 1024, DEF), true, '超阈值落');
eq(S.shouldCommitPlay(3 * 1024 * 1024, DEF), true, '真播几 MB 落');
// 3. 自定义阈值（files/play_commit_bytes 场景）
eq(S.shouldCommitPlay(10 * 1024, 8 * 1024), true, '自定义低阈值 8KB：10KB 落');
eq(S.shouldCommitPlay(4 * 1024, 8 * 1024), false, '自定义低阈值 8KB：4KB 不落');
// 4. 异常/缺省阈值 ⇒ 回退默认 256KB
eq(S.shouldCommitPlay(300 * 1024, 0), true, '阈值 0 回退默认：300KB 落');
eq(S.shouldCommitPlay(100 * 1024, 0), false, '阈值 0 回退默认：100KB 不落');
eq(S.shouldCommitPlay(300 * 1024, -1), true, '阈值负数回退默认：300KB 落');
eq(S.shouldCommitPlay(300 * 1024, NaN), true, '阈值 NaN 回退默认：300KB 落');
// 5. 非法字节数不落
eq(S.shouldCommitPlay(NaN, DEF), false, 'NaN 字节不落');
eq(S.shouldCommitPlay(undefined, DEF), false, 'undefined 字节不落');
eq(S.shouldCommitPlay(-1, DEF), false, '负数字节不落');

console.log('play-commit: ' + pass + ' pass, ' + fail + ' fail');
if (fail) process.exit(1);

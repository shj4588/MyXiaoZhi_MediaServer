/**
 * v1.7.37 回归：stream 播放记录「真播才落」——R1 拉流必须带 live=1（纯函数，不联网）。
 * 规则：URL 带 dev=<MAC>（R1 拉流特征）⇒ 必须同时带 live=1 才算真播；
 *       不带 dev 的老客户端（stem / 网页 / 未升级 R1）⇒ 放行，走原逻辑。
 */
const S = require('../server.js');

let pass = 0, fail = 0;
function eq(got, want, name) {
  if (got === want) { pass++; }
  else { fail++; console.error('FAIL ' + name + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
}
function req(url) { return { url, method: 'GET', headers: {} }; }

// 1. R1 拉流（带 dev）：真播带 live ⇒ 落
eq(S.isLiveCommit(req('/r/kw/668627?dev=98BB9936CD6B&live=1')), true,  'R1 真播(live=1)落');
eq(S.isLiveCommit(req('/m/music/a.mp3?dev=98BB9936CD6B&live=1')), true, 'R1 本地真播(live=1)落');
eq(S.isLiveCommit(req('/r/kw/x?dev=98BB9936CD6B&title=a&artist=b&live=1')), true, 'R1 带其它 query + live 落');
// 2. R1 拉流：预取/探活无 live ⇒ 不落
eq(S.isLiveCommit(req('/r/kw/668627?dev=98BB9936CD6B')), false,           'R1 预取(无 live)不落');
eq(S.isLiveCommit(req('/r/kw/668627?dev=98BB9936CD6B&live=0')), false,    'R1 live=0 不落');
eq(S.isLiveCommit(req('/r/kw/668627?dev=98BB9936CD6B&live=2')), false,    'R1 live=2 不落');
eq(S.isLiveCommit(req('/m/music/a.mp3?dev=98BB9936CD6B&title=x')), false, 'R1 本地预取(无 live)不落');
// 3. 老客户端（无 dev）：无论有没有 live 都放行，保持原行为
eq(S.isLiveCommit(req('/r/kw/668627')), true,                  'stem/网页 /r/ 无 dev ⇒ 放行');
eq(S.isLiveCommit(req('/m/music/a.mp3')), true,                'stem/网页 /m/ 无 dev ⇒ 放行');
eq(S.isLiveCommit(req('/r/kw/668627?title=x&artist=y')), true, '无 dev 带其它 query ⇒ 放行');
// 4. dev 存在但空值 ⇒ 视为无 dev（老逻辑放行）
eq(S.isLiveCommit(req('/r/kw/x?dev=')), true,                  'dev 空值 ⇒ 非 R1，放行');
// 5. HEAD 探活仍由 isPlayProbe 单独拦（这里只验 live 判据本身）
eq(S.isPlayProbe({ method: 'HEAD', url: '/r/x' }), true,  'HEAD = 探活');
eq(S.isPlayProbe({ method: 'GET', url: '/r/x' }), false, 'GET 非探活');
// 6. 异常 URL 不崩，放行
eq(S.isLiveCommit(req('')), true, '空 URL 放行');
eq(S.isLiveCommit({}), true, '无 url 字段放行');

console.log('live-commit: ' + pass + ' pass, ' + fail + ' fail');
if (fail) process.exit(1);

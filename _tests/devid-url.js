/**
 * v1.7.35 回归：R1 拉流 URL 的 dev 参数认领（不联网、不碰真实 history.json）。
 * 覆盖：header MAC 优先 > URL dev > IP 兜底；dev 只认 8~12 位十六进制；
 *       devName 只从 query 取、不污染；大小写/分隔符归一化。
 */
const S = require('../server.js');

let pass = 0, fail = 0;
function eq(got, want, name) {
  if (got === want) { pass++; }
  else { fail++; console.error('FAIL ' + name + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
}

function req(url, headers, remote) {
  return {
    url: url || '/r/kw/123',
    headers: headers || {},
    socket: { remoteAddress: remote || '172.23.0.1' },
  };
}

// 1. 无 dev 无 MAC → IP 兜底
eq(S.devIdOf(req('/r/kw/123', {})), 'ip-172.23.0.1', '无身份 → IP 兜底');
// 2. URL dev 认领（12 位大写）
eq(S.devIdOf(req('/r/kw/123?dev=98BB9936CD6B&title=x', {})), '98BB9936CD6B', 'URL dev → 认领 MAC');
// 3. URL dev 小写 + 分隔符 → 归一化大写取前 12
eq(S.devIdOf(req('/m/book/a.mp3?dev=98:bb:99:36:cd:6b', {})), '98BB9936CD6B', 'dev 小写带冒号归一化');
// 4. header MAC 优先于 URL dev
eq(S.devIdOf(req('/r/kw/1?dev=AAAAAAAAAAAA', { 'x-dev-mac': 'BB-BB-BB-BB-BB-BB' })),
   'BBBBBBBBBBBB', 'header MAC 优先于 URL dev');
// 5. dev 太短（<8 位十六进制）→ 不认，退 IP
eq(S.devIdOf(req('/r/kw/1?dev=ABC', {})), 'ip-172.23.0.1', 'dev 太短不认');
// 6. dev 含非十六进制字符被剥离后不足 8 位 → 不认
eq(S.devIdOf(req('/r/kw/1?dev=ZZZZZZZZ', {})), 'ip-172.23.0.1', 'dev 全非十六进制不认');
// 7. x-forwarded-for 优先于 socket（多跳网关取第一个）
eq(S.devIdOf(req('/r/kw/1', { 'x-forwarded-for': '10.0.0.9, 172.23.0.1' })),
   'ip-10.0.0.9', 'x-forwarded-for 取第一跳');
// 8. 带 dev 但同时有转发头 → dev 仍优先（设备认领不被网关覆盖）
eq(S.devIdOf(req('/r/kw/1?dev=98BB9936CD6B', { 'x-forwarded-for': '172.23.0.1' })),
   '98BB9936CD6B', 'dev 优先于转发头');
// 9. URL 无 ? （devName 场景不干扰）
eq(S.devIdOf(req('/index.json', {})), 'ip-172.23.0.1', '无 query 正常兜底');

console.log('devid-url: ' + pass + ' pass, ' + fail + ' fail');
if (fail) process.exit(1);

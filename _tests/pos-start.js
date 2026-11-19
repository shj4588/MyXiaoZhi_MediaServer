'use strict';
/**
 * v1.7.44 起播即上报 —— /v1/pos 的「pos<5s 不落账」只拦匿名上报，带 devId 的放行。
 *
 *   node _tests/pos-start.js
 *
 * 背景（2026-11-18 15:45）：
 *   device 1.3.349 起播那一拍就报 /v1/pos（pos 常常是 0~2 秒），为的是让播放记录
 *   立刻出现，不用再等 15 秒周期。但服务端 v1.7.17 加的 `pos<5s 不落账` 会把它整条
 *   丢掉 —— 那道门槛当年防的是网页那路的匿名上报（拿旧集号 + pos=0 把进度打回 0），
 *   不该把设备自己的权威上报也挡住。
 *
 * 覆盖：
 *   ① 带 devId + pos=0  ⇒ 落账（书级 + 设备记录都出现）
 *   ② 带 devId + pos=3  ⇒ 落账
 *   ③ 匿名 + pos=0      ⇒ 仍然拦住（老保护不退化）
 *   ④ 匿名 + pos=30     ⇒ 正常落账（证明③不是把所有匿名都拦了）
 *   ⑤ fin=1 + pos=0（匿名）⇒ 放行（「本集听完」的合法语义，老行为不变）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMPD = path.join(os.tmpdir(), 'posstart-' + process.pid);
fs.mkdirSync(TMPD, { recursive: true });
const HIST = path.join(TMPD, 'history.json');
const DG = path.join(TMPD, 'devgroups.json');
const PORT = 18300 + (process.pid % 400);

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } }

function post(p, body) {
  return new Promise((resolve, reject) => {
    const b = Buffer.from(JSON.stringify(body), 'utf8');
    const req = require('http').request({
      host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': b.length },
    }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({ raw: s }); } });
    });
    req.on('error', reject);
    req.end(b);
  });
}

function get(p) {
  return new Promise((resolve, reject) => {
    const req = require('http').request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({ raw: s }); } });
    });
    req.on('error', reject);
    req.end();
  });
}

/* 走 HTTP 读：history 是内存缓存 + 定时刷盘，直接读文件看不到刚写进去的。 */
async function hist() {
  const d = await get('/api/history');
  const books = {};
  for (const b of (d.books || [])) books[b.key || b.book] = b;
  return { books, devices: Object.fromEntries((d.devices || []).map(x => [x.id, x])) };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(PORT)], {
    env: Object.assign({}, process.env, { HIST_FILE: HIST, DG_FILE: DG }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  // 等端口起来
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(250);
    try { await post('/v1/pos', { kind: 'book', q: '__probe__', book: '__probe__', ep: 1, pos: 99 }); up = true; } catch { /* 还没起 */ }
  }
  if (!up) { console.log('服务没起来，中止'); child.kill(); process.exit(1); }

  const DEV = '98BB9936CD6B';

  console.log('\n[1] 带 devId + pos=0（起播那一拍）⇒ 必须落账');
  let r = await post('/v1/pos', {
    kind: 'book', q: '起播测试书', book: '起播测试书', ep: 1, pos: 0,
    devId: DEV, devName: 'R1-CD6B', src: 'online_program',
  });
  ok(!r.ignored, '没有被 ignored（' + JSON.stringify(r) + '）');
  ok(Number(r.ep) === 1, '书级 ep=1');
  let h = await hist();
  const bk = Object.keys(h.books || {}).filter(k => String((h.books[k] || {}).book || '').indexOf('起播测试书') >= 0);
  ok(bk.length === 1, '书级出现一条记录');
  ok(bk.length === 1 && Number(h.books[bk[0]].pos) === 0, '书级 pos=0（起播位置）');
  const dl = ((h.devices || {})[DEV] || {}).list || [];
  ok(dl.length >= 1 && String(dl[0].q).indexOf('起播测试书') >= 0, '设备记录里也出现了这本书');
  ok(dl.length >= 1 && Number(dl[0].pos) === 0, '设备记录 pos=0');

  console.log('\n[2] 带 devId + pos=3 ⇒ 落账');
  r = await post('/v1/pos', { kind: 'book', q: '起播测试书', book: '起播测试书', ep: 1, pos: 3, devId: DEV });
  ok(!r.ignored, '没有被 ignored');
  h = await hist();
  const k2 = Object.keys(h.books || {}).find(k => String(h.books[k].book || '').indexOf('起播测试书') >= 0);
  ok(k2 && Number(h.books[k2].pos) === 3, '书级位置跟进到 3');

  console.log('\n[3] 匿名 + pos=0 ⇒ 仍然拦住（老保护不退化）');
  r = await post('/v1/pos', { kind: 'book', q: '匿名测试书', book: '匿名测试书', ep: 1, pos: 0 });
  ok(!!r.ignored && /pos too small/.test(String(r.ignored)), '被 ignored：' + r.ignored);
  h = await hist();
  ok(!Object.keys(h.books || {}).some(k => String(h.books[k].book || '').indexOf('匿名测试书') >= 0), '匿名那本没有落库');

  console.log('\n[4] 匿名 + pos=30 ⇒ 正常落账');
  r = await post('/v1/pos', { kind: 'book', q: '匿名测试书', book: '匿名测试书', ep: 2, pos: 30 });
  ok(!r.ignored, '没有被 ignored');
  h = await hist();
  ok(Object.keys(h.books || {}).some(k => String(h.books[k].book || '').indexOf('匿名测试书') >= 0), '匿名那本落库了');

  console.log('\n[5] 匿名 + fin=1 + pos=0 ⇒ 放行（「本集听完」语义）');
  r = await post('/v1/pos', { kind: 'book', q: '结算测试书', book: '结算测试书', ep: 1, pos: 0, fin: 1 });
  ok(!r.ignored, '没有被 ignored');
  h = await hist();
  const k5 = Object.keys(h.books || {}).find(k => String(h.books[k].book || '').indexOf('结算测试书') >= 0);
  ok(!!k5 && !!h.books[k5].fin, '书级落了一条 fin=1');

  console.log('\n=== ' + (fail === 0 ? ('全部通过（' + pass + ' 项）') : (pass + ' 通过 / ' + fail + ' 失败')) + ' ===');
  child.kill();
  try { fs.rmSync(TMPD, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

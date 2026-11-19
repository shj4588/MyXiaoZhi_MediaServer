'use strict';
/**
 * v1.7.45 广播（电台）进播放记录 —— device 直链广播服务端看不见，只能靠 /v1/pos 上报。
 *
 *   node _tests/radio-record.js
 *
 * 背景（2026-11-18 17:35）：
 *   R1 播在线书《仙逆》/ 播广播，服务端一条记录都没有。广播更彻底：电台 URL 是上游
 *   直链（/radio/ 代理默认关），媒体服务器收不到任何拉流请求；device 侧只认「标题含
 *   第 N 集」的书 ⇒ 电台零上报。现在 device 1.3.350 用队列项 itemId（100_radio_<n>）
 *   认出台名，按 kind=radio 上报位置。
 *
 * 覆盖：
 *   ① kind=radio 上报 ⇒ 设备记录出现，kind=radio、src=radio
 *   ② 同台连续上报 ⇒ **合并成一条**（不能每 30 秒刷一行）
 *   ③ 换台 ⇒ 新建一条（总 2 条）
 *   ④ 电台不进 /api/history 的 books 续播快照（那里只装 book）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMPD = path.join(os.tmpdir(), 'radiorec-' + process.pid);
fs.mkdirSync(TMPD, { recursive: true });
const HIST = path.join(TMPD, 'history.json');
const DG = path.join(TMPD, 'devgroups.json');
const PORT = 18700 + (process.pid % 200);

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

async function hist() {
  const d = await get('/api/history');
  return {
    books: d.books || [],
    devices: Object.fromEntries((d.devices || []).map(x => [x.id, x])),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(PORT)], {
    env: Object.assign({}, process.env, { HIST_FILE: HIST, DG_FILE: DG }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(250);
    try { await post('/v1/pos', { kind: 'book', q: '__probe__', book: '__probe__', ep: 1, pos: 99 }); up = true; } catch { /* 还没起 */ }
  }
  if (!up) { console.log('服务没起来，中止'); child.kill(); process.exit(1); }

  const DEV = '98BB9936CD6B';
  const ST = '中国之声';

  console.log('\n[1] kind=radio 上报 ⇒ 设备记录出现');
  let r = await post('/v1/pos', { kind: 'radio', q: ST, pos: 2, devId: DEV, devName: 'R1-CD6B' });
  ok(!r.ignored, '没有被 ignored（' + JSON.stringify(r) + '）');
  let h = await hist();
  let dl = ((h.devices || {})[DEV] || {}).list || [];
  ok(dl.length === 1, '设备记录 1 条（实际 ' + dl.length + '）');
  ok(dl.length === 1 && dl[0].kind === 'radio', 'kind=radio');
  ok(dl.length === 1 && dl[0].q === ST, '台名对得上：' + (dl[0] && dl[0].q));
  ok(dl.length === 1 && dl[0].src === 'radio', 'src=radio：' + (dl[0] && dl[0].src));
  ok(dl.length === 1 && Number(dl[0].pos) === 2, 'pos=2');

  console.log('\n[2] 同台连续上报 ⇒ 合并成一条（不刷屏）');
  await post('/v1/pos', { kind: 'radio', q: ST, pos: 32, devId: DEV });
  await post('/v1/pos', { kind: 'radio', q: ST, pos: 62, devId: DEV });
  h = await hist();
  dl = ((h.devices || {})[DEV] || {}).list || [];
  ok(dl.length === 1, '仍然只有 1 条（实际 ' + dl.length + '）');
  ok(dl.length === 1 && Number(dl[0].pos) === 62, '位置跟到 62：' + (dl[0] && dl[0].pos));

  console.log('\n[3] 换台 ⇒ 新建一条');
  await post('/v1/pos', { kind: 'radio', q: '经济之声', pos: 5, devId: DEV });
  h = await hist();
  dl = ((h.devices || {})[DEV] || {}).list || [];
  ok(dl.length === 2, '设备记录 2 条（实际 ' + dl.length + '）');
  ok(dl.length === 2 && dl[0].q === '经济之声', '最新一条是换过去的台：' + (dl[0] && dl[0].q));

  console.log('\n[4] 电台不进 books 续播快照');
  h = await hist();
  ok(!h.books.some(b => b.kind === 'radio'), 'books 里没有 kind=radio 的条目');
  ok(h.books.every(b => b.kind === 'book'), 'books 全是 book（' + h.books.length + ' 条）');

  console.log('\n=== ' + (fail === 0 ? ('全部通过（' + pass + ' 项）') : (pass + ' 通过 / ' + fail + ' 失败')) + ' ===');
  child.kill();
  try { fs.rmSync(TMPD, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

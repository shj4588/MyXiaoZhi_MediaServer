#!/usr/bin/env node
/**
 * 空闲看门狗回归测试：上游吐 3 块之后「装死」（不断开、也不再发数据）。
 * 期望：IDLE_MS 之后本端主动收尾（客户端要么 end、要么被截断），进程依然存活。
 *
 *   v1.7.57：pipeAudio 搬到 pipeaudio.js，改成 require + opts 注入超时；
 *            maxResume:0 —— 这条只测看门狗本身，续传由 pipe-resume.js 专测。
 *
 * 用法：node _tests/pipe-idle.js [pipeaudio.js 路径]
 */
const http = require('http');
const path = require('path');

const { pipeAudio } = require(process.argv[2] || path.join(__dirname, '..', 'pipeaudio'));
const OPTS = { connectMs: 1200, idleMs: 1200, maxResume: 0 };

const upstream = http.createServer((rq, rs) => {
  rs.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(100 * 4096) });
  let n = 0;
  const t = setInterval(() => {
    if (n++ >= 3) { clearInterval(t); console.log('[up] 3 块后装死（保持连接不发数据）'); return; }
    rs.write(Buffer.alloc(4096, 0x42));
  }, 60);
  rs.on('close', () => clearInterval(t));
});

upstream.listen(0, '127.0.0.1', () => {
  const upUrl = 'http://127.0.0.1:' + upstream.address().port + '/a.m4a';
  const front = http.createServer((req, res) => { pipeAudio(res, req, upUrl, null, OPTS).catch(() => {}); });
  front.listen(0, '127.0.0.1', () => {
    const t0 = Date.now();
    const req = http.get({ host: '127.0.0.1', port: front.address().port, path: '/s/0' }, r => {
      let got = 0;
      const done = why => {
        const ms = Date.now() - t0;
        console.log('[client] ' + why + '，共 ' + got + ' 字节，用时 ' + ms + 'ms');
        const ok = ms < 8000;   // 上游声明了 Content-Length 却发一半 ⇒ 本端只会「截断」（aborted），正常
        console.log(ok ? '✅ 空闲看门狗按时收尾，进程存活' : '⚠️ 收尾太慢');
        try { front.close(); upstream.close(); } catch { /* ignore */ }
        setTimeout(() => process.exit(ok ? 0 : 1), 100);
      };
      r.on('data', c => { got += c.length; });
      r.on('end', () => done('收到 end'));
      r.on('error', e => done('连接被本端截断（' + e.message + '）'));
    });
    req.on('error', e => console.log('[client] 请求失败：' + e.message));
    setTimeout(() => { console.log('❌ 12s 还没收尾（看门狗没生效）'); process.exit(1); }, 12000);
  });
});

process.on('uncaughtException', e => {
  console.error('❌ 未捕获异常：' + (e && e.message || e));
  process.exit(1);
});

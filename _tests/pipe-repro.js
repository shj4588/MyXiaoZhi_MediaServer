#!/usr/bin/env node
/**
 * pipeAudio 崩溃复现/回归测试
 *
 *   场景：上游稳稳地吐数据 → 客户端读一点就「暂停」（模拟 R1 播放器暂停/拖进度，
 *        socket 缓冲填满 → 背压 → 上游 body 没人消费）→ 再恢复读。
 *
 *   旧版（AbortSignal.timeout 一把梭）：超时定时器照跑 → abort → fromWeb 的流
 *   error 没人接 → unhandled 'error' → 进程退出（= 容器偶发停止）
 *   新版：头到了就 clearTimeout，传输期只留空闲看门狗 → 暂停多久都不炸
 *
 *   v1.7.57：pipeAudio 搬到 pipeaudio.js，改成 require + opts 注入超时
 *            （不再从 server.js 抠函数体、正则改数字）。
 *
 * 用法：node _tests/pipe-repro.js [pipeaudio.js 路径]
 */
const http = require('http');
const path = require('path');

const { pipeAudio } = require(process.argv[2] || path.join(__dirname, '..', 'pipeaudio'));
// 把「等响应头」和「空闲看门狗」的时间缩到 1.2s，测试才跑得动；
// maxResume:0 —— 这条测的是「暂停不炸」，不是续传。
const OPTS = { connectMs: 1200, idleMs: 1200, maxResume: 0 };

// ---- 上游：每 80ms 吐 4KB，一共 400 块（约 1.6MB，够撑过暂停窗口）----
const TOTAL = 400;
const upstream = http.createServer((rq, rs) => {
  rs.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(TOTAL * 4096) });
  let n = 0;
  const t = setInterval(() => {
    if (n >= TOTAL) { clearInterval(t); try { rs.end(); } catch { /* ignore */ } return; }
    n++;
    try { rs.write(Buffer.alloc(4096, 0x41)); } catch { clearInterval(t); }
  }, 80);
  rs.on('close', () => clearInterval(t));
});

upstream.listen(0, '127.0.0.1', () => {
  const upUrl = 'http://127.0.0.1:' + upstream.address().port + '/a.m4a';

  const front = http.createServer((req, res) => {
    res.on('error', () => {});                 // 前置端自己也要扛住 EPIPE
    pipeAudio(res, req, upUrl, null, OPTS).catch(e => { console.log('[front] 调用抛错：' + e.message); });
  });

  front.listen(0, '127.0.0.1', () => {
    const port = front.address().port;
    const req = http.get({ host: '127.0.0.1', port, path: '/s/0' }, r => {
      let got = 0;
      r.on('data', c => { got += c.length; });
      r.on('error', () => {});
      // 先正常读 0.4s，然后「暂停」6s（远超 1200ms 超时窗口），再恢复
      setTimeout(() => {
        r.pause();
        console.log('[client] 已暂停读取（模拟 R1 播放器暂停），等 6s…');
        setTimeout(() => {
          const before = got;
          r.resume();
          setTimeout(() => {
            console.log('[client] 恢复后新增 ' + (got - before) + ' 字节，累计 ' + got);
            const ok = got > before;
            console.log(ok ? '✅ 进程存活且流继续' : '⚠️ 流没恢复（但进程没死）');
            cleanup(ok ? 0 : 1);
          }, 1500);
        }, 6000);
      }, 400);
    });
    req.on('error', e => console.log('[client] 请求失败：' + e.message));
  });

  let done = false;
  function cleanup(code) {
    if (done) return; done = true;
    try { front.close(); } catch { /* ignore */ }
    try { upstream.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(code), 100);
  }
});

// 没有这个兜底的话，我们测的就是「进程会不会崩」——崩了就真崩，正好当断言
process.on('uncaughtException', e => {
  console.error('❌ 进程级未捕获异常（这就是容器退出的原因）：' + (e && e.message || e));
  process.exit(1);
});

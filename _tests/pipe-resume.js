#!/usr/bin/env node
/**
 * ★ v1.7.57 新功能回归：**断流自动续传**（_tests/pipe-resume.js）
 *
 *   背景（用户报的现场）：
 *     日志 `[mini-lx] 转发流中断（单请求，不影响服务）：terminated`，紧跟着播放器
 *     跳到下一首。terminated = undici 在「上游 body 没发完就断连」时抛的错，也就是
 *     源站（酷我/网易 CDN、落雪中继）半路把连接掐了。以前 src 一报错就 res.end()，
 *     对外表现成「响应正常结束」⇒ 播放器当成这首歌播完了 ⇒ 自动下一首。
 *
 *   现在：记下已写进 res 的字节数，断了就用 Range: bytes=<已发>- 重新接，最多 3 次。
 *
 *   三条断言：
 *     ① 发一半就断、支持 Range ⇒ 客户端必须拿到**完整且一个字节不差**的内容，
 *        且第二轮请求确实带 `Range: bytes=<已发>-`（不能重头再发一遍）
 *     ② 源站不认 Range（永远回 200 整段）⇒ 宁可不接，绝不能把播过的重灌一遍
 *     ③ 客户端自己带 Range 起播 ⇒ 透传 206，字节数与内容仍要对得上
 *
 * 用法：node _tests/pipe-resume.js [pipeaudio.js 路径]
 */
const http = require('http');
const path = require('path');

const { pipeAudio } = require(process.argv[2] || path.join(__dirname, '..', 'pipeaudio'));

const CH = 4096;
const BLOCKS = 300;                    // 1,228,800 字节，实测一首 128k 歌的量级
const TOTAL = CH * BLOCKS;
const DROP_AT = 100;                   // 上游发到第 100 块就掐
const RESUME_FROM = DROP_AT * CH;

/** 每块内容按序号填充，能验出「重复」或「跳块」而不只是字节数凑巧相等 */
const FULL = Buffer.alloc(TOTAL);
for (let i = 0; i < BLOCKS; i++) FULL.fill(i % 251, i * CH, (i + 1) * CH);

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

/** mode: 'range' = 支持续传；'no-range' = 装死不认 Range */
function makeUpstream(mode) {
  const stats = { reqs: 0, ranges: [] };
  const srv = http.createServer((rq, rs) => {
    stats.reqs++;
    const range = rq.headers.range || '';
    stats.ranges.push(range);
    const m = /bytes=(\d+)-/.exec(range);
    const ignores = mode === 'no-range';
    const from = (m && !ignores) ? Number(m[1]) : 0;

    if (from > 0) {
      const body = FULL.subarray(from);
      rs.writeHead(206, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(body.length),
        'Content-Range': 'bytes ' + from + '-' + (TOTAL - 1) + '/' + TOTAL,
        'Accept-Ranges': 'bytes',
      });
      let off = 0;
      const t = setInterval(() => {
        if (off >= body.length) { clearInterval(t); try { rs.end(); } catch { /* ignore */ } return; }
        try { rs.write(body.subarray(off, off + CH)); } catch { clearInterval(t); }
        off += CH;
      }, 1);
      rs.on('close', () => clearInterval(t));
      return;
    }

    rs.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(TOTAL),
      'Accept-Ranges': 'bytes',
    });
    let i = 0;
    const t = setInterval(() => {
      if (i >= DROP_AT) {
        clearInterval(t);
        console.log('    [up] 发完 ' + DROP_AT + ' 块（' + RESUME_FROM + 'B）后掐断连接');
        try { rs.destroy(); } catch { /* ignore */ }
        return;
      }
      try { rs.write(FULL.subarray(i * CH, (i + 1) * CH)); } catch { clearInterval(t); }
      i++;
    }, 1);
    rs.on('close', () => clearInterval(t));
  });
  return { srv, stats };
}

/** 起一对「前端(pipeAudio) + 上游」，跑一次请求，收工 */
function runCase(name, mode, clientRange) {
  return new Promise((resolve) => {
    const { srv: up, stats } = makeUpstream(mode);
    up.listen(0, '127.0.0.1', () => {
      const url = 'http://127.0.0.1:' + up.address().port + '/a.mp3';
      const front = http.createServer((q, s) => {
        s.on('error', () => {});
        pipeAudio(s, q, url, null, { connectMs: 2000, idleMs: 3000 }).catch(() => {});
      });
      front.listen(0, '127.0.0.1', () => {
        const req = http.get({
          host: '127.0.0.1', port: front.address().port, path: '/r/kw/1',
          headers: clientRange ? { Range: clientRange } : {},
        }, (r) => {
          const chunks = [];
          let done = false;
          const finish = (okEnd, err) => {
            if (done) return; done = true;
            const buf = Buffer.concat(chunks);
            try { front.close(); up.close(); } catch { /* ignore */ }
            setTimeout(() => resolve({
              ok: okEnd, buf, err, stats, status: r.statusCode, headers: r.headers,
            }), 50);
          };
          r.on('data', c => chunks.push(c));
          r.on('end', () => finish(true));
          r.on('error', e => finish(false, e.message));
          r.on('aborted', () => finish(false, 'aborted'));
        });
        req.on('error', e => { try { up.close(); } catch { /* ignore */ } resolve({ ok: false, buf: Buffer.alloc(0), err: e.message, stats }); });
      });
    });
  });
}

(async () => {
  // ① 断流 + 支持 Range ⇒ 续传补满
  console.log('① 上游发一半掐断（支持 Range）');
  {
    const r = await runCase('resume', 'range');
    ok(r.buf.length === TOTAL, '客户端拿满 ' + TOTAL + ' 字节', { got: r.buf.length });
    ok(r.buf.equals(FULL), '内容逐字节一致（没重发、没跳块）');
    ok(r.ok, '响应正常收尾（不是被截断）', { err: r.err });
    ok(r.stats.reqs >= 2, '触发过第二轮取流（reqs=' + r.stats.reqs + '）');
    ok(r.stats.ranges.some(x => x === 'bytes=' + RESUME_FROM + '-'),
      '第二轮确实带 Range: bytes=' + RESUME_FROM + '-', r.stats.ranges);
  }

  // ② 源站不认 Range ⇒ 不许重灌
  console.log('② 上游发一半掐断（不认 Range，永远回 200 整段）');
  {
    const r = await runCase('no-range', 'no-range');
    ok(r.buf.length < TOTAL, '没收满（预期：接不上就别硬接）', { got: r.buf.length });
    ok(r.buf.length <= RESUME_FROM + CH, '没有把已播过的又灌一遍', { got: r.buf.length });
    ok(!r.buf.equals(FULL), '不是靠重灌凑出来的完整内容');
  }

  // ③ 客户端自己带 Range 起播 ⇒ 206 透传
  console.log('③ 客户端带 Range 起播（bytes=' + RESUME_FROM + '-）');
  {
    const r = await runCase('client-range', 'range', 'bytes=' + RESUME_FROM + '-');
    const want = TOTAL - RESUME_FROM;
    ok(r.buf.length === want, '收到剩余 ' + want + ' 字节', { got: r.buf.length });
    ok(r.buf.equals(FULL.subarray(RESUME_FROM)), '内容与偏移一致');
    ok(String(r.status) === '206', '状态码 206（能拖进度）', { status: r.status });
  }

  console.log('\n' + (fail ? '❌ ' : '✅ ') + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();

process.on('uncaughtException', e => {
  console.error('❌ 未捕获异常：' + (e && e.stack || e));
  process.exit(1);
});

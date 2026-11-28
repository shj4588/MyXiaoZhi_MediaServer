// 正常路径回归：上游完整吐完 100 块，客户端应收到等量字节 + 正常 end
//
//   v1.7.57：pipeAudio 搬到 pipeaudio.js，这里不再从 server.js 抠函数体
//   （那套 indexOf('const MIN_FULL_BYTES') 的做法一改结构就碎）。
//
//   用法：node _tests/pipe-full.js [pipeaudio.js 路径]
const http = require('http');
const path = require('path');

const { pipeAudio } = require(process.argv[2] || path.join(__dirname, '..', 'pipeaudio'));

const N = 100, CH = 4096;
const up = http.createServer((rq, rs) => {
  rs.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(N * CH) });
  let n = 0;
  const t = setInterval(() => {
    if (n >= N) { clearInterval(t); rs.end(); return; }
    n++;
    rs.write(Buffer.alloc(CH, 0x43));
  }, 5);
  rs.on('close', () => clearInterval(t));
});

up.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + up.address().port + '/a.m4a';
  const front = http.createServer((q, s) => { pipeAudio(s, q, url).catch(() => {}); });
  front.listen(0, '127.0.0.1', () => {
    const t0 = Date.now();
    http.get({ host: '127.0.0.1', port: front.address().port, path: '/s/0' }, r => {
      const cl = Number(r.headers['content-length'] || 0);
      let got = 0;
      r.on('data', c => { got += c.length; });
      r.on('end', () => {
        console.log('[client] end  收到 ' + got + '/' + cl + ' 字节  用时 ' + (Date.now() - t0) + 'ms');
        const ok = got === N * CH;
        console.log(ok ? '✅ 完整转发正常' : '❌ 字节数不对');
        front.close(); up.close(); setTimeout(() => process.exit(ok ? 0 : 1), 100);
      });
      r.on('error', e => { console.log('❌ 读错：' + e.message); process.exit(1); });
    });
  });
});
process.on('uncaughtException', e => { console.error('❌ ' + e.message); process.exit(1); });

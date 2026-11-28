'use strict';

/**
 * pipeaudio.js —— 把上游音频流转发给播放器（/r/、/s/ 默认走这条）。
 *
 * <p>v1.7.57 从 server.js 抽出来，只为两件事：</p>
 * <ol>
 *   <li><b>断流自动续传</b>：源站（酷我/网易 CDN、落雪）半路把连接掐了，以前我们
 *       <code>res.end()</code> 收场 —— 对播放器来说就是「这首歌正常播完了」，
 *       于是自动跳下一首（用户体感：歌播着播着停了、跳歌）。现在改成记下已发字节，
 *       用 <code>Range: bytes=&lt;已发&gt;-</code> 重新接上，最多续 3 次；真接不上
 *       才硬断连接（<b>不是</b> res.end，那是伪装成正常 EOF）。</li>
 *   <li>能单独跑测试：<code>_tests/pipe-resume.js</code> 直接 require 本文件，
 *       造一个「发一半就断、支持 Range」的假上游，验字节数一个不差。</li>
 * </ol>
 *
 * <h3>为什么是转发而不是 302</h3>
 * R1 的 DLNA 播放器（Platinum/Neptune）不一定跟随重定向，转发出去对它就是一个普通
 * http 音频源，最稳。代价是 NAS 中转一点局域网流量。支持 Range（拖进度）与 HEAD（探活）。
 *
 * <h3>★ v1.2.3（2026-11-07）那条血的教训，别删</h3>
 * 容器「偶发意外停止」的真凶就在这儿。旧写法 <code>signal: AbortSignal.timeout(20000)</code>
 * 的定时器<b>不会因为响应头到了就停</b>，它盯着整条连接的寿命。R1 一暂停 / 一拖进度，
 * 下游就不再读，pipe 背压把上游 body 卡住没人消费 —— 20s 一到 signal abort，body 流报错，
 * 而 <code>Readable.fromWeb(up.body)</code> 出来的流<b>没人挂 error 监听</b> ⇒ Node 的
 * "Unhandled 'error' event" 直接把整个进程干掉（compose 是 restart: unless-stopped，
 * 表现为「偶发停止」、正在播的歌和 Web 一起断）。所以现在：
 * <ol>
 *   <li>CONNECT_MS 只管「等到响应头」，拿到头立刻 clearTimeout；</li>
 *   <li>传输期换<b>空闲看门狗</b>：连续 IDLE_MS 没有字节流动才断，且「是我们自己按的
 *       暂停（背压）」不算上游死，继续等；</li>
 *   <li>src / res 都挂 error，res 一 close 就销毁上游流 —— 任何一条流报错都只影响
 *       这一个请求，不许冒到进程级。</li>
 * </ol>
 */

const { Readable } = require('stream');

/** 等响应头的上限（TCP + 握手 + 上游首包慢，给足 20s）。拿不到头才算失败。 */
const CONNECT_MS = 20000;
/** 传输期：连续这么久「一个字节都没动」才判定上游死了（不是整条流的死期）。 */
const IDLE_MS = 60000;
/** 断流后最多续传几次。3 次足够盖住 CDN 抖动，又不至于死磕一条坏链。 */
const MAX_RESUME = 3;
const LOG = '[mini-lx] ';

/** "bytes=123-" ⇒ 123；没有 Range / 不从 0 开始以外的怪格式一律按 0 处理。 */
function rangeStartOf(v) {
  const m = /bytes\s*=\s*(\d+)\s*-/i.exec(String(v || ''));
  return m ? Number(m[1]) : 0;
}

/** "bytes 300000-999999/1000000" ⇒ { from, to, total } */
function contentRangeOf(v) {
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(v || ''));
  if (!m) return null;
  return {
    from: Number(m[1]),
    to: Number(m[2]),
    total: m[3] === '*' ? null : Number(m[3]),
  };
}

/**
 * 转发一条音频流。
 *
 * @param {http.ServerResponse} res
 * @param {http.IncomingMessage} req
 * @param {string} upstream   源站直链
 * @param {Function} [onCommit] 真播回调（累计传输够 minBytes 才触发一次；探活传 null）
 * @param {Object} [opts] { minBytes, shouldCommit, connectMs, idleMs, maxResume }
 */
async function pipeAudio(res, req, upstream, onCommit, opts) {
  const o = opts || {};
  const minBytes = Number(o.minBytes) > 0 ? Number(o.minBytes) : 256 * 1024;
  const shouldCommit = typeof o.shouldCommit === 'function' ? o.shouldCommit : (b, m) => b >= m;
  const connectMs = Number(o.connectMs) > 0 ? Number(o.connectMs) : CONNECT_MS;
  const idleMs = Number(o.idleMs) > 0 ? Number(o.idleMs) : IDLE_MS;
  const maxResume = Number.isFinite(o.maxResume) ? Number(o.maxResume) : MAX_RESUME;

  const isHead = req.method === 'HEAD';
  const reqRange = (req.headers && req.headers.range) || '';
  const baseStart = rangeStartOf(reqRange);
  const tag = String(upstream).slice(0, 120);

  let sent = 0;              // 已经写进 res 的字节（相对 baseStart）
  let tries = 0;             // 已续传次数
  let committed = false;     // 真播是否已记账
  let closed = false;        // 下游（播放器）是否已经走了
  let cur = null;            // 当前上游 Readable
  let idleTimer = null;
  let totalLen = null;       // 上游声明的「整个文件」长度（拿得到才不是 null）
  let lastWhy = '';

  const stopIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  const onResGone = () => {
    if (closed) return;
    closed = true;
    stopIdle();
    try { if (cur) cur.destroy(); } catch { /* already dead */ }
  };
  res.on('close', onResGone);
  res.on('error', onResGone);
  // 下游重新开始读（拖进度 / 缓冲够了）→ 把上游接着放
  res.on('drain', () => { if (cur && cur.isPaused()) { try { cur.resume(); } catch { /* ignore */ } } });

  /** 传输一段上游 body，返回结束原因：end / closed / idle / error:<msg> */
  function pump(src) {
    return new Promise((resolve) => {
      let done = false;
      let idle = null;
      const stop = () => { if (idle) { clearTimeout(idle); idle = null; } };
      const cleanup = () => {
        stop();
        src.removeListener('data', onData);
        src.removeListener('end', onEnd);
        src.removeListener('error', onErr);
        src.removeListener('close', onClose);
      };
      const finish = (why) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(why);
      };
      function bump() {
        stop();
        idle = setTimeout(() => {
          // 下游不读（播放器暂停 / 拖进度）也会让管道停住，但那不是上游的错 —— 继续等
          if (src.isPaused()) { bump(); return; }
          finish('idle');
        }, idleMs);
      }
      function onData(chunk) {
        bump();                                            // 有字节流动就把看门狗续上
        sent += chunk.length;
        // ★ v1.7.36：累计真实传输字节，够阈值才确认「真播」并落记录（只触发一次）。
        //   探活/预取只拿几 KB 就断 ⇒ 永远到不了阈值 ⇒ 不落。
        if (!committed && onCommit && shouldCommit(sent, minBytes)) {
          committed = true;
          try { onCommit(); } catch { /* 记账失败绝不影响推流 */ }
        }
        if (closed) return;
        if (!res.write(chunk)) src.pause();                // 背压：等 res 的 drain
      }
      const onEnd = () => finish('end');
      const onErr = (e) => finish('error:' + String((e && e.message) || e).slice(0, 120));
      const onClose = () => finish('closed');
      src.on('data', onData);
      src.on('end', onEnd);
      src.on('error', onErr);
      src.on('close', onClose);
      bump();
    });
  }

  for (;;) {
    if (closed) {
      stopIdle();
      return;
    }
    const from = baseStart + sent;
    const ac = new AbortController();
    const connectTimer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, connectMs);
    let up = null;
    let cErr = '';
    try {
      const headers = { 'User-Agent': 'Mozilla/5.0' };
      // 首轮：按客户端给的 Range 原样透传；续传：从「已发字节」接着要
      if (from > 0) headers.Range = 'bytes=' + from + '-';
      else if (reqRange) headers.Range = reqRange;
      up = await fetch(upstream, {
        method: isHead ? 'HEAD' : 'GET',
        headers, redirect: 'follow', signal: ac.signal,
      });
    } catch (e) {
      cErr = String((e && e.message) || e).slice(0, 120);
    }
    clearTimeout(connectTimer);
    if (closed) {
      try { if (up && up.body) await up.body.cancel(); } catch { /* ignore */ }
      return;
    }

    // ① 连不上：还没发头 ⇒ 502 让播放器明确知道失败；已经发头 ⇒ 走下面的硬断
    if (!up) {
      if (!res.headersSent) {
        try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); } catch { /* ignore */ }
        try { res.end('转发失败：' + cErr); } catch { /* client gone */ }
        return;
      }
      lastWhy = cErr;
      break;
    }

    const cr = contentRangeOf(up.headers.get('content-range'));

    // ② 续传这一轮必须是「真续上」：206 + 起点对得上。源站不认 Range 就会回 200
    //    从头发一遍 —— 那样会把已经播过的几 MB 又灌一遍，宁可放弃。
    if (from > 0) {
      if (up.status !== 206 || !cr || cr.from !== from) {
        try { if (up.body) await up.body.cancel(); } catch { /* ignore */ }
        lastWhy = '源站不支持断点续传（status ' + up.status + '）';
        console.log(LOG + '断点续传接不上（' + lastWhy + '），放弃这条流：' + tag);
        break;
      }
      if (cr.total != null) totalLen = cr.total;
    } else if (cr && cr.total != null) {
      totalLen = cr.total;                                  // 客户端带了 Range、源站回 206
    } else {
      const n = parseInt(up.headers.get('content-length'), 10);
      if (Number.isFinite(n) && n >= 0) totalLen = n;
    }

    if (!res.headersSent) {
      const h = {
        'Content-Type': up.headers.get('content-type') || 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      };
      const len = up.headers.get('content-length');
      if (len) h['Content-Length'] = len;
      const crh = up.headers.get('content-range');
      if (crh) h['Content-Range'] = crh;
      res.writeHead(up.status === 206 ? 206 : (up.ok ? 200 : up.status), h);
      if (isHead || !up.body) {
        res.end();
        try { if (up.body) await up.body.cancel(); } catch { /* ignore */ }
        return;
      }
    }

    const src = Readable.fromWeb(up.body);
    cur = src;
    const why = await new Promise((resolve) => pump(src).then(resolve, () => resolve('error:pump')));
    cur = null;

    if (why === 'end') {
      stopIdle();
      if (!closed) { try { res.end(); } catch { /* client gone */ } }
      return;
    }
    if (why === 'closed' || closed) {
      stopIdle();
      return;
    }

    // ③ 断流 / 空闲：先试着接上，接不上才认输
    const detail = why === 'idle'
      ? ('上游 ' + idleMs + 'ms 无数据')
      : String(why).replace(/^error:/, '') || '未知原因';

    if (tries < maxResume) {
      tries++;
      console.log(LOG + '转发流中断（' + detail + '）⇒ 第 ' + tries + '/' + maxResume
        + ' 次断点续传，已发 ' + sent + 'B：' + tag);
      continue;
    }
    lastWhy = detail;
    console.log(LOG + '转发流中断（' + detail + '）⇒ '
      + (tries ? '续传 ' + tries + ' 次仍失败，' : '') + '放弃（单请求，不影响服务）：' + tag);
    break;
  }

  // ④ 收不了尾了
  stopIdle();
  if (!res.headersSent) {
    try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); } catch { /* ignore */ }
    try { res.end('转发失败：' + (lastWhy || '上游中断')); } catch { /* client gone */ }
    return;
  }
  // 其实整首已经发完（源站报错前就把字节送全了）⇒ 正常收尾
  if (totalLen != null && sent + baseStart >= totalLen) {
    try { res.end(); } catch { /* client gone */ }
    return;
  }
  // ★ 关键：这里**不能** res.end()。声明了 Content-Length 却短一截还正常收尾，
  //   播放器会把它当成「这首歌播完了」直接跳下一首；销毁连接才能让它看到错误、
  //   有机会重连同一首（下一轮请求会带上 Range，续传逻辑接着接）。
  try { res.destroy(); } catch { /* already gone */ }
}

module.exports = { pipeAudio, CONNECT_MS, IDLE_MS, MAX_RESUME, rangeStartOf, contentRangeOf };

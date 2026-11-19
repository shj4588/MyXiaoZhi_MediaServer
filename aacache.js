'use strict';
/**
 * aacache.js —— 受限终端的「服务端降档转码 + 本地缓存」
 *
 * <p>为什么要有这一层（实机结论，别再当"能不能播"来判）：
 *   R1（rk3229 / Android 5.1 / MediaPlayer）播 24bit FLAC 时，
 *   状态回报是 `phase=playing`、pos 每秒正常推进、`stalled=false` ——
 *   **但耳朵里没有声音**。这是 24bit→s32 输出链路静默失败：解码器不报错，
 *   也没有音频帧真正进到 AudioFlinger，播放器自己完全不知道。
 *   高码率源（24/96 = 2829kbps）长播还会把 NuCachedSource2 缓存和原生内存
 *   顶起来，表现为「听一阵就崩」。
 *
 * <p>所以判据只能是**规格**：无损/超采样率/超位深/多声道一律在服务端降到
 *   16bit / 44.1k / 立体声 AAC。AAC 96k 对听书是透明级，对音乐也够用，
 *   而且把 1000~2900kbps 压到 100~200kbps，顺带治好了 WiFi 抖动与崩溃。
 *
 * <p>三条硬约束（都是踩出来的）：
 *   ① **必须能拖进度**。R1 的播放器 seek 全靠 HTTP Range；流式转码没有索引，
 *      拖一下就废。所以转完要落成 m4a（有 moov 索引），命中缓存后由
 *      sendLocalFile 走标准 Range。
 *   ② **首次不能干等**。这台机器（aarch64 4 核）转 202s 音频要 34s，
 *      一集 20 分钟的书要三分钟 —— 同步转完再发等于"点了没反应"。
 *      未命中就边转边发（ADTS，可即时出声），同时把数据 tee 进缓存文件。
 *   ③ **客户端走了也要转完**。用户听 10 秒切歌是常态；此时若把 ffmpeg 杀掉，
 *      下次同一首又要重新等。所以下游断开只停写 socket，转码继续跑到底。
 *
 * <p>缓存目录按 `rel + 文件大小 + mtime + 档位` 做键 —— 用户重新拷贝/改名/换了
 *   码率档位都会自动失效，不会拿旧产物糊弄。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/* 无损容器：一律转。理由见文件头 —— 16/44.1 的 flac 虽然实测有声，
   但「哪些能播」取决于位深/异常帧，不可预测，统一转掉才不会偶尔踩坑。 */
const LOSSLESS = new Set(['.flac', '.wav', '.ape', '.alac', '.aiff', '.aif', '.dsf', '.dff', '.wv', '.tta']);

/* 终端默认档位（可按设备覆盖，见 devConf/setDev） */
const DEF = {
  id: 'r1',
  on: true,
  /* ★ 默认 MP3，不是 AAC。
     实测（R1 + 24/96 FLAC）：ADTS/AAC 流推过去，服务端在正常吐数据、播放器却
     pos=0 / stalled 一路涨 —— 这条路对这个 MediaPlayer 不可靠。
     而 /radio/ 代理的 64kbps MP3 流 R1 播了几个月都是稳的，MP3 是这台机器
     唯一被反复验证过的"能流式播"的编码。
     MP3 还有个附带好处：它是自带帧同步的文件格式，转完直接改名就能当缓存，
     不需要 m4a 那种 moov 重封装，Range/拖动天然可用。 */
  codec: 'mp3',
  br: 128,             // kbps：听书 96 够用，音乐 128~192
  rate: 44100,
  ch: 2,
  maxRate: 48000,      // 超过就转
  maxBits: 16,
  maxCh: 2,
  lossless: true,      // 无损一律转（关掉 = 16/44.1 的 flac 直发试运气）
  threads: 2,
  maxJobs: 2,          // 并发转码数（4 核，留一半给 HTTP 服务）
  maxMB: 2048,         // 缓存上限
};

let DIR = '';                    // 缓存目录（由 init 传入）
let FILE_CONF = '';              // 设备档案 json
let sendFile = null;             // 注入 server.js 的 sendLocalFile（保留 Range/记录逻辑）
let devConf = {};                // { MAC12: {br:128,...} }
/* ★ v1.7.54：转码改成**按设备白名单**。
   只有登记进 `devConf` 的设备（Web「音频转码」里勾上的那几台）才会被降档，
   没登记的——网页、浏览器、没加进来的老设备——一律原样直发。
   理由：11-19 实测 189 直发 24/96 FLAC 时 R1 原生就能播也有声音，「无损必转」
   这条判据不成立；转码只该给**具体某台解不了的老设备**兜底，不该默认影响所有人。
   应急总闸仍保留：环境变量 `TRANS_ON=0` ⇒ 所有设备都不转（Web 上点了也没用）。 */
let MASTER = true;               // 总闸（默认开；白名单决定谁真转）
let JOBS = 0;                    // 正在跑的转码数
const PENDING = new Map();       // key → [waiter]  同一集并发请求只转一次
const PROBE = new Map();         // rel → {stamp, info}
let PART_SEQ = 0;                // 同一集可能被并发转两条流，各自的临时文件名不能撞

/* ------------------------------------------------------------------ 工具 */

function clampInt(v, d, lo, hi) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(Math.max(n, lo), hi);
}

function extOf(p) {
  const m = String(p || '').toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : '';
}

/** 设备 id 归一：与 server.js 的 devIdOf / 分组表同口径（大写 12 位十六进制）。 */
function normId(v) {
  const s = String(v || '').toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 12);
  return s.length >= 8 ? s : '';
}

/** 转码白名单里的设备数 */
function listCount() {
  let n = 0;
  for (const k of Object.keys(devConf || {})) {
    if (k.charAt(0) === '_') continue;
    n++;
  }
  return n;
}

/* ---------------------------------------------------------- 缓存上限（全局） */

/**
 * 当前生效的缓存上限（MB）。三个来源，优先级从高到低：
 *   ① `devConf._maxMB` —— Web 上「缓存上限」输入框写的值
 *   ② 各设备档位 `maxMB` 里的最大值 —— `/api/trans/dev?id=..&maxMB=..`（v1.7.53 起真正生效；
 *      以前只写进返回值，enforceLimit 还在读 DEF.maxMB，设了等于没设）
 *   ③ `DEF.maxMB`（2 GB）
 * 为什么取「最大值」而不是逐设备统计：缓存按「文件+档位」共享，一个 mp3 可能同时服务
 * 好几台设备，逐设备算不准；总量上限只要覆盖住最贪的那台就不会撑爆磁盘。
 */
function maxMBof() {
  const g = parseInt(devConf && devConf._maxMB, 10);
  if (Number.isFinite(g)) return clampInt(g, 2048, 128, 65536);
  let m = clampInt(DEF.maxMB, 2048, 128, 65536);
  for (const k of Object.keys(devConf || {})) {
    if (k.charAt(0) === '_') continue;
    const v = parseInt(devConf[k] && devConf[k].maxMB, 10);
    if (Number.isFinite(v)) m = Math.max(m, clampInt(v, m, 128, 65536));
  }
  return m;
}

/** Web 上设缓存上限（MB）。传 0 / 空 = 回到默认（删掉 _maxMB，重新看设备档位）。 */
function setMaxMB(v) {
  if (!devConf || typeof devConf !== 'object') devConf = {};
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) delete devConf._maxMB;
  else devConf._maxMB = clampInt(n, 2048, 128, 65536);
  saveConf();
  const m = maxMBof();
  console.log('[aac] 缓存上限 → ' + m + ' MB');
  enforceLimit().catch(() => {});
  return m;
}

function info() {
  const n = listCount();
  return {
    dir: DIR,
    on: !!DIR && MASTER && n > 0,   // 「有没有可能发生转码」= 总闸开 且 名单非空
    master: !!MASTER,
    listed: n,
    jobs: JOBS,
    pending: PENDING.size,
    probed: PROBE.size,
    maxJobs: DEF.maxJobs,
    maxMB: maxMBof(),
    lossless: DEF.lossless,
    ffmpeg: FFMPEG,
  };
}

/**
 * 初始化。
 * @param {object} o
 *   dir      {string} 缓存目录（容器内绝对路径，建议挂载到宿主机）
 *   confFile {string} 设备档案 json 路径
 *   sendFile {function} (res, req, abs, ct, onCommit) —— 复用 server 的 Range 实现
 */
function init(o) {
  try {
    DIR = String((o && o.dir) || '');
    FILE_CONF = String((o && o.confFile) || '');
    sendFile = (o && o.sendFile) || null;
    if (DIR) fs.mkdirSync(DIR, { recursive: true });
    if (FILE_CONF) {
      try {
        devConf = JSON.parse(fs.readFileSync(FILE_CONF, 'utf8')) || {};
      } catch { devConf = {}; }
    }
    /* 总闸优先级：环境变量 TRANS_ON > 档案里的 _master > 默认开。
       `TRANS_ON=0` 可以在 compose 里把整个功能钉死（Web 上点了也开不回来）。 */
    const envOn = String(process.env.TRANS_ON == null ? '' : process.env.TRANS_ON).trim();
    if (envOn !== '') MASTER = !/^(0|false|off|no)$/i.test(envOn);
    else if (devConf && typeof devConf._master === 'boolean') MASTER = devConf._master;
    if (DIR) enforceLimit().catch(() => {});
  } catch (e) {
    console.log('[aac] 初始化失败（转码功能关闭）：' + String(e && e.message || e));
    DIR = '';
  }
  return info();
}

function saveConf() {
  if (!FILE_CONF) return;
  try {
    const tmp = FILE_CONF + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(devConf, null, 2));
    fs.renameSync(tmp, FILE_CONF);
  } catch (e) {
    console.log('[aac] 写设备档案失败：' + String(e && e.message || e));
  }
}

/* ------------------------------------------------------- 设备档位（per-device） */

/**
 * 取某设备的档位。
 *
 * ★ v1.7.54：**白名单制**。`listed` 为假 = 这台设备不在转码列表里 ⇒ 一律原样直发。
 * 以前是「认不出就套默认档」，导致任何 UA 像 MediaPlayer 的终端都被降档；现在
 * 只有 Web 上显式加进「音频转码」列表的设备才有 `devConf[id]` 这条记录。
 *
 * @param devId 设备 MAC（12 位十六进制）
 * @param patch 临时覆盖（只影响本次判定，不落盘）
 */
function profile(devId, patch) {
  const id = normId(devId);
  const rec = id ? (devConf[id] || null) : null;
  const base = Object.assign({}, DEF, rec || {}, patch || {});
  base.devId = id;
  base.listed = !!rec;                     // ★ 只有登记过的设备才转
  base.on = base.listed && !(rec && rec.on === false);
  base.br = clampInt(base.br, 96, 32, 320);
  base.rate = clampInt(base.rate, 44100, 22050, 48000);
  base.ch = clampInt(base.ch, 2, 1, 2);
  base.maxRate = clampInt(base.maxRate, 48000, 22050, 192000);
  base.maxBits = clampInt(base.maxBits, 16, 16, 32);
  base.maxCh = clampInt(base.maxCh, 2, 1, 8);
  base.maxJobs = clampInt(base.maxJobs, 2, 1, 4);
  base.maxMB = clampInt(base.maxMB, 2048, 128, 65536);
  base.tag = base.codec + base.br + 'k' + base.rate + 'x' + base.ch;
  return base;
}

/** 总闸（应急用；真正决定「谁转」的是白名单） */
function globalOn() { return !!MASTER; }

function setGlobal(v) {
  MASTER = !(v === false || v === 0 || v === '0' || v === 'false' || v === 'off');
  if (!devConf || typeof devConf !== 'object') devConf = {};
  devConf._master = MASTER;
  saveConf();
  console.log('[aac] 转码总闸 → ' + (MASTER ? '开（仍按白名单）' : '关（全部直发）'));
  return MASTER;
}

function setDev(devId, patch) {
  const id = normId(devId);
  if (!id) return null;
  const cur = Object.assign({}, devConf[id] || {});
  for (const k of ['on', 'codec', 'br', 'rate', 'ch', 'maxRate', 'maxBits', 'maxCh', 'lossless', 'maxJobs', 'maxMB']) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
      let v = patch[k];
      if (k === 'on' || k === 'lossless') {
        // 数字 0 也要算「关」（URL 传过来是字符串 '0'，代码里可能直接给 0）
        v = !(v === 0 || v === false || v === '0' || v === 'false' || v === 'off');
      } else if (k === 'codec') v = String(v) === 'mp3' ? 'mp3' : 'aac';
      else v = parseInt(v, 10);
      if (k === 'codec' || k === 'on' || k === 'lossless' || Number.isFinite(v)) cur[k] = v;
    }
  }
  if (Object.keys(cur).length) devConf[id] = cur; else delete devConf[id];
  saveConf();
  return profile(id);
}

/** ★ v1.7.54：加进转码白名单（等于「勾上这台设备」）。 */
function addDev(devId) {
  const id = normId(devId);
  if (!id) return null;
  const cur = Object.assign({}, devConf[id] || {});
  if (!cur.addedAt) cur.addedAt = Date.now();
  devConf[id] = cur;
  saveConf();
  console.log('[aac] 加入转码列表：' + id);
  return profile(id);
}

/** ★ v1.7.54：移出白名单（连同它的自定义档位一起删掉；缓存不删，命中即用）。 */
function delDev(devId) {
  const id = normId(devId);
  if (!id || !devConf[id]) return false;
  delete devConf[id];
  saveConf();
  console.log('[aac] 移出转码列表：' + id);
  return true;
}

function devList() {
  const out = {};
  for (const k of Object.keys(devConf)) {
    if (k.charAt(0) === '_') continue;      // _on 等内部键不是设备档案
    out[k] = profile(k);
  }
  return out;
}

/* --------------------------------------------------------------- ffprobe 探测 */

function stamp(abs) {
  try {
    const s = fs.statSync(abs);
    return s.size + ':' + Math.floor(s.mtimeMs / 1000);
  } catch { return ''; }
}

/**
 * 读音频真实规格（带缓存）。
 * 只有「决定要不要转」这一件事需要它，所以失败一律返回 null → 调用方直发，
 * 宁可试一次失败的直发，也不能因为探针挂了把能播的文件也拦住。
 */
function probe(abs, rel) {
  const st = stamp(abs);
  const hit = PROBE.get(rel);
  if (hit && hit.stamp === st) return Promise.resolve(hit.info);
  return new Promise(resolve => {
    let out = '', err = '';
    let ch;
    try {
      ch = spawn(FFPROBE, ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_fmt,sample_rate,bits_per_raw_sample,channels',
        '-show_entries', 'format=duration,bit_rate',
        '-print_format', 'json', abs], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return resolve(null); }
    const fin = info0 => {
      try { if (info0) PROBE.set(rel, { stamp: st, info: info0 }); } catch { /* ignore */ }
      if (PROBE.size > 8000) PROBE.clear();
      resolve(info0);
    };
    const t = setTimeout(() => { try { ch.kill('SIGKILL'); } catch { /* ignore */ } fin(null); }, 8000);
    if (t.unref) t.unref();
    ch.stdout.on('data', d => { out += d.toString('utf8'); });
    ch.stderr.on('data', d => { err += d.toString('utf8'); });
    ch.on('error', () => { clearTimeout(t); fin(null); });
    ch.on('close', () => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out || '{}');
        const s = (j.streams || [])[0] || {};
        const f = j.format || {};
        fin({
          codec: String(s.codec_name || ''),
          rate: parseInt(s.sample_rate, 10) || 0,
          bits: parseInt(s.bits_per_raw_sample, 10) || 0,
          ch: parseInt(s.channels, 10) || 0,
          dur: parseFloat(f.duration) || 0,
          br: parseInt(f.bit_rate, 10) || 0,
          raw: String(s.sample_fmt || ''),
        });
      } catch { fin(null); }
    });
  });
}

/**
 * 这个文件该不该转。
 * @returns {Promise<{need:boolean, why:string, info:object|null}>}
 */
async function judge(abs, rel, prof) {
  const p = prof || profile('');
  if (!MASTER) return { need: false, why: 'master-off', info: null };
  if (!p.listed) return { need: false, why: 'not-listed', info: null };   // ★ v1.7.54 白名单
  if (!p.on || !DIR) return { need: false, why: 'off', info: null };
  const ext = extOf(rel);
  if (LOSSLESS.has(ext) && p.lossless) {
    return { need: true, why: 'lossless:' + ext, info: null };
  }
  const inf = await probe(abs, rel);
  if (!inf) return { need: false, why: 'probe-failed', info: null };
  if (inf.codec && inf.codec !== 'aac' && inf.codec !== 'mp3') {
    return { need: true, why: 'codec:' + inf.codec, info: inf };
  }
  if (inf.rate > p.maxRate) return { need: true, why: 'rate:' + inf.rate, info: inf };
  if (inf.bits > p.maxBits) return { need: true, why: 'bits:' + inf.bits, info: inf };
  if (inf.ch > p.maxCh) return { need: true, why: 'ch:' + inf.ch, info: inf };
  return { need: false, why: 'ok', info: inf };
}

/* ------------------------------------------------------------------ 缓存 */

function keyOf(abs, rel, prof) {
  const h = crypto.createHash('sha1')
    .update(String(rel) + '|' + stamp(abs) + '|' + prof.tag)
    .digest('hex');
  return h.slice(0, 32);
}

function cachePaths(key) {
  return {
    m4a: path.join(DIR, key + '.m4a'),
    aac: path.join(DIR, key + '.aac'),
    mp3: path.join(DIR, key + '.mp3'),
    part: path.join(DIR, key + '.part'),
  };
}

function hitOf(key) {
  const p = cachePaths(key);
  if (fs.existsSync(p.m4a)) return { file: p.m4a, ct: 'audio/mp4' };
  if (fs.existsSync(p.mp3)) return { file: p.mp3, ct: 'audio/mpeg' };
  if (fs.existsSync(p.aac)) return { file: p.aac, ct: 'audio/aac' };
  return null;
}

/** LRU：按 mtime 从旧到新删，直到总量回到上限以内 */
async function enforceLimit() {
  if (!DIR) return { files: 0, bytes: 0, removed: 0, maxMB: maxMBof() };
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return { files: 0, bytes: 0, removed: 0, maxMB: maxMBof() }; }
  const list = [];
  let total = 0;
  for (const n of names) {
    const f = path.join(DIR, n);
    try {
      const s = fs.statSync(f);
      if (!s.isFile()) continue;
      list.push({ f, n, size: s.size, t: s.mtimeMs });
      total += s.size;
    } catch { /* ignore */ }
  }
  const limMB = maxMBof();                 // ★ v1.7.53：不再写死 DEF.maxMB
  const maxB = limMB * 1024 * 1024;
  let removed = 0;
  if (total > maxB) {
    list.sort((a, b) => a.t - b.t);
    for (const x of list) {
      if (total <= maxB * 0.9) break;      // 一次清到 90%，避免每转一首都来扫一遍
      try { fs.unlinkSync(x.f); total -= x.size; removed++; } catch { /* ignore */ }
    }
  }
  return { files: list.length - removed, bytes: total, removed, maxMB: limMB };
}

async function stats() {
  const l = await enforceLimit();
  const maxMB = maxMBof();
  return Object.assign(info(), l, {
    maxMB,
    maxBytes: maxMB * 1024 * 1024,
    pct: Math.round((l.bytes || 0) / (maxMB * 1024 * 1024) * 1000) / 10,
    devs: devList(),
  });
}

async function purge() {
  if (!DIR) return { removed: 0, freed: 0 };
  let n = 0, freed = 0;
  try {
    for (const x of fs.readdirSync(DIR)) {
      const f = path.join(DIR, x);
      try {
        const s = fs.statSync(f);
        if (!s.isFile()) continue;
        fs.unlinkSync(f); n++; freed += s.size;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  PROBE.clear();
  return { removed: n, freed };
}

/* ------------------------------------------------------------------ 转码 */

function buildArgs(abs, prof, toPipe, seekSec) {
  const a = ['-hide_banner', '-nostdin', '-loglevel', 'error',
    /* 源文件可能带坏帧（实测 24/48 的 flac 会报 invalid residual）。
       转码宁可跳过去出一份能听的，也不该整首失败 —— 目标设备上本来就连
       解码都做不到，能听到 99% 远好过一句 502。 */
    '-err_detect', 'ignore_err',
    '-threads', String(prof.threads || 2)];
  /* v1.7.51：seek 续转。输入侧 -ss（放在 -i 前）才是快的，输出侧 -ss 要解码过去。
     目标时间是"目标字节 / 字节率"，CBR 下对齐误差不到一帧（26ms）。 */
  if (seekSec && seekSec > 0.05) a.push('-ss', seekSec.toFixed(3));
  a.push('-i', abs,
    '-vn', '-map', '0:a:0',
    '-ac', String(prof.ch), '-ar', String(prof.rate),
    /* ★ filter_size 默认 16（高保真重采样），但这台 aarch64 上 24/96 → 44.1k
       只有 1.0x 实时 —— 实时流式永远喂不饱播放器（播放要 1x，转码也 1x，起播
       那几秒预缓冲永远攒不出来，设备侧表现就是 loading → stalled 卡死）。
       降到 4 大约 2.1x（实测 60s 音频 28s 转完），听书/流行乐听不出差别。 */
    '-af', 'aresample=' + prof.rate + ':filter_size=4');
  if (prof.codec === 'mp3') {
    a.push('-c:a', 'libmp3lame', '-b:a', prof.br + 'k', '-f', 'mp3');
  } else {
    a.push('-c:a', 'aac', '-b:a', prof.br + 'k');
    a.push('-f', toPipe ? 'adts' : 'mp4');
    if (!toPipe) a.push('-movflags', '+faststart');
  }
  a.push(toPipe ? 'pipe:1' : 'pipe:1');   // 都走 pipe，文件由 Node 落盘（便于 tee）
  return a;
}

/** aac → m4a 重封装（-c copy，秒级），失败就保留 aac*/
function remux(key) {
  const p = cachePaths(key);
  return new Promise(resolve => {
    if (!fs.existsSync(p.aac)) return resolve(false);
    const tmp = p.m4a + '.tmp';
    let ch;
    try {
      ch = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-i', p.aac, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp],
        { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch { return resolve(false); }
    let err = '';
    ch.stderr.on('data', d => { err += d.toString('utf8'); });
    ch.on('error', () => resolve(false));
    ch.on('close', code => {
      if (code === 0) {
        try {
          fs.renameSync(tmp, p.m4a);
          fs.unlinkSync(p.aac);
          return resolve(true);
        } catch { /* ignore */ }
      }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      if (err) console.log('[aac] 重封装失败 ' + key + '：' + err.replace(/\s+/g, ' ').slice(0, 140));
      resolve(false);
    });
  });
}

/**
 * 起一次转码：返回 { child, done:Promise<boolean> }
 * 数据由调用方消费（写 socket / 写缓存文件都由它决定）。
 */
function startTranscode(abs, prof, seekSec) {
  return new Promise(resolve => {
    let ch;
    try {
      ch = spawn(FFMPEG, buildArgs(abs, prof, true, seekSec), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ child: null, done: Promise.resolve(false), err: String(e && e.message || e) });
    }
    let err = '';
    ch.stderr.on('data', d => { err += d.toString('utf8'); });
    const done = new Promise(res2 => {
      ch.on('error', e => { err += String(e && e.message || e); res2(false); });
      ch.on('close', code => {
        if (code !== 0 && err) {
          console.log('[aac] 转码退出 code=' + code + '：' + err.replace(/\s+/g, ' ').slice(0, 160));
        }
        res2(code === 0);
      });
    });
    resolve({ child: ch, done, errText: () => err });
  });
}

/** 等前面那一次转完（同 key 并发请求不重复转） */
function waitFor(key) {
  return new Promise(resolve => {
    const arr = PENDING.get(key) || [];
    arr.push(resolve);
    PENDING.set(key, arr);
  });
}

function settle(key) {
  const arr = PENDING.get(key);
  PENDING.delete(key);
  if (arr) for (const fn of arr) { try { fn(); } catch { /* ignore */ } }
}

/* ------------------------------------------------------------------ 对外主入口 */

/**
 * 发一个需要转码的文件。
 *
 * <p>命中缓存 → 走 sendFile（标准 Range，可拖进度，零延迟）。
 * <p>未命中 → 边转边发（ADTS，1~2 秒出声），同时 tee 落缓存；
 *            转完重封装成 m4a，下次就是秒开 + 可拖。
 *
 * @param {object} req
 * @param {object} res
 * @param {object} o  { abs, rel, prof, tag, onCommit }
 * @returns {Promise<'hit'|'stream'|'queued'|'fail'>}
 */
async function serve(req, res, o) {
  const abs = o.abs, rel = o.rel;
  const prof = o.prof || profile('');
  const tag = o.tag || rel;
  if (!DIR) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('服务端转码未启用');
  }
  const key = keyOf(abs, rel, prof);

  // ① 命中缓存（整首已转完，标准 Range，最理想）
  const hit = hitOf(key);
  if (hit) {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': hit.ct, 'Accept-Ranges': 'bytes', 'X-Audio-Cache': 'hit' });
      return res.end();
    }
    return new Promise(resolve => {
      res.on('close', () => resolve('hit'));
      try { sendFile(res, req, hit.file, hit.ct, o.onCommit); } catch { /* ignore */ }
      setTimeout(() => resolve('hit'), 50).unref();
    });
  }

  /* ② v1.7.51：先算"这条流有多长"。
   *
   * MP3 CBR 的字节位置与播放时间严格线性（128k ⇒ 每秒恒定 16000 字节），于是还在
   * 长的 .part 也能对外伪装成一个**普通可拖的 mp3 文件**：
   *     Content-Length = 时长 × 字节率   ⇒ 播放器一上来就知道 durMs
   *     Accept-Ranges: bytes + 真 Range  ⇒ 转过的区间任意拖
   * 旧版发 chunked 无长度，MediaPlayer 只能当直播流：dur=0、拖不动、还一直判 stalled。
   * 这就是 Emby/Jellyfin 用 m3u8 清单给出的两样东西（总时长、按位置取），我们换成
   * 字节区间来表达，播放器不用懂 HLS。 */
  const inf = await probe(abs, rel);
  const durS = (inf && inf.dur > 0) ? inf.dur : 0;
  const bps = byteRateOf(prof);
  const total = (prof.codec === 'mp3' && durS > 0) ? Math.floor(durS * bps) : 0;

  /* HEAD 探活：**必须排在任何等待之前**。device 的 probeUrl 用 HEAD + 3 秒超时，
     排在转码等待后面会让设备直接判"地址播不了"。 */
  if (req.method === 'HEAD') {
    const h = {
      'Content-Type': prof.codec === 'mp3' ? 'audio/mpeg' : 'audio/aac',
      'Accept-Ranges': 'bytes',
      'X-Audio-Cache': 'miss',
      'X-Audio-Transcode': '1',
    };
    if (total > 0) h['Content-Length'] = String(total);
    try { res.writeHead(200, h); } catch { /* ignore */ }
    return res.end();
  }

  // ③ Range 解析（bytes=a-b / bytes=a- / bytes=-n）
  let from = 0, to = total > 0 ? total - 1 : -1;
  const raw = String(req.headers.range || '').trim();
  if (raw && total > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
    if (m) {
      if (m[1]) {
        from = parseInt(m[1], 10) || 0;
        if (m[2]) to = Math.min(parseInt(m[2], 10) || to, total - 1);
      } else if (m[2]) {
        const n = parseInt(m[2], 10) || 0;
        from = Math.max(0, total - n);
      }
      if (from >= total) {
        try { res.writeHead(416, { 'Content-Range': 'bytes */' + total, 'Content-Type': 'text/plain' }); } catch { /* ignore */ }
        return res.end();
      }
    }
  }

  /* ④ 同一份已经在转 ⇒ 跟着那个 .part 读（预读连接 + 正式连接共用一条 ffmpeg）。
   *   三种接不上要重起一条 `-ss`：
   *     · 客户端要从比这条流的起点更早的位置读（新连接从 0 开始，而旧流是从 seek 点起的）
   *     · 拖到还没转到的位置，且距离超过 15 秒音频（240KB）——等下去不如重转
   *   这正是 Emby/Jellyfin「拖到没转出来的位置就重启 ffmpeg -ss」那一手。 */
  let live = LIVE.get(key);
  if (live) {
    const head = live.startByte || 0;
    const ahead = from - (head + live.bytes);
    if (from < head || (from > 0 && ahead > 240000)) {
      live.abandon = true;
      try { live.child && live.child.kill('SIGKILL'); } catch { /* ignore */ }
      live = null;
    }
  }
  if (!live) {
    const seekSec = from > 0 && bps > 0 ? from / bps : 0;
    live = await startLive(abs, rel, prof, tag, key, from, seekSec);
    if (!live) {
      // 起不来转码 ⇒ 退回直发源文件（至少还有一次机会）
      try { if (sendFile) sendFile(res, req, abs, o.ct || 'audio/flac', o.onCommit); } catch { /* ignore */ }
      return 'fail';
    }
  }
  return followLive(req, res, live, prof, o, tag, { from, to, total });
}

/* ------------------------------------------------- v1.7.50 单飞转码 + 文件跟随 */

/* key -> { partPath, bytes, done, ok, committed, startByte, readers, child, abandon }
   同一个文件只跑一条 ffmpeg；每条 HTTP 连接各自从 .part 的 startByte 开始读、
   读到当前末尾就等。这样既不会把转码算力劈开，又天然支持"预读连接 + 正式连接"同时在线。 */
const LIVE = new Map();

function sleepMs(n) { return new Promise(r => setTimeout(r, n)); }

/** 所有连接里正在被读的转码条数（预取要不要让路靠它判） */
function activeReaders() {
  let n = 0;
  for (const v of LIVE.values()) n += (v.readers || 0);
  return n;
}

/** CBR 字节率：128k → 16000 B/s（字节 ↔ 时间的换算全靠它） */
function byteRateOf(prof) {
  return Math.round((prof.br || 128) * 1000 / 8) || 16000;
}

/**
 * 边转边发：从 from 读 .part，读到当前末尾就等，直到整首转完或客户端断开。
 *
 * <p>v1.7.51 三个要点：
 *   ① **报长度**（Content-Length = 总字节），播放器据此算出 durMs，能显示时长；
 *   ② **真 Range**：已转过的区间任意拖，206 + Content-Range 回；
 *   ③ 声明长度比实际产出多出来的几百字节（编码器帧对齐）用零字节补齐 ——
 *      尾部若干零字节解码器直接忽略，比"连接提前断"对播放器友好得多。
 */
async function followLive(req, res, live, prof, o, tag, rg) {
  const from = (rg && rg.from) || 0;
  const total = (rg && rg.total) || 0;
  const to = total > 0 ? ((rg.to >= 0) ? rg.to : total - 1) : -1;
  const known = total > 0;
  const partial = known && (from > 0 || to < total - 1);
  const bps = byteRateOf(prof);

  const headers = {
    'Content-Type': prof.codec === 'mp3' ? 'audio/mpeg' : 'audio/aac',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'X-Audio-Transcode': '1',
    'X-Audio-Format': prof.codec + '/' + prof.br + 'k/' + prof.rate + '/' + prof.ch,
    'X-Audio-Seek': (from / bps).toFixed(1),
  };
  if (known) {
    headers['Content-Length'] = String(to - from + 1);
    if (partial) headers['Content-Range'] = 'bytes ' + from + '-' + to + '/' + total;
  }
  try { res.useChunkedEncodingByDefault = !known; } catch { /* ignore */ }
  try { res.writeHead(partial ? 206 : 200, headers); } catch { return 'fail'; }

  live.readers = (live.readers || 0) + 1;
  let freed = false;
  const release = () => {
    if (freed) return;
    freed = true;
    live.readers = Math.max(0, (live.readers || 1) - 1);
  };
  res.on('close', release);

  // .part 由 startLive 创建，这里可能早了一拍 ⇒ 等它出现（最多 3 秒）
  let fh = null;
  for (let i = 0; i < 100 && !fh; i++) {
    if (res.destroyed || res.writableEnded) { release(); return 'fail'; }
    try { fh = await fs.promises.open(live.partPath, 'r'); } catch { await sleepMs(30); }
  }
  if (!fh) { try { res.end(); } catch { /* ignore */ } release(); return 'fail'; }

  let pos = from;                    // 客户端视角的绝对字节位置
  const end = known ? to : -1;
  let mine = false;
  try {
    for (;;) {
      if (res.destroyed || res.writableEnded) break;
      const off = pos - (live.startByte || 0);
      if (off < 0) break;                                   // 不该出现：已按 head 对齐过
      if (off >= live.bytes) {
        if (live.done) break;                               // 转完且读到末尾 ⇒ 正常收工
        await sleepMs(40);                                  // 转码还在追，等下一坨
        continue;
      }
      const want = Math.min(65536, live.bytes - off);
      const buf = Buffer.allocUnsafe(want > 0 ? want : 1);
      let n = 0;
      try { const r = await fh.read(buf, 0, want, off); n = r.bytesRead; } catch { n = 0; }
      if (n <= 0) { await sleepMs(40); continue; }           // write stream 还没刷盘
      let w = n;
      if (known && pos + w > to + 1) w = to + 1 - pos;       // 不越过声明长度
      if (w <= 0) break;
      pos += w;
      if (!mine && pos - from >= 32768) {                    // 真吐出 32KB 才算这次起播成立
        mine = true;
        if (!live.committed) {
          live.committed = true;
          if (typeof o.onCommit === 'function') { try { o.onCommit(); } catch { /* ignore */ } }
        }
      }
      let ok = true;
      try { ok = res.write(buf.subarray(0, w)); } catch { ok = false; }
      if (!ok) {
        await new Promise(done => {
          const f = () => { res.removeListener('drain', f); res.removeListener('close', f); done(); };
          res.once('drain', f); res.once('close', f);
        });
      }
      if (end >= 0 && pos > end) break;
    }
    if (known && !res.destroyed && !res.writableEnded && pos <= to) {
      while (pos <= to) {
        const n = Math.min(32768, to - pos + 1);
        let ok = true;
        try { ok = res.write(Buffer.alloc(n)); } catch { ok = false; }
        if (!ok) break;
        pos += n;
      }
    }
  } finally { try { await fh.close(); } catch { /* ignore */ } }
  release();
  if (!res.destroyed && !res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
  return 'stream';
}

/**
 * 起一条转码并登记到 LIVE。
 * @param {number} startByte 这条流的输出从源文件的哪个"字节位置"开始（0 = 从头）
 * @param {number} seekSec   给 ffmpeg 的 -ss（startByte / 字节率 得来）
 */
async function _startLive(abs, rel, prof, tag, key, startByte, seekSec) {
  /* 预取不许跟正在播的那条抢核：一条 24/96 转码本来就只有 2x，两条并行各 1x，
     正好等于播放消耗 ⇒ 缓冲永远攒不满（设备侧表现就是 playing 但 stalled 一路涨）。 */
  const t0 = Date.now();
  while (JOBS >= prof.maxJobs
    || (!LIVE.has(key) && activeReaders() > 0 && Date.now() - t0 < 20000)) {
    await sleepMs(200);
  }
  const p = cachePaths(key);
  const partPath = p.part + '.' + process.pid + '.' + (++PART_SEQ);
  const live = {
    partPath, bytes: 0, done: false, ok: false, committed: false,
    startByte: startByte || 0, readers: 0, child: null, abandon: false,
  };
  LIVE.set(key, live);
  JOBS++;

  const ctx = await startTranscode(abs, prof, seekSec || 0);
  if (!ctx.child) { JOBS--; if (LIVE.get(key) === live) LIVE.delete(key); return null; }
  live.child = ctx.child;
  console.log('[aac] 实时转码 ' + tag + (live.startByte ? ' @' + live.startByte + 'B' : '')
    + ' → ' + prof.tag + '（并发 ' + JOBS + '/' + prof.maxJobs + '）');

  let ws = null;
  try { ws = fs.createWriteStream(partPath); } catch { ws = null; }
  let idleAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - idleAt > 120000) {
      console.log('[aac] 转码 120s 无产出，放弃：' + tag);
      try { ctx.child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 5000);
  if (watchdog.unref) watchdog.unref();

  ctx.child.stdout.on('data', ch => {
    idleAt = Date.now();
    live.bytes += ch.length;
    if (ws) { try { ws.write(ch); } catch { /* ignore */ } }
  });
  ctx.child.stdout.on('error', () => { /* 断管由 done 收尾 */ });

  ctx.done.then(ok => {
    clearInterval(watchdog);
    JOBS--;
    const finish = () => {
      live.ok = ok;
      const full = ok && live.bytes > 0 && !live.abandon && (live.startByte || 0) === 0;
      if (full) {
        if (prof.codec === 'mp3') {
          // MP3 自带帧同步，直接就是可 Range 的缓存文件，不用重封装
          try { fs.renameSync(partPath, p.mp3); } catch { /* ignore */ }
        } else {
          try { fs.renameSync(partPath, p.aac); } catch { /* ignore */ }
          remux(key).catch(() => {});
        }
        console.log('[aac] 缓存完成 ' + tag + ' ' + (live.bytes / 1048576).toFixed(1) + 'MB');
        enforceLimit().catch(() => {});
      } else {
        // 中途被 seek 打断 / 只转了一段：这段字节接不回整首，别留在缓存里当"已转好"
        try { fs.unlinkSync(partPath); } catch { /* ignore */ }
      }
      live.done = true;        // 收尾做完才放行读者，免得他们读到"还没刷盘"的末尾
      if (LIVE.get(key) === live) LIVE.delete(key);
    };
    // ws.end 的回调在数据真正刷进文件之后才来（rename 之前必须等它）
    if (ws) { try { ws.end(finish); } catch { finish(); } } else { finish(); }
  });

  return live;
}

/* 同 key 起转的互斥：设备一次起播会同时发"预读 + 正式"两条连接，两条都刚到
   这里时 LIVE 里还没有它，会各起一条 ffmpeg（算力被劈半的真凶）。后到的那条
   等前一条登记好，直接共用。 */
const STARTING = new Set();

async function startLive(abs, rel, prof, tag, key, startByte, seekSec) {
  if (STARTING.has(key)) {
    for (let i = 0; i < 200; i++) {
      const l = LIVE.get(key);
      if (l) return l;
      await sleepMs(20);
    }
  }
  STARTING.add(key);
  try { return await _startLive(abs, rel, prof, tag, key, startByte, seekSec); }
  finally { STARTING.delete(key); }
}

/* ------------------------------------------------------- 后台预转队列 */

const WARMQ = [];        // 待转队列
let WARM_BUSY = 0;       // 正在转的个数（固定 1：转码吃满核，别和播放抢）
let WARM_DONE = 0, WARM_FAIL = 0;

/** 把一个文件塞进后台转码队列（同一个 key 不会重复入队） */
function kick(abs, rel, prof) {
  try {
    const p0 = prof || profile('');
    if (!p0.on || !DIR) return false;
    const key = keyOf(abs, rel, p0);
    if (hitOf(key)) return false;
    if (PENDING.has(key)) return false;
    if (WARMQ.some(x => x.key === key)) return false;
    WARMQ.push({ abs, rel, prof: p0, key });
    pump();
    return true;
  } catch { return false; }
}

function pump() {
  if (WARM_BUSY >= 1 || !WARMQ.length) return;
  const j = WARMQ.shift();
  WARM_BUSY++;
  console.log('[aac] 后台预转开始 ' + j.rel + '（队列剩 ' + WARMQ.length + '）');
  Promise.resolve()
    .then(() => prewarm(j.abs, j.rel, j.prof))
    .then(r => {
      if (r && r.ok) { WARM_DONE++; enforceLimit().catch(() => {}); }
      else { WARM_FAIL++; console.log('[aac] 预转未完成 ' + j.rel + '：' + ((r && r.err) || (r && r.skipped) || '')); }
    })
    .catch(e => { WARM_FAIL++; console.log('[aac] 预转异常 ' + j.rel + '：' + String(e && e.message || e)); })
    .then(() => { WARM_BUSY--; setTimeout(pump, 1200); });
}

function warmInfo() {
  return { queued: WARMQ.length, busy: WARM_BUSY, done: WARM_DONE, fail: WARM_FAIL };
}

/** 后台预热：不占请求，转完落缓存（给"整本/整专辑先转好"用） */
async function prewarm(abs, rel, prof, cb) {
  const p = prof || profile('');
  const j = await judge(abs, rel, p);
  if (!j.need) return { ok: true, skipped: j.why };
  const key = keyOf(abs, rel, p);
  const hit = hitOf(key);
  if (hit) return { ok: true, hit: true };
  const pth = cachePaths(key);
  const partPath = pth.part + '.' + process.pid + '.' + (++PART_SEQ);
  const ctx = await startTranscode(abs, p);
  if (!ctx.child) return { ok: false, err: ctx.err || '' };
  let ws;
  try { ws = fs.createWriteStream(partPath); } catch { return { ok: false, err: 'write' }; }
  let n = 0;
  ctx.child.stdout.on('data', c => { n += c.length; try { ws.write(c); } catch { /* ignore */ } });
  const ok = await ctx.done;
  try { ws.end(); } catch { /* ignore */ }
  if (ok && n > 0) {
    if (p.codec === 'mp3') {
      try { fs.renameSync(partPath, pth.mp3); } catch { /* ignore */ }
    } else {
      try { fs.renameSync(partPath, pth.aac); } catch { /* ignore */ }
      await remux(key);
    }
    if (cb) { try { cb(rel); } catch { /* ignore */ } }
    return { ok: true, bytes: n };
  }
  try { fs.unlinkSync(partPath); } catch { /* ignore */ }
  return { ok: false, err: 'transcode-failed' };
}

module.exports = {
  init, info, stats, purge, kick, warmInfo, globalOn, setGlobal,
  profile, setDev, devList, addDev, delDev, maxMBof, setMaxMB,
  judge, probe, serve, prewarm,
  DEF, LOSSLESS, keyOf,
};

#!/usr/bin/env node
'use strict';
/**
 * server.js —— mini-lx 的 Web 服务端
 *
 * 用法：node server.js [音源脚本.js] [--port 8099]
 *   · 音源脚本可选；不传则自动加载 scripts/ 目录下已导入的脚本。
 *   · 不传且 scripts/ 为空 → 只能搜不能播（/api/url 返回 503）。
 *
 * 接口：
 *   GET  /                                   Web UI（与 R1 控制台同一套观感）
 *   GET  /api/pool?n=100[&fresh=1]           随机曲库（默认 100 首；fresh=1 换一批）
 *   POST /api/pool/add  {…} | {items:[…]}    把搜索结果加进曲库（语音点歌也能点到）
 *   GET  /m/<path>                                本地音乐文件（支持 Range）
 *   GET  /radio/<b64url(电台原始地址)>            ★ 网络电台代理（预缓冲，抗公网抖动）
 *   GET  /index.json                         ★ R1 语音点歌曲库（契约见 PlayerBridge.loadIndex）
 *   GET  /s/<i>                              ★ 曲库第 i 首：现场取链 → 转发（写 files/stream_redirect 改 302）
 *   GET  /api/sources                       搜索源清单（kw/kg/wy/tx/mg）
 *   GET  /api/search?q=&source=all&n=&page=  多源搜索
 *   GET  /api/boards  /api/board?id=         酷我榜单（曲库池用，UI 已不再展示）
 *   GET  /api/lyric?rid=&source=  /api/pic?rid=  歌词 / 封面（歌词：kw 走酷我直连，没词再落雪兜底）
 *   GET  /api/hot                            热搜词
 *   GET  /api/url?rid=&q=&source=&title=&artist=  取播放直链（lxserver中继；q 省略=默认音质）
 *   GET|POST /api/quality                        默认音质（128k / 192k / 320k，默认 128k）
 *   GET  /api/probe?u=                       直链探针（排障）
 *   GET  /api/script                         当前音源脚本状态
 *   POST /api/script/import  {url} | {text,name}   导入音源脚本
 *   POST /api/script/clear                   卸载音源脚本
 *   GET|POST /api/cookie                     网易登录态（解锁 VIP / 无版权原版）
 *   GET  /api/health
 *   GET|DELETE /api/ab/cache           ★ v1.6.9 在线书目永久缓存：查看 / 清除（?key= 或 ?all=1）
 *
 * ★ v1.4.0 双设备：R1 音箱 + AlphaPi（小智）同时可用
 *   同一个路径按客户端自动分流：R1 拿原始 mp3/m4a（它自己解码），
 *   AlphaPi 现转成 WAV 8bit/24000Hz/单声道（它**没有** mp3 解码器，flac 也处理不了）。
 *   识别依据见 isAlphaPi()：UA 里带 alphapi/xiaozhi/stem/esp32、`?dev=ap`，
 *   或直接走 /ap/ 前缀（前缀最可靠 —— 固件不发 UA 时也能确定要转码）。
 *
 *   GET  /ap/index.json                  AlphaPi 版曲库（tracks[].url 已指向 /ap/…，必定转码）
 *   GET  /ap/online.json                 只要在线池（同上）
 *   GET  /ap/radios.json                 AlphaPi One 收音机格式 {radios:[{name,url,on}]}
 *   GET  /ap/m/<path>  /ap/s/<i>  /ap/r/<source>/<rid>
 *                                        与 /m /s /r 同址，强制转码
 *   GET  /api/whoami                     当前请求被识别成什么设备（排障）
 *   GET  /api/ap/selftest                转码自检（正弦波跑一遍，不依赖外部源）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
// ★ 常见部署错误：只拷了 server.js，没带 sdk/ 和 lxrt.js。给一句人话提示，别甩 MODULE_NOT_FOUND。
let S, LXRuntime;
try {
  S = require('./sdk/sources');
  LXRuntime = require('./lxrt').LXRuntime;
} catch (e) {
  console.error('\n[mini-lx] 启动失败：依赖不完整 —— ' + (e && e.message || e));
  console.error('[mini-lx] 请把整个 mini-lx 目录一起部署（必须含 sdk/、web/、lxrt.js、server.js），');
  console.error('[mini-lx] 只上传 server.js 一个文件是跑不起来的。当前目录: ' + __dirname + '\n');
  process.exit(1);
}

const argv = process.argv.slice(2);
const pIdx = argv.indexOf('--port');
const PORT = pIdx > -1 ? parseInt(argv[pIdx + 1], 10) : 8099;
// 版本号（打在 /api/health、Web 顶栏与启动日志里 —— 远程排障时先对版本再排查）。
// 1.1.0（2026-11-04）：① Web「取链正常」假绿灯改成只认真实取链结果；
//   ② 取链失败文案按原因分级（网络隔离 / CDN 不通 / 鉴权 / 平台没资源）；
//   ③ 新增 /api/lx/selftest 五步自检 + Web「测一下」按钮。
//   起因：威联通用户两个容器网络配置不同相互隔离，每档 12s 全超时，
//   而页面绿灯只看「配置了没」，日志又只有一句万能兜底文案，排查全靠猜。
// 1.2.0（2026-11-04）：新增 NAS 本地有声书库（ablocal.js）——
//   /api/abl/books|eps|pos|rescan + media_flags.abLocal 开关；
//   文件名认四种命名，合集（三体139-【黑暗森林Ⅱ】第85集）自动拆「合集→子书→集」，
//   记忆按子书各存一份、父级聚合展示。播放走 /m/<rel>，不经过落雪取链。
// 1.2.1（2026-11-04 晚）：读有声书目录自带的 sidecar（cover*/desc.txt/reader.txt/metadata.json）——
//   封面上列表、作者/演播/年份上书名行、简介进详情、chapters[] 的 end-start 当每集时长；
//   顺带修 /m/ 只认音乐根的问题（有声书是独立挂载 ABL_DIR，两个根都要认，且图片要给对 MIME）。
// 1.2.2（2026-11-04 夜）：书列表的封面从相对 /m/… 改成 NAS 绝对地址 ——
//   R1 网页是用设备 IP 打开的，相对路径会打到设备上，封面全是 404（图裂）。
// 1.2.3（2026-11-07）：修「容器偶发意外停止」（日志 Unhandled 'error' event + TimeoutError）——
//   pipeAudio 的 AbortSignal.timeout(20000) 定时器不会因响应头到达而停，播放器一暂停/拖进度
//   就背压卡住上游 body，20s 后 abort → fromWeb 的 Readable error 无人接 → 进程退出。
//   改成「等头 20s + 传输期 60s 空闲看门狗」，src/res 全挂 error，另加进程级兜底。
// 1.2.4（2026-11-07）：前端修「播放失败：The play() request was interrupted by a new load
//   request」——web/index.html 的 play() 把「换歌导致旧 play() 被打断」当成失败弹红字。
//   服务端代码未变（页面每次请求现读，覆盖 web/index.html 即可生效）。
// 1.4.0（2026-11-11）：**同时兼容 R1 与 AlphaPi（小智）**。
//   AlphaPi 的音频通路只吃 8bit/24000Hz 单声道 PCM（协控 1 字节 = 1 样本，
//   而且固件里没有 mp3 解码器、flac 更不行）⇒ 服务端按客户端身份现转码：
//     · R1（或浏览器）= 原样转发 mp3/m4a，行为与 1.3.x 完全一致；
//     · AlphaPi = ffmpeg 解码 + 重采样到 24k + 降到 8bit，包 44 字节流式 WAV 头推流。
//   识别：UA / ?dev=ap / /ap/ 前缀（三选一命中即转码），转码参数可用 AP_RATE、
//   AP_BITS、AP_CH、AP_GAIN_DB 覆盖；/api/whoami、/api/ap/selftest 用于排障。
// 1.5.0（2026-11-11）：**AlphaPi 设备侧语音点歌** `/ap/song`。
//   小智固件 V2.2.0 起带设备侧 MCP（initialize / tools/list / tools/call），
//   语音「播放晴天」由云端 LLM 调 self.stem.play_song ⇒ 设备请求
//   `GET /ap/song?q=<关键词>&raw=1`，服务端选歌 + 转码后**直接给 8bit/24k 裸 PCM**
//   （不带 WAV 头，设备零解析零解码，收到就塞播放 FIFO）。
//   ★ 响应刻意不用 chunked（Connection: close + useChunkedEncodingByDefault=false），
//     设备侧只做"读到连接关闭为止"，少一层帧解析。
// 1.5.1（2026-11-11 晚）：**本地播放三件套** —— 歌单连播 / 网络电台 / 有声书。
//   新增统一出口 `GET /ap/play?kind=song|radio|book`：
//     · song  = 关键词 → 本地库优先 + 落雪，多首由 ffmpeg concat 拼成**一条** PCM 流
//               （设备端没有队列；`idx=` 就是"下一首" —— 带新 idx 重连即可）
//     · radio = 台名 → 直播流（无限长，永不 EOF）；台名匹配宁可"没听懂"也不乱选台
//     · book  = 书名 → NAS 本地书库优先（有"上次第几集"记忆）→ 在线书库，
//               `ep=0` 续播，`ep=N` 跳集，`n=` 连播几集
//   transcode.js 同步支持 items[] 多输入（aresample+aformat 统一格式后 concat）——
//   ★不能只在输出端统一格式：concat filter 要求各路输入本身一致，否则直接
//   "Input channels are not matching" 或拼出半速噪声。
// 1.6.0（2026-11-11 夜）：**跨设备播放记录 + 有声书续播**。
//   · 设备身份：固件在媒体库请求里带 `X-Dev-Mac`（WiFi MAC），没有就退化成 ip-<地址>；
//   · files/history.json 记每台设备最近 60 条（起播落一条，流结束按**实际写出字节**结算秒数）；
//   · `GET/DELETE /api/history`，Web 新增「播放记录」页；
//   · `/ap/play?kind=book&ep=0` = 续播：按本机上次那本书的集号 +（位置 - 10s）起播
//     （bytes 比耳朵略超前，回退 10s 正好抹掉这段）；
//   · 顺带修「听三体必 404」：合集 lastEp（86）套到子书（54 集）上集表为空 ⇒ 现在用
//     子书自己的 lastEp，越界回落第 1 集。**只有有声书续播**，歌曲/电台不续。
// 1.6.9（2026-11-13）：**在线有声书整本索引永久缓存**（abookcache.js）。
//   起因：/api/ab/search 与 /api/ab/episodes 原本只有 5 分钟内存缓存，进程重启 /
//   超时就要对落雪重跑 abSearchRaw + 单发全量 lxSearchAll（一本 2101 集的书得拉一次大的），
//   而 albumId / source / rid / 集表基本不变。
//   现在：搜过 / 整理过 / 播过的书落 files/ab_cache.json，**无 TTL、变了才写盘**，
//   所有设备共享同一份；只有取链失败累计到阈值、整本取链全空或 ?fresh=1 才回源重搜。
//   直链不落盘（会过期），仍走 resolveUrl 的 30 分钟内存缓存。
// 1.7.9（2026-11-13）：**缺集列表只要集号 + 真名自动同步**（用户定验收标准）。
//   · /api/ab/episodes 与 /api/ab/cache?full=1 输出层把缺集占位标题统一成「第 N 集」
//     （磁盘原文不动）—— R1 列表 / Web 列表都只显示集号，缺集提示靠 missing 字段角标；
//   · /r/ 回传识别兼容新标题（「第 N 集」且 rid 不在缓存书目 ⇒ 设备自救）；
//   · Web 书架详情页 15s 轻量轮询 full=1（纯缓存直读、零回源零风控），
//     rev 变了就原地重渲染（保留页码/滚动）—— 别的设备救援/补真名后自动更新。
// 1.7.8（2026-11-13）：**回传补真名 · 借标题兜底**（用户点破：常规救援一跑就有真名）。
//   · 实测遮天 260：设备走的 rid 在 kw 搜索里连全量枚举都捞不出，按 rid 对号补名
//     永远落空 —— 但精确词搜出的**同集号其它条目带真标题**；
//   · 补真名 = 复跑一遍常规救援（abRescueEp 四词形+评分）：候选 rid 与回传 rid
//     一致 → 完整补齐；不一致 → 只借真标题保留旧 rid（旧 rid 是设备播出验证过的）。
// 1.7.7（2026-11-13）：**直链播放也落播放记录**（P1 最小切片，路线图痛点 #1）。
//   · /r/ 与 /m/ 此前一次都不进 history.json（R1 听了什么服务端一无所知）——
//     现在 /r/ 成功路径按 rid 反查缓存（bookByRid）落 kind=book 记录（书/集/主播齐），
//     非书目 rid 落 kind=song；/m/ 音频请求按路径段落本地歌/本地书记录；
//   · 防刷：同设备同 rid 120s 去重（Range/seek 重放请求不重复记账）；
//   · /r/ 流的位置服务端无从得知（设备没接 /pos 上报），记录标 stream=true，
//     pos 留空 —— 完整进度中枢待 P1 正式做（§7 待拍板）。
// 1.7.6（2026-11-13）：**设备救援回传**（实测：R1 点缺集自己搜 rid 播成功了，
//   但结果没回传 —— 服务端缓存还是占位，两个 Web 都灰着，下次别设备又要重搜）。
//   · /r/ 播成功且 title 是占位文案（缺集 · 上游没有第 N 集）⇒ 按集号+主播+albumId
//     找到有占位的书，把 rid 用 rescueEp 学回缓存；设备搜过 ⇒ siGet 里有原始
//     真标题/专辑，学回的是带真信息的条目；
//   · 设备端零改动：R1 继续用自己的救援逻辑，服务端旁路学习。
// 1.7.5（2026-11-13）：**点播缺集自动救援**（R1 端零改动适配）。
//   · /api/ab/episodes 带 ep=N 且该集是占位 → 自动触发精确词救援再应答，
//     不再要求显式 rescue=1（R1 说「播放第N集」缺集有机会救回再播；rescue=1 参数兼容保留）；
//   · 救援落空负缓存 10 分钟：救不回的集反复点播不反复全量搜（省上游限流预算）。
// 1.7.4（2026-11-13）：**救援成功顺手预热取链**（用户实测：搜索 4s + 点击播放又 4s）。
//   · 点击播放不是再搜一遍 —— 是 /r/ 惰性取链（rid→可播直链，lxserver 3.6~4s）；
//   · 救援落盘成功后立刻后台 resolveUrl 预热（lx:源:rid:音质 缓存 30 分钟），
//     用户点这一集时 /r/ 直接命中缓存秒开，把取链耗时从点击路径上拿掉。
// 1.7.3（2026-11-13）：**救援提速**（实测遮天 250 救援 27s，手工搜同词 3s）。
//   · abRescueEp 词形搜索不再 lxSearchAll 'all' 全量枚举（单趟 19s/1.26MB 是元凶）：
//     先按限量 50 快搜（精确词相关度前排必含目标集，实测 3~4s），四趟全落空
//     才对「书名 第N集」做一次全量兜底 —— 常见 case 从 27s 降到 ~4s。
// 1.7.2（2026-11-13）：**书架批量管理 + 搜索不写摘要缓存**（用户定稿）。
//   · 书架新增「批量管理」：卡片勾选（全选 / 选全部仅摘要 / 清空选择），
//     删除所选走 DELETE /api/ab/cache?keys=k1,k2,… 双重确认，真删缓存；
//   · /api/ab/search 回源路径不再 putSearch 写「仅摘要」—— 没播放 / 没点开的书
//     不进缓存（书架不再堆积摘要条目）；进缓存收敛为：＋缓存 / 点开书 / 设备播过。
// 1.7.1（2026-11-13）：**缺集救援提速 + 缓存防降级**（实测翻车两连修）。
//   · Web 缺集重试不再带 fresh=1 整本重搜（三路并行+全量枚举几十秒）—— 直接吃
//     缓存集表走精确词救援，秒级出结果；
//   · putFull 防降级：上游对重复查询吐截断缓存（2101→2000→200）时，旧表真集
//     优先补回新表占位行，不再把好集降级成「缺」；
//   · _tests/ab-cache.js 新增 ⑪ 防降级回归（83 项全绿）。
// 1.7.0（2026-11-13）：**Web UI 自适应改版 + 书架页**。
//   · web/index.html：落雪音乐风格移动端/桌面端自适应（≥860px 宽屏出多栏网格）；
//   · 新增「书架」页：直接看已缓存的书单（/api/ab/cache 的 items），点开即播、
//     进度条可点/可拖调进度（直播流除外）；书架打开书目走纯缓存直读，绝不回源；
//   · /api/ab/cache 新增 GET ?key=…&full=1：按 key 纯缓存直读整本集表（abcache.byKey）；
//   · Web 🎧 有声书搜索改走 /api/ab/search（缓存优先）—— **在网页上搜过 / 点开过的书
//     同样进永久缓存**，与 R1 / AlphaPi 共享同一份；播放时 /r/ 成功自动 markRidPlay。
// 1.7.10（2026-11-14）：**历史缺集脏行也能触发按需救援**（真机实测回归）。
//   ab_cache.json 里 v1.6.x 遗留的占位行只有「（缺集 · 上游没有第 N 集）」文案 + rid:''，
//   **没有 missing 字段**。v1.7.5 起的按需救援只认 tgt.missing ⇒ 这批行永远救不回来：
//   Web 点它提示「稍后再试」、语音点播报「网络好像出了点问题」、rev 也不涨。
//   统一改成「没有 rid 就是缺集」：救援判定 / episodes 输出 / cache?full=1 输出三处同口径。
//   仍只在 ep=N 单点请求时触发精确词救援，ep=0 的整本预填绝不批量回源（风控红线不变）。
// 1.7.11（2026-11-14）：**歌曲也走服务端 rid 缓存**（用户拍板「歌曲也和有声书一样走
//   服务器 rid 缓存吧」）。R1 收藏 357 条里 322 条没绑源，device 单点播放五路全空
//   直接 ERR「还没配上源」——此前 rid 只写回 device 本地 fav.json，换设备就丢。
//   新增 GET /api/song/resolve?title=&artist=：song_cache.json 纯缓存命中直回；
//   未命中**单次**落雪搜索 + 歌手闸筛选，写缓存再回；搜不到记 10 分钟负缓存。
//   只处理单条、绝不批量预搜（风控红线同有声书）。
// 1.7.12（2026-11-14）：**歌曲 rid 缓存可视化 + 可管理**（用户需求）。
//   GET  /api/song/cache?page=&size=&q=  分页列表（入库时间倒序，q 过滤歌名/歌手/rid）；
//   POST /api/song/cache  {op:'del',keys:[...]} 删选中 / {op:'clear'} 全部清空 /
//                         {op:'limit',n} 自定义上限（存 json，改小立刻淘汰）。
//   默认上限 5000 条，超出按「最久没播 → 最早入库」顺序删旧。Web 端注明：
//   这只是**取链用 rid 缓存**（不是歌曲文件缓存），每条约 150 字节，占用极小。
// 1.7.13（2026-11-15）：P0「项目骨架独立」收尾升版（功能无变化，纯骨架/配置层）：
//   package.json 更名 myxiazhi-media-server（并补进容器，之前热更三件套漏了它）；
//   lxrelay 支持 env LX_ADDR（env > files/my_lx > 未启用）；compose 宿主路径 env 化
//   ${MUSIC_HOST}/${ABL_HOST} + .env.example（仅本地通用版，VM Podroid 版 compose 不动）。
// 1.7.14（2026-11-15）：P1「统一进度中枢」落地，进度归属用户拍板 **书级共享**：
//   history.json 新增 books 字段（同书全设备一份进度，devices 原样兼容）；
//   /ap/play 起播 + /ap/pos 心跳/结算同步进书级表；histResume = 本机 vs 共享谁新听谁，
//   新设备 ep=0 直接吃共享 —— 换设备「继续听」成立；ab_local_pos 补 tmp+rename 原子写；
//   新增 GET /v1/history（设备+书聚合）与 POST /v1/pos（通用位置上报，老固件走 /ap 不变）。
// 1.7.15（2026-11-15）：R1 设备端接入书级共享（P1 收尾）：
//   新增 GET /v1/resume?q=<书名> —— 轻量续播查询口，复用 histResumeShared 的书级匹配，
//   命中回 {found,book,ep,pos,off,dur,fin,nextEp,dev}；R1 abResume 先问它再退本地记忆。
// 1.7.16（2026-11-15）：R1 设备型号上报（用户需求：播放记录里能看出最近是谁播的）：
//   /v1/pos 带显式 devId 时，设备维度也记一条（histDevTouch，同书同集原地更新不刷屏），
//   设备列表能看到 R1-xxxx；books.dev 同步换成真实设备号，不再记 ip-xxx。
// 1.7.17（2026-11-15）：防误报（stem /ap/pos 同口径）：/v1/pos 非 fin 且 pos<5s 不落账
//   —— 防止「刚起播还没出声」的客户端把书级进度打回 0 开头（books 多出 0:00 记录）。
// 1.7.18（2026-11-15）：播放记录的「全 N 集」从集表缓存补（abTotalOf）—— R1 /v1/pos
//   记的条目不带 total，Web 显示「全 ? 集」；快照输出时按书名查 abcache 补上。
// 1.7.19（2026-11-15）：**真实播放入库曲库缓存 + 遮天重搜降级根治**（用户反馈两件）：
//   ① 「曲库缓存没起效，r1 和网页播放都没有进缓存」—— song_cache.json 此前只有
//   /api/song/resolve（收藏单点解析）会写，真播的路径全都不入库。新增 songLearnPlay()：
//   已在缓存记 markPlay（hits/lastPlay），没有 → put 入库；挂在四个真实播放口 ——
//   apPickSong（/ap/song 语音点歌）、apToItems（/ap/play?kind=song 歌单连播）、
//   /s/<i>（曲库池）、/r/<source>/<rid>（网页在线播放）；有声书 rid 用 bookByRid
//   反查闸门排除（书的 rid 归 ab_cache 管），本地文件没有 rid 天然不进。
//   ② 「遮天点重搜缺6变成缺112」—— 数据确诊：救援的 6 集全部完好（铺回成功），
//   真集 2797→2845 反而更多；上游这次重拉吐的列表带大洞（2803→2955 行/3366 集），
//   v1.7.1 占位行保护只覆盖「新表里存在的行」，两个真问题：
//   a) 整行缺席的集号（断档 > GAP_FILL_MAX 连占位都没给）putFull 会整表替换丢掉
//      旧真集 ⇒ putFull 加防降级补全（缺席旧真集恢复，不参与指纹）；
//   b) 整行缺席的缺集播到时救援闸门（!tgt ⇒ false）永远不触发 ⇒ ep=N 闸门改
//      「行不在 = 缺」，rescueEp 本来就支持缺席追加。
// 1.7.20（2026-11-15）：**ep=0 花絮行不进集表输出**（用户反馈「3366 后面还有
//   2950-2956 且都不是集」）—— 上游专辑尾部带感言/宣传音频，标题解析不出集号 →
//   ep=0，缓存里留在原位（fillGaps v2 规则）；R1 设备端自己滤掉了显示正常，
//   Web 集表却渲染成列表序号（e.ep || (gi+1)）。/api/ab/episodes 与
//   /api/ab/cache?full=1 输出层滤掉 ep=0 行，total/count/missing 同口径重算；
//   磁盘缓存原文不动（番外/序章内容保留）。集号断档（2646→2730）是上游真缺，
//   超 GAP_FILL_MAX 不补占位 —— 播到时 v1.7.19 闸门按需救援。
// 1.7.48（2026-11-19）：**合集子书的书身份 = 子书名**（用户拍板：「后面的名字才是
//   书名，三体只是系列」）。ablocal.episodes() 对 kind=coll 的子书改成
//   name=子书名、sub=子书名、series=合集名；以前 name=x.name 让「地球往事Ⅰ /
//   黑暗森林Ⅱ / 死神永生Ⅲ」三部共用「三体」一个书键 ⇒ 书级进度、播放记录、
//   续播点全糊成一本，看不出在听哪一部。relIndex/bookOfRel 与 /v1/pos 的本地书
//   名单（isAblBook）本来就按子书名记，这次只是把集表响应补齐到同一口径，
//   device 侧拿到的 book 名随之变成子书名，两侧不再各说各话。
const MS_VER = '1.7.56';

// 1.7.39（2026-11-18）：**修「播放记录在几集之间来回跳」**
//   现象：R1 在听「遮天 第4集」，播放记录却每 14 秒来回刷「第1集」和「第4集」两条，
//   两边的 pos 都在涨（实测 13:30 一批：ep1 48→64→80→96，ep4 51→67→83→99）。
//   根因：设备侧有**两路上报**同时写同一本书 ——
//     ① device ProgProgress（15s，ep/pos 都取自 player 队列当前项，正确：cur=3 → ep=4）
//     ② player 网页（8s）把「全局播放秒数」配上 `ebCurPlay.ep` 上报，而那个 ep 只在
//        网页点播那一刻写入，之后自动连播到第几集都不更新、换书也不清空 ⇒
//        一直用「第1集 + 第4集的秒数」写服务端。
//   服务端这边：histDevTouch 只在 `lt.ep === e.ep` 时才合并到同一条记录，ep 不同就
//     新建 ⇒ 列表里同书留两条，被两路不同频率轮流刷新，看起来就是"跳来跳去"。
//   修法：① player.html 回写改成按**当前真实曲目标题**校正集号，认不出/已换书就停止
//     这条回写（权威上报交给 ProgProgress）；② 服务端 histDevTouch 把「同设备同书
//     3 分钟内」的上报一律合并到同一条（ep 跟随最新），列表不再出现同书双条。

// 1.7.38（2026-11-18）：**设备分组 —— 进度按组共享/隔离**（用户需求）
//   背景：1.7.13 起的「书级共享」是全设备一份进度，任何设备都能接着听。现在要能
//   把设备分组：同组共享、异组隔离，新设备默认独立组，Web 手动分配。
//   数据：新增 files/devgroups.json（groups{gid:{name,devs[],createdAt,system}}）。
//     设备不属于任何组 ⇒ 组 id = 'solo:<devId>'（每台天然独立）。
//   首次启用迁移：把 history.json 现有全部设备并入 'default'「默认组」，旧 books
//     键（无 g: 前缀）统一改写成 'g:default|旧键' —— 升级前后行为一致（现有设备仍
//     共享），只有以后新出现的设备才各自独立。
//   共享表键：bookKeyOf 第 4 参 grp，book → 'g:<grp>|<书名>'，song/radio →
//     'g:<grp>|song|<书名>'；记录里存 grp 便于 Web 展示与清理。
//   读写：能识别设备的请求（X-Dev-Mac / ?dev= / body.devId）严格按组隔离；
//     识别不出的匿名读（R1 的 /v1/resume、/v1/history 不带设备标识）退回全组
//     取最新 —— 保证 R1 续播不断，等 device 补 ?dev= 后再收严。
//   新增 GET/POST /api/devgroups（建组/改名/删组/设备移入移出）+ Web「设备分组」页。

// 1.7.37（2026-11-18）：**真播才落记录的终态**（player 打 live 标记，服务端只认带标记的）
//   背景：1.7.36 按「累计传输字节 ≥256KB」判真播，实测失败——player 装载队列时对
//   每首预取曲也整首下载（1.5~2MB），和真播的 HTTP 特征几乎一致，服务端无从区分。
//   根治：改由客户端在**真正起播**（引擎 setDataSource，会 play()）时给拉流 URL 追加
//   &live=1；预取（setPreparingDataSource）不带标记。player pl-1.6.160 起生效。
//   这里 /r/ /m/ 落记录前置 isLiveCommit(req)：URL 带 R1 设备特征(dev=)时必须带 live=1
//   才落；不带 dev 的老客户端（stem / 网页 / 未升级 R1）保持原「到达即落」不受影响。
//   1.7.36 的字节计数保留作第二道防线（live 标记已带时仍走字节阈值），双保险。
// 1.7.36（2026-11-18）：**修「取链了还没播也记成播放」**（stream 落记录改按真实字节）
//   现象：R1 播放队列里有 15 首，只播了第 1 首 Sold Out，第 2 首铁血丹心等根本没出声，
//   却也在播放记录里各占一条（pos=0、间隔几秒依次出现）。
//   根因：/r/ /m/ 的 histStart 在 **GET 请求到达瞬间**就落，不管客户端后续有没有真拉流。
//   player 装载队列时会对「当前曲 + 预取曲」都发 GET 拿响应头做格式探测（几 KB 就断），
//   v1.7.35 的 HEAD 判断挡不住这种 GET ⇒ 全部误记。
//   修法：stream 落记录改成**延迟到真实传输**——给 pipeAudio/sendLocalFile 的响应流挂
//   字节计数，累计超过 PLAY_COMMIT_BYTES（默认 256KB，约十几秒音频；可由
//   files/play_commit_bytes 覆盖）才真正 histStart；探活/预取只拿几 KB 就断 ⇒ 不落。
//   HEAD 判断保留作快速短路。/ap/play 的起播记账（真点播）不受影响。
//   AlphaPi 转码路径与 302 分支不走 pipeAudio，仍用「到达即落」（它们本来就不探活预取）。
// 1.7.35（2026-11-18）：**R1 播放记录设备身份认领**（修「R1 被误识别成网页播放」）
//   现象：群晖 docker 端口映射下 R1 的 /r/ /m/ 拉流（MediaPlayer 底层发，带不了
//   X-Dev-Mac 头）全从网关 IP 进来 ⇒ 落进 ip-<网关> 桶，硬编码名「网页 / 未报 MAC
//   的设备」；而书级进度走 /v1/pos 带 devId，记在真 R1 名下 ⇒ 同一台 R1 被拆成两个设备。
//   根治：device 侧在推给 player 的 /r/ /m/ URL 上挂 ?dev=<MAC12>&devName=<名>，
//   这里 devIdOf 认领 query、histDevice 认领设备名（header 仍最高优先）。
//   存量一次性迁移 migrateR1DeviceIdentity()：把 ip-* 桶里 UA=stagefright 的记录
//   并入名字带 R1 的 MAC 设备桶，files/.devid_migrated_1735 标记防重复。
//   来源五分类不受影响（标签起播时已写对）。

// 1.7.34（2026-11-16 晚）：**修「本地节目点不进去」**（纯前端 hotfix）
//   本地节目栏的事件委托把 data-* 只从 e.target 取，点到书卡的封面/标题文字、
//   集表行的标题文字时 target 是内部 span/div，不带 data-ablb/data-abe，点击被吞。
//   改为从 e.target 向上逐层找（与在线栏 closest('.bkc'/'.li') 同口径）。

// 1.7.33（2026-11-16 晚）：**Web「书架」更名「我的节目」+ 新增本地节目栏**（纯前端）
//   主导航「书架」→「我的节目」，页内两栏：本地节目（扫 /audiobook 挂载目录，
//   走 /api/abl/books → /api/abl/eps → /m/ 直链）/ 在线节目（原书架缓存，/api/ab/cache）。
//   两栏共用同一套 .shelf 卡片 / detHeader / detPager / .blk 集表样式，风格统一。
//   服务端接口零改动（ablocal 链路早已就绪），本版仅 web/index.html 与版本号变更。

// 1.7.31（2026-11-16 晚）：**播放记录来源标识五分类**（与 R1 播放页 npTag 同口径）
//   在线音乐 / 在线节目 / 本地音乐 / 本地节目 / 广播电台。
//   每条设备记录与书级记录写 src（英文码）+ srcLabel（中文标签），随 /api/history、
//   /v1/history 原样吐出，R1 不必再靠 URL 猜。服务端在**起播入口**判定最准：
//   /ap/play?kind=radio → 广播电台；/m/ 本地文件 → 本地音乐/本地节目；
//   /r/<src>/<rid> 命中 abcache 书目 → 在线节目，其余 → 在线音乐；
//   /ap/play?kind=book&local / abl → 本地节目；stem 的 /v1/pos 继承起播结论。
//   ★ 另加 GET /api/src?url=<当前曲地址>&q=&title= —— 服务端用权威电台表精确匹配当前曲，
//     直接回答「这是广播电台 / 在线音乐 / 本地节目…」。R1 的 radioList 名册是 10 分钟
//     缓存 + 精确串比，电台 URL 一变（换服务器 IP / 换源）就被漏掉、外部 URL 被
//     player 的 viaOf() 判成在线音乐 —— 这里让服务端给权威答案。
// 1.7.32（2026-11-16 深夜）：**纠偏越过错误缓存** —— stem 实测「写你」先回源命中
//   《让你写卖鱼佬…》并入 abcache 后，v1.7.30 的拼音纠偏因排在 disk 命中之后，
//   每次搜「写你」都被那本错书截胡 ⇒ 一直播错书、服务端播放记录也留错书名。
//   /api/ab/search 增加判据 pinyinCacheOverride()：短查询(≤4) + 缓存非 normQ 全等
//   + 拼音有命中 + 纠偏 Top1 与缓存 Top1 不同书 ⇒ 纠偏结果顶掉错误缓存命中。
//   真书名（如「凡人」→《凡人修仙传》）因缓存与纠偏指向同一本，不接管、零影响。
//   ?pinyin=0 仍可整体关闭纠偏。
// 1.7.30（2026-11-16 晚）：**ASR 同音字纠偏 · 拼音模糊搜索引擎** —— STEM 语音点播
//   《仙逆》被麦克风听成「写你」，服务端忠实回源搜「写你」→ 播成《让你写卖鱼佬，你现场写高启强？》。
//   根因在设备侧 ASR，服务端兜底：新增 pinyin.js（离线拼音表 files/pinyin_map.json，零 npm 依赖），
//   把查询词转拼音，在「本地库 → 磁盘缓存」两级书名里找读音相近的（首字母开头命中为核心武器），
//   命中即返回并标注 match:'pinyin'/hint，**早于在线回源**拦截错词回源。
//   /api/ab/search 与 /api/ab/episodes 两级都接；fresh=1 或 ?pinyin=0 可绕过，不影响精确命中路径。
// 1.7.29（2026-11-15 晚）：**共享表 dur 跨集继承根治** —— histBookSave 的 dur 之前
//   是 `Number(rec.dur) || prev.dur || 0`：R1 的 /v1/pos 不带 dur（PlayerBridge 没有
//   可靠的集时长源），stem 的 /ap/pos 带 dur。R1 播 ep17 时继承了上一条（stem ep16）
//   写下的 dur=799s，pos=803 ≥ 799-3 被误判「已听完」⇒ stem 续播凡人修仙传直接跳到
//   ep18 开头（用户正听到 13:23）。修法：换集后旧 dur 一律清零 —— dur 只属于本集，
//   新集的时长等带 dur 的上报来了再写。fin 语义不变（fin 只来自显式上报）。

// 1.7.28（2026-11-15）：**直链位置补齐的 IP 兜底** —— R1 的 /r/ 直链请求不带 MAC 头，
//   stream 记录落在 devIdOf(req)（ip-192.168.2.x）名下；而 /v1/pos 上报带 body.devId
//   （MAC，R1 1.3.342+ / ProgProgress 1.3.343+ 统一 MAC 口径），两把钥匙开同一台设备
//   却互相对不上 ⇒ histBackfillStreamAuto：body.devId 查不到 stream 记录时按来源 IP
//   再试一次（请求与 /r/ 同设备同 IP，q+ep/rid 精确匹配门槛不变）。
//   配套：R1 device 1.3.343 把 ProgProgress 的 devId 从 R1-xxxx 统一成 12 位大写 MAC，
//   设备列表不再出现两条 R1。

// 1.7.21（2026-11-15）：**stem（AlphaPi 固件）播放记录接入统一设备列表** —— /ap/pos 的
//   结算与心跳都补一次 histDevTouch（与 /v1/pos R1 同口径），设备名优先 X-Dev-Name 头
//   （V2.4.14 固件起 pos/log 请求也带；老固件只有起播带）。书级进度 1.7.13 起就同步，
//   这里补的是「播放记录能认出是谁播的」设备维度。
const scriptFile = argv.find((a, i) => !a.startsWith('--') && !(argv[i - 1] === '--port'));
const pool = require('./pool');
const lxrelay = require('./lxrelay');
const radioproxy = require('./radioproxy');
const local = require('./local');
const ablocal = require('./ablocal');   // ★ v1.2.0：NAS 本地有声书库（书名/合集/集，扫挂载目录）
const abcache = require('./abookcache'); // ★ v1.6.9：在线书目永久缓存（多设备共享，无 TTL）
const pinyin = require('./pinyin');     // ★ v1.7.30：ASR 同音字纠偏（拼音模糊搜索引擎）

/**
 * ★ v1.7.32：拼音纠偏是否该越过「缓存部分命中」—— 纯函数，供接入点与回归测试共用。
 * 场景：首次「写你」回源命中《让你写卖鱼佬…》进缓存后，v1.7.30 的纠偏排在 disk 命中
 * 之后 ⇒ 每次搜「写你」都被那本错书截胡，stem 一直播错。这里给出接管判据：
 *   q 短(≤4) + 缓存非全等命中 + 有拼音命中 + 拼音 Top1 与缓存 Top1 不是同一本书。
 * 「凡人」→ 缓存与拼音都指向《凡人修仙传》⇒ 不接管（返回 false），正常书名零影响。
 */
function pinyinCacheOverride(q, hitBooks, fz) {
  if (!q || String(q).length > 4 || !Array.isArray(hitBooks) || !hitBooks.length) return false;
  if (!Array.isArray(fz) || !fz.length) return false;
  const nq = abcache.normQ(q);
  // 缓存里有 normQ 全等的真书名 ⇒ 这是用户真想搜的书，直接走 disk
  // （abcache.search 返回的是 rec 数组，rec 自带 .book / .key —— 不是 {rec,score}）
  if (hitBooks.some(h => abcache.normQ(h && h.book) === nq)) return false;
  const diskTop = abcache.normQ(hitBooks[0] && hitBooks[0].book);
  const pyTop = abcache.normQ(fz[0] && fz[0].book);
  return !!pyTop && pyTop !== diskTop;
}

// ============================================================ v1.7.31 来源标识五分类
const SRC_LABELS = Object.freeze({
  online_music: '在线音乐', online_program: '在线节目',
  local_music: '本地音乐', local_program: '本地节目', radio: '广播电台',
});
const LABEL_SRC = Object.freeze(Object.keys(SRC_LABELS).reduce((m, k) => {
  m[SRC_LABELS[k]] = k; return m;
}, {}));
/** 英文码 / 中文标签都收，认不出来返回空串（绝不把「未知」写成在线音乐） */
function srcNorm(s) {
  const k = String(s || '').trim();
  return SRC_LABELS[k] ? k : (LABEL_SRC[k] || '');
}
/** 从一条记录的 kind / local / source 推来源（只在入口没显式给 src 时兜底） */
function srcOf(rec) {
  if (!rec) return '';
  const s = srcNorm(rec.src || rec.srcLabel);
  if (s) return s;
  if (rec.kind === 'radio' || rec.live === true) return 'radio';
  if (rec.kind === 'book' || rec.kind === 'program') {
    return (rec.local === true || rec.source === 'abl' || rec.via === 'abl')
      ? 'local_program' : 'online_program';
  }
  if (rec.kind === 'song' || rec.kind === 'music') {
    return rec.local === true ? 'local_music' : 'online_music';
  }
  return '';
}
/** 给记录补 src / srcLabel；显式 src 优先，其次记录自带，最后按 kind 推 */
function withSrc(rec, explicit) {
  const s = srcNorm(explicit) || srcOf(rec);
  return s ? Object.assign({}, rec, { src: s, srcLabel: SRC_LABELS[s] }) : Object.assign({}, rec);
}

/* ★ v1.7.43：本地书名单（本地库 ablocal 是权威）—— /v1/pos 判「本地节目 / 在线节目」用。
   设备上报不带 src（device 自己也不知道 URL 算本地还是在线），以前只能按 kind 推成
   「在线节目」，本地书被标错。这里用服务端手上已有的本地库名单判定，不靠客户端猜。
   本地库扫描本身有缓存（ensure(false)），这里再套 60s 名单缓存，15s 一次的进度上报不心疼。 */
let _ablNamesAt = 0;
let _ablNames = [];
function ablNameList() {
  const now = Date.now();
  if (_ablNames.length && now - _ablNamesAt < 60000) return _ablNames;
  try {
    const r = ablocal.books('');
    const arr = [];
    for (const b of (r.books || [])) {
      if (b.name) arr.push(String(b.name));
      for (const s of (b.subs || [])) if (s.name) arr.push(String(s.name));
    }
    _ablNames = arr;
    _ablNamesAt = now;
  } catch { /* 本地库不可用就沿用上一次名单 */ }
  return _ablNames;
}
/** 这本书是不是本地库里的书（设备可能报「书名 · 副标题」，两边互为前缀都算） */
function isAblBook(q) {
  const t = String(q || '').trim();
  if (!t) return false;
  for (const n of ablNameList()) {
    if (n === t) return true;
    if (t.startsWith(n + ' · ') || n.startsWith(t + ' · ')) return true;
  }
  return false;
}

/** 测试出口：本机没有本地书库（/audiobook）时给个名单，单测 isAblBook 用。 */
function _setAblNamesForTest(arr) {
  _ablNames = Array.isArray(arr) ? arr.slice() : [];
  _ablNamesAt = Date.now();
}
/** 电台 URL 归一化：去首尾空白 / 去 hash / 去末尾斜杠 / 小写；可选忽略 query */
function radioNorm(u, ignoreQuery) {
  let s = String(u || '').trim();
  if (!s) return '';
  const h = s.indexOf('#'); if (h >= 0) s = s.slice(0, h);
  if (ignoreQuery) { const q = s.indexOf('?'); if (q >= 0) s = s.slice(0, q); }
  return s.replace(/\/+$/, '').toLowerCase();
}
/** /radio/<b64> 本机代理地址 → 原始直播流地址（拿不到就原样） */
function radioUnwrap(u) {
  const s = String(u || '');
  const m = s.match(/\/radio\/([A-Za-z0-9_-]+)/);
  if (!m) return s;
  try { return radioproxy.decTarget(m[1]) || s; } catch { return s; }
}
/** 当前曲地址是否在服务端权威电台表里（精确 / 解码 / 去 query 三档） */
function radioMatchUrl(url, list) {
  const raw = radioUnwrap(url);
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* ignore */ }
  for (const cand of [raw, decoded]) {
    const a = radioNorm(cand, false), b = radioNorm(cand, true);
    if (!a) continue;
    for (const r of (list || [])) {
      const ru = String(r && r.url || '');
      if (!ru) continue;
      const x = radioNorm(ru, false), y = radioNorm(ru, true);
      if ((a && a === x) || (a && a === y) || (b && b === x) || (b && b === y)) return r;
    }
  }
  return null;
}
/** 给定当前曲地址 / 关键词，服务端给来源结论（不回源、零网络） */
function srcFromUrl(url, q, radios, books) {
  const u = String(url || '').trim();
  const rm = radioMatchUrl(u, radios);
  if (rm) return { src: 'radio', srcLabel: SRC_LABELS.radio, radio: true,
    name: rm.name || '', via: 'radio-list' };
  const dec = (() => { try { return decodeURIComponent(u); } catch { return u; } })();
  if (u.indexOf('/m/') >= 0 || dec.indexOf('/m/') >= 0) {
    const prog = /第\s*\d+\s*[集回章话节]/.test(dec);
    const src = prog ? 'local_program' : 'local_music';
    return { src, srcLabel: SRC_LABELS[src], radio: false, name: '', via: 'local-path' };
  }
  const mm = u.match(/\/r\/([^/?#]+)\/([^/?#]+)/);
  if (mm) {
    // 书/集反查：rid 在 rec.list[].rid（不是顶层）；先用传入的缓存快照，
    // 再用 abcache 自己的 rid 索引兜底（两者都不命中才算在线音乐）。
    let name = '';
    for (const b of (books || [])) {
      const bs = String(b && b.source || 'kw');
      const hit = (Array.isArray(b && b.list) && b.list.some(e =>
        String(e && e.rid || '') === mm[2] && bs === mm[1]));
      if (hit) { name = String(b.book || b.title || ''); break; }
    }
    if (!name) {
      try {
        const b = abcache.bookByRid(mm[1], mm[2]);
        if (b) name = String(b.book || '');
      } catch { /* ignore */ }
    }
    const src = name ? 'online_program' : 'online_music';
    return { src, srcLabel: SRC_LABELS[src], radio: false, name, via: 'rid' };
  }
  const key = String(q || '').trim().toLowerCase().replace(/\s+/g, '');
  if (key.length >= 2) {
    for (const b of (books || [])) {
      const n = String(b && b.book || b && b.title || '').toLowerCase().replace(/\s+/g, '');
      if (n && (n.indexOf(key) >= 0 || key.indexOf(n) >= 0)) {
        return { src: 'online_program', srcLabel: SRC_LABELS.online_program,
          radio: false, name: String(b.book || b.title || ''), via: 'title' };
      }
    }
  }
  return { src: '', srcLabel: '', radio: false, name: '', via: '' };
}
const songcache = require('./songcache'); // ★ v1.7.11：歌曲 rid 永久缓存（收藏点播按需解析）
const tc = require('./transcode');      // ★ v1.4.0：AlphaPi 兼容层（ffmpeg → 8bit/24k 单声道）
/* ★ v1.7.49：受限终端（R1）的降档转码 + 缓存。
   与上面 tc 是两件事：tc 是「协议层不兼容」（1 字节 1 样本的裸 PCM），
   aacache 是「解得了但放不出声/会崩」（24bit FLAC 静默失败、高码率长播崩）。
   两者共用同一个容器内的 ffmpeg，互不干扰。 */
const aac = require('./aacache');
const WEB = path.join(__dirname, 'web');
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

let rt = null;
let rtErr = null;
let rtName = null;

// ★ 必须声明在「启动加载音源」之前：mountRuntime() 里会调 clearUrlCache() 碰它。
//   放在下面的工具区（启动之后）会命中 TDZ → 「Cannot access 'cache' before initialization」，
//   而该异常被启动处的 try/catch 吞掉，表现为「音源静默加载失败」。
const cache = new Map();

/**
 * ★ 音源脚本取链失败的短负缓存。
 * 实测：幻音/ikun 这类第三方后端在用户网络里常常不可达，而每次 /api/url 都要先试它，
 * 一个超时就是十几秒 —— 点一首歌要等半天，最后才走到可用的内置通道。
 * 失败后 10 分钟内不再试（换脚本 / 卸载脚本时由 clearUrlCache 清空）。
 * ★ 声明位置同 cache：必须在「启动加载音源」之前，否则 clearUrlCache() 命中 TDZ。
 */
const failAt = new Map();
const FAIL_TTL = 600000;
const scriptDead = src => (Date.now() - (failAt.get(src) || 0)) < FAIL_TTL;

/**
 * ★★ lxserver 中继的短负缓存 —— v2（2026-10-17 修「在线歌整台不出声」）。
 *
 * <p>必要性照旧：lxserver 容器没起 / 地址写错时，每次取链都要先等它 12s 超时。
 * 但 v1「一次硬失败封 10 分钟」太粗暴 —— 实测后果是：一次网络抖动（批量取链
 * 撞上游限流、容器重启的十几秒）就把落雪整级封死 10 分钟，而**落雪是唯一
 * 还在出链的通道**（脚本音源那一路早取不到链了）⇒ 表现就是「在线歌曲全哑」，
 * 且除了重启容器毫无出路。</p>
 *
 * v2 三级策略：
 *   ① 偶发一次硬失败**不封**，只记时间戳；连续 LX_FAIL_NEED(2) 次才真封；
 *   ② 封顶 LX_FAIL_TTL = 60s（旧 600s）；
 *   ③ ★ 半开自愈：封满 LX_HALFOPEN(30s) 后**放行一个探针**，通了立刻清零，
 *      不通才续封 —— 不用等满 TTL，更不用重启容器；
 *   ④ 任一档取链成功即 lxOk() 全量清零（自愈）。
 */
const lxFailAt = { t: 0, n: 0, probeAt: 0 };
const LX_FAIL_TTL = 60000;    // 封顶 60s（v1 是 600s）
const LX_FAIL_NEED = 2;       // 连续 2 次硬失败才封
const LX_HALFOPEN = 30000;    // 封满 30s 后放行一次探针

/** 当前是否处于「封禁窗口」内（纯读，无副作用 —— health / debug 用这个）。 */
const lxBlocked = () => {
  const f = lxFailAt;
  if (!f.t || f.n < LX_FAIL_NEED) return false;
  return (Date.now() - f.t) < LX_FAIL_TTL;
};

/**
 * 取链侧实际用的闸门：在 lxBlocked() 之外再叠一层「半开探针」——
 * 封了一段时间就放一个请求过去试试，通了自然 lxOk() 清零，不通才继续挡。
 * ★ 有副作用（会推进 probeAt），只在真正要取链的地方调，别拿去做状态展示。
 */
const lxDead = () => {
  if (!lxBlocked()) return false;
  const now = Date.now();
  if (now - lxFailAt.t >= LX_HALFOPEN && now - lxFailAt.probeAt >= LX_HALFOPEN) {
    lxFailAt.probeAt = now;          // 这一个请求放行（半开）
    return false;
  }
  return true;
};

/** 记一次硬失败（落雪这一级本身没给链：HTTP 错 / 超时，不是「给了但播不了」）。 */
function lxFail() {
  const now = Date.now();
  // 距上次失败已超过一个封禁周期 ⇒ 那是旧账，不累计成连击
  lxFailAt.n = (now - lxFailAt.t >= LX_FAIL_TTL) ? 1 : lxFailAt.n + 1;
  lxFailAt.t = now;
}

/** 取链成功 / 换地址 / 手动 fresh ⇒ 全量清零。 */
function lxOk() { lxFailAt.t = 0; lxFailAt.n = 0; lxFailAt.probeAt = 0; }

/**
 * 最近一次「真实取链」的结果（1.1.0）。
 * ★ 不能拿 lxOk() 当绿灯依据 —— 它在「手动 fresh / 换地址 / 越狱清账」这些
 *   非取链路径上也会被调用。这对标记只在「真的拿到 / 没拿到一条可播直链」时打点，
 *   Web 的状态灯和 /api/lx 只认它。
 */
const lxLast = { ok: 0, bad: 0, badErr: '' };
const lxMarkOk = () => { lxLast.ok = Date.now(); };
const lxMarkBad = err => { lxLast.bad = Date.now(); lxLast.badErr = String(err || '').slice(0, 120); };

/**
 * 取链失败的人话分类（1.1.0）。以前四种完全不同的故障共用一句
 * 「落雪没给到可播直链」，远程用户没法自查。判据来自 runLx 推进 steps 的记录：
 *   · 无 raw + 网络错/超时      ⇒ 连不上落雪（容器网络隔离 / 端口只听 127.0.0.1 / 没起）
 *   · 有 raw + status 0/网络错  ⇒ 落雪给链了，但本容器连不上那条 CDN（出网/DNS）
 *   · HTTP 401/403             ⇒ 鉴权（匿名 open 被限制 / Token 不对）
 *   · HTTP 5xx + 平台关键词    ⇒ 订阅源不认这个平台（业务性失败，落雪本身正常）
 */
function lxFailReason(steps) {
  const ls = (steps || []).filter(s => s && s.step === '落雪docker');
  if (!ls.length) return '落雪 docker 没参与本轮取链（地址没配？）';
  if (ls.some(s => /负缓存/.test(String(s.skipped || ''))))
    return '落雪连续失败，被 60s 负缓存挡住了 —— 它现在通吗？去音源页点「测一下」实测';
  let net = 0, cdn = 0, auth = 0, biz = 0;
  for (const s of ls) {
    const e = String(s.err || '');
    const netish = s.status === 0
      || /中继无响应|timeout|timed? ?out|abort|fetch failed|ECONN|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN/i.test(e);
    if (/HTTP 40[13]/.test(e)) auth++;
    else if (s.raw && netish) cdn++;
    else if (!s.raw && netish) net++;
    else if ((s.status || 0) >= 500 || /平台的源|解析失败|找不到|not support|unknow error/i.test(e)) biz++;
  }
  if (auth) return '落雪拒绝访问（401/403）：匿名 open 被限制或 Token 不对 —— 去落雪后台建个 API Token，填在「具名用户」里';
  if (cdn) return '落雪给链了，但本容器连不上那条直链 —— 是本容器的出网/DNS 问题，跟落雪无关';
  if (net) return '落雪 12s 内无响应（各档全超时）—— 多半是两个容器的网络配置不同相互隔离，或落雪端口只监听 127.0.0.1；去音源页点「测一下」看断在哪一环';
  if (biz) return '落雪的订阅源不认这个平台（5xx），跨源兜底也没顶上';
  return '落雪没给到可播直链（用 ?debug=1 看完整链）';
}

/**
 * 落雪链路一键自检（1.1.0）。五步各自独立计时，断在哪一环一眼可见：
 *   ① 首页  GET {base}/             —— TCP/端口/容器网络隔离在这一步现形
 *   ② 出网  GET https://www.baidu.com —— 本容器 DNS/出网（给①失败时做对照）
 *   ③ 搜索  GET {base}/api/music/search?source=kw&name=晴天&limit=1
 *   ④ 取链  POST {base}/api/music/url（拿③的第一条；③挂了用兜底 rid）
 *   ⑤ 验链  probeUrl(④ 的 url)      —— 「给了链但连不上 CDN」在这一步现形
 */
async function lxSelfTest() {
  const base = lxrelay.base();
  const steps = [];
  if (!base) return { ok: false, msg: '未配置落雪地址（Web 音源页先填一个）', steps };
  const push = (name, ok, ms, extra) => steps.push(Object.assign({ name, ok: !!ok, ms }, extra || {}));
  let t = Date.now();
  try {
    const r = await fetch(base + '/', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
    push('① 落雪首页', true, Date.now() - t, { status: r.status });
  } catch (e) {
    push('① 落雪首页', false, Date.now() - t, { err: String(e && e.message || e).slice(0, 100) });
  }
  t = Date.now();
  try {
    await fetch('https://www.baidu.com', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
    push('② 本容器出网', true, Date.now() - t);
  } catch (e) {
    push('② 本容器出网', false, Date.now() - t, { err: String(e && e.message || e).slice(0, 100) });
  }
  let hit = null;
  t = Date.now();
  try {
    const s = await lxrelay.search({ source: 'kw', name: '晴天', limit: 1 });
    hit = (s && s.list && s.list[0]) || null;
    push('③ 落雪搜索', !!hit, Date.now() - t,
      hit ? { detail: (hit.source || 'kw') + ' · ' + String(hit.name || '') }
          : { err: String((s && s.err) || '返回空').slice(0, 100) });
  } catch (e) {
    push('③ 落雪搜索', false, Date.now() - t, { err: String(e && e.message || e).slice(0, 100) });
  }
  let url = '';
  t = Date.now();
  try {
    const info = hit || { source: 'kw', songmid: '659200234', name: '晴天', singer: '周杰伦' };
    const r = await lxrelay.relayUrl({
      source: info.source || 'kw', rid: String(info.songmid || info.id || ''),
      title: info.name || '晴天', artist: info.singer || '', quality: '128k', info,
    });
    url = (r && r.url) || '';
    push('④ 落雪取链', !!url, Date.now() - t,
      url ? { detail: String(url).slice(0, 80) }
          : { err: String((r && r.err) || '没给到 url').slice(0, 100) });
  } catch (e) {
    push('④ 落雪取链', false, Date.now() - t, { err: String(e && e.message || e).slice(0, 100) });
  }
  if (url) {
    t = Date.now();
    const pr = await probeUrl(url);
    push('⑤ 直链验真', !!pr.ok, Date.now() - t,
      pr.ok ? { detail: 'HTTP ' + pr.status + (pr.size > 0 ? ' · ' + Math.round(pr.size / 1024) + 'KB' : '') }
            : { status: pr.status, err: String(pr.err || '').slice(0, 100) });
    if (pr.ok) lxMarkOk(); else lxMarkBad('自检⑤ ' + pr.err);
  } else if (steps[3] && !steps[3].ok) {
    lxMarkBad('自检④ ' + String(steps[3].err || '').slice(0, 80));
  }
  // 核心 = ①能碰到落雪 且 ④拿到链 且（走了⑤的话）⑤通；②出网失败不必然致命
  //（纯内网环境公网可以全断，但只要④⑤通就能用）。
  const coreOk = steps[0].ok && steps[3] && steps[3].ok && (!steps[4] || steps[4].ok);
  return { ok: !!coreOk, ver: MS_VER, msg: coreOk ? '链路通：本容器 → 落雪 → 直链 全程可达'
    : '链路断在第一个红叉（按步骤对号入座）', steps };
}

/**
 * 「越狱重试」的节流闸。
 * ★ 不加这个闸的话：每首失败的歌都会多走一轮救赎（超时场景一首多花 24s），
 *   而且 lxOk() 会把失败连击数冲回 1 ⇒ 封禁永远攒不起来（负缓存形同虚设）。
 * 45s 内最多救赎一次：救活了立刻清零，救不活就交给半开探针（30s）去试。
 */
const RESCUE_GAP = 45000;        // 走完整轮还是没链 ⇒ 45s 才再救一次
const RESCUE_GAP_BLOCKED = 12000; // 只是被负缓存挡住（这轮根本没花时间）⇒ 12s 就可再试
const lxRescueAt = { t: 0 };

/**
 * 每首歌「上次哪一档音质通了」的记忆（内存级，重启即忘，无所谓）。
 * 落雪 docker 的高音质源常给中转地址（出不去），低音质源给真链 ——
 * 记住这个结果，下次起播直接从通的那一档开始，省两档白试的时间。
 */
const BEST_Q = new Map();

/**
 * 域名级负缓存：某个域名「拿得到链但连不上」（fetch failed / status 0）
 * 就记 10 分钟。落雪的高音质源往往整批都指向同一个中转域名，
 * 不记的话同一批 20 首歌会一首一首去撞它（每首 2~3s）。
 */
const BAD_HOST = new Map();
const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
const hostDead = h => !!h && (Date.now() - (BAD_HOST.get(h) || 0)) < FAIL_TTL;

/**
 * 音质档位级负缓存：某个 source 的某一档最近给的链都连不上 ⇒ 10 分钟内
 * 这一档连问都不问（省掉一次落雪多源轮询 2~3s）。
 *
 * ★★ 必须「连续 3 次」才封档，不能一次就封：
 *    实测 rid 无效时落雪会把 128k 也指到那个死域名 —— 一首无效歌就把整档
 *    封掉，结果好歌也跟着取不到链（歌1 第二次直接 500）。偶发失败不封档。
 * ★ 最后一档永不跳过 —— 否则可能全档被跳，直接没歌听。
 */
const BAD_Q = new Map();   // 'src:q' -> {n, t}
const Q_FAIL_NEED = 3;
function qFail(rsrc, qq) {
  const k = rsrc + ':' + qq;
  const o = BAD_Q.get(k) || { n: 0, t: 0 };
  o.n++; o.t = Date.now();
  BAD_Q.set(k, o);
}
function qOk(rsrc, qq) { BAD_Q.delete(rsrc + ':' + qq); }

/**
 * ★ 音源可播性统计（2026-10-17 三修）：每个 source 取链成功/失败各记一笔。
 * 用途：搜索结果排序 —— 有过半失败率的源（实测 mg「咪咕找不到」、kg 缺 hash）
 * 往后排，让用户翻列表时先看到点得响的条目；并在结果上标 `weak`。
 * 内存级，重启清零（没有历史包袱，几分钟就能重新学出来）。
 */
const SRC_STAT = new Map();   // source -> {ok, fail}
function noteSrc(src, ok) {
  if (!src) return;
  const o = SRC_STAT.get(src) || { ok: 0, fail: 0 };
  if (ok) o.ok++; else o.fail++;
  SRC_STAT.set(src, o);
}
/**
 * 0 = 正常/未知，1 = 最近总取不到链。
 * 判据放宽到「连着 2 次全败」或「≥3 次且失败过半」——太严（要 3 次）的话
 * mg/kg 这种稳定失败的源要好几首歌之后才被认出来，用户早就踩过了。
 * 自愈：任意一次成功都会让 ok 涨上去，weak 自动解除（没有额外 TTL）。
 */
function srcWeak(src) {
  const o = SRC_STAT.get(src);
  if (!o) return 0;
  const n = o.ok + o.fail;
  return ((n >= 2 && o.fail === n) || (n >= 3 && o.fail * 2 >= n)) ? 1 : 0;
}

/**
 * ★★ songInfo 暂存（2026-10-18：搜索改走落雪之后必须有它）
 *
 * 落雪的取链接口要的是「它自己搜索返回的那条 songInfo」，尤其是里面的
 * `_types`（每档音质的 size/hash）。少了这份信息，mg 一律 500「咪咕找不到」
 * —— 实测把整条 songInfo 原样回传，mg 立刻 200 出真链。
 *
 * 麻烦在于：列表里给 R1 的是**惰性地址** `/r/<source>/<rid>?title=&artist=`，
 * 只带 rid，没地方塞 _types。⇒ 搜到的时候按 `source:rid` 存一份在这儿，
 * 真正起播那一刻（/r/、/s/、/api/url）再按同样的 key 查回来带上。
 *
 * 内存级、简易 LRU（上限 4000 条）：丢了只是「这一首退回裸 songmid 取链」，
 * 不会出错；池里的歌另有 pool.types 落盘，容器重建也还在。
 */
const SONGINFO = new Map();
const SI_MAX = 4000;
const siKey = (src, rid) => String(src || 'kw') + ':' + String(rid);

function siPut(src, rid, info) {
  if (!info || !rid) return;
  const k = siKey(src, rid);
  SONGINFO.delete(k);                 // 重插 = 挪到最新（简易 LRU）
  SONGINFO.set(k, info);
  if (SONGINFO.size > SI_MAX) {
    let n = SONGINFO.size - SI_MAX;
    for (const k2 of SONGINFO.keys()) {
      SONGINFO.delete(k2);
      if (--n <= 0) break;
    }
  }
}

function siGet(src, rid) {
  return rid ? (SONGINFO.get(siKey(src, rid)) || null) : null;
}

/** 从跨源搜索结果里挑最像的那条（歌名全等 > 包含；再看歌手）。 */
function pickBest(list, title, artist) {
  const t = String(title || '').trim().toLowerCase();
  const a = String(artist || '').trim().toLowerCase();
  let hit = null, sc0 = -1;
  for (const x of list || []) {
    const xt = String(x.title || '').trim().toLowerCase();
    const xa = String(x.artist || x.singer || '').trim().toLowerCase();
    let sc = 0;
    if (t && xt) sc += (xt === t) ? 4 : ((xt.indexOf(t) >= 0 || t.indexOf(xt) >= 0) ? 2 : 0);
    if (a && xa) sc += (xa === a) ? 2 : ((xa.indexOf(a) >= 0 || a.indexOf(xa) >= 0) ? 1 : 0);
    if (sc > sc0) { sc0 = sc; hit = x; }
  }
  return sc0 > 0 ? hit : ((list || [])[0] || null);
}
const qDead = (rsrc, qq, isLast) => {
  if (isLast) return false;                       // 最后一档永远实测一次
  const o = BAD_Q.get(rsrc + ':' + qq);
  return !!o && o.n >= Q_FAIL_NEED && (Date.now() - o.t) < FAIL_TTL;
};

/**
 * ★ 取链缓存必须与「当前音源脚本」绑定：换脚本后旧缓存会返回上一个音源给出的 URL。
 *   （实测：从 demo 音源切到 ikun 后，/api/url 仍返回 demo 的 cdn.example.com 直链。）
 */
function clearUrlCache() {
  for (const k of [...cache.keys()]) if (k.startsWith('u:')) cache.delete(k);
  failAt.clear();
  lxOk();
}

/**
 * ★ 「当前音源」落盘。
 * 必要性：scripts/ 里可能同时躺好几个脚本（ikun / 幻音 / 自己导的），
 * 旧逻辑「按文件名排序取最后一个」—— 导入的新音源一重启就被别的挤掉，
 * 表现为「明明导入成功了，重启后又变回上一个音源」。改成记住用户最后一次导入的那个。
 */
const CUR_FILE = path.join(__dirname, 'files', 'current_script');
function rememberScript(name) {
  try {
    fs.mkdirSync(path.join(__dirname, 'files'), { recursive: true });
    fs.writeFileSync(CUR_FILE, name, 'utf8');
  } catch (e) { console.log('[mini-lx] 记录当前音源失败（不影响使用）: ' + e.message); }
}
function forgetScript() {
  try { fs.unlinkSync(CUR_FILE); } catch { /* 本来就没有 */ }
}

function mountRuntime(code, name) {
  const r = new LXRuntime({ verbose: false });
  const sources = r.loadCode(code, name);
  rt = r;
  rtErr = null;
  rtName = name;
  clearUrlCache();
  rememberScript(name);
  console.log('[mini-lx] 已加载音源 ' + name + ' -> ' + sources.map(s => s.source).join(', '));
  return sources;
}

if (scriptFile) {
  try { mountRuntime(fs.readFileSync(scriptFile, 'utf8'), path.basename(scriptFile)); }
  catch (e) { rtErr = String(e && e.message || e); console.log('[mini-lx] 音源加载失败: ' + rtErr); }
} else {
  // 自动加载 scripts/ 下已导入的脚本（最后一个为准）
  try {
    if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
    const files = fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.js')).sort();
    if (files.length) {
      // 优先「用户最后导入的那个」，没有记录才退回排序取最后一个
      let f = files[files.length - 1];
      try {
        const cur = fs.existsSync(CUR_FILE) ? fs.readFileSync(CUR_FILE, 'utf8').trim() : '';
        if (cur && files.includes(cur)) f = cur;
      } catch { /* ignore */ }
      console.log('[mini-lx] 自动加载音源脚本: ' + f + (files.length > 1 ? '（共 ' + files.length + ' 个）' : ''));
      try { mountRuntime(fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8'), f); }
      catch (e) { rtErr = String(e && e.message || e); console.log('[mini-lx] 自动加载 ' + f + ' 失败: ' + rtErr); }
    } else {
      console.log('[mini-lx] 未指定音源脚本，/api/url 不可用（可在 UI 的「音源」页导入）');
    }
  } catch (e) { console.log('[mini-lx] scripts/ 初始化失败: ' + e.message); }
}

// ---------------------------------------------------------------- 三块曲库的可见性开关

const FLAGS_FILE = path.join(__dirname, 'files', 'media_flags.json');

/**
 * 三块内容（本地音乐库 / 在线音乐库 / 网络电台）各自能不能被小智看到。
 *
 * <p>关掉哪块，/index.json 里就**根本不出现**那一块 —— 不是"藏起来"，
 * 是小智从头就拿不到（用户原话：关闭后小智就获取不到了）。
 * 落盘 files/media_flags.json（挂载卷，容器重建不丢）。</p>
 */
function mediaFlags() {
  try {
    const j = JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8'));
    return {
      local: j.local !== false,
      online: j.online !== false,
      radio: j.radio !== false,
      // ★ 有声书/节目（2026-10-31）：只管「混不混进普通搜索结果」——
      //   关掉后 /api/search（普通模式，含 R1 语音点歌）滤掉 kind=program，
      //   专设的「有声书」类目（kind=program 显式搜索）不受它管。
      audiobook: j.audiobook !== false,
      // ★ v1.2.0：NAS 本地有声书库（扫 /music 挂载目录的那一路）。
      //   关掉后 /api/abl/* 一律当没有这本书 —— 小智与 Web 都拿不到。
      abLocal: j.abLocal !== false,
    };
  } catch {
    // 没有文件 = 全开（保持升级前的默认行为）
    return { local: true, online: true, radio: true, audiobook: true, abLocal: true };
  }
}

function setMediaFlags(o) {
  const cur = mediaFlags();
  const next = {
    local: o && o.local !== undefined ? !!o.local : cur.local,
    online: o && o.online !== undefined ? !!o.online : cur.online,
    radio: o && o.radio !== undefined ? !!o.radio : cur.radio,
    audiobook: o && o.audiobook !== undefined ? !!o.audiobook : cur.audiobook,
    abLocal: o && o.abLocal !== undefined ? !!o.abLocal : cur.abLocal,
  };
  try {
    fs.mkdirSync(path.dirname(FLAGS_FILE), { recursive: true });
    fs.writeFileSync(FLAGS_FILE, JSON.stringify(next));
  } catch { /* 只读环境也能改，只是重启后回到全开 */ }
  return next;
}

// ---------------------------------------------------------------- 默认音质

const QFILE = path.join(__dirname, 'files', 'quality.json');

/**
 * 可选档位（**从高到低**）。落雪 docker 就是按这几档去问订阅源的，
 * 别自己发明 'flac'/'ape' —— 多数源没有，白试一轮（各 0.6~2.3s）。
 */
const QALL = ['320k', '192k', '128k'];
/**
 * ★ 出厂默认 = 128k。
 * 实测：落雪的高音质档命中的常是「幻音音源」那种中转地址（拿得到链但出不去），
 * 而 128k 命中的是酷我真链（car-lv.kuwo.cn/...mp3，200 + audio/mpeg 直接可播）。
 * 绝大多数歌本来也只有 128k ⇒ 从 128k 起手，出链最快、失败最少。
 */
const QDEF = '128k';

/** 当前默认音质（落盘 files/quality.json，挂载卷里 ⇒ 容器重建不丢）。 */
function defQuality() {
  try {
    const j = JSON.parse(fs.readFileSync(QFILE, 'utf8'));
    const q = String((j && j.default) || '').trim();
    if (QALL.includes(q)) return q;
  } catch { /* 没文件 / 内容不合法 ⇒ 用出厂默认 */ }
  return QDEF;
}

function setDefQuality(q) {
  const v = QALL.includes(String(q || '').trim()) ? String(q).trim() : QDEF;
  try {
    fs.mkdirSync(path.dirname(QFILE), { recursive: true });
    fs.writeFileSync(QFILE, JSON.stringify({ default: v }));
  } catch { /* 只读环境：本次生效，重启回到 128k */ }
  return v;
}

/**
 * 本次取链要试的档位顺序（去重、高→低兜底）：
 *   ① 这首歌上次通了的档（BEST_Q 记忆） ② 调用方点名要的档 ③ 默认档
 *   ④ 默认档**往下**补齐 ⑤ 默认档**往上**补齐（默认档没链时的退路 —— 换一档
 *      常常命中另一个源，实测 128k 挂了而 192k 给真链的情况并不少见）。
 */
function qualityChain(want, defq, best) {
  const out = [];
  const push = x => {
    const s = String(x || '').trim();
    if (s && QALL.includes(s) && !out.includes(s)) out.push(s);
  };
  push(best);
  push(want);
  push(defq);
  const i = Math.max(0, QALL.indexOf(defq));
  for (let k = i; k < QALL.length; k++) push(QALL[k]);
  for (let k = i - 1; k >= 0; k--) push(QALL[k]);
  return out;
}

// ---------------------------------------------------------------- 工具
/**
 * skipIf：返回 true 时「不写缓存」。
 * ★ 必要性：上游接口偶发返回空（限流/抖动），若把空结果缓存起来，
 *   一次抖动会被固化成整整一个 ttl 的「查不到」。实测歌词接口就会偶发空。
 */
async function cached(key, fn, ttl = 600000, skipIf = null) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  if (skipIf && skipIf(v)) return v;
  cache.set(key, { t: Date.now(), v });
  return v;
}
const hasList = v => !v || !v.list || !v.list.length;
/** 取一个直链 + 验证是真音频 + 缓存（空结果不缓存，见 cached 的 skipIf） */
async function ok(key, fn) {
  return cached(key, async () => {
    try { const u = await fn(); return (await isAudioUrl(u)) ? u : ''; }
    catch { return ''; }
  }, 1800000, v => !v);
}
/**
 * ★ 探测直链：是不是音频 + 多大。
 * 除了 isAudioUrl 的 content-type 判断，这里多取一个「总字节数」，用来识别
 * 酷我给的 11 秒试听提示音（实测固定 177KB）—— 那是「当前音乐仅在酷我音乐客户端播放」
 * 的录音，不是我们要的歌。
 * @returns {{ok:boolean,size:number,ct:string}}
 */
async function probeUrl(u) {
  if (!u || !/^https?:\/\//.test(u)) return { ok: false, size: -1, ct: '', status: 0, finalUrl: '', err: '非 http(s) 地址' };
  let last = { ok: false, size: -1, ct: '', status: 0, finalUrl: '', err: '' };
  // 两轮：先 Range（省流量），被拒（405/400/416…）再退化为普通 GET（只读头就丢掉 body）。
  // 必要性：音源后端（如 sayqz）不一定支持 Range，而旧版只发 Range 就把好直链判死了。
  for (const headers of [{ Range: 'bytes=0-1', 'User-Agent': 'Mozilla/5.0' },
    { 'User-Agent': 'Mozilla/5.0' }]) {
    try {
      const r = await fetch(u, { method: 'GET', headers, redirect: 'follow', signal: AbortSignal.timeout(12000) });
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      const status = r.status;
      const finalUrl = r.url || u;              // ★ 跟随 302 后的真实地址
      if (!r.ok && status !== 206) {
        last = { ok: false, size: -1, ct, status, finalUrl, err: 'HTTP ' + status };
        try { await r.body.cancel(); } catch { /* ignore */ }
        if (status >= 400 && status !== 404 && status !== 403) continue;   // 换一种请求方式再试
        return last;
      }
      if (/^text\/|json/.test(ct)) {
        try { await r.body.cancel(); } catch { /* ignore */ }
        return { ok: false, size: -1, ct, status, finalUrl, err: '返回的是文本/JSON，不是音频' };
      }
      const m = String(r.headers.get('content-range') || '').match(/\/(\d+)/);
      const size = m ? Number(m[1]) : Number(r.headers.get('content-length') || -1);
      try { await r.body.cancel(); } catch { /* ignore */ }
      return { ok: true, size, ct, status, finalUrl, err: '' };
    } catch (e) {
      last = { ok: false, size: -1, ct: '', status: 0, finalUrl: '', err: String(e && e.message || e).slice(0, 120) };
    }
  }
  return last;
}

/** 30 秒 @128kbps ≈ 480KB；小于它基本就是提示音/试听片段 */
// ---------------------------------------------------------------- 音源脚本下载（多镜像 + 真因回显）
/**
 * ★ 为什么要有这一段：用户反馈「之前能载入的链接现在 fetch failed」。
 *   而 Node 的 undici 只会抛一句干巴巴的 `fetch failed`，真因藏在 e.cause.code 里
 *   （ENOTFOUND / UND_ERR_SOCKET / CERT…），UI 看不到就没法判断「域名死了」还是「被墙了」。
 *   同时 2026-10-15 实测：
 *     · raw.githubusercontent.com 直连 = TLS 握手就被掐（cause 为空的 socket hang up）
 *     · ghproxy.net / gh-proxy.com = HTTP 403（老的「一律加 ghproxy」经验已失效）
 *     · cdn.jsdelivr.net = 通
 *   ⇒ 镜像链必须换成「jsdelivr 优先」，并且逐个试、逐个报。
 */
function describeErr(e) {
  const c = e && e.cause;
  const code = String((c && c.code) || e.code || '');
  const msg = String((c && c.message) || e.message || '');
  const M = {
    ENOTFOUND: '域名解析不到（域名已失效，或 DNS 不给结果）',
    EAI_AGAIN: 'DNS 查询失败（DNS 服务器不稳）',
    ECONNREFUSED: '连接被拒绝（对方端口没开）',
    ECONNRESET: '连接被重置（对端或中间设备掐断）',
    ETIMEDOUT: '连接超时',
    UND_ERR_CONNECT_TIMEOUT: '连接超时（15 秒没连上）',
    UND_ERR_SOCKET: '连接被中途掐断（TLS 被干扰的典型症状）',
    UND_ERR_HEADERS_TIMEOUT: '响应头超时',
    UND_ERR_BODY_TIMEOUT: '下载超时',
    UND_ERR_RESPONSE_STATUS_CODE: 'HTTP 状态码异常',
    CERT_HAS_EXPIRED: '证书过期',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书校验失败（代理/中间人）',
    ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配',
    EPROTO: 'TLS 握手失败（协议不匹配）',
  };
  return M[code] ? (M[code] + ' [' + code + ']') : (code || e.name || msg || '未知错误');
}

/** 为一个音源脚本 URL 生成候选地址（原地址 + 镜像） */
function scriptCandidates(u) {
  const out = [u];
  const add = x => { if (x && !out.includes(x)) out.push(x); };
  try {
    const x = new URL(u);
    const h = x.hostname;
    const seg = x.pathname.split('/').filter(Boolean);
    // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path...>
    if (h === 'raw.githubusercontent.com' && seg.length >= 4) {
      const [owner, repo, ...rest] = seg;
      add('https://cdn.jsdelivr.net/gh/' + owner + '/' + repo + '@' + rest.join('/'));  // 带 ref
      add('https://cdn.jsdelivr.net/gh/' + owner + '/' + repo + '/' + rest.slice(1).join('/')); // 默认分支
      add('https://jsdelivr.b-cdn.net/gh/' + owner + '/' + repo + '@' + rest.join('/'));
    }
    if (h.endsWith('.github.io') && seg.length >= 1) {
      // <user>.github.io/<repo>/... → 该仓库的 jsdelivr
      const [repo, ...rest] = seg;
      add('https://cdn.jsdelivr.net/gh/' + h.split('.')[0] + '/' + repo + '/' + rest.join('/'));
    }
    if (/github\.com\/.*\/raw\//.test(u)) {
      add(u.replace('github.com/', 'raw.githubusercontent.com/'));
    }
    if (/github\.com|githubusercontent\.com|gist\.github/.test(h)) {
      add('https://ghproxy.net/' + u);
      add('https://gh-proxy.com/' + u);
    }
  } catch { /* 不是合法 URL，就只用原地址 */ }
  return out;
}

/** 逐个候选下载，全失败时把每个候选的失败原因带回去 */
async function downloadScript(u) {
  const tried = [];
  for (const url of scriptCandidates(u)) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const txt = await r.text();
      if (!r.ok) { tried.push({ url, err: 'HTTP ' + r.status, ms: Date.now() - t0 }); continue; }
      if (!txt || txt.length < 32) { tried.push({ url, err: '内容为空（' + txt.length + ' 字节）', ms: Date.now() - t0 }); continue; }
      return { ok: true, code: txt, url, tried };
    } catch (e) {
      tried.push({ url, err: describeErr(e), ms: Date.now() - t0 });
    }
  }
  return { ok: false, tried };
}

// ---------------------------------------------------------------- 取链 / 转发
const { Readable } = require('stream');

// ★ v1.2.3：最后一道保险。真正的修法在 pipeAudio 里（分段超时 + 流 error 监听），
//   这里只兜「还有没想到的漏网之鱼」—— 一个请求的流报错不该让整个容器退出：
//   重启虽然只有几秒，但正在播的歌全断、Web 也瞬断，用户看到的就是「偶发停止」。
process.on('uncaughtException', e => {
  console.error('[mini-lx] 未捕获异常（已兜住，服务继续）：' + String(e && e.stack || e));
});
process.on('unhandledRejection', e => {
  console.error('[mini-lx] 未处理的 Promise 拒绝（已兜住）：' + String(e && e.stack || e));
});

const clampN = (v, d) => Math.min(Math.max(parseInt(v || d, 10) || d, 1), 300);

/**
 * ★★ 在线曲目的播放地址一律用 /r/<source>/<rid>，不用 /s/<i>。
 *
 * 为什么：/s/<i> 是**池内下标**，而 pool 一到「换一批」（random_online / Web 点换一批）
 * 就被整个重摇 —— 下标 i 指的还是第 i 个位置，但那里坐的已经是另一首歌。
 * 于是 R1 手里那份列表（歌名是旧批的）会全部错位：
 *   · 语音点歌「播放第 3 首」⇒ 播出来是别的歌
 *   · 「随机播放在线音乐」再说一次 ⇒ 上次那批还没播完的 s/<i> 全部指到新歌
 * /r/<source>/<rid> 绑的是**这首歌本身**，池怎么重摇都不受影响。
 *
 * 代价与 /s/<i> 完全一样：都是惰性地址，起播那一刻才取链。
 * src/rid 恒为 ASCII，中文歌名只在 query 里（已 encode），路径本身不带中文。
 */
const lazyFile = t => 'r/' + (t.source || 'kw') + '/' + t.rid;
const lazyUrl = (self, t, ap) => self + (ap ? '/ap' : '') + '/' + lazyFile(t)
  + '?title=' + encodeURIComponent(t.title || '')
  + '&artist=' + encodeURIComponent(t.artist || '');

/** 自己在局域网里的地址（拼 /index.json 里的绝对 url 用）。可用 files/my_base 覆盖。 */
function selfBase(req) {
  try {
    const f = path.join(__dirname, 'files', 'my_base');
    if (fs.existsSync(f)) {
      const s = fs.readFileSync(f, 'utf8').trim();
      if (s) return s.replace(/\/+$/, '');
    }
  } catch { /* ignore */ }
  return 'http://' + String(req.headers.host || '127.0.0.1:' + PORT).replace(/\/+$/, '');
}

// ---------------------------------------------------------- 设备识别（v1.4.0）
/**
 * ★★ R1 与 AlphaPi 共用一套接口，靠「客户端是谁」决定要不要转码。
 *
 *   R1 / 浏览器：原样转发 mp3 / m4a（R1 自带解码，转码只会白白多耗 CPU 和 24KB/s 带宽）；
 *   AlphaPi    ：**必须**转 —— 小智固件里没有 mp3 解码器，flac/aac 更不可能，
 *                协控那条音频通路只认 1 字节 1 样本的 8bit/24000Hz。
 *
 * 识别优先级（前者覆盖后者）：
 *   ① `?fmt=wav|pcm` / `?fmt=mp3|src`  —— 显式指定，调试与个别设备兜底用
 *   ② `/ap/...` 路径前缀             —— **最可靠**，固件不发 UA 也不会认错
 *   ③ 环境变量 AP_TRANSCODE=on|off    —— 单设备部署时一刀切
 *   ④ `?dev=ap|r1`                   —— 手动指定
 *   ⑤ User-Agent 里带 alphapi / xiaozhi / stem / esp32 / espressif
 *      （AlphaPi One 的收音机就明发 `AlphaPi-One-S-Radio/1.0`）
 */
const AP_MODE = String(process.env.AP_TRANSCODE || 'auto').trim().toLowerCase();
const AP_FORCE = /^(on|1|true|yes|all)$/.test(AP_MODE);
const AP_OFF = /^(off|0|false|no|none)$/.test(AP_MODE);
const AP_UA_RE = /(alpha-?pi|xiaozhi|espressif|esp32|esp-idf|\bstem\b)/i;

function isAlphaPi(req) {
  if (AP_OFF) return false;
  const u = req.__u;
  const q = k => (u ? String(u.searchParams.get(k) || '').trim().toLowerCase() : '');

  const fmt = q('fmt');
  if (fmt) return /^(wav|wav8|pcm|pcm8|u8|ap|alphapi)$/.test(fmt);

  if (req.__ap) return true;          // /ap/ 前缀（handler 入口已把路径前缀剥掉）
  if (AP_FORCE) return true;

  const dev = q('dev');
  if (dev) return /^(ap|alphapi|alpha|stem|xiaozhi|1|on|yes)$/.test(dev);

  return AP_UA_RE.test(String(req.headers['user-agent'] || ''));
}

/** 在 /index.json 里拼地址时用：识别为 AlphaPi 就直接给 /ap/ 地址（后续请求不必再靠 UA）。 */
const apPrefix = req => (isAlphaPi(req) ? '/ap' : '');

/** 转码参数覆盖（rate / bits / ch / gain / raw 都可以按请求带，默认取环境变量）。 */
function apOpts(req) {
  const u = req.__u;
  const get = k => (u ? u.searchParams.get(k) : null);
  const num = (k, d) => {
    const v = get(k);
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  const g = get('gain');
  return {
    rate: num('rate', tc.OUT.rate),
    bits: num('bits', tc.OUT.bits) === 16 ? 16 : 8,
    ch: num('ch', tc.OUT.ch),
    gainDb: g === null || g === '' ? undefined : Number(g),
    raw: /^(1|true|yes|raw)$/i.test(String(get('raw') || '')),
  };
}

/**
 * 统一出口：AlphaPi 走转码，其余走原来的直通转发。
 * @param {string} input  本地绝对路径（kind=file）或 http(s) 地址（kind=url）
 */
function serveAudio(req, res, input, kind, ctHint) {
  if (isAlphaPi(req)) {
    const o = apOpts(req);
    console.log('[ap] 转码 ' + (kind === 'url' ? 'URL' : 'FILE') + ' → '
      + (o.raw ? 'pcm' : 'wav') + '/u' + o.bits + '/' + o.rate + ' ' + String(input).slice(0, 110));
    return tc.serve(req, res, Object.assign({ input, kind, tag: String(input).slice(0, 100) }, o));
  }
  return kind === 'url' ? pipeAudio(res, req, input) : sendLocalFile(res, req, input, ctHint);
}

/**
 * ★ v1.5.0：给小智（AlphaPi STEM）语音点歌挑一首 —— 一次调用就定"放什么"。
 *
 * <p>顺序：**本地曲库 → 落雪多源 → 脚本源**。本地优先是因为它零取链耗时、离线可用；
 * 落雪优先于脚本源，是因为搜索与取链同源（「搜得到却播不了」就是混源混出来的）。
 *
 * @returns {Promise<{input:string,kind:'file'|'url',title:string,artist:string,via:string}|null>}
 */
/** ★ v1.7.19：真实播放的在线歌落 rid 缓存（song_cache.json）。
 *  此前只有 /api/song/resolve（收藏单点解析）会写缓存，语音点歌 / 网页播放 /
 *  曲库池这些「真播了」的路径全都不入库 —— 缓存页永远只有收藏里点过的那几条。
 *  规则：
 *   · 已在缓存 → markPlay 记一笔（hits/lastPlay，LRU 淘汰依据）；
 *   · 没在缓存 → put 入库（title/artist 存播放时的真名，多设备共享）；
 *   · 有声书/节目不入：kind==='program' 直接拒，rid 属于 abcache 书目
 *     （bookByRid 反查命中）也拒 —— 书的 rid 归 ab_cache.json 管；
 *   · 本地文件没有 rid，天然进不来（也不该进）；
 *   · 任何失败静默 —— 缓存永远不能影响播放本身。 */
function songLearnPlay(title, artist, source, rid, album, kind) {
  try {
    if (!rid || !String(title || '').trim()) return;
    if (String(kind || '') === 'program') return;
    if (abcache.bookByRid(source, rid)) return;   // 有声书的集，别混进曲库缓存
    const sk = songcache.keyOf(String(title), String(artist || ''));
    if (songcache.get(sk)) {
      songcache.markPlay(sk);
      return;
    }
    const saved = songcache.put({
      key: sk,
      title: String(title),
      artist: String(artist || ''),
      source: String(source || 'kw'),
      rid: String(rid),
      album: String(album || ''),
      kind: String(kind || ''),
    });
    if (saved) {
      console.log('[songcache] 播放入库：' + title + (artist ? ' - ' + artist : '')
        + ' → ' + saved.source + '/' + saved.rid);
    }
  } catch { /* 缓存失败不影响播放 */ }
}

async function apPickSong(q) {
  const key = String(q || '').trim();
  if (!key) return null;
  const k = key.toLowerCase();

  // ① 本地曲库：歌名或歌手包含关键词即可（简单包含，行为可预期）
  try {
    const tracks = await local.list();
    const hit = tracks.find(t => String(t.title || '').toLowerCase().includes(k)
      || String(t.artist || '').toLowerCase().includes(k));
    if (hit) {
      const abs = local.absOf(hit.file);
      if (abs && fs.existsSync(abs)) {
        return { input: abs, kind: 'file', title: hit.title, artist: hit.artist, via: 'local' };
      }
    }
  } catch { /* 本地库不可用就走在线 */ }

  // ② 在线：落雪优先，空结果再落脚本源
  let list = [];
  try { list = await lxSearchAll(key, 10, 'all'); } catch { list = []; }
  if (!list.length) {
    try {
      const r = await S.searchAll(key, 10, 1);
      list = (r && r.list) || (Array.isArray(r) ? r : []) || [];
    } catch { list = []; }
  }
  // 有声书/节目不参与"点歌"（整本长内容会被当成"播第一章"，体验很怪）
  const cand = (list || [])
    .filter(x => x && (x.rid || x.url))
    .filter(x => (x.kind || detectKind(String(x.title || ''), String(x.album || ''),
      String(x.artist || ''))) !== 'program')
    .slice(0, 3);
  for (const it of cand) {
    if (it.url && /^https?:\/\//i.test(it.url)) {
      return { input: it.url, kind: 'url', title: it.title, artist: it.artist, via: it.source || 'url' };
    }
    if (!it.rid) continue;
    try {
      const r = await resolveUrl({ rid: it.rid, source: it.source, title: it.title, artist: it.artist });
      if (r && r.url) {
        songLearnPlay(it.title, it.artist, it.source, it.rid, it.album, it.kind);   // ★ v1.7.19
        return { input: r.url, kind: 'url', title: it.title, artist: it.artist, via: r.viaSource || it.source };
      }
    } catch { /* 这首取不到链就换下一首 */ }
  }
  return null;
}

// ================================================================ v1.5.1 语音播放队列
/*
 * 三种内容，一条出口：`GET /ap/play?kind=song|radio|book`
 *
 *    song  —— 关键词 → **整张歌单连播**（本地库优先，再落雪），`idx=` 跳过前几首
 *    radio —— 台名 → 直播流（无限长，永不 EOF）
 *    book  —— 书名 → 有声书，`ep=0` 走续播记忆，`ep=N` 从第 N 集起，`n=` 连播几集
 *
 * ★ 为什么把「歌单」做在服务端而不是设备端：设备端是 ESP32-C3，做队列就要
 *   维护 N 个 rid、处理"上一首取链失败"、还要在 24KB/s 的播放泵旁边再排一条
 *   状态机；而服务端只是把 N 个输入 concat 成一条 PCM 流 —— 设备端看到的就是
 *   "一首有点长的歌"，零改动。切歌缝、取链失败跳过，全在 NAS 侧消化。
 */

/** 歌：候选元数据（**不取链** —— 每首取链几百 ms，idx 大时不能白取一堆） */
async function apSongMeta(q) {
  const key = String(q || '').trim();
  if (!key) return [];
  const k = key.toLowerCase();
  const meta = [];
  const seen = new Set();
  // ① 本地曲库：歌名/歌手/专辑包含关键词
  try {
    const tracks = await local.list();
    for (const t of tracks) {
      const hay = (String(t.title || '') + ' ' + String(t.artist || '') + ' ' + String(t.album || '')).toLowerCase();
      if (hay.indexOf(k) < 0) continue;
      meta.push({ t: 'local', title: t.title, artist: t.artist, file: t.file });
      const sig = String(t.title || '').toLowerCase();
      if (sig) seen.add(sig);
    }
  } catch { /* 本地库不可用就走在线 */ }
  // ② 在线：落雪优先（搜/取链同源），空结果再落脚本源
  let list = [];
  try { list = await lxSearchAll(key, 20, 'all'); } catch { list = []; }
  if (!list.length) {
    try {
      const r = await S.searchAll(key, 20, 1);
      list = (r && r.list) || (Array.isArray(r) ? r : []) || [];
    } catch { list = []; }
  }
  for (const it of (list || [])) {
    if (!it || !(it.rid || it.url)) continue;
    // 有声书/节目不混进歌单（整本长内容会把"随机听会儿歌"变成听书）
    if ((it.kind || detectKind(String(it.title || ''), String(it.album || ''),
      String(it.artist || ''))) === 'program') continue;
    const sig = String(it.title || '').toLowerCase();
    if (sig && seen.has(sig)) continue;          // 本地已有同一首，别重复
    if (sig) seen.add(sig);
    meta.push({ t: 'online', title: it.title, artist: it.artist,
      rid: it.rid, source: it.source, url: it.url });
  }
  return meta;
}

/** 元数据 → ffmpeg 能吃的 items。取链失败的**跳过**（一首坏链不该毁掉整张歌单） */
async function apToItems(slice) {
  const out = [];
  for (const m of slice) {
    if (m.t === 'local') {
      const abs = local.absOf(m.file);
      if (abs && fs.existsSync(abs)) {
        out.push({ input: abs, kind: 'file', title: m.title, artist: m.artist });
      }
      continue;
    }
    if (m.url && /^https?:\/\//i.test(m.url)) {
      out.push({ input: m.url, kind: 'url', title: m.title, artist: m.artist });
      continue;
    }
    try {
      const r = await resolveUrl({ rid: m.rid, source: m.source, title: m.title, artist: m.artist });
      if (r && r.url) {
        songLearnPlay(m.title, m.artist, m.source, m.rid, '', '');   // ★ v1.7.19：歌单里真会播的才入库
        out.push({ input: r.url, kind: 'url', title: m.title, artist: m.artist });
      }
    } catch { /* 这首取不到链就换下一首 */ }
  }
  return out;
}

/**
 * 电台：按台名选台。
 *
 * ★ 匹配顺序写死，宁可回「没找到这个电台」也不要随便挑一个放 ——
 *   用户说「播放中国之声」，放成交通台比不放更糟。
 */
function apPickRadio(q) {
  const list = (local.radios() || []).slice();
  if (!list.length) return { err: '电台清单是空的（files/radios.json）' };
  const raw = String(q || '').trim();
  if (!raw) return { err: '缺台名', list: list.map(r => r.name).slice(0, 30) };
  const nz = s => String(s).toLowerCase().replace(/[\s'"「」《》,，。!！?？·\-_]/g, '');
  const strip = s => nz(s).replace(/(网络电台|广播电台|电台|广播|频道|fm|调频)$/g, '');
  const key = nz(raw);
  const key2 = strip(raw);
  const cands = [];
  for (const r of list) {
    const n = nz(r.name);
    const n2 = strip(r.name);
    let score = 0;
    if (n === key) score = 100;
    else if (n2 && key2 && n2 === key2) score = 90;
    else if (key.length >= 2 && n.indexOf(key) >= 0) score = 70;
    else if (n.length >= 2 && key.indexOf(n) >= 0) score = 60;
    else if (n2 && key2 && (n2.indexOf(key2) >= 0 || key2.indexOf(n2) >= 0)) score = 50;
    if (score) cands.push({ score, r });
  }
  if (!cands.length) return { err: '没找到这个电台：' + raw, list: list.map(r => r.name).slice(0, 30) };
  cands.sort((a, b) => b.score - a.score);
  return { hit: cands[0].r, others: cands.slice(1, 4).map(x => x.r.name) };
}

/** 自己调自己（本机回环）—— 复用已有的书库接口，不再复刻一份索引逻辑 */
async function apSelfJson(pathQ) {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + pathQ, {
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/**
 * 有声书：书名 → 集表 → 从 ep 起的 n 集。
 *
 * ★ 两条腿：先 NAS 本地书库（有精确"上次第几集"记忆，且文件在本机零取链），
 *   再在线书库（落雪按 albumId 聚整本）。
 * ★ ep=0 = 续播：v1.6.0 起**优先用这台设备的播放记录**（resume），
 *   没有记录才退回本地库自带的 lastEp。
 * ★★ 合集陷阱：`books[0].lastEp` 是**整个合集**（三体 86 集）聚合出来的，
 *   而真正要播的是 subs[0]（地球往事Ⅰ 只有 54 集）—— 直接拿 86 去查子书
 *   就是空集表 ⇒ 以前"听三体"必 404。现在用子书自己的 lastEp，并且越界回落第 1 集。
 *
 * @param {{ep:number, off:number}|null} resume 设备续播点（off = 已播秒数）
 */
/**
 * ★★ v1.6.8：把集内起点夹到「集尾前 3 秒」以内。
 *   v1.6.3 用 `dur-30` 防「历史 pos 是旧版字节污染值 ⇒ -ss 落到文件外 ⇒
 *   ffmpeg 零字节 ⇒ 设备嘀一声没声」。但 30 秒太狠：设备断流原地续播 /
 *   用户主动跳到集尾时，ss 本来就在 dur 附近，一刀切倒回 30 秒 ⇒
 *   听感「倒回去重播这一集」，而且每 30 秒又 EOF 又续播，形成死循环
 *   （实机第 8 集 dur=771，日志反复「跳 741s / pos=769s / wall=30s」，
 *    769−741=28 正是用户说的「回退 28 秒」，且永远不跳下一集）。
 *   3 秒足够让 ffmpeg 出字节，最多重听 3 秒，仍不会零字节。
 */
function apSeekClamp(off, dur) {
  const d = Number(dur) || 0;
  let o = Math.max(0, Number(off) || 0);
  if (d > 0 && o > d - 3) o = Math.max(0, d - 3);
  return o;
}

/** ★ v1.7.26 集时长解析：上游集表的 duration 是 "mm:ss" / "hh:mm:ss" 字符串
 *   （kw 光合积木实测 "12:35"），也有纯秒数的源。直接 Number("12:35")=NaN ⇒ 0 ⇒
 *   X-Book-Dur 不下发 ⇒ 设备 mLibDur=0：小智答不出本集时长（LLM 还会自己编个数），
 *   V2.4.10 的「真播完 vs 提前掐断」对账也失效。这里统一归一成秒。 */
function durParse(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));          // 纯秒
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);                  // mm:ss / hh:mm:ss
  if (!m) return 0;
  return (m[1] ? parseInt(m[1], 10) * 3600 : 0)
    + (parseInt(m[2], 10) || 0) * 60 + (parseInt(m[3], 10) || 0);
}

async function apBookItems(q, ep, n, resume, ss) {
  const key = String(q || '').trim();
  if (!key) return { err: '缺少书名' };
  const want = Math.max(parseInt(ep, 10) || 0, 0);
  const cnt = Math.min(Math.max(parseInt(n, 10) || 1, 1), 5);
  const rOff = resume ? Math.max(0, Number(resume.off) || 0) : 0;
  // ★ v1.6.1：`ss=` = 设备端主动给的集内偏移（暂停后按 C 继续时用）。
  //   和续播的 off 走同一条 `items[0].ss`，区别只是它来自请求而不是历史记录。
  const seek = Math.max(0, Number(ss) || 0);

  // ★ v1.6.2：**自动续播**（第 N 集播完→要第 N+1 集）越界 = 全书听完，
  //   必须明确报"没有第 N 集"，绝不能回落第 1 集 —— 那会把整本书从头再放一遍，
  //   听感就是"刚听完又从头念"。回落只在"续播用的 lastEp 已经过期"时才允许。
  const strict = want > 1 || !!(resume && resume.nextEp);

  /** 取一本书从 from 起的集（非 strict 时越界回第 1 集，别把 404 甩给用户） */
  const epsFrom = async (id, from) => {
    const pull = async f => {
      const d = await apSelfJson('/api/abl/eps?id=' + encodeURIComponent(id)
        + '&ep=' + f + '&size=80');
      if (!d || !Array.isArray(d.episodes)) return { d: null, eps: [] };
      return { d, eps: d.episodes.filter(e => (e.ep || 0) >= f) };
    };
    let r = await pull(from);
    if (!r.eps.length && from > 1 && !strict) r = await pull(1);   // 越界/该集被删 ⇒ 回第 1 集
    return r;
  };

  // ① 本地有声书库
  const bl = await apSelfJson('/api/abl/books?q=' + encodeURIComponent(key));
  if (bl && Array.isArray(bl.books) && bl.books.length) {
    const pick = bl.books[0];
    // 合集（多部）默认先放第一部，和 R1 侧行为一致
    let sub = (pick.subs && pick.subs.length) ? pick.subs[0] : pick;
    /* ★ v1.7.48：书身份是子书名之后的选部规则（越明确越优先）：
       ① 服务端 books() 认出的 hitSub（用户原话直接点了某一部）
       ② q 本身等于某个子书名（「播放黑暗森林Ⅱ」）
       ③ 续播记录属于某一部（上次听的就是这部，ep 才对得上）
       ④ 兜底第一部 */
    if (pick.subs && pick.subs.length) {
      const want = String(pick.hitSub || '').trim()
        || String(key).trim();
      const byName = pick.subs.find(s => String(s.name || '') === want);
      const byResume = (resume && resume.book)
        ? pick.subs.find(s => String(s.name || '') === String(resume.book)) : null;
      if (byName) sub = byName;
      else if (byResume) sub = byResume;
    }
    const useId = sub.id || pick.id;
    const from = want || (resume && resume.ep) || sub.lastEp || 1;
    const { d, eps } = await epsFrom(useId, from);
    /* ★ v1.7.56：**本地库只是残卷时，别再当成"全书听完"**。
       /audiobook 里同名的《凡人修仙传》实测只有 3 集（在线 2113 集），
       而设备的续播指针会一直指着这本残卷。旧版集号一越界就在这儿
       return tail=true，stem 只听到「已经没有第 7 集了（共 3 集）」，
       看上去像书听完了 —— 实际是本地不全，第 7 集在线明明有。
       用户口径是「本地库 → 缓存 → 在线」，所以这里改成：
         本地取不到 ⇒ 记下原因，继续走 ② 在线分支回源；
         在线也取不到 ⇒ 才报收尾（tail 保留）。
       （R1 侧 device 1.3.359 的 ab_resume 已有同口径降级链） */
    const localShort = (!eps.length && strict)
      ? { name: sub.name || pick.name || key, total: (d && d.total) || 0, from }
      : null;
    if (localShort) {
      console.log('[ap] 本地库「' + localShort.name + '」只有 ' + (localShort.total || '?')
        + ' 集，缺第 ' + from + ' 集 → 回源在线');
    }
    if (eps.length) {
      const take = eps.slice(0, cnt);
      const items = [];
      for (const e of take) {
        const abs = ablocal.absOf(e.file);
        // ★ v1.7.56：带上设备可直接播放的 url（/api/abl/eps 已补成 NAS 绝对地址），
        //   统一解析口 /api/ab/pick 要用它，别让调用方再去猜 /m/ 路径。
        if (abs && fs.existsSync(abs)) items.push({ input: abs, kind: 'file', title: e.title, ep: e.ep, url: e.url || '' });
      }
      if (items.length) {
        // 显式 `ss` 优先（设备暂停后继续，位置是它自己算的、最准）；
        // 其次才是"续播且续的还是同一集"的历史偏移；显式 ep=N 无 ss 一律从头。
        const ssOk = seek > 0 && (!want || items[0].ep === want);
        let off = ssOk ? seek
          : ((!want && resume && resume.ep === items[0].ep) ? rOff : 0);
        // ★ v1.6.3 兜底：历史 pos 可能是旧版"已写字节"的污染值，比这一集还长 ⇒
        //   -ss 落到文件外 ⇒ ffmpeg 零字节 ⇒ 设备"嘀一声没声音"。
        //   ★★ v1.6.8：夹到集尾前 **3 秒**（原来 30 秒会把集尾续播倒回半分钟，
        //   造成"重播本集、不跳下一集"的循环），详见 apSeekClamp 注释。
        const durE = durParse((take[0] && (take[0].dur || take[0].duration)) || 0);
        off = apSeekClamp(off, durE);
        if (off > 0) items[0].ss = off;
        /* ★ v1.7.48：合集子书的**书名 = 子书名**（「黑暗森林Ⅱ」），合集名只作系列前缀
           出现在展示位（X-Media-Title）。记录口径（histStart/histBookSave 吃 bookTitle）
           与 R1 device 的 /v1/pos 上报从此同一本书名，三部曲不再糊成「三体」一条。 */
        return { items, book: sub.name || pick.name, bookTitle: sub.name || pick.name,
          series: (sub.name && pick.name !== sub.name) ? pick.name : '',
          id: useId,
          from: items[0].ep, total: d.total, local: true, off, dur: durE };
      }
    }
  }

  // ② 在线书库
  const bs = await apSelfJson('/api/ab/search?q=' + encodeURIComponent(key));
  if (!bs || !Array.isArray(bs.books) || !bs.books.length) {
    // ★ v1.7.56：本地残卷回源到这儿还搜不到 = 这才真是"没得听"
    if (localShort) {
      return { err: '本地库「' + localShort.name + '」只有 ' + (localShort.total || '?')
        + ' 集，第 ' + localShort.from + ' 集在线也没找到', tail: true };
    }
    return { err: '没找到这本书：' + key };
  }
  const b = bs.books[0];
  const from = want || (resume && resume.ep) || 1;
  const d = await apSelfJson('/api/ab/episodes?q=' + encodeURIComponent(b.book)
    + '&albumId=' + encodeURIComponent(b.albumId || '')
    + '&source=' + encodeURIComponent(b.source || 'kw')
    + '&ep=' + from + '&size=80');
  if (!d || !Array.isArray(d.episodes) || !d.episodes.length) {
    return { err: '这本书的集表拉不到：' + b.book };
  }
  const eps = d.episodes.filter(e => (e.ep || 0) >= from).slice(0, cnt);
  if (!eps.length) {
    return { err: '已经没有第 ' + from + ' 集了（' + b.book + ' 共 ' + (d.total || '?') + ' 集）', tail: true };
  }
  const items = [];
  for (const e of eps) {
    if (!e.rid) continue;
    try {
      const r = await resolveUrl({ rid: e.rid, source: e.source || b.source, title: e.title, artist: b.narrator });
      if (r && r.url) items.push({ input: r.url, kind: 'url', title: e.title, ep: e.ep, url: r.url });
    } catch { /* 这一集取不到链就跳过 */ }
  }
  if (!items.length) {
    // ★ v1.6.9：整本所有集都取不到链 = 强信号，立即标 stale 让下次重搜
    abcache.failBook(b.source, b.albumId, b.book, '整本取链全空');
    return { err: '取不到音频链：' + b.book };
  }
  abcache.markBookPlay(b.source, b.albumId, b.book, items[0].ep);
  // ★ v1.7.24：在线集也支持集内偏移 —— stem 跳转（前进/后退 N 秒/跳到第 N 分钟）
  //   是「同一集带显式 ss= 重新起播」，旧版整段忽略 ss 导致跳转变集首。
  //   当年的顾虑（"远端 URL 盲跳容易跳到别处"）不成立：转码器的 ss 是 ffmpeg
  //   输入侧 -ss（-i 前置、靠 Range 快速定位），只定起点不换流内容，远端安全。
  //   规则与①本地分支完全对齐：显式 ss 优先（且集号对得上才认）；ep=0 续播
  //   且续的还是同一集才用历史 off；显式 ep 无 ss 一律从头。
  {
    const ssOk = seek > 0 && (!want || items[0].ep === want);
    let off = ssOk ? seek
      : ((!want && resume && resume.ep === items[0].ep) ? rOff : 0);
    // ★ v1.7.26：在线集时长来自 duration（"mm:ss" 字符串），durParse 归一成秒 ——
    //   X-Book-Dur 才能真正下发：设备 mLibDur 有值 ⇒ 小智答得出本集时长/剩余时间，
    //   V2.4.10 的断流对账（真播完 vs 提前掐断）也恢复。
    const durE = durParse((eps[0] && (eps[0].dur || eps[0].duration)) || 0);
    off = apSeekClamp(off, durE);
    if (off > 0) items[0].ss = off;
    return { items, book: b.book, bookTitle: b.book, from: items[0].ep, total: d.total,
      narrator: b.narrator, off, dur: durE };
  }
}

// ================================================================ v1.6.0 播放记录
/*
 * 存哪儿：**媒体库这边**（files/history.json），不是设备 NVS。
 *   ① C3 的 NVS 就几十 KB，还要擦写寿命；② 放这儿能"换台设备接着听"，
 *   也能让 Web 一个页面看全所有设备听了什么。
 *
 * 设备身份：优先 `X-Dev-Mac`（固件报的 WiFi MAC，12 位大写十六进制）；
 *   老固件/浏览器没有这个头就退化成 `ip-<地址>` —— 同一台机器换个 IP 会被当成新设备，
 *   只影响"续播"，不影响别的。
 *
 * 记账口径：起播时先落一条（pos=0），流结束/被掐时按**实际写出的字节数**结算播放秒数。
 *   bytes 比耳朵听到的略超前（TCP 发送缓冲 + 设备 FIFO），所以续播统一回退 10s。
 */
// HIST_FILE 可用环境变量覆盖 —— 回归测试不该把真实播放记录写脏
const HIST_FILE = process.env.HIST_FILE || path.join(__dirname, 'files', 'history.json');
const HIST_MAX = 60;          // 每台设备保留多少条
const HIST_SAVE_MS = 1500;    // 写盘防抖（起播/结束各一次，别把 NAS 盘刷爆）

let histData = null;
let histTimer = null;

function histLoad() {
  if (histData) return histData;
  histData = { ver: 1, devices: {}, books: {} };
  try {
    const j = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8'));
    if (j && j.devices && typeof j.devices === 'object') {
      // ★ v1.7.13 P1 书级共享：books 字段可选（老文件没有 → 空表起步），devices 原样兼容
      histData = { ver: 1, devices: j.devices,
        books: (j.books && typeof j.books === 'object') ? j.books : {} };
    }
  } catch { /* 第一次跑 / 文件损坏都从空开始，不耽误播放 */ }
  return histData;
}

function histFlush() {
  if (histTimer) { clearTimeout(histTimer); histTimer = null; }
  try {
    fs.mkdirSync(path.join(__dirname, 'files'), { recursive: true });
    const tmp = HIST_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(histLoad()));
    fs.renameSync(tmp, HIST_FILE);        // 原子替换：写一半断电也不会留半截 JSON
  } catch (e) {
    console.log('[hist] 写播放记录失败（不影响播放）: ' + e.message);
  }
}

function histTouch() {
  if (histTimer) return;
  histTimer = setTimeout(histFlush, HIST_SAVE_MS);
  if (histTimer.unref) histTimer.unref();
}

/**
 * 设备 id：MAC header 优先 → URL query `dev` 认领 → 来源 IP 兜底。
 * ★ v1.7.35：R1 拉流（/r/ /m/）是 MediaPlayer 底层发的，加不了自定义头，
 *   设备端改在播放 URL 上挂 ?dev=<12位MAC>&devName=<名>，这里认领，
 *   根治「R1 播放记录掉进 ip-<docker网关> / 网页 / 未报 MAC 的设备」。
 *   MAC header 仍最高优先（可信通道），query 只接受 8~12 位十六进制，防乱写。
 */
/**
 * ★ v1.7.42：按来源 IP 反查「已登记的真实设备」。
 *
 * 背景：R1 播**本地节目**（NAS 有声书 /m/ 直链）时，URL 由 ablocal 生成的相对路径拼成，
 * 不带 `?dev=<MAC>`（只有在线 /r/ 那路由 device 自己加），于是 devIdOf 只能落到 IP 兜底
 * ⇒ 播放记录里出现「ip-192.168.2.5 / 网页 / 未报 MAC 的设备」，其实是 R1 在播。
 * 这里用「设备上次起播时的 IP」反查 MAC：只认有 MAC 的设备（跳过 ip-* / unk 自身），
 * 同一 IP 多台取最近活跃的那台。查到就顶替 ip-* ，查不到保持原行为。
 */
function devByIp(ip) {
  const key = String(ip || '').trim();
  if (!key) return '';
  try {
    const d = histLoad();
    let best = '', ts = -1;
    for (const id of Object.keys(d.devices || {})) {
      if (!id || id === 'unk' || id.indexOf('ip-') === 0) continue;
      const dv = d.devices[id];
      if (!dv || String(dv.ip || '') !== key) continue;
      const t = Number(dv.seen) || 0;
      if (t > ts) { ts = t; best = id; }
    }
    return best;
  } catch { return ''; }
}

function devIdOf(req) {
  const mac = String(req.headers['x-dev-mac'] || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (mac.length >= 8) return mac.slice(0, 12);
  // URL query dev 认领（R1 拉流 URL 自带）；只认 8~12 位十六进制，与 header 同口径
  try {
    const raw = String(req.url || '');
    const qi = raw.indexOf('?');
    if (qi >= 0) {
      const u = new URL(raw, 'http://local');
      const dv = String(u.searchParams.get('dev') || '').toUpperCase().replace(/[^0-9A-F]/g, '');
      if (dv.length >= 8) return dv.slice(0, 12);
    }
  } catch { /* 解析失败走 IP 兜底 */ }
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '')
    .split(',')[0].trim().replace(/^::ffff:/, '');
  // ★ v1.7.42：本地节目（/m/）不带 dev ⇒ 按已登记设备的来源 IP 反查，别记成「网页」
  const owner = devByIp(ip);
  if (owner) return owner;
  return ip ? 'ip-' + ip : 'unk';
}

/**
 * ★ v1.7.49：这次请求是不是「已知的受限终端」。
 *
 * <p>只有认得出是谁，才敢给它降档 —— 网页/浏览器播 flac 完全没问题，
 * 无差别转码等于把所有终端的音质都拉低一档。
 *
 * <p>三级判定：① URL/头里的 dev 或 IP 反查到的真实 MAC；② MediaPlayer 的 UA
 * （R1 底层是 stagefright，Android 5.1）；③ 都不认识 ⇒ 空字符串（不转）。
 */
/**
 * ★ v1.7.54：这次请求是**谁**。
 *
 * <p>只认真实 MAC（头 / `?dev=` / 来源 IP 反查设备表）。v1.7.49~53 还有一级
 * 「UA 像 Android MediaPlayer 就当成通用档 'r1'」的兜底 —— 那条已经删掉：
 * 转码改成按设备白名单后，认不出身份就不该转（否则所有人都被默认降档，
 * 而 'r1' 这份档位还是所有匿名终端共用的，改一台等于改全部）。
 *
 * <p>认不出的返回空串 ⇒ `aac.profile('')` 的 `listed=false` ⇒ `/m/` 原样直发。
 * 设备要能命中，靠的是 `/v1/pos` 上报时把 MAC→IP 写进 history.devices；
 * 万一某台真机没命中，`/api/trans/devs` 能看到它的 ip-xxx 记录，手动加白名单即可。
 */
function knownDevId(req) {
  const id = devIdOf(req);
  if (/^[0-9A-F]{8,12}$/.test(String(id || ''))) return String(id);
  return '';
}

// ============================================================ v1.7.38 设备分组
/*
 * 进度归属从「全设备共享」升级为「按组共享」：
 *   · 同组设备共享一份进度；不同组互不可见；
 *   · 设备不在任何组 ⇒ 组 id = 'solo:<devId>'（天然独立，新设备默认就是这个）；
 *   · 只有 'default' 默认组是系统组（首次迁移的落点，不可删除，可改名）。
 * 组信息单独存 files/devgroups.json，与播放记录（history.json）解耦。
 */
const DG_FILE = process.env.DG_FILE || path.join(__dirname, 'files', 'devgroups.json');
const DG_DEFAULT = 'default';
let dgData = null;

function dgLoad() {
  if (dgData) return dgData;
  dgData = { ver: 1, groups: {} };
  try {
    const j = JSON.parse(fs.readFileSync(DG_FILE, 'utf8'));
    if (j && j.groups && typeof j.groups === 'object') {
      dgData = { ver: 1, groups: j.groups };
    }
  } catch { /* 第一次跑 / 文件损坏都从空开始 */ }
  return dgData;
}

function dgFlush() {
  try {
    fs.mkdirSync(path.join(__dirname, 'files'), { recursive: true });
    const tmp = DG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(dgLoad()));
    fs.renameSync(tmp, DG_FILE);      // 原子替换
  } catch (e) {
    console.log('[grp] 写设备分组失败（不影响播放）: ' + e.message);
  }
}

/** 设备所在组 id；不属于任何组 ⇒ 'solo:<devId>'（每台独立）。 */
function devGroupId(dev) {
  const id = String(dev || '').trim();
  const gs = dgLoad().groups || {};
  if (id) {
    for (const gid of Object.keys(gs)) {
      if ((gs[gid].devs || []).indexOf(id) >= 0) return gid;
    }
  }
  return 'solo:' + id;
}

/** 识别不出的「伪设备」（ip-* / unk / 空）—— 读取端要对其放宽，否则 R1 匿名续播断。 */
function isPseudoDev(id) {
  const s = String(id || '');
  return !s || s === 'unk' || s === 'solo:' || /^ip-/.test(s) || /^solo:$/.test(s);
}

/** 请求 → 组 id。识别不出设备时返回 null = 「不按组过滤」（全组取最新，兼容旧行为）。 */
function reqGroupId(req) {
  const dev = devIdOf(req);
  if (isPseudoDev(dev)) return null;
  return devGroupId(dev);
}

/** 首次启用迁移：现有设备并入默认组 + 旧 books 键加 g:default| 前缀（可重复调用，幂等）。 */
function dgInit() {
  const d = dgLoad();
  if (!d.groups) d.groups = {};
  if (!d.groups[DG_DEFAULT]) {
    const hist = histLoad();
    d.groups[DG_DEFAULT] = {
      name: '默认组',
      devs: Object.keys(hist.devices || {}),
      createdAt: Date.now(),
      system: true,
    };
    dgFlush();
    console.log('[grp] 首次启用分组：现有 ' + d.groups[DG_DEFAULT].devs.length + ' 台设备并入「默认组」');
  }
  // 旧 books 键（无 g: 前缀）→ g:default|<旧键>
  const hist = histLoad();
  const books = hist.books || {};
  let n = 0;
  for (const k of Object.keys(books)) {
    if (k.indexOf('g:') === 0) continue;
    const b = books[k] || {};
    books['g:' + DG_DEFAULT + '|' + k] = Object.assign({}, b, { grp: DG_DEFAULT });
    delete books[k];
    n++;
  }
  if (n) {
    histFlush();
    console.log('[grp] 迁移共享进度 ' + n + ' 条 → 默认组（g:default|…）');
  }
}

/** 分组快照（给 Web 用）：组列表含成员名，设备列表含归属组。 */
function dgSnapshot() {
  const hist = histLoad();
  const devName = {};
  for (const id of Object.keys(hist.devices || {})) {
    const dv = hist.devices[id] || {};
    devName[id] = dv.name || id;
  }
  const g = dgLoad().groups || {};
  const groups = Object.keys(g).map(gid => {
    const gg = g[gid] || {};
    const devs = (gg.devs || []).map(id => ({ id, name: devName[id] || id }));
    return {
      id: gid, name: gg.name || gid, system: !!gg.system,
      createdAt: gg.createdAt || 0, devs, count: devs.length,
    };
  }).sort((a, b) => (a.system === b.system ? (a.createdAt - b.createdAt) : (a.system ? -1 : 1)));
  const assigned = {};
  for (const gid of Object.keys(g)) {
    for (const id of (g[gid].devs || [])) assigned[id] = gid;
  }
  const devices = Object.keys(devName).map(id => {
    const gid = assigned[id] || '';
    return {
      id, name: devName[id],
      grp: gid || ('solo:' + id),
      grpName: gid ? ((g[gid] && g[gid].name) || gid) : '独立',
      solo: !gid,
      seen: (hist.devices[id] && hist.devices[id].seen) || 0,
    };
  }).sort((a, b) => (b.seen || 0) - (a.seen || 0));
  return { groups, devices };
}

/**
 * ★ v1.7.35：是不是「取链探活」请求 —— R1 device 的 probeUrl() 对 URL 发 HTTP HEAD
 *  （HEAD 不支持时退 GET 但不读 body），用来判断地址能不能播。这种请求并不代表
 *  用户真在听，绝不能落播放记录。判据：请求方法 HEAD。GET 一律算真播（播放器
 *  setDataSource 会真拉流）。
 */
function isPlayProbe(req) {
  return String(req && req.method || '').toUpperCase() === 'HEAD';
}

/**
 * ★ v1.7.37：stream（/r/ /m/）是否允许落播放记录。
 *
 * R1 player pl-1.6.160 起，只有「真播」（引擎 setDataSource，会 play()）才给
 * 拉流 URL 追加 &live=1；预取（setPreparingDataSource）不带。服务端据此过滤：
 *   - URL 带 dev=<MAC>（R1 拉流特征）⇒ 必须同时带 live=1 才算真播，才落记录；
 *   - 不带 dev 的请求（stem / 网页 / 未升级的旧 R1）⇒ 无标记体系，保持原行为放行。
 * 这样只对新版 R1 生效，不会误伤旧客户端。
 */
function isLiveCommit(req) {
  let u;
  try { u = new URL(String(req && req.url || ''), 'http://local'); }
  catch { return true; }               // URL 解析不了 ⇒ 不拦截，走原逻辑
  const hasDev = !!String(u.searchParams.get('dev') || '').trim();
  if (!hasDev) return true;             // 非 R1 拉流（无设备认领参数）⇒ 老客户端，放行
  return String(u.searchParams.get('live') || '') === '1';
}

/**
 * ★ v1.7.43：这条拉流是不是「会自己上报进度的设备」发的（R1 拉流 URL 带 dev=MAC）。
 *
 * <p>为什么要单独判它：书的「在播什么」由 device 的 ProgProgress 每 15s 权威上报
 * （book + ep + pos 一次给全）。stream 记录只是「取链/传输事实」，**分不清真播和预载** ——
 * 引擎预载下一首也走 setDataSource（带 live=1），实测播第 1 集时会落下第 2 集的
 * stream 记录，于是同一本书刷出多条 ep 不同的行、还会被误当成「当前集」。
 * 所以对这类设备，书不再由 stream 记录建行（歌/电台照旧，它们的行只能从 stream 来）。</p>
 */
function isReportingDev(req) {
  try {
    const u = new URL(String(req && req.url || ''), 'http://local');
    return !!String(u.searchParams.get('dev') || '').trim();
  } catch { return false; }
}

/**
 * ★ v1.7.36：stream 播放记录「真播判据」——累计传输字节够不够才算真听了。
 *
 * <p>R1 player 装载播放队列时会对当前曲 + 预取曲都发 GET（拿响应头做格式探测），
 * 几 KB 就断开。/r/ /m/ 若在请求到达瞬间落记录，队列里没播的歌全会混进来。
 * 真播一首歌至少拉几十 KB～几 MB；探活/预取只有几 KB。用累计字节阈值区分。</p>
 *
 * @param {number} bytes 本次响应流累计已传字节
 * @param {number} min   阈值（PLAY_COMMIT_BYTES）
 * @returns {boolean} true=确认真播，可以落记录
 */
function shouldCommitPlay(bytes, min) {
  return Number.isFinite(bytes) && bytes >= (Number.isFinite(min) && min > 0 ? min : 256 * 1024);
}

/** ★ v1.7.35：URL query devName（R1 拉流 URL 自带），供 histDevice 认设备名 */
function devNameFromUrl(req) {
  try {
    const raw = String(req.url || '');
    if (raw.indexOf('?') < 0) return '';
    const u = new URL(raw, 'http://local');
    return String(u.searchParams.get('devName') || '').trim().slice(0, 40);
  } catch { return ''; }
}

function histDevice(req) {
  const d = histLoad();
  const id = devIdOf(req);
  let dev = d.devices[id];
  if (!dev) dev = d.devices[id] = { id, list: [] };
  const nm = String(req.headers['x-dev-name'] || '').trim()
    || devNameFromUrl(req);   // ★ v1.7.35：R1 拉流 URL 自带 devName
  dev.name = nm ? nm.slice(0, 40)
    : (id.startsWith('ip-') ? '网页 / 未报 MAC 的设备' : 'AlphaPi-' + id.slice(-4));
  dev.ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  dev.ua = String(req.headers['user-agent'] || '').slice(0, 80);
  dev.seen = Date.now();
  if (!Array.isArray(dev.list)) dev.list = [];
  return dev;
}

/**
 * ★ v1.7.35 一次性迁移：把历史「网页 / 未报 MAC 的设备」桶里其实是 R1 播放器的记录
 *   归到真正的 R1 设备名下。docker 端口映射下 R1 的 /r/ /m/ 拉流都从网关 IP 进来、
 *   又没有 MAC 头 ⇒ 全落进 ip-<网关> 桶；现在源头已带 dev 参数，新记录自动归位，
 *   这里只把存量纠正一次（用 files/.devid_migrated_1735 标记，绝不重复跑）。
 *
 *   判据（保守，宁可漏不误伤）：
 *     · 源桶 id 形如 ip-* 且 UA 含 stagefright（= R1 的 MediaPlayer 拉流）；
 *     · 目标桶是 12 位十六进制 MAC id、名字带 "R1"（如 R1-CD6B）；
 *     · 找不到明确目标就整体跳过，留着原文不动。
 */
function migrateR1DeviceIdentity() {
  const flag = path.join(__dirname, 'files', '.devid_migrated_1735');
  try { if (fs.existsSync(flag)) return; } catch { /* ignore */ }
  let d;
  try { d = histLoad(); } catch { return; }
  if (!d || !d.devices) return;
  const ids = Object.keys(d.devices);
  const targets = ids.filter(k => /^[0-9A-F]{12}$/.test(k)
    && /R1/i.test(String(d.devices[k].name || '')));
  if (targets.length === 0) {
    try { fs.writeFileSync(flag, 'skip:no-target ' + Date.now()); } catch {}
    return;
  }
  const target = targets[0];
  const td = d.devices[target];
  if (!Array.isArray(td.list)) td.list = [];
  const have = new Set(td.list.map(e => e && e.id).filter(Boolean));
  let moved = 0;
  for (const k of ids) {
    if (k === target || !/^ip-/.test(k)) continue;
    const src = d.devices[k] || {};
    if (!/stagefright/i.test(String(src.ua || ''))) continue;   // 只认 R1 播放器 UA
    for (const e of (Array.isArray(src.list) ? src.list : [])) {
      if (!e || (e.id && have.has(e.id))) continue;
      if (e.id) have.add(e.id);
      td.list.unshift(e);
      moved++;
    }
    // 并掉 ip 桶的 last（取最新那条）
    if (src.last && (!td.last || (Number(src.last.ts) || 0) > (Number(td.last.ts) || 0))) {
      td.last = src.last;
    }
    delete d.devices[k];
  }
  td.list.sort((a, b) => (Number(b && b.ts) || 0) - (Number(a && a.ts) || 0));
  if (td.list.length > HIST_MAX) td.list.length = HIST_MAX;
  if (td.last && !td.list.length) td.list = [td.last];
  td.seen = Date.now();
  try {
    fs.writeFileSync(flag, 'ok:' + moved + '@' + Date.now());
    histFlush();
    console.log('[hist] v1.7.35 设备身份迁移：把 R1 播放器 ' + moved + ' 条旧记录并入 '
      + target + '（' + td.name + '）');
  } catch (e) {
    console.log('[hist] 迁移标记写入失败: ' + e.message);
  }
}

/** 起播记账：返回的 entry 是被 list/last 共享引用的对象，结束时直接改 pos 即可 */
function histStart(req, rec) {
  const dev = histDevice(req);
  const entry = withSrc(Object.assign({
    ts: Date.now(), kind: 'song', q: '', title: '', ep: 0, off: 0, pos: 0, done: false,
  }, rec || {}));
  entry.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  dev.list.unshift(entry);
  if (dev.list.length > HIST_MAX) dev.list.length = HIST_MAX;
  dev.last = entry;
  histTouch();
  return entry;
}

/**
 * ★ v1.6.6：判断「设备上报的位置是否已经到集尾」。
 *   v1.6.5 曾拿它**拦 fin**，已撤销 —— fin 是设备用 X-Book-Dur 对账后给的结论，
 *   而设备侧位置可能因播放泵重锚而少算（实机 828s 的集报成 602s），拿 pos 否定
 *   fin 会把真播完误判成掐断、续播倒回同一集。现在只用来决定"要不要校正 pos"。
 */
function apFinSane(fin, pos, dur) {
  if (!fin) return false;
  if (!(dur > 0)) return true;
  return pos >= dur - 5;
}

/**
 * ★★ v1.6.6：把设备上报的 (pos, fin) 落到播放记录上。
 *   fin=1 **一律采信**：设备侧 V2.4.10 起 cutShort 用 X-Book-Dur 对过账、V2.4.11 起
 *   真播完直接报集尾，没有第二条路径能产生 fin=1。服务端不再做"位置合理性"二次拦截。
 *   仅当 dur 已知且 pos 明显没到集尾时把 pos 校正到 dur，并回报 corrected 供日志说明
 *   （"听到这里"的记录停在半集比"跳错一集"危害小得多，而且这里 fin 已经确定无误）。
 */
function apApplyPos(entry, pos, fin) {
  if (!fin) return { fin: false, corrected: false };
  const atTail = apFinSane(fin, pos, entry.dur);
  entry.done = true;
  entry.endTs = Date.now();
  entry.paused = true;      // 之后 onEnd 不许覆盖（devsync 是更强的门，两道都留着）
  entry.fin = true;         // 本集真播完 ⇒ 下次续播从下一集开头
  if (!atTail && entry.dur > 0) {
    entry.pos = entry.dur;
    return { fin: true, corrected: true, from: Math.round(pos) };
  }
  return { fin: true, corrected: false };
}

/** 结算：sec = 实际送出的音频秒数（含续播起点 off） */
function histEnd(entry, sec, extra) {
  if (!entry) return;
  // ★ v1.6.1：设备已用 /ap/pos 主动报过位置（按键暂停/打断/播完）就别再被
  //   onEnd 的"已写字节"覆盖 —— 那个数比耳朵听到的超前一个 TCP 缓冲 + FIFO。
  if (entry.devsync) return;
  if (entry.paused && !(extra && extra.force)) return;
  entry.done = true;
  entry.endTs = Date.now();
  if (extra && extra.err) entry.err = String(extra.err).slice(0, 120);
  // ★★ v1.6.3：`/ap/` 设备那条流的**字节数完全不可信**（实测：本地文件 ffmpeg 转得
  //   比实时快十几倍，一次就能把剩下 78 秒全塞进 TCP 缓冲 —— 只听了 5 秒，bytes 却是
  //   整集）。位置和"是否播完"一律只认设备自己上报的 /ap/pos，onEnd 连 pos 都不写，
  //   免得把"听 3 分钟"记成"集尾 11:17"、下次续播直接跳走一整集。
  const trust = !(extra && extra.trustBytes === false);
  if (trust) {
    const played = Math.max(0, Number(sec) || 0);
    let pos = played + (Number(entry.off) || 0);
    if (entry.dur > 0) pos = Math.min(pos, entry.dur);
    entry.pos = Math.round(pos * 10) / 10;
    // ★ v1.6.2：只有 ffmpeg **自己走完**（transcode 报 eof:0）才算"这一集播完了"。
    //   ⚠️ 不能用 pos≈时长来判断：设备中途断连时 onEnd 的 sec 恰好=播放位置，
    //   两个数永远"相等"，会把"听了 3 分钟就断"误当成听完而跳下一集。
    if (extra && /^eof:0$/.test(String(extra.reason || ''))) entry.fin = true;
  } else if (!entry.devsync && (Number(entry.dur) || 0) > 0) {
    /* ★★ v1.6.4 最后一道兜底 —— 设备意外断电 / 死机 / 被拔电，一条 /ap/pos 都没发出来
       （连 30s 心跳都没赶上），这条记录否则会永远停在起播点，那一段听得全白听。
       真正播过的秒数**不可能超过**「从开流到断开」的墙钟时间；而字节数可能远超
       （ffmpeg 转本地文件比实时快十几倍，整集能一次塞进 TCP 缓冲）。
       取两者较小值当上界。★若是空闲看门狗杀的（断电后 socket 不再消费、ffmpeg 被
       背压停住），还得把那 20s 空等扣掉，否则听 40 分钟会被记成 60 分钟。 */
    const wall = Math.max(0, Number(extra.wall) || 0);
    const idleSec = Number((String(extra.reason || '').match(/空闲\s*(\d+)ms/) || [])[1] || 0) / 1000;
    const played = Math.min(Math.max(0, Number(sec) || 0), Math.max(0, wall - idleSec - 1));
    if (played > 0.5) {
      let pos = played + (Number(entry.off) || 0);
      if (entry.dur > 0) pos = Math.min(pos, entry.dur);
      entry.pos = Math.round(pos * 10) / 10;
      entry.est = 'wall';   // 标记：这是按墙钟估的，不是设备上报的（Web 可据此提示）
      console.log('[hist] 设备没上报过位置（可能断电），墙钟兜底：'
        + (entry.book || entry.q) + ' 第 ' + entry.ep + ' 集 → pos=' + entry.pos.toFixed(0)
        + 's（wall=' + wall.toFixed(0) + 's bytes=' + (Number(sec) || 0).toFixed(0) + 's）');
    }
  }
  histTouch();
}

/** 找这台设备上"这本书这一集"的记录（设备上报位置时用来定位条目） */
function histFindBook(req, q, ep) {
  const dev = histLoad().devices[devIdOf(req)];
  if (!dev || !Array.isArray(dev.list)) return null;
  const key = String(q || '').toLowerCase().replace(/\s+/g, '');
  for (const e of dev.list) {
    if (e.kind !== 'book') continue;
    if (ep && e.ep && e.ep !== ep) continue;
    const b = String(e.book || e.q || '').toLowerCase().replace(/\s+/g, '');
    if (!key || !b || b.indexOf(key) >= 0 || key.indexOf(b) >= 0) return e;
  }
  return null;
}

/** 找这台设备上"这本书"的最后一条记录（续播用，本机维度 —— P1 后与书级共享取新者） */
function histResumeOwn(req, q, wantKind) {
  const wk = String(wantKind || 'book');
  const dev = histLoad().devices[devIdOf(req)];
  if (!dev || !Array.isArray(dev.list) || !dev.list.length) return null;
  const key = String(q || '').toLowerCase().replace(/\s+/g, '');
  if (!key) return null;
  for (const e of dev.list) {
    if (e.kind !== wk) continue;
    /* ★ v1.7.27：歌单本机续播 —— 同一口播词，回到上次第几首（idx 0 基）。 */
    if (wk === 'song') {
      const qq = String(e.q || '').toLowerCase().replace(/\s+/g, '');
      if (qq && (qq.indexOf(key) >= 0 || key.indexOf(qq) >= 0)) {
        return { kind: 'song', q: e.q, title: e.title || '',
          idx: Math.max(0, parseInt(e.idx, 10) || 0),
          pos: Number(e.pos) || 0, ts: e.ts || 0, own: true };
      }
      continue;
    }
    const book = String(e.book || '').toLowerCase().replace(/\s+/g, '');
    const qq = String(e.q || '').toLowerCase().replace(/\s+/g, '');
    if ((book && (book.indexOf(key) >= 0 || key.indexOf(book) >= 0))
      || (qq && (qq.indexOf(key) >= 0 || key.indexOf(qq) >= 0))) {
      // ★ v1.6.2：上一集已经**完整播完** ⇒ 从下一集开头继续（pos=0、不跳 -10s）。
      //   否则 pos≈时长，续播会卡在集尾把那 10 秒反复放一遍。
      // ★ v1.6.3：老记录是「已写字节」算的，可能把"听了 5 分钟"记成"集尾"（甚至超出时长）。
      //   所以除了 fin，还要用时长兜一道：pos 已经贴到集尾 3 秒内 ⇒ 当成本集听完。
      const dur = Number(e.dur) || 0;
      if (e.fin || (dur > 0 && (Number(e.pos) || 0) >= dur - 3)) {
        return Object.assign({}, e, { ep: (e.ep || 1) + 1, pos: 0, off: 0, nextEp: true });
      }
      return e;
    }
  }
  return null;
}

/**
 * ★ v1.7.27 P1 收尾：直链播放（/r/ /m/，v1.7.7 起落「起播事实」stream 记录）的位置补齐。
 *   设备 /v1/pos 上报到达时，同一设备**最近一条**同书同集（book）/同 rid（song）的
 *   stream 记录就地补 pos/dur/fin ——「起播事实」升级成「真实进度」，不再永远停在 0。
 *   只认 2 小时内的 stream 记录（更老的属于已收场的旧会话，不拿今天的位置去改写）。
 *   命中返回补过的记录（调用方可打日志），没匹配到返回 null（正常，多数上报本就没
 *   对应的直链会话）。
 */
function histBackfillStream(devId, rec) {
  try {
    const d = histLoad();
    const dev = d.devices && d.devices[devId];
    if (!dev || !Array.isArray(dev.list)) return null;
    let e = null;
    for (const x of dev.list) { if (x && x.stream) { e = x; break; } }  // list[0] 最新在前
    if (!e) return null;
    if (Date.now() - (Number(e.ts) || 0) > 2 * 3600 * 1000) return null;
    const nk = s => String(s || '').toLowerCase().replace(/\s+/g, '');
    const qk = nk(rec.q);
    if (rec.rid) {
      if (String(e.rid || '') !== String(rec.rid)) return null;
    } else {
      if (!qk || nk(e.q) !== qk) return null;
      if (Number(rec.ep) > 0 && Number(e.ep) !== Number(rec.ep)) return null;
    }
    e.pos = Math.max(0, Math.round((Number(rec.pos) || 0) * 10) / 10);
    if (Number(rec.dur) > 0) e.dur = Number(rec.dur);
    if (rec.fin) { e.done = true; e.fin = true; e.endTs = Date.now(); }
    e.devsync = true;      // 设备报的，永不被字节数改写（同 /ap/pos 口径）
    e.bf = 1;              // backfilled 标记（Web 可选展示「已补位置」）
    histTouch();
    return e;
  } catch { return null; }
}

/**
 * ★ v1.7.28：backfill 兜底 —— R1 的 /r/ 直链请求不带 MAC 头，stream 记录落在
 *   devIdOf(req)（ip-*）名下；而 /v1/pos 上报带 body.devId（MAC，1.3.342+）。
 *   两个身份不是一把钥匙，先按 body.devId 找，找不到再按来源 IP 找一次 ——
 *   请求与 /r/ 来自同一台设备（同一 IP），IP 口径匹配安全；q+ep/rid 精确对上才补，
 *   门槛不变。命中返回补过的记录，两次都没匹配返回 null。
 */
function histBackfillStreamAuto(devId, req, rec) {
  const hit = histBackfillStream(devId, rec);
  if (hit) return hit;
  let alt = '';
  try { alt = req ? devIdOf(req) : ''; } catch { alt = ''; }
  if (alt && alt !== devId) return histBackfillStream(alt, rec);
  return null;
}

/** 给 Web 的只读快照：设备按最近活跃排序，条目已裁到最近 20 条 */
/** ★ v1.7.18：按书名从集表缓存取全集数（abcache.search 相似度排序取第一）。
 *  R1 /v1/pos 记的播放记录不带 total（AlphaPi /ap 流自带），Web 显示「全 ? 集」；
 *  快照输出时补 —— 查不到返回 0（Web 维持 ?，不编数）。 */
function abTotalOf(q) {
  if (!q) return 0;
  try {
    const rec = abcache.search(String(q))[0];
    const t = rec ? (Number(rec.total) || (Array.isArray(rec.list) ? rec.list.length : 0)) : 0;
    return t > 0 ? Math.round(t) : 0;
  } catch { return 0; }
}

function histSnapshot() {
  const d = histLoad();
  const devices = Object.keys(d.devices).map(k => {
    const v = d.devices[k] || {};
    return {
      id: k,
      name: v.name || k,
      ip: v.ip || '',
      ua: v.ua || '',
      seen: v.seen || 0,
      // ★ v1.7.31：老记录没有 src 字段，读端按 kind 补一次（标签不为空）
      last: v.last ? withSrc(v.last) : null,
      list: (Array.isArray(v.list) ? v.list : []).slice(0, 20).map(e => {
        if (!e) return e;
        const w = withSrc(e);
        // ★ v1.7.18：书类条目缺 total 就从集表缓存补（R1 /v1/pos 条目）
        if (w.kind === 'book' && !w.total) {
          const t = abTotalOf(w.book || w.q);
          if (t > 0) return Object.assign({}, w, { total: t });
        }
        return w;
      }),
    };
  }).sort((a, b) => (b.seen || 0) - (a.seen || 0));
  return { ver: MS_VER, count: devices.length, devices, file: 'files/history.json' };
}

// ============================================================ v1.7.13 P1 书级共享进度
/*
 * 进度归属拍板（2026-11-15 用户定）：**书级共享** —— 同一本书全设备一份进度，
 * 任何一台设备 /ap/play?kind=book&q=…&ep=0 都从「最近有人在听的位置」接着听。
 *
 * 结构：history.json 新增 `books` 字段（devices 一个字没动，Web 播放记录照旧）：
 *   books[书名归一化] = { book, q, ep, pos, dur, fin, title, dev, at }
 * 写入时机（只认「设备自己报的权威位置」）：
 *   ① /ap/play 起播（ep / 起点落账，同时清掉上一轮的 fin）；
 *   ② /ap/pos 心跳（30s 一次）与结算（暂停 / 播完 / 打断）。
 *   histEnd 的字节数 / 墙钟兜底**不写** books —— 那是估算值，宁缺毋滥。
 * 读取：histResume = 本机记录 vs 书级共享，**谁新听谁**（at/ts 比较）；
 *   新设备没有本机记录时直接吃共享 —— 「换设备接着听」就在这里成立。
 */
/**
 * ★ v1.7.27 P1 收尾：共享表支持 kind —— book（默认，键不带前缀，兼容历史数据）/ song / radio
 *   （键带前缀，避免与同名书互踩）。读取端一律按 kind 过滤，书名匹配到歌单也不会串。
 */
function bookKeyOf(book, q, kind, grp) {
  const nk = String(book || q || '').toLowerCase().replace(/\s+/g, '');
  const k = String(kind || 'book');
  const base = (k === 'book') ? nk : k + '|' + nk;
  // ★ v1.7.38：带组维度 —— g:<grp>|<base>；grp 缺省返回旧键（设备列表匹配 / 清理用）
  return grp ? 'g:' + grp + '|' + base : base;
}

/** 把一条权威位置写进书级共享表（ep/pos 覆盖，at 刷新，其余字段留旧值兜底） */
function histBookSave(rec) {
  const d = histLoad();
  if (!d.books) d.books = {};
  const kind = String(rec.kind || 'book');
  // ★ v1.7.38：进度按设备分组隔离 —— 由写入设备推组；无设备（匿名写）落默认组，
  //   保持旧「全共享」语义，不至于凭空丢进度。
  const grp = String(rec.grp || (rec.dev ? devGroupId(rec.dev) : DG_DEFAULT));
  const key = bookKeyOf(rec.book, rec.q, kind, grp);
  if (!key) return null;
  const prev = d.books[key] || {};
  const epN = (parseInt(rec.ep, 10) > 0) ? parseInt(rec.ep, 10) : (prev.ep || 0);
  const cur = Object.assign({}, prev, {
    kind,                                  // ★ v1.7.27：记录种类（读端过滤用）
    grp,                                   // ★ v1.7.38：所属组（读端按组隔离）
    // ★ v1.7.31：来源五分类（src=英文码 / srcLabel=中文标签，随记录一起持久化）
    ...withSrc({}, (rec && rec.src) || prev.src || srcOf(rec)),
    book: rec.book || prev.book || rec.q || '',
    q: rec.q || prev.q || '',
    ep: epN,
    pos: Math.max(0, Math.round((Number(rec.pos) || 0) * 10) / 10),
    // ★ v1.7.29：dur 只属于本集 —— 换集后旧 dur 清零，防跨集继承把「听了 13:23」
    //   误判成「已听完」（pos ≥ 旧时长-3）。同集保持 prev.dur（设备不带 dur 的
    //   周期报不抹掉带 dur 报写下的值）。
    dur: Number(rec.dur) || (epN === (prev.ep || 0) ? (prev.dur || 0) : 0),
    fin: (rec.fin != null) ? !!rec.fin : !!prev.fin,
    title: rec.title || prev.title || '',
    dev: rec.dev || prev.dev || '',
    at: Date.now(),
  });
  if (Array.isArray(rec.tracks) && rec.tracks.length) cur.tracks = rec.tracks.slice(0, 8);
  d.books[key] = cur;
  histTouch();
  return cur;
}

/** ★ v1.7.16：/v1/pos 带显式 devId 的上报也落「设备维度」一条（R1 等新客户端进播放记录设备列表）。
 *  同一设备同一本书同一集：原地更新 pos/done/ts，不刷屏；换书/换集/播完才新增一行。 */
function histDevTouch(devId, devName, rec) {
  const d = histLoad();
  if (!d.devices) d.devices = {};
  const dev = d.devices[devId] || (d.devices[devId] = { list: [] });
  dev.name = devName || dev.name || devId;
  dev.ip = dev.ip || '';
  dev.seen = Date.now();
  const lt = (Array.isArray(dev.list) && dev.list[0]) || null;
  const e = withSrc(Object.assign({
    ts: Date.now(), kind: 'book', q: '', title: '', ep: 0, off: 0, pos: 0, done: false,
  }, rec || {}), (rec && rec.src) || (lt && lt.src));
  e.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  /* ★ v1.7.39：同一场收听的两路上报合并成一条（不再要求 ep 相等）。
     以前 `lt.ep === e.ep` 才合并，于是「同一场播放」被两路用不同集号写进来
     （R1 实测：device ProgProgress 报 ep=5、player 网页回写报 ep=1，8s/15s 交替）
     ⇒ 列表里同书留两条，两路轮流刷新 ⇒ 播放记录在两集之间来回跳。
     判据：3 分钟内 + 同书 + 「ep 相同，或位置没有大幅回退」。
       · 错标：ep5 pos=227 → ep1 pos=160 ⇒ 位置没回退（160+120 ≥ 227），是同一次
         播放被贴错集号 ⇒ 合并，ep 跟随最新一条；
       · 正常换集：上一集 pos=315 → 新集 pos=8 ⇒ 位置大幅回退（8+120 < 315），
         真的是新一集从头开始 ⇒ 照旧新建条目，记录流水不变。
     （先按 |Δpos| ≤ 45 判过，实测网页那路的秒数会和真值差 67s，故改成回退判据。） */
  const prevPos = Number(lt && lt.pos) || 0;
  const rewound = (Number(e.pos) || 0) + 120 < prevPos;     // 位置大幅回退 = 新一集从头
  /* 晚到的旧集结算（下面第 3 个分支）也并进当前条 —— 换集时「上一集听完」的结算
     常常比新一集的实时上报晚到，若按 rewound 新建，列表里就多一条 pos=0 的旧集假记录。 */
  const lateDone = !!e.done && (Number(e.ep) || 0) > 0 && (Number(e.ep) || 0) < (Number(lt && lt.ep) || 0);
  const sameRun = lt && (
    /* ★ v1.7.45：电台（广播）也并进当前条 —— 它没有集号，身份就是台名。
       以前只合并 book，而 device 每 30 秒上报一次广播位置 ⇒ 设备列表被同一个台
       刷成几十行、时间还一直跳。 */
    (lt.kind === 'radio' && e.kind === 'radio' && lt.q === e.q
      && (Date.now() - (Number(lt.ts) || 0) <= 1800000))
    || (lt.kind === 'book' && e.kind === 'book'
      && lt.q === e.q
      && (Date.now() - (Number(lt.ts) || 0) <= 180000)
      && (Number(lt.ep) === Number(e.ep) || !rewound || lateDone))
  );
  if (sameRun) {
    /* ★ v1.7.40：结算（done/fin）上报也并进当前这条，而不是另开一条 pos=0 的「假记录」。
       以前 `&& !e.done` 把结算挡在合并之外 ⇒ 每集换集结算都新建一条 {ep:旧集, pos:0, done},
       它顶到 list[0] 成为设备「当前在播」快照；随后新一集的上报又因为「已 done 不改写」只推 ts
       ⇒ 设备维度的时间永远停在那一集的 0（实测 R1：书级 ep=13/pos=172，设备记录死守 12 集 0）。
       现在的口径：
         · 结算且 ep 不比当前旧 ⇒ 标 done，pos 只升不降（结算常带 pos=0，不能抹掉实时位置）；
         · 未结算且未 done ⇒ 照常更新 ep/pos；
         · 已 done 但这一轮集号前进了 ⇒ 说明还在往下听，**复活**这条（done=false）;
         · 已 done 且只是同集的回写 ⇒ 只推 ts，不刷屏也不篡改播完快照（老行为保留）。 */
    const eps = Number(e.ep) || 0;
    const lts = Number(lt.ep) || 0;
    const epAhead = eps > 0 && eps > lts;
    if (e.done) {
      if (eps === 0 || eps >= lts) {          // 晚到的旧集结算（eps<lts）不把快照拉回旧集
        if (eps > 0) lt.ep = eps;
        if ((Number(e.pos) || 0) >= (Number(lt.pos) || 0)) lt.pos = Number(e.pos) || 0;
        lt.done = true;
      }
    } else if (!lt.done) {
      if (eps > 0) lt.ep = eps;
      lt.pos = e.pos;
    } else if (epAhead) {
      /* ★ v1.7.40：集号前进了 = 明确还在往下播（结算后新一集的实时上报）。
         只认集号前进，不认「位置更大」—— 同集两路秒数抖动实测能差 67s，
         拿位置当证据会把刚播完的快照误复活。 */
      lt.done = false;
      lt.ep = eps;
      lt.pos = e.pos;
    }
    if (e.title && !e.done) lt.title = e.title;
    if (e.dur) lt.dur = e.dur;
    lt.ts = e.ts;
    dev.last = lt;
    histTouch();
    return lt;
  }
  dev.list = Array.isArray(dev.list) ? dev.list : [];
  dev.list.unshift(e);
  if (dev.list.length > HIST_MAX) dev.list.length = HIST_MAX;
  dev.last = e;
  histTouch();
  return e;
}

/** 书级共享续播点：扫 books 全表（书名/口播词双向部分匹配，同本机口径），取最近上报的一条。
 *  ★ v1.7.27：wantKind 过滤（'book' 默认 / 'song' / 'radio'）——书名匹配到歌单不串台。
 *    song 命中返回 {kind:'song', idx（0 基第几首）, title, tracks}，无集语义。 */
function histResumeShared(q, wantKind, grp) {
  const wk = String(wantKind || 'book');
  const wantGrp = grp ? String(grp) : '';
  const d = histLoad();
  const key = String(q || '').toLowerCase().replace(/\s+/g, '');
  if (!key || !d.books) return null;
  let best = null;
  for (const k of Object.keys(d.books)) {
    const b = d.books[k] || {};
    if (String(b.kind || 'book') !== wk) continue;   // ★ v1.7.27：老记录无 kind 视作 book
    // ★ v1.7.38：按组隔离 —— 给了组就只认本组（老记录无 grp 视作默认组）；
    //   没给组（匿名读，识别不出设备）⇒ 不筛，保持旧的全共享行为。
    if (wantGrp && String(b.grp || DG_DEFAULT) !== wantGrp) continue;
    const bk = String(b.book || '').toLowerCase().replace(/\s+/g, '');
    const bq = String(b.q || '').toLowerCase().replace(/\s+/g, '');
    const hit = (bk && (bk.indexOf(key) >= 0 || key.indexOf(bk) >= 0))
      || (bq && (bq.indexOf(key) >= 0 || key.indexOf(bq) >= 0));
    if (!hit) continue;
    if (!best || (b.at || 0) > (best.at || 0)) best = b;
  }
  if (!best) return null;
  if (wk === 'song') {
    return {
      kind: 'song', book: best.book || best.q || key, q: best.q || key,
      idx: Math.max(0, (parseInt(best.ep, 10) || 1) - 1),
      title: best.title || '', tracks: best.tracks || [],
      pos: Number(best.pos) || 0, ts: best.at || 0, shared: true, dev: best.dev || '',
    };
  }
  const dur = Number(best.dur) || 0;
  const out = {
    kind: wk, book: best.book || best.q || key, q: best.q || key,
    ep: best.ep || 1, pos: Number(best.pos) || 0, dur,
    ts: best.at || 0, shared: true, dev: best.dev || '',
  };
  // 与本机续播同口径：上一集真听完（fin / pos 贴集尾 3 秒内）⇒ 从下一集开头继续
  if (best.fin || (dur > 0 && out.pos >= dur - 3)) {
    return Object.assign(out, { ep: (best.ep || 1) + 1, pos: 0, off: 0, nextEp: true });
  }
  return out;
}

/** ★ v1.7.13：续播总入口 = 本机记录 vs 书级共享，谁新听谁（老设备无本机记录直接吃共享）
 *  ★ v1.7.27：wantKind 透传（'book' 默认 / 'song'）。 */
/** ★ v1.7.48：合集名 → 子书名清单（「三体」⇒ 地球往事Ⅰ/黑暗森林Ⅱ/死神永生Ⅲ）。
 *  书身份改成子书名后，用户说合集名查续播必然落空 —— 这一层把合集展开成
 *  各部去查，取最近听的那一条。不是本地库的书/普通书返回空数组。 */
function ablSubNames(q) {
  const t = String(q || '').trim();
  if (!t) return [];
  try {
    const r = ablocal.books(t);
    const out = [];
    for (const b of (r.books || [])) {
      if (b.kind !== 'coll' || String(b.name || '') !== t) continue;
      for (const s of (b.subs || [])) {
        if (s && s.name && s.name !== b.name) out.push(String(s.name));
      }
    }
    return out;
  } catch { return []; }
}

function histResume(req, q, wantKind) {
  const own = histResumeOwn(req, q, wantKind);
  // ★ v1.7.38：共享进度按请求设备所在组取；识别不出设备 ⇒ null（全组取最新，兼容旧行为）
  const sh = histResumeShared(q, wantKind, reqGroupId(req));
  if (own && sh) {
    // 严格大于：时间戳打平时优先本机（本机记录至少不含别的设备的回退风险）
    return ((sh.ts || 0) > (own.ts || 0)) ? sh : own;
  }
  if (own || sh) return own || sh;
  /* ★ v1.7.48：合集名兜底 —— 书身份是子书名（「黑暗森林Ⅱ」），用户嘴里说的却是
     合集名（「三体」）⇒ 直接查必然空。展开合集的每一部各查一次，取最新的一条
     （返回值带 book，apBookItems 据此定位到是哪一部，ep 不会串到别的部上）。 */
  if (String(wantKind || 'book') !== 'book') return null;
  let best = null;
  for (const alias of ablSubNames(q)) {
    const o2 = histResumeOwn(req, alias, wantKind);
    const s2 = histResumeShared(alias, wantKind, reqGroupId(req));
    const cand = (o2 && s2) ? (((s2.ts || 0) > (o2.ts || 0)) ? s2 : o2) : (o2 || s2);
    if (cand && (!best || (cand.ts || 0) > (best.ts || 0))) best = cand;
  }
  return best;
}

/** ★ v1.7.41：组 id → 可读标签，给书级进度 / 播放记录展示用。
 *   'default' → 默认组；'solo:<devId>' → 独立（带上设备名，多条独立记录才分得清）；具名组 → 组名。 */
function dgGrpName(grp, hist) {
  const gid = String(grp || DG_DEFAULT);
  if (gid === DG_DEFAULT) return '默认组';
  if (gid.indexOf('solo:') === 0) {
    const id = gid.slice(5);
    const dv = ((hist || histLoad()).devices || {})[id];
    const nm = String((dv && dv.name) || '').trim();
    return '独立' + (nm && nm !== id ? ' · ' + nm : '');
  }
  const g = dgLoad().groups || {};
  return (g[gid] && g[gid].name) || gid;
}

/** 给 Web / GET /v1/history 的书级进度快照（按最近上报倒序）
 *  ★ v1.7.27：只出 book —— song/radio 条目有设备列表呈现，集语义在这里会显示错乱。
 *  ★ v1.7.41：带 grpName（默认组 / 独立 · R1-CD6B / 组名），同书分属不同组时前端能区分。 */
function histBooksSnapshot(grp) {
  const wantGrp = grp ? String(grp) : '';
  const d = histLoad();
  return Object.keys(d.books || {}).map(k => {
    const b = withSrc(d.books[k] || {});
    const gid = String(b.grp || DG_DEFAULT);
    return {
      key: k, kind: String(b.kind || 'book'), src: b.src || '', srcLabel: b.srcLabel || '',
      grp: gid,                            // ★ v1.7.38：所属组
      grpName: dgGrpName(gid, d),          // ★ v1.7.41：可读组名
      book: b.book || b.q || k, q: b.q || '',
      ep: b.ep || 0, pos: b.pos || 0, dur: b.dur || 0, fin: !!b.fin,
      title: b.title || '', dev: b.dev || '', at: b.at || 0,
      total: abTotalOf(b.book || b.q || k),   // ★ v1.7.18：书级续播区也带全集数
    };
  }).filter(x => x.kind === 'book' && (!wantGrp || x.grp === wantGrp))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}


/**
 * 电台的原始直播流地址 → 本机代理地址。
 *
 * ★ 只用在**消费侧**（/index.json 给 R1、/api/lib 给 Web）。
 * ★★ 绝对不能用在 /api/radios —— 那是 Web 电台编辑页读写用的：
 *     GET 若吐代理地址，用户点「保存」就会把 /radio/xxx 写回 radios.json，
 *     下回请求再包一层，几轮下来 URL 变成俄罗斯套娃。
 *     （radioproxy.serve 里还有一层「拒绝代理本站」的兜底，双保险。）
 */
const radioUrl = (self, u) => self + '/radio/' + radioproxy.encTarget(u);

/**
 * ★★ 电台走不走本机代理（`RADIO_PROXY=1` 才走，**默认不走**）。
 *
 *   2026-10-18：旧组合（小飞 player + 自带电台）直连源站不卡，我们走代理卡 6+3
 *     ⇒ 判定「这跳代理是多余的」，默认关掉，改直连。
 *   2026-10-19 00:17 补充（重要，别误读成「代理背锅」）：关掉代理后**直连也照样卡** ——
 *     设备 socket 确认连的是公网 123.60.16.94:80（本机 8100 完全不在链路上），
 *     75 秒里 play_time 走 30 秒、墙钟走 34 秒 ⇒ 顿了约 4 秒，logcat 有
 *     `buffer low` ×1、`buffering` ×11。
 *     ⇒ 直播流供给 8.2KB/s ≈ 播放消耗 8.0KB/s 的**零余量**是根本，
 *       代理 / 直连都只是「起播那一下给了多少」的差别，两都不治本。
 *
 *   ★★ 用户 00:25 拍板：**问题在设备端，不要再往服务端（docker）加东西**，
 *      预攒 / 常热这类「服务器替设备缓冲」的方案一律不做。
 *      ⇒ 保持默认直连（链路最干净，排障时变量最少）。真要对比代理就 `RADIO_PROXY=1`。
 */
const RADIO_PROXY = String(process.env.RADIO_PROXY || '0') === '1';

// ---------------------------------------------------------------- 取链节流闸
/**
 * ★★ 取链节流闸 —— 凡是**真打上游**的取链请求，都必须从这道闸过。
 *
 * 为什么需要它：惰性地址（/r/、/s/）已经把「推 100 首」变成 0 次取链，
 * 但取链这件事本身还是要发生 —— 只是挪到了「起播那一刻」。这道闸是最后一道保险：
 *   万一还有谁（旧版 device 的批量取链、Web 上手滑连点、播放器预取）
 *   一次丢十几个过来，也会被压成「同时最多 2 个、彼此隔 250ms」的细流，
 *   而不是一股脑并发砸向落雪 docker。
 *
 * 为什么是防封禁而不只是防变慢：lxserver 背后是别人的订阅源 / 音源接口，
 * 短时间一波密集请求 = 限流甚至封 IP；一旦被封，连正常的起播取链都会全部哑火，
 * 那时就不是「慢一点」而是「整台音箱播不了在线歌」。
 *
 * 只闸「取链」这一步，不转发流（pipeAudio 是长任务，不该占槽）。
 * 缓存命中根本不到闸（cached 先命中就直接返回）。
 */
const GATE_MAX = 2;     // 同时最多 2 个取链上路
const GATE_GAP = 250;   // 相邻两个取链开始之间至少 250ms
const GATE_CAP = 40;    // 排队上限：超过就直接放弃（宁可让它失败，也不能堆成雪崩）
let gateIn = 0;
let gateLast = 0;
const gateWait = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gateRun(fn) {
  if (gateIn >= GATE_MAX) {
    if (gateWait.length >= GATE_CAP) {
      throw new Error('取链排队已满（' + GATE_CAP + '），这次先不取 —— 稍后再试');
    }
    await new Promise(res => gateWait.push(res));
  }
  gateIn++;
  try {
    const w = gateLast + GATE_GAP - Date.now();
    if (w > 0) await sleep(w);
    gateLast = Date.now();
    return await fn();
  } finally {
    gateIn--;
    const nx = gateWait.shift();
    if (nx) nx();
  }
}

/**
 * 取播放直链 —— /api/url 与 /s/<i>、/r/<source>/<rid> 共用。
 *
 * ★★ v1.3.179（用户拍板）：**只保留落雪 docker（lxserver）这一条取链路**。
 *
 * <p>以前是六级串联：⓪中继 → ①音源脚本 → ②网易同源 → ③酷狗跨源 → ④网易跨源
 * → ⑤酷我 antiserver，**每级各有 12s 超时**，上游一抽风，一首歌能卡几十秒
 * （R1 那边 5s 预算一到就交白卷，就是这么来的）。而 lxserver 自己跑的是
 * desktop 原版 musicSdk + 订阅源，覆盖面比我们手搓的五级还广 ——
 * 留着它们只会把「取链失败」变成「取链很慢但偶尔成功」，更难排查。</p>
 *
 * <p>⇒ 没配 lxserver 就**明确报没配**，不再悄悄降级拿试听片段糊弄过去。</p>
 */
/**
 * 歌词两级通道（2026-10-18）。
 *
 * ⊙ 历史 bug：`/api/lyric` 只调 `S.lyric(rid)` —— 那是**酷我直连**
 *   （sdk/kw.js 的 m.kuwo.cn 接口），于是
 *     · wy / kg / mg 的 rid 喂给酷我 ⇒ 必然 0 行（rid 是别家的 ID）；
 *     · 部分 kw rid 酷我接口本身就没词（实测「稻香」kw:440613：酷我 0 行、
 *       落雪 1122 字节）。
 *   用户在落雪上明明搜得到词，我们这儿就是 0 行 —— 根因在这。
 *
 * 现在：kw 先走酷我直连（快、不依赖 lxserver）⇒ 没词再用落雪多源兜底；
 *       非 kw 源直接走落雪（rid 是别家的 ID，问酷我毫无意义）。
 */
async function lyricOf(rid, src) {
  const empty = { lines: [], lrc: '' };
  try {
    if (src === 'kw' || !src) {
      const r = await S.lyric(rid).catch(() => null);
      if (r && r.lines && r.lines.length) {
        return { lines: r.lines, lrc: r.lrc || '', via: 'kw' };
      }
    }
  } catch { /* 酷我挂了就走兜底 */ }
  try {
    const x = await lxrelay.relayLyric({ source: src || 'kw', rid });
    if (x && x.lines && x.lines.length) {
      return { lines: x.lines, lrc: x.lrc || '', via: 'lx' };
    }
  } catch { /* 落雪也没词 */ }
  return empty;
}

async function resolveUrl(opt) {
  const o = opt || {};
  const rid = o.rid || '';
  // 调用方没点名 ⇒ 用页面里设的默认音质（出厂 128k）
  const defq = defQuality();
  const q = o.q || defq;
  const want = o.source || '';
  // 中继用调用方原始 source：缺则按 kw 兜（lxserver 那边 kw 订阅源最全）
  const rsrc = want || 'kw';
  const title = o.title || '';
  const artist = o.artist || '';
  const steps = [];

  /**
   * ★ 落雪要的「这首歌的完整档案」（含 _types）。
   *   三级找：① 调用方直接给（跨源兜底拿到的那条）② 搜索时暂存的 ③ 池里落盘的 types。
   *   都没有 ⇒ 退回裸 songmid（kw/wy/tx 照旧能播，mg 会 500）。
   */
  const ptInfo = (() => {
    const t = pool.byRid(rsrc, rid);
    if (t && t.types) {
      return { _types: t.types, source: rsrc, songmid: rid, name: title, singer: artist };
    }
    return null;
  })();
  const info = o.info || siGet(rsrc, rid) || ptInfo || null;

  let url = '', via = '';

  /**
   * ★★ 音质降级链（2026-10-17 实测落雪 docker）：
   *   320k 命中的是「幻音音源」，它给的是中转地址 music-dl.sayqz.com/api/...
   *   —— 拿得到链但**出不去**（fetch failed）；而 128k 命中的「野花🌷」给的是
   *   酷我真链 car-lv.kuwo.cn/...mp3，200 + audio/mpeg 直接可播。
   *   ⇒ 一档要不到可播直链就往下退，别把整次取链判死。
   */
  // 这首歌上次哪一档通的（内存级）：记住它，下次直接从这档开始，
  // 免得每首起播都先把 320k/192k 那两档白试一遍（各 0.6~2.3s）。
  const bk = rsrc + ':' + rid;
  const best = BEST_Q.get(bk);
  const QCHAIN = qualityChain(o.q, defq, best);

  const lxb = lxrelay.base();
  if (!lxb) {
    steps.push({ step: '落雪docker', skipped: '未配置地址（去 Web 音源页填）' });
  } else {
    if (o.fresh) lxOk();

    /**
     * 走一遍落雪 docker 的音质降级链。
     * @param {string[]} chain 本次要试的档位
     * @param {string} tag     debug 里区分「主链」还是「越狱重试」
     * @returns {Promise<boolean>} 拿到可播直链返回 true
     */
    const runLx = async (chain, tag) => {
      if (lxDead()) {
        steps.push({ step: '落雪docker', tag, skipped: '负缓存中（偶发失败不封，连续失败才封 60s）' });
        return { ok: false, blocked: true, unsupported: false };
      }
      let relayHardFail = false;
      let lastHardErr = '';
      let unsupported = false;
      for (let qi = 0; qi < chain.length; qi++) {
        const qq = chain[qi];
        const isLast = qi === chain.length - 1;
        if (qDead(rsrc, qq, isLast)) {
          steps.push({ step: '落雪docker', tag, quality: qq, skipped: '该音质最近给的链都连不上（负缓存）' });
          continue;
        }
        // 过闸：缓存 miss 才真的上路，且同时最多 GATE_MAX 个、彼此隔 GATE_GAP
        const r = await cached('lx:' + rsrc + ':' + rid + ':' + qq,
          () => gateRun(() => lxrelay.relayUrl({ source: rsrc, rid, title, artist, quality: qq, info })),
          1800000, v => !v || v.skip || !v.url);
        if (!(r && r.url)) {
          const err = String((r && r.err) || '中继无响应');
          /* ★★ 源不支持 ≠ 落雪坏了（2026-10-17 三修，这条是「整台播不了」的放大器）
             落雪对不支持的平台会明确回 HTTP 500：「已尝试了 N 个支持 mg 平台的源，
             但全部解析失败（咪咕找不到）」。它明明在好好应答，只是这个平台没资源。
             以前这类失败照样记进落雪的**连败计数** ⇒ 点两首 mg/kg，落雪就被封 60s，
             连一向能播的 kw 也跟着全哑（用户报「在线歌播不了」多半是这个）。
             ⇒ ① 不记连败；② 同 source 其他档位也一样 ⇒ 直接放弃本轮，交给跨源兜底。 */
          const bizFail = /5\d\d/.test(err)
            && /平台的源|解析失败|找不到|unknow error|not support/i.test(err);
          steps.push({ step: '落雪docker', tag, quality: qq, err: err.slice(0, 130) });
          if (bizFail) { unsupported = true; break; }
          relayHardFail = true;
          lastHardErr = err;
          continue;
        }
        const h = hostOf(r.url);
        // ★ 最后一档不走域名负缓存：无论如何真测一次。
        //   否则域名一旦记坏，10 分钟内连好链也会被跳过（实测 rid 无效时落雪
        //   会把 128k 也指到同一个中转域名，就是这个坑）。
        if (!isLast && hostDead(h)) {
          steps.push({
            step: '落雪docker', tag, quality: qq, raw: String(r.url).slice(0, 110),
            skipped: '域名 ' + h + ' 10 分钟内连不上（负缓存，直接换档）',
          });
          continue;
        }
        const pr = await probeUrl(r.url);
        if (!pr.ok && pr.status === 0) {
          BAD_HOST.set(h, Date.now());
          qFail(rsrc, qq);
        }
        steps.push({
          step: '落雪docker', tag, quality: qq, raw: String(r.url).slice(0, 110),
          status: pr.status, ct: pr.ct, size: pr.size, err: pr.err, ms: r.ms,
        });
        if (pr.ok) {
          // 302 解析：音源给的是「API 地址」，靠 302 跳到真 CDN。
          // 浏览器/ExoPlayer 会跟，R1 的播放器不一定跟 ⇒ 服务端先解析好。
          url = (pr.finalUrl && pr.finalUrl !== r.url) ? pr.finalUrl : r.url;
          via = 'lxserver(订阅源) ' + qq;
          BEST_Q.set(bk, qq);
          qOk(rsrc, qq);               // 成功即清零，别让偶发失败越积越多
          if (h) BAD_HOST.delete(h);   // 这一档实测通了 ⇒ 域名的坏印象撤销（自愈）
          lxOk();                      // ★ 落雪活着 ⇒ 任何封禁记录一并抹掉
          lxMarkOk();                  // ★ 1.1.0：真实成功打点（Web 绿灯只认这个）
          return { ok: true, blocked: false, unsupported: false };
        }
      }
      if (relayHardFail) { lxFail(); lxMarkBad(lastHardErr || '落雪硬失败'); }
      return { ok: false, blocked: false, unsupported };
    };

    const main = await runLx(QCHAIN, '主链');
    let got = main.ok;

    /**
     * ★★ 越狱重试（修「在线歌整台不出声」的另一半）。
     * 主链一轮走完还是没链，八成不是「这首歌没源」，而是被负缓存 / 一次抖动挡住了
     * —— 落雪是唯一还在出链的通道，被挡住 = 整台在线全哑，且除了重启容器没别的出路。
     * ⇒ 这里强制清账，用「这首上次通的档 + 128k」再试一遍。
     *   只有失败路径才走到这（本来就要等十几秒），多花几秒换一首能响的歌划算。
     */
    // ★ 被负缓存挡住时这轮根本没花时间 ⇒ 允许更频繁地再试（常见场景：落雪其实活着，
    //   只是刚才抖了一下；救回来立刻满血，用户只觉得「慢半拍」而不是「整台哑」）。
    const gap = main.blocked ? RESCUE_GAP_BLOCKED : RESCUE_GAP;
    // ★ 源不支持（落雪明确说这个平台没资源）⇒ 再试一遍也是同样的 500，别白等一轮，
    //   直接交给下面的跨源兜底（换 kw 的同名歌）。
    if (!got && !main.unsupported && Date.now() - lxRescueAt.t >= gap) {
      lxRescueAt.t = Date.now();
      const prevN = lxFailAt.n;       // 越狱前已经连败几次
      const rescue = [];
      if (best) rescue.push(best);
      if (!rescue.includes(defq)) rescue.push(defq);
      // ★ 128k 永远留一个位：绝大多数源都有它，是「最后一档也拿不到」时的保底档
      if (!rescue.includes('128k')) rescue.push('128k');
      steps.push({ step: '落雪docker', tag: '越狱重试', note: '清账后按「记忆档 + 默认档 + 128k」再试一次' });
      lxOk();
      // ★ 取 .ok —— runLx 返回的是 {ok, blocked}，直接赋值会拿到一个恒为真的对象
      got = (await runLx(rescue, '越狱重试')).ok;
      if (got) {
        lxRescueAt.t = 0;             // 救活了 ⇒ 下次失败还能再救
      } else {
        // 救不回来 ⇒ 把账补回去（+1）。不清零的话越狱每回都把连击冲回 1，
        // 封禁永远攒不起来 ⇒ 超时场景下每首歌都要白等一整轮。
        lxFailAt.t = Date.now();
        lxFailAt.n = prevN + 1;
      }
    }
  }


  /**
   * ★★ 跨源兜底（2026-10-17 三修：修「搜得到却播不了」）
   *
   * 起因（实测）：搜索走我们自己的脚本音源 —— 它能搜出 mg / kg 的歌；取链却走落雪
   * docker 的订阅源，而它对 mg 直接报「咪咕找不到」、kg 缺 hash 报 unknow error
   * （直连落雪打同样的 rid 也是 HTTP 500，说明不是我们中转的锅）。
   * ⇒ 结果就是「列表里有这首歌，点了不出声」。
   *
   * 修法：整条链都没拿到 ⇒ 拿「歌名 + 歌手」去 **kw**（实测 24/24 可播）重搜一条顶上。
   * 同一首歌换个平台的版本，至少让它响 —— 比给用户一个点不动的条目强。
   * 只在失败路径才走（本来就要等十几秒），多花一两次搜索（约 1s）很划算。
   */
  /* 源记账只记「落雪这一趟」的结果 —— 跨源顶替成功**不算**原源的功劳，
     否则 mg/kg 因为总能被 kw 顶上就永远不会被标成弱源，用户还会一直点到它们。 */
  noteSrc(rsrc, !!url);

  if (!url && !o._xf && (title || artist)) {
    const kwKey = (title + ' ' + artist).trim();
    try {
      /**
       * ★ 跨源也优先用落雪搜（同源 ⇒ 拿到的 rid 它自己一定认，还带 _types）；
       *   落雪没配 / 没结果才回落到脚本音源（那还是会有 mg/kg 认不出的老问题）。
       */
      let rs = [];
      const lxr = await cached('xl:' + kwKey,
        () => lxrelay.search({ source: 'kw', name: kwKey, limit: 6 }), 600000,
        v => !v || !v.list || !v.list.length);
      if (lxr && lxr.list && lxr.list.length) {
        rs = lxr.list.map(x => ({
          rid: String(x.songmid || ''),
          title: String(x.name || ''),
          artist: String(x.singer || ''),
          source: x.source || 'kw',
          _raw: x,                     // ★ 整条留给 resolveUrl 当 info
        }));
      } else {
        rs = await cached('xk:' + kwKey, () => S.search('kw', kwKey, 6, 1), 600000,
          v => !v || !v.length);
      }
      const hit = pickBest(rs, title, artist);
      if (hit && String(hit.rid || '') && !(hit.source === rsrc && String(hit.rid) === String(rid))) {
        steps.push({
          step: '跨源兜底',
          note: (rsrc || '?') + ' 取不到链 ⇒ 改搜 kw 的同名歌「' + (hit.title || '?') + '」',
        });
        const r2 = await resolveUrl({
          rid: String(hit.rid), source: hit.source || 'kw', q, title, artist, _xf: true,
          info: hit._raw || null,
        });
        if (r2 && r2.url) {
          url = r2.url;
          via = (r2.viaSource || 'kw') + ' · 跨源顶替';
          steps.push({ step: '跨源兜底', ok: true, raw: String(r2.url).slice(0, 110) });
        }
      }
    } catch (e) {
      steps.push({ step: '跨源兜底', err: String((e && e.message) || e).slice(0, 120) });
    }
  }
  const out = {
    code: url ? 200 : 500,
    url: url || '',
    message: url ? '' : (lxb ? lxFailReason(steps)
      : '还没配置落雪 docker 地址 —— 去 Web 音源页填一个，如 http://192.168.2.189:9527'),
    viaSource: via, trial: false, alt: false, song: null,
  };
  // ?debug=1：把落雪 docker 那一步的原始结果吐出来（排查「为什么取不到链」用）
  if (o.debug) {
    out.debug = {
      src: rsrc, rid, quality: q, want: o.q || '', def: defq, chain: QCHAIN, title, artist,
      lx: lxb || '未配置',
      lxDead: !!lxb && lxBlocked(),
      lxFailN: lxFailAt.n,
      steps,
    };
  }
  return out;
}

/** 落雪 docker 的搜索源顺序（与脚本源一致，weak 的后排由调用方再做） */
const LX_SRCS = ['kw', 'wy', 'tx', 'kg', 'mg'];

/**
 * ★ 有声书/节目识别（2026-10-31）。
 *
 * 为什么需要：酷我搜索接口对「歌曲」和「有声书章节」返回的字段完全一致，
 * 没有任何官方 type 标记（~50 个字段逐一对比过）。但走落雪 musicSdk 这条链
 * 有两个可靠信号：
 *   ① albumName 几乎必带「声音剧/广播剧/有声/评书…」等词（普通歌专辑极少带）；
 *   ② 章节标题是「《书名》第N集 xxx」形态。
 * 据此推断 kind='program'（节目）| ''（普通音乐），顺带把集数 ep 抽出来——
 * 语音「播放第N集」选集时下游直接用，不用再解析一遍。
 */
const PROG_ALBUM_RE = /声音剧|广播剧|有声书|有声小说|有声剧|听书|评书|评弹|相声|单播|单田芳|袁阔成/;
const PROG_TITLE_RE = /第\s*\d+\s*[集回话章]|第[一二三四五六七八九十百]+\s*[集回话章]/;
const PROG_ARTIST_RE = /单田芳|袁阔成|田连元|刘兰芳|张震讲|青雪|紫襟|头陀渊|郭德纲|于谦|岳云鹏|德云社|相声|评书|听书|有声|广播剧|声音剧/;

function detectKind(title, album, artist) {
  if (PROG_ALBUM_RE.test(album || '')) return 'program';
  if (PROG_ARTIST_RE.test(artist || '')) return 'program';
  // 标题本身带类型词（郭德纲相声精选 这类）也算
  if (PROG_ALBUM_RE.test(title || '')) return 'program';
  // 标题带《…》第N集 形态才算（裸「第N集」对 MV/Live 误判率低但仍有，加书名号门槛）
  if (/《.+?》/.test(title || '') && PROG_TITLE_RE.test(title || '')) return 'program';
  return '';
}

function detectEp(title) {
  const m = /第\s*(\d+)\s*[集回话章]/.exec(title || '');
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * ★ 落雪多源搜索（`/api/search` 的主路径，2026-10-18）。
 *
 * 为什么改走它：搜索和取链**同源** —— 列表里的 rid 是落雪自己发的，它取链一定认得。
 * 以前搜索走脚本音源、取链走落雪，两边对不上：mg 一律 500「咪咕找不到」、
 * kg 缺 hash 报 unknow error ⇒ 「搜得到却播不了」。
 *
 * 顺带两个便宜：① 每条结果都带 `_types`（这首有哪些音质档）⇒ 起播前就知道
 * 该问哪一档，不用白试；② 快 —— 单源 220~440ms，并发 8 次无一失败。
 *
 * @param {string} q         关键词
 * @param {number} n         每个源取几条（与脚本源口径一致：n 条/源）
 * @param {string} srcParam  'all' 或逗号分隔的源列表
 * @returns {Promise<object[]>} 统一字段的列表（rid/source/title/artist/album/duration/img/types）
 */
async function lxSearchAll(q, n, srcParam, page) {
  if (!lxrelay.base()) return [];
  const srcs = srcParam === 'all'
    ? LX_SRCS
    : String(srcParam || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!srcs.length) return [];
  // ★ n='all' = ab（有声书）整本枚举专用：不设条数上限，lxserver 一次吐全量。
  //   但全量受上游相关度截断且对重复查询吐缓存（2101→2000→200），
  //   整本枚举现改用 abPageSweep 翻页（确定性），'all' 只作首搜。
  const wantAll = (n === 'all');
  const lim = wantAll ? 'all' : Math.min(Math.max(parseInt(n, 10) || 20, 1), 100);
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  // ★ 并发 5 + 错峰 30ms：五个请求别同一毫秒糊到落雪脸上（跟池子那边一个道理）
  const rs = await pool.mapLimit(
    srcs.map(s => () => lxrelay.search({ source: s, name: q, limit: lim, page: pg })),
    Math.min(srcs.length, 5), 30);
  const out = [];
  for (let i = 0; i < srcs.length; i++) {
    const r = rs[i];
    if (!r || !r.list) continue;
    for (const it of r.list) {
      const rid = String(it.songmid || '');
      if (!rid) continue;
      siPut(srcs[i], rid, it);        // ★ 整条存档（含 _types），起播那一刻取链要用
      out.push({
        rid,
        source: srcs[i],
        title: String(it.name || ''),
        artist: String(it.singer || ''),
        album: String(it.albumName || ''),
        // ★ 落雪 musicSdk 给的 albumId 是「书/专辑」级（道诡异仙全部剧集同 id），
        //   留着它：语音选集时按 albumId 聚簇就能枚举整本书（分页翻搜索结果即可）。
        albumId: String(it.albumId || ''),
        duration: String(it.interval || ''),
        img: String(it.img || ''),
        via: 'lx',
        types: it._types || null,
        // ★ kind='program'（有声书/节目）| ''（普通音乐）；ep=集数（非节目为 0）
        kind: detectKind(String(it.name || ''), String(it.albumName || ''), String(it.singer || '')),
        ep: detectEp(String(it.name || '')),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 有声书（/api/ab/*）专用（2026-10-31）

/**
 * 把 kind=program 的扁平搜索结果按 source|albumId 聚成「本」。
 * 书名 = 专辑名第一段（|·分隔）；播音者 = singer；集数按 ep 升序（凑不出集号的垫底）。
 * R1 固件的 ab_* MCP 工具（v1.3.262）直接吃这里的输出 —— NAS 侧只读，
 * 起播与进度全在 R1 本地做（播放推动方式）。
 */
function abGroupBooks(list) {
  const groups = new Map();
  for (const it of list || []) {
    const key = (it.source || 'kw') + '|' + (it.albumId || it.album || it.title || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const out = [];
  for (const [key, items] of groups) {
    if (!abQualify(items)) continue;   // ★ 组级再判：关键词或集号聚簇（凡人修仙传型兜底）
    const t0 = items[0] || {};
    const alb = String(t0.album || '');
    const seg = alb ? alb.split(/[|｜·]/)[0].trim() : '';
    const m = /《(.+?)》/.exec(String(t0.title || ''));
    const book = seg || (m && m[1]) || String(t0.title || '(未命名)');
    const rest = alb ? alb.split(/[|｜·]/).slice(1).join('·').trim() : '';
    const eps = items.map(x => ({ ep: x.ep || 0, title: x.title, rid: x.rid, duration: x.duration }));
    eps.sort((a, b) => {
      const ea = a.ep > 0, eb = b.ep > 0;
      if (ea !== eb) return ea ? -1 : 1;
      if (a.ep !== b.ep) return a.ep - b.ep;
      return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN', { numeric: true });
    });
    out.push({
      key, book,
      narrator: String(t0.artist || ''),
      albumId: String(t0.albumId || ''),
      source: t0.source || 'kw',
      count: items.length,
      albumRest: rest,
      episodes: eps,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/** 从查询里抽取点名的主播（如「光合积木」「关彦之」）：返回在 books 里出现过的、
 *  最长的那个 narrator；查不到返回 null。用于「同名书不同主播」时挑对人。 */
function abNarratorHint(q, books) {
  const s = String(q || '');
  if (!s) return null;
  let best = null;
  for (const b of (books || [])) {
    const n = b.narrator || '';
    if (n && s.indexOf(n) >= 0) {
      if (!best || n.length > best.length) best = n;
    }
  }
  return best;
}

/** kind=program 专项搜索（只走落雪同源 —— 搜到的 rid 取链它一定认）。
 *  ★ 2026-10-31 晚：**不再先按 kind 过滤** —— 凡人修仙传（光合积木演播）这类书，
 *    书名+主播混在专辑名里、标题只有「第N集 集名」，detectKind 认不出 ⇒ 之前
 *    直接被滤光、ab_search 什么都搜不到。现在把整批结果原样交给 abGroupBooks，
 *    由 abQualify 在**组级**再判（同 albumId 聚簇 + 集号占比）。 */
async function abSearchRaw(q, src, n) {
  // ★ 书名裸搜经常只露出 1 条节目（凡人修仙传 ⇒ 全是动画 OST）——
  //   带上类型词再搜就整本整本地出来了（「凡人修仙传 单播」⇒ 15 集）。
  //   q 本身带类型词就不补，省两趟；补搜并行跑。
  const TYPE_WORDS = /有声|单播|听书|评书|评弹|相声|广播剧|声音剧/;
  // ★ 第一趟走**全量**（n='all'，不带 limit → lxserver 一次吐整本）：
  //   凡人修仙传这种 2000+ 集的书，钳 100 根本枚举不完。补词趟仍钳 100（并行，不拖时长）。
  const tries = TYPE_WORDS.test(q) ? ['all:' + q] : ['all:' + q, q + ' 有声', q + ' 单播'];
  const merged = [];
  const seen = new Set();
  const push = (x) => {
    const k = (x.source || '') + '|' + (x.rid || '');
    if (seen.has(k)) return;
    seen.add(k);
    merged.push(x);
  };
  const rs = await Promise.all(tries.map(t => {
    if (t.startsWith('all:')) return lxSearchAll(t.slice(4), 'all', src).catch(() => []);
    return lxSearchAll(t, n, src).catch(() => []);
  }));
  for (const lx of rs) {
    for (const x of lx || []) push(x);
  }
  return merged;
}

/**
 * ★ v1.7.0 缺集救援搜索：用「书名 第N集」精确词回源搜这一集（落雪同款搜法）。
 *  起因：整本全量拉取（3559 集）上游会截断漏集（仙逆 196），但**单集精确词能搜到** ——
 *  落雪搜「仙逆 … 完结 196」就能出「仙逆 第196集 古神之地1」，同一专辑。
 *  搜回来的条目可能来自同一专辑（漏抓补齐）或其它专辑（同名书别的版本），都能救。
 *  串行两趟：「书名 第N集」→「书名 N」；命中条件 = rid 非空 + 标题/ep 对得上 + 专辑沾书名。
 */
// ★ v1.7.5 救援落空负缓存：key = cacheKey:ep，value = 落空时刻。10 分钟内同集不再空搜
//   （救援落空说明精确词真搜不到，短时间内重试大概率还是空，白耗上游限流预算）。
const RESCUE_FAIL = new Map();

// ★ v1.7.7 直链播放记账去重：key = devId|src|rid，value = 上次记账时刻。
//   Range/seek 会把同一个 /r/、/m/ 地址反复请求，120s 内只记一条。
const HIST_SEEN = new Map();

async function abRescueEp(full, ep, src) {
  const book = String(full.book || '').trim();
  if (!book || !ep) return null;
  const epPat = new RegExp('第\\s*' + ep + '\\s*集|[（(]\\s*' + ep + '\\s*[)）]|(^|\\D)' + ep + '\\s*集');
  const bn = book.replace(/\s+/g, '');
  const abOk = (alb, title) => {
    const ab = String(alb || '').replace(/\s+/g, '');
    if (!ab) {
      // ★ v1.7.20：无专辑名不能裸放行 —— 集号对上但书名完全对不上的是别的书
      //   （实测翻车：圣墟「第3373/3374集」因此被救进遮天，点了播的是别的书）。
      //   标题必须也沾书名（全名或剥段短名）。
      const tt = String(title || '').replace(/\s+/g, '');
      if (!tt) return false;
      if (tt.indexOf(bn) >= 0) return true;
      const bh = bn.split(/[|｜·+＋]/)[0];
      return !!(bh && bh.length >= 2 && tt.indexOf(bh) >= 0);
    }
    if (ab.indexOf(bn) >= 0 || bn.indexOf(ab) >= 0) return true;
    const head = ab.split(/[|｜·]/)[0];
    return !!(head && bn.indexOf(head) >= 0);
  };
  // ★ 搜索词带全「演播 书名 第N集」（用户定稿）：同名书 / 同书不同演播版本极多，
  //   只搜「书名 第N集」容易捞错版本。串行四趟：全词 → 无演播 → 短书名（书名可能
  //   带「| 多人社 | …」专辑段，剥头段再试）→ 裸集号兜底。
  const narrator = String(full.narrator || '').trim();
  const shortBook = book.split(/[|｜]/)[0].trim() || book;
  const tries = [
    ...(narrator ? [narrator + ' ' + book + ' 第' + ep + '集'] : []),
    book + ' 第' + ep + '集',
    ...(shortBook !== book ? [shortBook + ' 第' + ep + '集'] : []),
    shortBook + ' ' + ep,
  ];
  const seen = new Set();
  const cands = [];
  // 收一趟搜索结果里能对上集号 + 专辑沾书名的候选（快搜/兜底共用）
  const collect = (rs) => {
    for (const x of (rs || [])) {
      const k = (x.source || '') + '|' + (x.rid || '');
      if (!x.rid || seen.has(k)) continue;
      seen.add(k);
      const title = String(x.title || '');
      if (Number(x.ep) === ep || epPat.test(title)) {
        if (abOk(x.album, title) || abOk(title, title)) cands.push(x);
      }
    }
  };
  // ★ v1.7.3 提速（实测翻车：遮天 250 救援 27s，同词手工搜 3s）——
  //   元凶是每趟词形都 lxSearchAll 'all' 全量枚举（单趟 19s / 1.26MB）。
  //   「书名 第N集」这种精确词相关度极高，目标集就在前排：先按限量 50 快搜
  //   （实测 3~4s 一趟），哪趟有货就停；四趟全落空才对「书名 第N集」做
  //   一次全量兜底（上游偶尔把目标埋深，只这一趟承受 19s）。
  const LIM_FAST = 50;
  for (const t of tries) {
    collect(await lxSearchAll(t, LIM_FAST, src).catch(() => []));
    if (cands.length) break;                       // 快搜有货就不跑下一趟（省限流预算）
  }
  if (!cands.length) {
    collect(await lxSearchAll(book + ' 第' + ep + '集', 'all', src).catch(() => []));
  }
  if (!cands.length) return null;
  // 评分：同专辑 albumId（漏抓补齐的常见情形）> ep 字段精确相等 > 同主播 > 标题更短
  const wantAlb = String(full.albumId || '');
  cands.sort((a, b) => {
    const sa = wantAlb && String(a.albumId || '') === wantAlb ? 2 : 0;
    const sb = wantAlb && String(b.albumId || '') === wantAlb ? 2 : 0;
    if (sa !== sb) return sb - sa;
    const ea = Number(a.ep) === ep ? 1 : 0, eb = Number(b.ep) === ep ? 1 : 0;
    if (ea !== eb) return eb - ea;
    const na = full.narrator && String(a.artist || '').indexOf(full.narrator) >= 0 ? 1 : 0;
    const nb = full.narrator && String(b.artist || '').indexOf(full.narrator) >= 0 ? 1 : 0;
    if (na !== nb) return nb - na;
    return String(a.title || '').length - String(b.title || '').length;
  });
  const best = cands[0];
  return { title: best.title, rid: best.rid, duration: String(best.duration || ''),
           source: best.source || src, albumId: String(best.albumId || ''), album: String(best.album || '') };
}

/**
 * ★ 深挖（2026-10-31 晚）：上游搜索按查询词相关性返回，弱词经常只吐整本的一截
 * （凡人修仙传第一季 裸词 ⇒ 光合积木版只有 383/2101 集；而「主播 书名」能吐满 2101）。
 * 对指定组反查一次「主播 书名」全量搜索并去重合并。
 * ★★ 必须串行单发：并发多个全量查询会被上游限流截断（实测 2101 → 1059）。
 * 返回合并后的新数组；不适用/失败原样返回。 */
async function abPageSweep(raws, group, src) {
  try {
    if (!group || group.count >= 800 || !group.book || group.book === '(未命名)') return raws;
    if (!group.albumId) return raws;                      // 没 albumId 没法定向
    if (!src || src === 'all' || String(src).indexOf(',') > -1) return raws;  // 只扫单源
    // 查询词用「主播 书名」：它的全集里目标专辑占满（实测 2101/2101），
    // 用户原词的全集里目标专辑只零星（凡人修仙传第一季 裸词 ⇒ 383/3600）。
    const want = String(group.albumId);
    const narrator = String(group.narrator || '');
    const book = String(group.book);
    // 完整专辑名（脚本源无 albumId，用它精确匹配，避免把同书名不同季捞进来）
    const normAlb = a => String(a || '').replace(/\s+/g, '');
    const albumFull = normAlb((raws.find(x => String(x.albumId) === want) || {}).album || '');
    const q2 = (narrator + ' ' + book).trim() || book;
    const narratorHead = narrator.split(/[，,/／\s]/)[0].trim();
    const seen = new Set((raws || []).map(x => (x.source || '') + '|' + (x.rid || '')));
    const out = (raws || []).slice();

    // ★ 双通道并行翻页：上游对「同一查询串短时间重复」会吐截断缓存（2101→2000→200→空），
    //   且单通道连发会被限流（实测 2101→1128 就断供）。落雪(源内)与脚本源(另一条上游)预算独立，
    //   各自翻页后 Union，能稳定凑满整本（凡人修仙传第一季=2101 集）。
    // 落雪通道：按 albumId 精确过滤（同书名不同季 albumId 不同）
    const sweepLx = async () => {
      const local = [], ls = new Set();
      let noNew = 0;
      for (let p = 1; p <= 40 && noNew < 2; p++) {
        const lx = await lxSearchAll(q2, 100, src, p).catch(() => []);
        let add = 0;
        for (const x of lx || []) {
          if (String(x.albumId || '') !== want) continue;
          const k = (x.source || '') + '|' + (x.rid || '');
          if (ls.has(k)) continue; ls.add(k); local.push(x); add++;
        }
        if (!add) noNew++; else noNew = 0;
      }
      return local;
    };
    // 脚本源通道：按「完整专辑名+主播」精确过滤（脚本源条目无 albumId，
    // rid 是酷我 songmid，落雪取链能直接认；顺手 siPut 存档供起播取链）
    const sweepSd = async () => {
      const local = [], ls = new Set();
      let noNew = 0;
      for (let p = 1; p <= 40 && noNew < 2; p++) {
        let list = [];
        try { list = await S.search('kw', q2, 100, p); } catch { break; }
        let add = 0;
        for (const it of list || []) {
          if (albumFull && normAlb(it.album) !== albumFull) continue;
          if (narratorHead && !String(it.artist || '').includes(narratorHead)) continue;
          const rid = String(it.rid || '');
          if (!rid) continue;
          const k = 'kw|' + rid;
          if (ls.has(k)) continue; ls.add(k);
          local.push({
            rid, source: 'kw', title: String(it.title || ''), artist: String(it.artist || ''),
            album: String(it.album || ''), albumId: want, duration: String(it.duration || ''),
            img: String(it.img || ''), via: 'sd', types: null,
            kind: detectKind(String(it.title || ''), String(it.album || ''), String(it.artist || '')),
            ep: detectEp(String(it.title || '')),
          });
          siPut('kw', rid, { songmid: rid, name: String(it.title || ''), singer: String(it.artist || ''), albumName: String(it.album || '') });
          add++;
        }
        if (!add) noNew++; else noNew = 0;
      }
      return local;
    };

    console.log('[ab] 翻页枚举(双通道)', JSON.stringify(q2), 'album=' + want, '组内', group.count, '集');
    const [l1, l2] = await Promise.all([sweepLx(), sweepSd()]);
    for (const x of l1.concat(l2)) {
      const k = (x.source || '') + '|' + (x.rid || '');
      if (seen.has(k)) continue;
      seen.add(k); out.push(x);
    }
    console.log('[ab] 翻页枚举完成: 落雪+' + l1.length + ' 脚本源+' + l2.length + ' → 合计 ' + out.length + ' 条');
    return out;
  } catch { return raws; }
}

function abQualify(items) {
  const arr = items || [];
  // ① 专辑名 / 播音者带类型词（声音剧/有声/单播/评书/郭德纲…）⇒ 稳，单条也认
  if (arr.some(x => PROG_ALBUM_RE.test(String(x.album || ''))
      || PROG_ARTIST_RE.test(String(x.artist || '')))) return true;
  // ② 仅标题像节目（裸第N集/《…》第N集）⇒ 必须**聚簇**：同 albumId ≥3 条
  //    且大半带集号。单条「提到书名的播客」就是靠这条压掉的。
  if (arr.length >= 3) {
    const withEp = arr.filter(x => PROG_TITLE_RE.test(String(x.title || ''))).length;
    if (withEp * 2 >= arr.length) return true;
  }
  return false;
}

/** 等响应头的上限（TCP+握手+上游首包慢，给足 20s）。拿不到头才算失败。 */
const CONNECT_MS = 20000;
/** 传输期：连续这么久「一个字节都没动」才判定上游死了（不是整条流的死期）。 */
const IDLE_MS = 60000;

/**
 * 把上游音频流转发给播放器（/s/<i> 默认走这条）。
 * 为什么要转发而不是 302：R1 的 DLNA 播放器（Platinum/Neptune）不一定跟随重定向，
 * 转发出去对它就是一个普通 http 音频源，最稳。代价是 NAS 中转一点局域网流量。
 * 支持 Range（拖进度）与 HEAD（播放器探活）。
 *
 * ★ v1.2.3（2026-11-07）：容器「偶发意外停止」的真凶就在这儿。
 *   现场日志：
 *     node:events:502   throw er; // Unhandled 'error' event
 *     DOMException [TimeoutError]: The operation was aborted due to timeout
 *     Emitted 'error' event on Readable instance at: emitErrorNT …
 *   旧写法 `signal: AbortSignal.timeout(20000)` 的定时器**不会因为响应头到了就停**，
 *   它盯着整条连接的寿命。R1 播放器一暂停 / 一拖进度，下游就不再读，pipe 背压把上游
 *   body 卡住没人消费 —— 20s 一到 signal abort，body 流报错，而
 *   `Readable.fromWeb(up.body)` 出来的流**没人挂 error 监听** ⇒ Node 的
 *   "Unhandled 'error' event" 直接把整个进程干掉（compose 是 restart: unless-stopped，
 *   于是表现为「偶发停止」、正在播的歌和 Web 一起断）。
 *   现在分两段：
 *     ① CONNECT_MS 只管「等到响应头」，拿到头立刻 clearTimeout；
 *     ② 传输期换**空闲看门狗**：连续 IDLE_MS 没有字节流动才断，且「是我们自己按的
 *        暂停（背压）」不算上游死，继续等；
 *     ③ src / res 都挂 error，res 一 close 就销毁上游流 —— 任何一条流报错都只影响
 *        这一个请求，不许冒到进程级。
 */
async function pipeAudio(res, req, upstream, onCommit) {
  const range = req.headers.range || '';
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  if (range) headers.Range = range;
  const ac = new AbortController();
  let connectTimer = setTimeout(() => ac.abort(), CONNECT_MS);
  const stopConnectTimer = () => { if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; } };
  try {
    const up = await fetch(upstream, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers, redirect: 'follow', signal: ac.signal,
    });
    stopConnectTimer();                                  // ★ 头到了，别再掐整条流
    const h = {
      'Content-Type': up.headers.get('content-type') || 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    const len = up.headers.get('content-length');
    if (len) h['Content-Length'] = len;
    const cr = up.headers.get('content-range');
    if (cr) h['Content-Range'] = cr;
    res.writeHead(up.status === 206 ? 206 : (up.ok ? 200 : up.status), h);
    if (req.method === 'HEAD' || !up.body) { res.end(); try { if (up.body) await up.body.cancel(); } catch {} return; }

    const src = Readable.fromWeb(up.body);
    let idleTimer = null;
    const stopIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
    const bump = () => {
      stopIdle();
      idleTimer = setTimeout(() => {
        // 下游不读（播放器暂停 / 拖进度）也会让 pipe 停住，但那不是上游的错 —— 继续等
        if (src.isPaused()) { bump(); return; }
        stopIdle();
        console.log('[mini-lx] 上游 ' + IDLE_MS + 'ms 无数据，掐断：' + String(upstream).slice(0, 120));
        try { src.destroy(new Error('upstream idle')); } catch { /* already dead */ }
        // 已经声明了 Content-Length 却传不完 ⇒ 只能断连接，不能 res.end()（那会发一条
        // 「短了半截」的完整响应，播放器当成正常 EOF，反而不重试）
        try { res.destroy(); } catch { /* client gone */ }
      }, IDLE_MS);
    };
    // ★ 这三行缺一行就会重演「一条流报错 ⇒ 整个容器重启」
    src.on('error', e => {
      stopIdle();
      console.log('[mini-lx] 转发流中断（单请求，不影响服务）：' + String(e && e.message || e).slice(0, 120));
      try { res.end(); } catch { /* client gone */ }
    });
    res.on('error', () => { stopIdle(); try { src.destroy(); } catch { /* ignore */ } });
    res.on('close', () => { stopIdle(); try { src.destroy(); } catch { /* ignore */ } });
    src.on('end', stopIdle);
    // ★ v1.7.36：累计真实传输字节，够阈值才确认「真播」并落记录（只触发一次）。
    //   探活/预取只拿几 KB 就断 ⇒ 永远到不了阈值 ⇒ 不落，根治「取链未播也算播」。
    let committed = false;
    let txBytes = 0;
    src.on('data', chunk => {
      bump();                                            // 有字节流动就把看门狗续上
      if (committed || !onCommit) return;
      txBytes += (chunk && chunk.length) || 0;
      if (shouldCommitPlay(txBytes, PLAY_COMMIT_BYTES)) {
        committed = true;
        try { onCommit(); } catch { /* 记账失败绝不影响推流 */ }
      }
    });
    bump();
    src.pipe(res);
  } catch (e) {
    stopConnectTimer();
    try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); } catch {}
    try { res.end('转发失败：' + String(e && e.message || e)); } catch { /* client gone */ }
  }
}

const MIN_FULL_BYTES = 480 * 1024;

// ★ v1.7.36：stream 落记录的最小真实传输字节。低于它视为「取链探活/预取」，不记播放。
//   默认 256KB（≈十几秒 128kbps 音频）—— 足以覆盖真实起播，又能挡住 player 装载队列时
//   对每首发几 KB 就断的格式探测。可用 files/play_commit_bytes（纯数字）覆盖，便于调参。
let PLAY_COMMIT_BYTES = 256 * 1024;
try {
  const _pcf = path.join(__dirname, 'files', 'play_commit_bytes');
  if (fs.existsSync(_pcf)) {
    const _n = parseInt(fs.readFileSync(_pcf, 'utf8').trim(), 10);
    if (Number.isFinite(_n) && _n > 0) PLAY_COMMIT_BYTES = _n;
  }
} catch { /* 配置文件坏掉就用默认，不影响播放 */ }

/**
 * 把**本地文件**（/m/<path>）发给播放器。
 *
 * <p>原 r1-music 用的是 Flask 的 send_from_directory(conditional=True)，
 * 自带 Range 支持。这里在 Node 里手搓一遍：Range 不是可选项 ——
 * R1 的播放器会先发 `Range: bytes=0-` 探一眼，不认 Range 的服务器
 * 有些播放器连首帧都拿不到。</p>
 */
/**
 * ★ v1.2.1：/m/ 现在也发封面图（有声书的 cover_small.jpg）——
 *   local.mimeOf 只认音频扩展名，图片会被当成 audio/mpeg 发出去，浏览器不显示。
 */
const IMG_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};
function mimeAny(rel) {
  const e = String(rel || '').toLowerCase().match(/\.[a-z0-9]+$/);
  const ext = e ? e[0] : '';
  return IMG_MIME[ext] || local.mimeOf(rel);
}

function sendLocalFile(res, req, abs, ct, onCommit) {
  let size = 0;
  try { size = fs.statSync(abs).size; } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('读不到这个文件');
  }
  const range = req.headers.range || '';
  let s = 0, e = size - 1, code = 200;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    s = m[1] ? parseInt(m[1], 10) : 0;
    e = m[2] ? parseInt(m[2], 10) : size - 1;
    if (!Number.isFinite(s)) s = 0;
    if (!Number.isFinite(e) || e >= size) e = size - 1;
    if (s > e || s >= size) {
      res.writeHead(416, {
        'Content-Type': ct, 'Content-Range': 'bytes */' + size, 'Accept-Ranges': 'bytes',
      });
      return res.end();
    }
    code = 206;
  }
  const h = { 'Content-Type': ct, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (code === 206) {
    h['Content-Range'] = 'bytes ' + s + '-' + e + '/' + size;
    h['Content-Length'] = e - s + 1;
  } else {
    h['Content-Length'] = size;
  }
  res.writeHead(code, h);
  if (req.method === 'HEAD') return res.end();
  const st = fs.createReadStream(abs, code === 206 ? { start: s, end: e } : {});
  st.on('error', () => { try { res.end(); } catch { /* 客户端断了很常见 */ } });
  // ★ v1.2.3：播放器拖进度会直接掐连接，res 上的 EPIPE/ECONNRESET 没人接同样是
  //   「Unhandled 'error' event」→ 进程退出。这里一起兜住，并顺手停掉读文件。
  res.on('error', () => { try { st.destroy(); } catch { /* ignore */ } });
  res.on('close', () => { try { st.destroy(); } catch { /* ignore */ } });
  // ★ v1.7.36：同 /r/ —— 本地音频也按真实传输字节确认真播，探活/预取不落记录。
  if (onCommit) {
    let committed = false, txBytes = 0;
    st.on('data', chunk => {
      if (committed) return;
      txBytes += (chunk && chunk.length) || 0;
      if (shouldCommitPlay(txBytes, PLAY_COMMIT_BYTES)) {
        committed = true;
        try { onCommit(); } catch { /* 记账失败绝不影响推流 */ }
      }
    });
  }
  st.pipe(res);
}

/**
 * ★ 验证一个"直链"真的是音频。
 * 必要性实测：幻音音源对 kw/tx/wy 不做解析，直接把 sayqz 的 API 地址当 musicUrl 返回
 * （`https://music-dl.sayqz.com/api/?source=kuwo&id=..&type=url..`）—— 该地址正常时靠 302
 * 跳到音频，异常时返回 JSON/不可达 ⇒ <audio> 加载失败且"取链成功"骗过了兜底。
 * 用 Range GET（字节 0-1）判：非 2xx、或 content-type 是 text/json ⇒ 不是音频。
 */
async function isAudioUrl(u) {
  const r = await probeUrl(u);
  return !!r.ok;
}
const send = (res, obj, code = 200) => {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  // ★v1.7.22：API JSON 一律 no-store —— /api/history 这类实时数据没缓存头时，
  //   个别浏览器（尤其手机 WebView）会拿旧响应，播放记录页就「不刷新」。
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
};
const readBody = req => new Promise((resolve, reject) => {
  let buf = '';
  req.on('data', c => { buf += c; if (buf.length > 4e6) { req.destroy(); reject(new Error('body too large')); } });
  req.on('end', () => resolve(buf));
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;

  // ★ v1.4.0：/ap/... 是「同一个接口的 AlphaPi 专用入口」。
  //   做法是**剥掉前缀后照常走下面的全部路由**，只把 req.__ap 立起来 ——
  //   不用为 /ap 复制一整套路由，也就不会出现「改了 /r/ 忘了改 /ap/r/」这种漏。
  req.__u = u;
  req.__ap = false;
  if (p === '/ap' || p === '/ap/') {
    req.__ap = true;
    p = '/';
  } else if (p.startsWith('/ap/')) {
    req.__ap = true;
    p = p.slice(3);                    // '/ap/m/x' → '/m/x'
  }

  try {
    /* ★ v1.7.50：转码面要能被 **player 网页** 读到。
       R1 播放页在设备 8080，问的是这台服务器的 8100 —— 跨源，没有 CORS 头就被浏览器拦，
       「转码」那颗 pill 永远问不到结果。
       ★ v1.7.53：改成**显式只读白名单**（stats / probe）。以前是 `/api/trans/` 前缀全开，
       而 on / maxmb / purge / prewarm 都是 GET 改状态 —— 局域网里随便哪个页面都能替你
       关转码、清缓存。这几个只给同源用，不放开。 */
    if (p === '/api/trans/stats' || p === '/api/trans/probe') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Content-Length': 0 }); return res.end(); }
    }

    if (p === '/' || p === '/index.html') {
      const b = fs.readFileSync(path.join(WEB, 'index.html'));
      // ★ v1.7.41：页面不留缓存 —— 以前改了 UI 用户刷新还是旧的（尤其手机 WebView），
      //   这台机器是局域网工具页，每次现读最新才对。
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
      return res.end(b);
    }

    if (p === '/api/sources') return send(res, { list: S.meta() });

    // 多源搜索：source 可为单个源 id、逗号分隔列表、或 all
    // ★ v1.7.11 歌曲 rid 缓存 —— GET /api/song/resolve?title=&artist=
    //   device 单点收藏播放 / fav_resolve 先问这里：
    //   ① song_cache.json 命中 → 直接返回（零上游、秒回，多设备共享同一份）；
    //   ② 10 分钟内精确搜过没有 → 负缓存直接返回失败；
    //   ③ 否则单次落雪搜索（n=5）+ 歌手闸筛选，选中写缓存再回。
    //   只处理单条 —— 收藏里几百条空源靠用户逐条点击回填，绝不批量预搜（风控红线）。
    if (p === '/api/song/resolve') {
      const t0 = (u.searchParams.get('title') || '').trim();
      const a0 = (u.searchParams.get('artist') || '').trim();
      if (!t0) return send(res, { ok: false, error: '缺少 title' });
      const sk = songcache.keyOf(t0, a0);
      const hit = songcache.get(sk);
      if (hit) {
        songcache.markPlay(sk);
        return send(res, Object.assign({ ok: true, cached: true, key: sk }, hit));
      }
      if (songcache.recentFail(sk)) {
        return send(res, { ok: false, key: sk, negative: true,
          error: '10 分钟内精确搜过没有（负缓存），稍后再试' });
      }
      const q = a0 ? (t0 + ' ' + a0) : t0;
      let list = [];
      try { list = await lxSearchAll(q, 5, 'all'); } catch { list = []; }
      const normS = s => String(s || '').toLowerCase().replace(/\s+/g, '');
      const na = normS(a0);
      // 歌手闸：artist 非空必须对得上（互含）；artist 空取第一条有 rid 的。
      // 宁缺毋滥 —— 没有歌手匹配的候选就不乱拿第一条（避免配成翻唱/同名歌）。
      const pick = (list || []).find(x => x && x.rid
        && (!na || (() => {
          const xa = normS(x.artist || x.singer || '');
          return xa && (xa.includes(na) || na.includes(xa));
        })()));
      if (!pick) {
        songcache.markFail(sk);
        console.log('[songcache] 精确落空：' + t0 + (a0 ? ' - ' + a0 : '') + '（负缓存 10 分钟）');
        return send(res, { ok: false, key: sk, error: '没搜到歌手对得上的版本' });
      }
      const saved = songcache.put({
        key: sk,
        title: String(pick.title || pick.name || t0),
        artist: String(pick.artist || pick.singer || a0),
        source: pick.source || 'kw',
        rid: pick.rid,
        album: pick.album || '',
        kind: pick.kind || '',
      });
      console.log('[songcache] 解析成功：' + t0 + (a0 ? ' - ' + a0 : '')
        + ' → ' + (saved ? saved.source + '/' + saved.rid : '(写缓存失败)'));
      return send(res, Object.assign({ ok: true, cached: false, key: sk }, saved || {}));
    }
    // ★ v1.7.12 歌曲 rid 缓存管理（Web「rid缓存」页）——
    //   GET  列表分页；POST {op:...} 删选中 / 清空 / 改上限。纯缓存操作，不回源。
    if (p === '/api/song/cache') {
      if (req.method === 'POST') {
        const rq = await readBody(req).then(JSON.parse).catch(() => ({}));
        const op = String(rq.op || '').trim();
        if (op === 'del') {
          const n = songcache.del(rq.keys || []);
          console.log('[songcache] 手动删除 ' + n + ' 条');
          return send(res, { ok: true, deleted: n });
        }
        if (op === 'clear') {
          const n = songcache.clearAll();
          console.log('[songcache] 手动清空（原 ' + n + ' 条）');
          return send(res, { ok: true, cleared: n });
        }
        if (op === 'limit') {
          const v = songcache.setLimit(rq.n);
          return send(res, { ok: true, limit: v });
        }
        return send(res, { ok: false, error: '未知 op（del/clear/limit）' });
      }
      return send(res, songcache.list(
        parseInt(u.searchParams.get('page') || '1', 10) || 1,
        parseInt(u.searchParams.get('size') || '50', 10) || 50,
        u.searchParams.get('q') || ''));
    }
    if (p === '/api/search') {
      const q = u.searchParams.get('q') || u.searchParams.get('k') || '';
      if (!q) return send(res, { total: 0, list: [], errors: [] });
      const n = Math.min(parseInt(u.searchParams.get('n') || '30', 10) || 30, 100);
      const page = parseInt(u.searchParams.get('page') || '1', 10) || 1;
      const srcParam = (u.searchParams.get('source') || 'all').trim();
      const wantKind = (u.searchParams.get('kind') || '').trim();  // 'program' = 只要有声书/节目（Web 有声书类目）
      const key = 's:' + srcParam + ':' + q + ':' + n + ':' + page + ':' + wantKind;
      const out = await cached(key, async () => {
        /**
         * ★★ 主走落雪（2026-10-18）：搜索与取链**同源** ⇒ 列表里出现的歌
         *    落雪一定认得（以前脚本源给 mg/kg 的 rid，落雪取链全 500，
         *    「搜得到却播不了」就是这么来的）。搜不出来才回落脚本音源。
         *    ★ 落雪的搜索不认 page（实测 page=2 还是第一页）⇒ 翻页直接走脚本源。
         */
        if (page <= 1) {
          const lx = await lxSearchAll(q, n, srcParam);
          if (lx.length) return { list: lx, errors: [] };
        }
        if (srcParam === 'all') return S.searchAll(q, n, page);
        const only = srcParam.split(',').map(s => s.trim()).filter(Boolean);
        if (only.length === 1) return { list: await S.search(only[0], q, n, page), errors: [] };
        return S.searchAll(q, n, page, only);
      }, 300000, hasList);
      /* ★ 三修：把「长期取不到链」的音源（实测 mg / kg）排到后面 —— 用户翻列表时
         先看到点得响的那批；顺便给它们打上 weak 标记，页面可提示「此源可能播不了」。
         取链失败时另有跨源兜底（resolveUrl 里改搜 kw 顶替），两道保险。 */
      /* ★★ 每条都要带 url —— Web 播放条直接吃这个字段。
         以前 lxSearchAll 只给 rid/source 不给 url ⇒ Web 点了 play() 第一行
         `if (!t || !t.url) return;` 直接静默返回（「搜得到却播不了」）；
         player 端是自己拼的 /r/<src>/<rid>，所以只有 Web 中招。
         统一用惰性地址：起播那一刻才取链，跟 /index.json 里的一模一样。 */
      const self = selfBase(req);
      /* ★ kind=program：只保留有声书/节目条目（lx 条目自带 kind；
         脚本源条目没有 kind 字段，现场用同一套启发式补判）。
         配合 n=100：有声书一搜一大把章节，单源上限拉满才够汇总。 */
      const raws = wantKind
        ? (out.list || []).filter(x =>
            (x.kind || detectKind(String(x.title || x.name || ''),
              String(x.album || ''), String(x.artist || ''))) === wantKind)
        : (mediaFlags().audiobook
            ? (out.list || [])
            : // ★ 有声书开关关掉：普通搜索（含 R1 语音点歌）不再混入节目
              (out.list || []).filter(x =>
                (x.kind || detectKind(String(x.title || x.name || ''),
                  String(x.album || ''), String(x.artist || ''))) !== 'program'));
      const list = raws.map(x => Object.assign({}, x, {
        weak: !!srcWeak(x.source),
        url: x.url || lazyUrl(self, x),
      }));
      list.sort((a, b) => (a.weak ? 1 : 0) - (b.weak ? 1 : 0));   // 稳定排序：不改组内次序
      return send(res, { total: list.length, list, errors: out.errors || [] });
    }

    if (p === '/api/boards') return send(res, { list: S.boards() });

    if (p === '/api/board') {
      const id = u.searchParams.get('id') || '93';
      const list = await cached('b:' + id, () => S.board(Number(id), 1, 100), 600000,
        v => !v || !v.length);
      return send(res, { total: list.length, list });
    }

    if (p === '/api/lyric') {
      const rid = u.searchParams.get('rid') || '';
      const src = u.searchParams.get('source') || '';
      if (!rid) return send(res, { lines: [], lrc: '' });
      /* ★ 2026-10-18：缓存键必须带 source —— 以前只有 'l:'+rid，于是
         同一个 rid 一旦被某次请求以错误姿势查过，后面全跟着错。 */
      const r = await cached('l:' + src + ':' + rid, () => lyricOf(rid, src), 3600000,
        v => !v || !v.lines || !v.lines.length);
      return send(res, r);
    }

    // 排障用：/api/lyric/debug?rid=&source= 看两级通道各自给了什么
    if (p === '/api/lyric/debug') {
      const rid = u.searchParams.get('rid') || '';
      const src = u.searchParams.get('source') || '';
      const out = { rid, source: src, kw: null, lx: null };
      if (src === 'kw' || !src) {
        try {
          const r = await S.lyric(rid);
          out.kw = { lines: (r && r.lines || []).length };
        } catch (e) { out.kw = { err: String(e && e.message || e).slice(0, 120) }; }
      }
      const x = await lxrelay.relayLyric({ source: src || 'kw', rid });
      out.lx = x && x.skip ? { skip: true }
        : (x && x.err ? { err: x.err, ms: x.ms } : { lines: (x && x.lines || []).length, ms: x.ms });
      return send(res, out);
    }

    if (p === '/api/pic') {
      const rid = u.searchParams.get('rid') || '';
      if (!rid) return send(res, { url: null });
      const url = await cached('p:' + rid, () => S.pic(rid), 3600000, v => !v);
      return send(res, { url });
    }

    if (p === '/api/hot') {
      const list = await cached('hot', () => S.hotSearch(), 1800000, v => !v || !v.length);
      return send(res, { list });
    }

    // 取播放直链 —— 四级兜底：脚本 → 网易同城 → 网易跨源 → 酷我 antiserver
    // 取播放直链 —— 五级兜底：脚本 → 网易同城 → 酷狗跨源 → 网易跨源 → 酷我 antiserver
    if (p === '/api/url') {
      const r = await resolveUrl({
        rid: u.searchParams.get('rid') || '',
        source: u.searchParams.get('source') || '',
        q: u.searchParams.get('q') || defQuality(),
        title: u.searchParams.get('title') || '',
        artist: u.searchParams.get('artist') || '',
        alt: u.searchParams.get('alt'),
        fresh: u.searchParams.get('fresh'),
        debug: u.searchParams.get('debug'),
      });
      return send(res, r);
    }

    // ★ 曲库池：载入后随机 100 首（fresh=1 = 换一批）
    //   与 /index.json 用的是同一份池（落盘 files/pool.json），
    //   否则 R1 已加载的曲库和 Web 上看到的下标会对不上号。
    if (p === '/api/pool') {
      const n = clampN(u.searchParams.get('n'), 100);
      const list = await pool.get(n, u.searchParams.get('fresh') === '1');
      return send(res, { total: list.length, poolSize: pool.size(), list });
    }

    if (p === '/api/pool/add' && req.method === 'POST') {
      const body = await readBody(req).then(JSON.parse).catch(() => ({}));
      const items = Array.isArray(body.items) ? body.items : [body];
      return send(res, pool.add(items));
    }

    // ★★ R1 语音点歌曲库 —— 契约与 R1 PlayerBridge.loadIndex() 完全一致：
    //      {"base":"", "tracks":[{"title","artist","file","url"}], "radios":[]}
    //
    // ★ v1.3.179：本地曲库并进来以后，这里是**一份 JSON 装下全部**：
    //     本地曲目（/m/<path>，真文件直出） + 在线随机池（/s/<i>，惰性取链） + 电台。
    //   在线段一律排在后面，并用 onlineFrom 标出起点 —— R1 的「随机播放在线」
    //   只替换这一段，不会把本地那一千多首一起冲掉。
    //     用法：把 http://<NAS>:8100/index.json 写进 R1 的 files/music_index（只写这一条）。
    if (p === '/index.json') {
      const F = mediaFlags();
      const n = clampN(u.searchParams.get('n'), 100);
      // 关掉的部分**连拉都不拉**（本地关了就不扫目录，省一次几千个文件的 stat）
      const [locals, poolList] = await Promise.all([
        F.local ? local.list().catch(() => []) : [],
        F.online ? pool.get(n, false) : [],
      ]);
      const self = selfBase(req);
      const enc = f => String(f).split('/').map(encodeURIComponent).join('/');
      // ★ v1.4.0：识别为 AlphaPi ⇒ 地址直接给 /ap/…（这条请求之后，
      //   设备再取音频时就算不发 UA 也一定会走转码），并在 tracks 里带上格式提示。
      const AP = apPrefix(req);
      const tracks = locals.map(t => ({
        src: 'local',
        title: t.title, artist: t.artist, album: t.album,
        file: (AP ? 'ap/' : '') + 'm/' + t.file,
        url: self + AP + '/m/' + enc(t.file),
        ...(AP ? { fmt: 'wav8/24000/1' } : {}),
      }));
      const online = poolList.map(t => ({
        src: 'online',
        title: t.title, artist: t.artist, album: t.album,
        file: (AP ? 'ap/' : '') + lazyFile(t), url: lazyUrl(self, t, AP),
        ...(AP ? { fmt: 'wav8/24000/1' } : {}),
      }));
      return send(res, {
        base: '',
        source: 'mini-lx',
        ver: MS_VER,
        // ★ 设备侧可据此判断「服务端会不会帮我转码」：alpha = 所有 url 都是转码流
        device: AP ? 'alphapi' : 'r1',
        audioFormat: AP ? 'wav/pcm_u8/24000/1' : 'source',
        updatedAt: new Date().toISOString(),
        onlineFrom: tracks.length,
        localCount: tracks.length,
        onlineCount: online.length,
        radioCount: F.radio ? local.radios().length : 0,
        tracks: tracks.concat(online),
        // 电台地址：默认**直连源站**（见 RADIO_PROXY 的注释）；
        // 只有显式 RADIO_PROXY=1 才改写成 /radio/<b64> 走本机代理。
        radios: F.radio ? local.radios().map(r => ({
          src: 'radio', name: r.name,
          url: RADIO_PROXY ? radioUrl(self, r.url) : r.url,
        })) : [],
      });
    }

    // ★ /online.json：**只吐在线随机池**。
    //   合库之后 /index.json 里混着本地曲目，而 R1 的「随机播放在线音乐」
    //   是拿一整批新歌替换曲库 —— 若还去打 /index.json，本地曲库会被一起换掉。
    if (p === '/online.json') {
      const F = mediaFlags();
      const n = clampN(u.searchParams.get('n'), 100);
      const list = F.online ? await pool.get(n, u.searchParams.get('fresh') === '1') : [];
      const self = selfBase(req);
      const AP = apPrefix(req);
      return send(res, {
        base: '',
        source: 'mini-lx',
        ver: MS_VER,
        device: AP ? 'alphapi' : 'r1',
        audioFormat: AP ? 'wav/pcm_u8/24000/1' : 'source',
        updatedAt: new Date().toISOString(),
        onlineFrom: 0,
        // 关掉在线库 ⇒ 这里也是空的：R1 的「随机播放在线音乐」会因此拿不到歌，
        // 自己回落到本地随机 —— 与 Web 上的开关说的一致。
        off: !F.online,
        tracks: list.map(t => ({
          title: t.title, artist: t.artist, album: t.album,
          file: (AP ? 'ap/' : '') + lazyFile(t), url: lazyUrl(self, t, AP),
          ...(AP ? { fmt: 'wav8/24000/1' } : {}),
        })),
        radios: [],
      });
    }

    // ★ /ap/radios.json（v1.4.0）：AlphaPi One 的「收音机」上传格式
    //   {"radios":[{"name":"台名","url":"http://...","on":true}]}
    //   它的 Web 管理页可以直接导入这份文件 —— 于是同一套电台清单 R1 / AlphaPi 共用。
    //   ★ 地址原样给（MP3 直播流），**不转码**：One 的收音机是流式无限播放，
    //     转成 24KB/s 的 8bit WAV 只会白占带宽（它那条路本来就有 MP3 解码器）。
    //     真要转码就自己加 ?fmt=wav。
    if (p === '/radios.json') {
      const F = mediaFlags();
      const list = F.radio ? local.radios() : [];
      return send(res, {
        ver: MS_VER,
        count: list.length,
        radios: list.map(r => ({ name: r.name, url: r.url, on: true })),
      });
    }

    // ★★ 网络电台代理 /radio/<b64url(原始直播流地址)>。
    //    为什么要代理而不是让设备直连公网电台，见 radioproxy.js 文件头：
    //    电台是 64kbps 直播流（恒定 8.00 KB/s），公网供给只有 10~12 KB/s 且会周期性
    //    停滞数秒，R1 那个播放器的缓冲区被抽干，表现就是「播几秒停一会儿又继续」。
    //    代理把公网抖动挡在 NAS 后面：设备侧是局域网，NAS 手里常备十几秒存量。
    if (p.startsWith('/radio/')) {
      if (!mediaFlags().radio) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('网络电台已关闭');
      }
      const b64 = p.slice(7).replace(/\/+$/, '');
      // ★ v1.4.0：只有**显式**要求 ?fmt=wav|pcm 才把直播流转码。
      //   默认不转：AlphaPi One 的收音机自带 MP3 解码器，转成 24KB/s 的 8bit WAV
      //   只会白占带宽、还多一层解码延迟；而完全没解码能力的小智版本才需要它。
      //   转码这条腿绕过 /radio 的预缓冲（ffmpeg 自己连上游），只当排障/兜底用。
      const fmtQ = String(u.searchParams.get('fmt') || '').toLowerCase();
      if (/^(wav|wav8|pcm|pcm8|u8)$/.test(fmtQ)) {
        let target = '';
        try { target = radioproxy.decTarget(b64); } catch { target = ''; }
        if (target) return serveAudio(req, res, target, 'url');
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('电台地址解不开：' + b64.slice(0, 60));
      }
      // ★ serve() 是**同步**的：它只是把客户端挂到一个常驻的 Upstream 上，
      //   真正的数据由 Upstream 推。所以这里不能 await、也没有 promise 可接
      //   （第三版之前是 async 函数，同步化之后 `.catch()` 会直接 TypeError）。
      //   别 await 它结束 —— 电台是无限流，会一直挂到用户切台或关音箱。
      try {
        radioproxy.serve(b64, req, res, selfBase(req));
      } catch (e) {
        console.error('[radio] ' + e.message);
        try { res.end(); } catch { /* ignore */ }
      }
      return;
    }

    // ★ 本地音乐文件（原 r1-music 的 /music/<path>）。
    //   必须支持 Range：R1 的播放器会发 Range 请求（拖进度 / 续播），
    //   不认 Range 的服务器有些播放器连首帧都拿不到。
    /* ★ v1.6.1 `GET /ap/log?tag=&m=&mac=&ep=&kind=&a=&b=` —— 设备端事件上报。
       这块 STEM 的 USB-Serial-JTAG 在应用运行时打不出日志（三种握手都试过），
       "播几分钟就停"这种问题只能靠设备自己把原因吐回来。
       产出：console 一行 + `files/devlog.txt` 追加（超过 256KB 自动裁到最近 400 行）。 */
    if (p === '/log') {
      const tag = String(u.searchParams.get('tag') || '-').slice(0, 16);
      const msg = String(u.searchParams.get('m') || '').slice(0, 160);
      const mac = String(u.searchParams.get('mac') || '').slice(0, 16);
      const ep = u.searchParams.get('ep') || '';
      const kind = u.searchParams.get('kind') || '';
      const a = u.searchParams.get('a') || '';
      const b = u.searchParams.get('b') || '';
      const line = new Date().toISOString().replace('T', ' ').slice(0, 19)
        + ' ' + (mac || '-') + ' [' + tag + '] ' + msg
        + (ep !== '' ? ' ep=' + ep : '') + (kind !== '' ? ' kind=' + kind : '')
        + (a !== '' ? ' a=' + a : '') + (b !== '' ? ' b=' + b : '');
      console.log('[dev] ' + line);
      try {
        const f = path.join(__dirname, 'files', 'devlog.txt');
        fs.appendFileSync(f, line + '\n');
        if (fs.statSync(f).size > 256 * 1024) {
          const keep = fs.readFileSync(f, 'utf8').split('\n').slice(-400).join('\n');
          fs.writeFileSync(f, keep + '\n');
        }
      } catch { /* 只读/盘满就算了，别把日志变成故障 */ }
      return send(res, { ok: true });
    }

    /* ★ v1.6.1 `GET /ap/pos?q=书名&ep=N&sec=本集绝对位置秒&fin=0|1` —— 设备端主动
       "停推流 + 报位置"（按 C 暂停 / 说停 / 切歌 / 本集播完都走它）。
       为什么不靠 onEnd：那是 TCP 断开才触发，而且算的是**已写出的字节** —— 本地文件
       ffmpeg 转得比实时快十几倍，一次能把整集塞进 TCP 缓冲，bytes 直接等于"集尾"
       （实测 ss=600 只读 5 秒，记成 677s）。设备自己知道播到哪，它报的数才是权威。
       ★ sec 是**集内绝对位置**（设备那边 = 起点 X-Resume-Offset + 本次实播），
         所以这里**不能再加 entry.off** —— 那正是"起播点被算两遍"的来源。 */
    if (p === '/pos') {
      const qq = String(u.searchParams.get('q') || '').trim();
      const epq = Math.max(parseInt(u.searchParams.get('ep') || '0', 10) || 0, 0);
      const secRaw = Math.max(Number(u.searchParams.get('sec') || 0) || 0, 0);
      const absRaw = Math.max(Number(u.searchParams.get('abs') || 0) || 0, 0);
      const fin = u.searchParams.get('fin') === '1';
      // ★ v1.6.4：`beat=1` = 播放中的**周期心跳**（固件每 30s 一次），不是"这次播放结束了"。
      //   只刷新 pos，不许把记录标成 done/paused、也不许动 fin；但**必须置 devsync** ——
      //   它同样是"设备自己报的、权威的"位置，而且设备随后断电时，histEnd 的封顶兜底
      //   会拿它当"已经有人报过"的证据、自动让位，否则心跳刚写的位置会被字节数冲掉。
      const beat = u.searchParams.get('beat') === '1';
      let ent = histFindBook(req, qq, epq);
      if (!ent) {
        const dev = histLoad().devices[devIdOf(req)];
        ent = (dev && dev.last && dev.last.kind === 'book') ? dev.last : null;
      }
      if (ent) {
        // `abs` = 集内绝对位置（V2.4.6 固件给）；没这个参数就是老固件，按旧口径 sec+off。
        const secAbs = absRaw > 0 ? absRaw : secRaw + (Number(ent.off) || 0);
        const pos = (ent.dur > 0) ? Math.min(secAbs, ent.dur) : secAbs;
        ent.pos = Math.round(pos * 10) / 10;
        ent.devsync = true;     // ★设备报的，永不被字节数改写
        // ★ v1.7.21 统一设备列表：/ap/pos 与 /v1/pos 同口径 —— 每次上报都刷新
        //   histDevTouch（同书同集原地更新不刷屏），播放记录能认出是 stem 播的。
        //   设备名优先 X-Dev-Name 头（V2.4.14 固件起 pos/log 都带；老固件只有起播带过，
        //   设备记录里已有名字就用已有的）。
        histDevTouch(devIdOf(req),
          String(req.headers['x-dev-name'] || '').trim().slice(0, 24) || undefined,
          { kind: 'book', q: ent.q, title: ent.title || ent.book || ent.q,
            ep: ent.ep, pos: ent.pos, off: 0, done: false, src: ent.src });
        // ★ v1.7.13 P1 书级共享：设备报的权威位置同步进书级进度（换设备接着听就靠它）
        histBookSave({ book: ent.book || ent.q, q: ent.q, ep: ent.ep, pos: ent.pos,
          dur: ent.dur, fin: false, title: ent.title, dev: devIdOf(req),
          src: ent.src });
        if (beat) {
          // 心跳：只记"听到哪了"。done / endTs / paused / fin 一个都不碰 ——
          // 否则 Web 上正在播的一集会显示成"已播完"，续播判据也会被带偏。
          histTouch();
          return send(res, { ok: true, beat: 1, ep: ent.ep, pos: ent.pos });
        }
        // ★★ v1.6.6：fin 只认设备，不再用 pos 二次拦截（详见 apApplyPos 注释）。
        //   2026-11-11 实机第 6 集 dur=828s(13:48) 真播完，设备报 pos=602s(10:02)：
        //   播放泵每次「饿透重推头」把 dlSentTotal 清零 ⇒ mLibPlayedSec() 少算 226s；
        //   v1.6.5 的 apFinSane 因此把正确的 fin=1 拦下 ⇒ 记录停在半集、续播倒回同一集。
        const applied = apApplyPos(ent, pos, fin);
        // ★ v1.7.13 P1 书级共享：结算（暂停/播完/打断）也同步 —— fin 语义随 apApplyPos
        //   校正后的 ent.pos 一起落账，另一台设备据此「下一集开头 / 本集续播」。
        histBookSave({ book: ent.book || ent.q, q: ent.q, ep: ent.ep, pos: ent.pos,
          dur: ent.dur, fin: applied.fin === true, title: ent.title, dev: devIdOf(req),
          src: ent.src });
        // ★ v1.7.21 结算也刷设备列表（done=fin，暂停/播完/打断统一口径）
        histDevTouch(devIdOf(req),
          String(req.headers['x-dev-name'] || '').trim().slice(0, 24) || undefined,
          { kind: 'book', q: ent.q, title: ent.title || ent.book || ent.q,
            ep: ent.ep, pos: ent.pos, off: 0, done: applied.fin === true, src: ent.src });
        if (applied.corrected) {
          console.log('[hist] fin 位置校正：第 ' + ent.ep + ' 集设备报 ' + applied.from
            + 's / 本集 ' + ent.dur + 's ⇒ 按集尾记账（位置少算不影响 fin）');
        }
        histTouch();
        console.log('[hist] 设备上报位置「' + (ent.book || ent.q) + '」第 ' + ent.ep
          + ' 集 → pos=' + (ent.pos || 0).toFixed(0) + 's'
          + (fin ? '（本集播完）' : ''));
      } else {
        console.log('[hist] 设备上报位置但没有可结算的记录（q=' + qq + ' ep=' + epq + '）');
      }
      return send(res, { ok: !!ent, ep: ent ? ent.ep : 0, pos: ent ? ent.pos : 0 });
    }

    /* ★ v1.5.1 `/ap/play?kind=song|radio|book&q=...` —— 小智语音「放歌 / 听电台 / 听书」的唯一出口。
       一律回 **裸 PCM**（raw），设备端不做任何容器解析：
         kind=song  q=关键词  idx=跳过前 N 首  n=最多连播几首（默认 6，上限 8）
         kind=radio q=台名
         kind=book  q=书名    ep=集数(0=续播)   n=连播几集（默认 1，上限 5）
       多个曲目由 ffmpeg concat 成**一条**流 ⇒ 设备端没有队列，播完即 EOF。
       电台例外：无限流，永远不 EOF，只能靠用户说停/切台。 */
    if (p === '/play') {
      if (!isAlphaPi(req)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('这是 AlphaPi 专用播放口：请用 /ap/play?kind=song&q=歌名');
      }
      let kind = String(u.searchParams.get('kind') || 'song').trim().toLowerCase();
      const q = String(u.searchParams.get('q') || u.searchParams.get('k') || '').trim();
      const idx = Math.max(parseInt(u.searchParams.get('idx') || u.searchParams.get('skip') || '0', 10) || 0, 0);
      const nRaw = parseInt(u.searchParams.get('n') || '0', 10) || 0;
      const ep = Math.max(parseInt(u.searchParams.get('ep') || '0', 10) || 0, 0);
      const ss = Math.max(Number(u.searchParams.get('ss') || 0) || 0, 0);
      const o = apOpts(req);
      const opt = { raw: true, rate: o.rate, bits: o.bits, ch: o.ch, gainDb: o.gainDb };
      // 裸流不需要 chunked：设备"读到连接关闭"，帧边界越少越稳（同 /ap/song）
      res.useChunkedEncodingByDefault = false;
      res.setHeader('Connection', 'close');

      // ★ v1.7.25：书名撞歌名兜底 —— 小智 LLM 有时把「继续播放凡人修仙传」路由成
      //   play_song（曲库点歌），曲库上游能搜出一堆同名同人歌（实测 52 首），书永远续不上，
      //   听感就是「说继续播放没反应/放了些不相干的歌」。
      //   q 在书架缓存里**精确命中书名**（normQ 归一化全等）⇒ 它其实是一本已缓存的书，
      //   改按 kind=book 处理：play_song 不带 ep ⇒ ep=0 ⇒ 服务端 histResume 续到上次
      //   听到的地方（v1.7.24 起在线书也带集内偏移）。本地曲库有同名文件的仍优先点歌
      //   ——用户自己的歌单意图明确，不该被书抢走。
      if (kind === 'song' && q) {
        let abIsBook = false;
        try { abIsBook = !!abcache.byTitle(q); } catch { abIsBook = false; }
        if (abIsBook) {
          let locHit = false;
          try {
            const tracks = await local.list();
            const k = q.toLowerCase();
            locHit = tracks.some(t => String(t.title || '').toLowerCase() === k);
          } catch { locHit = false; }
          if (!locHit) {
            console.log('[ap] 「' + q + '」命中书架（LLM 误路由成点歌）→ 转有声书续播');
            kind = 'book';
          }
        }
      }

      if (kind === 'radio') {
        const r = apPickRadio(q);
        if (r.err) {
          console.log('[ap] 电台「' + q + '」' + r.err);
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(r.err + (r.list && r.list.length ? '\n现有：' + r.list.join(' / ') : ''));
        }
        console.log('[ap] 电台「' + q + '」→ ' + r.hit.name);
        try { res.setHeader('X-Radio-Name', encodeURIComponent(r.hit.name)); } catch { /* ignore */ }
        // ★ v1.6.5：当前播放信息（固件 current_play 工具答"现在放的是什么"用）
        try { res.setHeader('X-Media-Title', encodeURIComponent(String(r.hit.name).slice(0, 60))); } catch { /* ignore */ }
        const ent = histStart(req, { kind: 'radio', q, title: r.hit.name, live: true,
          src: 'radio' });
        // ★ v1.7.27 P1 收尾：电台也进共享表（kind=radio）——radio 没有进度概念，
        //   记的是「最近谁在听哪个台」，Web 共享区可见；跨设备续播=换台再说台名。
        histBookSave({ book: q, q, kind: 'radio', ep: 0, pos: 0, fin: false,
          title: r.hit.name, dev: devIdOf(req), src: 'radio' });
        return tc.serve(req, res, Object.assign({
          input: r.hit.url, kind: 'url', tag: 'radio:' + r.hit.name,
          onEnd: e => histEnd(ent, e.sec),
        }, opt));
      }

      if (kind === 'book') {
        // ★ v1.6.0：ep=0 = 续播 —— 先看**这台设备**上次听到哪（10s 回退），
        //   没有记录再退回本地书库自带的 lastEp。
        const rm = ep ? null : histResume(req, q, 'book');
        const resume = rm ? {
          ep: rm.ep || 1,
          off: Math.max(0, (rm.pos || 0) - 10),
          nextEp: !!rm.nextEp,     // ★ v1.6.2：上一集已听完 ⇒ 从下一集开头起，且越界即全家完
        } : null;
        if (resume) {
          console.log('[hist] ' + (resume.nextEp ? '上一集已听完，续到' : '续播')
            + '「' + q + '」第 ' + resume.ep + ' 集 +' + resume.off.toFixed(0) + 's'
            + (resume.nextEp ? '' : '（上次 ' + (rm.pos || 0).toFixed(0) + 's）'));
        }
        const r = await apBookItems(q, ep, nRaw || 1, resume, ss)
          .catch(e => ({ err: String(e && e.message || e) }));
        if (r.err) {
          console.log('[ap] 有声书「' + q + '」' + r.err + (r.tail ? '（正常收尾）' : ''));
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(r.err);
        }
        console.log('[ap] 有声书「' + r.book + '」第 ' + r.from + ' 集起 ' + r.items.length
          + ' 集（' + (r.local ? '本地' : '在线') + '，共 ' + (r.total || '?') + ' 集'
          + (r.off ? '，跳 ' + r.off.toFixed(0) + 's' : '') + '）');
        try {
          // ★ 只回两个短头：设备侧响应头缓冲只有 512B，别塞书名（中文百分号编码能吃 100+ 字节）
          res.setHeader('X-Book-Ep', String(r.from));
          res.setHeader('X-Resume-Offset', String(Math.round(r.off || 0)));
          // ★ v1.6.5：这集的时长（秒）——设备拿它判断"流是不是被提前掐断"（见固件 V2.4.10）
          if (r.dur > 0) res.setHeader('X-Book-Dur', String(Math.round(r.dur)));
          // ★ v1.6.5：当前播放信息 —— 书名 · 演播 · 第 N 集 集题（有谁给谁，60 字内）
          {
            const bn = [r.series, r.bookTitle || r.book].filter(Boolean).join(' · ');
            const mTitle = [bn, r.narrator,
              '第 ' + r.from + ' 集' + ((r.items[0] && r.items[0].title) ? ' ' + r.items[0].title : '')]
              .filter(Boolean).join(' · ');
            try { res.setHeader('X-Media-Title', encodeURIComponent(String(mTitle).slice(0, 60))); }
            catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        const bookT0 = Date.now();   // ★ v1.6.4：墙钟起点（断电兜底要用）
        const ent = histStart(req, {
          kind: 'book', q, book: r.bookTitle || r.book, title: r.items[0].title || '',
          ep: r.from, off: Math.round(r.off || 0),
          // ★ v1.6.3：起播就先把 pos 记成起点 —— 万一设备没来得及上报就掉线，
          //   Web 显示的是"这集从哪开始听的"，而不是刺眼的 0:00。
          pos: Math.round(r.off || 0),
          dur: r.dur || 0, total: r.total || 0, local: !!r.local,
          src: r.local ? 'local_program' : 'online_program',
        });
        // ★ v1.7.13 P1 书级共享：起播即落书级进度（ep/起点、清上一轮 fin）——
        //   本机没记录的新设备下一次 ep=0 就能从这条共享进度接着听。
        histBookSave({ book: r.bookTitle || r.book, q, ep: r.from,
          pos: Math.round(r.off || 0), dur: r.dur || 0, fin: false,
          title: (r.items[0] && r.items[0].title) || '', dev: devIdOf(req),
          src: r.local ? 'local_program' : 'online_program' });
        return tc.serve(req, res, Object.assign({
          items: r.items, tag: 'book:' + r.book,
          // ★ v1.6.3：设备这条流**只用 onEnd 收尾，不用它的字节数**（见 histEnd 注释）。
          //   位置与"是否播完"都等设备 /ap/pos 来定，它才听得见自己播到哪。
          // ★ v1.6.4：再传一个 wall（开流到断开的墙钟秒数）—— 设备一条上报都没发
          //   （断电）时，histEnd 用 min(bytes, wall) 兜一个保守位置，别整段丢掉。
          onEnd: e => histEnd(ent, e.sec, {
            reason: e.reason, trustBytes: false, wall: (Date.now() - bookT0) / 1000,
          }),
        }, opt));
      }

      if (kind !== 'song') {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('kind 只支持 song / radio / book，收到：' + kind);
      }

      const meta = await apSongMeta(q).catch(() => []);
      if (!meta.length) {
        console.log('[ap] /play 点歌「' + q + '」没找到任何结果');
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('没找到：' + q);
      }
      // ★ v1.7.27 P1 收尾：歌单跨设备续播 —— idx 没显式给（=0）时查历史
      //   （本机 vs 共享，谁新听谁）。优先按上次那首的标题在新候选里定位（顺序会变），
      //   找不到再按 idx 落位。ep=idx+1（共享表里「第几首」1 基）。
      if (!idx && !ep) {
        const rsm = histResume(req, q, 'song');
        if (rsm && rsm.kind === 'song') {
          let want = -1;
          const t0 = String(rsm.title || '').toLowerCase().replace(/\s+/g, '');
          if (t0) {
            for (let i = 0; i < meta.length; i++) {
              const t1 = String((meta[i] && meta[i].title) || '').toLowerCase().replace(/\s+/g, '');
              if (t1 && t1 === t0) { want = i; break; }
            }
          }
          if (want < 0) want = Math.max(0, Math.min(rsm.idx || 0, meta.length - 1));
          if (want > 0 && want < meta.length) {
            idx = want;
            console.log('[hist] 歌单续播「' + q + '」第 ' + (idx + 1) + ' 首「'
              + ((meta[idx] && meta[idx].title) || '') + '」'
              + (rsm.shared ? '（共享自 ' + (rsm.dev || '?') + '）' : '（本机）'));
          }
        }
      }
      const take = Math.min(Math.max(nRaw || 6, 1), 8);
      const slice = meta.slice(idx, idx + take);
      if (!slice.length) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('这个列表只有 ' + meta.length + ' 首，没有第 ' + (idx + 1) + ' 首了');
      }
      const items = await apToItems(slice);
      if (!items.length) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('取不到音频链：' + q);
      }
      console.log('[ap] 歌单「' + q + '」' + (idx ? '跳过 ' + idx + ' 首，' : '')
        + '共 ' + meta.length + ' 首候选 → 本次连播 ' + items.length + ' 首：'
        + items.map(x => x.title).join(' / ').slice(0, 160));
      const ent = histStart(req, {
        kind: 'song', q, title: items[0].title || q, idx,
        tracks: items.map(x => x.title).slice(0, 8), src: 'online_music',
      });
      // ★ v1.7.27 P1 收尾：歌也落共享表（kind=song，ep=第几首 1 基）——
      //   换设备说同一个词「继续听」能从上次那首接上。歌没有逐曲边界（ffmpeg
      //   concat 单进程），曲内秒数不做跨设备（诚实降级：从那首开头放）。
      histBookSave({ book: q, q, kind: 'song', ep: idx + 1, pos: 0, dur: 0,
        fin: false, title: (items[0] && items[0].title) || q,
        tracks: items.map(x => x.title).slice(0, 8), dev: devIdOf(req),
        src: 'online_music' });
      // ★ v1.6.5：当前播放信息 —— 第一首「歌名 - 歌手」
      {
        const t0 = items[0] || {};
        const mTitle = String(t0.title || q) + (t0.artist ? ' - ' + t0.artist : '');
        try { res.setHeader('X-Media-Title', encodeURIComponent(mTitle.slice(0, 60))); } catch { /* ignore */ }
      }
      return tc.serve(req, res, Object.assign({
        items, tag: 'song:' + q,
        onEnd: e => histEnd(ent, e.sec),
      }, opt));
    }

    /* ★ v1.5.0 `/ap/song?q=关键词&raw=1` —— 小智（AlphaPi STEM）语音点歌的"一步到位"入口：
       搜一首 → 取链 → 直接转成 8bit/24000 单声道裸 PCM 推出去。设备端只做两件事：
       读到连接关闭之前的所有字节、把它们塞进播放 FIFO（它没有解码器，也不该有）。
       ★响应刻意**不用 chunked**（useChunkedEncodingByDefault=false + Connection: close）：
       设备是"一次性 GET + 读到关闭"，帧边界解析越少越不容易在真机上翻车。
       （固件里仍保留 chunked 解码分支，服务端换实现也不会变沙沙声。） */
    if (p === '/song') {
      if (!isAlphaPi(req)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('这是 AlphaPi 专用点歌口：请用 /ap/song?q=歌名');
      }
      const q = (u.searchParams.get('q') || u.searchParams.get('k') || '').trim();
      if (!q) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('缺少 q（歌名/歌手）');
      }
      const pick = await apPickSong(q).catch(() => null);
      if (!pick) {
        console.log('[ap] /song 「' + q + '」没找到可播的');
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('没找到：' + q);
      }
      console.log('[ap] /song 「' + q + '」→ ' + pick.title + (pick.artist ? ' — ' + pick.artist : '')
        + ' [' + pick.via + ']');
      res.useChunkedEncodingByDefault = false;
      res.setHeader('Connection', 'close');
      return serveAudio(req, res, pick.input, pick.kind);
    }

    if (p.startsWith('/m/')) {
      // 本地库关了 ⇒ 文件也不给（否则 index 里没了、还能靠残留 URL 播，口径不一致）
      // ★ v1.2.0：本地有声书库开着时也放行 —— 它同样走 /m/<rel> 播，
      //   不能因为「本地音乐库」关着就把有声书一起锁死。
      if (!mediaFlags().local && !mediaFlags().abLocal) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('本地音乐库已关闭');
      }
      let rel = '';
      try { rel = decodeURIComponent(p.slice(3)); } catch { rel = p.slice(3); }
      // ★ v1.2.1：有声书库是**独立挂载**（ABL_DIR），和音乐目录不是一个根，
      //   两个根都认；先音乐后有声书（同一路径不会重名）。
      let isAbl = false;
      let abs = local.absOf(rel);
      if (!abs || !fs.existsSync(abs)) {
        abs = ablocal.absOf(rel);
        isAbl = !!(abs && fs.existsSync(abs));     // 本地有声书根命中
      }
      if (!abs || !fs.existsSync(abs)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('本地曲库里没有这个文件：' + rel);
      }
      // ★ v1.7.7 本地直链播放也落记录（R1 本地歌/本地书走 /m/，此前不进 history）。
      //   只记音频；AlphaPi 不记（/ap/play 已记账，避免双份）；120s 去重防 Range 刷。
      // ★ v1.7.36：改成「真播才落」——构造 commit 闭包交给 sendLocalFile，等它真实
      //   传输够 PLAY_COMMIT_BYTES 才调用；探活/预取只拿几 KB 就断 ⇒ 不落。
      const ctM = mimeAny(rel);
      let onCommitM = null;
      // HEAD = device probeUrl() 取链探活，没真播，不落记录（v1.7.35）
      if (/^audio\//i.test(ctM) && !isAlphaPi(req) && !isPlayProbe(req)) {
        const hkM = devIdOf(req) + '|m|' + rel;
        const seg0 = rel.split('/')[0] || '';
        const baseM = (rel.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '');
        /* ★ v1.7.43：本地书身份以 ablocal 反查为准，**不再拿目录名当书名**。
           目录名常是「道诡异仙 - 狐尾的笔 - 演播…- Zm」这种长串，而本地库/player/device
           用的都是「道诡异仙」⇒ 同一本书在记录里裂成两条。反查不到（比如目录刚删、
           还没重扫）才退回老口径。 */
        const bl = isAbl ? ablocal.bookOfRel(rel) : null;
        const epM = isAbl ? (Number((/第\s*(\d+)\s*[集回]/.exec(baseM) || [])[1]) || 0) : 0;
        const recM = isAbl ? {
          kind: 'book', q: bl ? bl.name : seg0, book: bl ? bl.name : seg0,
          ep: bl ? bl.ep : epM,
          title: (bl && bl.title) ? bl.title : baseM,
          artist: '', local: true, dur: 0,
          src: 'local_program',
        } : {
          kind: 'song', q: seg0, title: baseM, artist: '', local: true, dur: 0,
          src: 'local_music',
        };
        onCommitM = () => {
          // ★ v1.7.37：R1 拉流必须带 live=1（真播）才落；预取曲无标记 ⇒ 不落。
          if (!isLiveCommit(req)) return;
          /* ★ v1.7.43：本地**书**一律不建 stream 行。两个原因：
             ① 书的「在播什么」由 device ProgProgress 权威上报（book+ep+pos），
                stream 记录分不清真播与预载（引擎预载下一首也带 live=1）；
             ② 本地书的 /m/ 地址由服务端自己生成，**不带 dev 参数**，没法按设备判，
                只能整类不建行。
             本地**音乐**没有 device 上报，照旧建行。 */
          if (recM.kind === 'book') return;
          if (HIST_SEEN.has(hkM) && Date.now() - HIST_SEEN.get(hkM) <= 120000) return;
          if (HIST_SEEN.size > 4000) HIST_SEEN.clear();
          HIST_SEEN.set(hkM, Date.now());
          histStart(req, recM).stream = true;
        };
      }
      // ★ v1.4.0：AlphaPi 请求音频 ⇒ 先转码（它没有解码器）；封面图等非音频照旧直发。
      const ct = mimeAny(rel);
      if (!/^image\//i.test(ct) && isAlphaPi(req)) {
        return serveAudio(req, res, abs, 'file', ct);
      }
      /* ★ v1.7.49：受限终端降档转码（R1 播 24bit FLAC 是「假播放」——状态在走但没声音，
         高码率长播还会原生崩溃）。
         · 只对**认得出身份的终端**生效：网页/浏览器直发原文件（它们解码正常，转了反而降音质）；
         · 判据是**规格**（无损/超采样率/超位深/多声道），不是"能不能播"——
           播放器自己都不知道自己没出声；
         · 命中缓存后是普通文件请求（能拖进度），首次则边转边发保证出声。 */
      if (/^audio\//i.test(ct)) {
        const prof = aac.profile(knownDevId(req));
        if (prof.on) {
          const j = await aac.judge(abs, rel, prof);
          if (j.need) {
            return aac.serve(req, res, {
              abs, rel, prof, ct, tag: rel, onCommit: onCommitM,
            });
          }
        }
      }
      return sendLocalFile(res, req, abs, ct, onCommitM);
    }

    // 重扫本地曲库（往音乐目录里丢完歌不想等缓存过期就点它）
    if (p === '/reindex') {
      local.reindex();
      const l = await local.list().catch(() => []);
      return send(res, { ok: true, tracks: l.length, radios: local.radios().length });
    }

    /* ★ v1.7.49：降档转码的运维面（只读 + 清缓存 + 设备档位）。
       为什么要对外露：这类问题（"在播但没声音"）现场只能靠规格说话，
       有个 /api/trans/probe 就能一眼看出"这个文件 24bit/96k ⇒ 必须转"。 */
    if (p === '/api/trans/stats') {
      const st = await aac.stats();
      st.warm = aac.warmInfo();
      return send(res, st);
    }

    /* ★ v1.7.54 转码设备白名单（数据源 = 已有的「设备分组」）。
       GET /api/trans/devs                → 设备列表 + 每台是否在转码列表
       GET /api/trans/devs?add=<MAC>      → 勾上（加入名单）
       GET /api/trans/devs?del=<MAC>      → 取消勾选（移出名单）
       名单本身存 files/audio_profiles.json 的键（非 `_` 开头的都是设备）。
       只列真实设备：`ip-xxx` / `unk` 这种匿名桶不给勾（勾了也没法稳定命中）。 */
    if (p === '/api/trans/devs') {
      const add = String(u.searchParams.get('add') || '');
      const del = String(u.searchParams.get('del') || '');
      if (add) aac.addDev(add);
      if (del) aac.delDev(del);
      const snap = dgSnapshot();
      const listed = aac.devList();
      /* ★ v1.7.55：标出 AlphaPi（小智）设备。它走 /ap/ 兼容层，无条件转 8bit/24k WAV，
         加不加进白名单都一样 —— 前端「＋」候选里就不给它出现，免得白点一次。
         判据只有设备名（设备分组里的名字是设备自报的，如 AlphaPi-STEM-AAA4），
         认不出也不影响功能（最多多出一条可点的候选，加了对 alpha 也无害）。 */
      const APNAME = /alpha\s*pi|小智|stem|esp\s*32/i;
      const devices = (snap.devices || [])
        .filter(d => d && d.id && !/^ip-/i.test(d.id) && d.id !== 'unk')
        .map(d => {
          const p = listed[d.id] || null;
          const nm = d.name || d.id;
          return {
            id: d.id, name: nm, grp: d.grp, grpName: d.grpName,
            solo: !!d.solo, seen: d.seen || 0, listed: !!p,
            ap: APNAME.test(String(nm)) || APNAME.test(String(d.id || '')),
            prof: p ? { codec: p.codec, br: p.br, rate: p.rate, ch: p.ch } : null,
          };
        });
      const anon = (snap.devices || [])
        .filter(d => d && /^ip-/i.test(String(d.id || '')))
        .map(d => ({ id: d.id, name: d.name || d.id, seen: d.seen || 0 }));
      return send(res, {
        ok: true, master: aac.globalOn(), devices, anon,
        groups: snap.groups || [], stats: await aac.stats(),
      });
    }

    /* 转码总闸：GET /api/trans/on 查询；?v=1 / ?v=0 切换。
       v1.7.54 起它只是**应急总闸** —— 真正决定谁转的是上面的设备白名单；
       总闸关掉 = 所有设备都直发（名单保留，重启/再打开后照旧生效）。 */
    if (p === '/api/trans/on') {
      const v = u.searchParams.get('v');
      if (v === null) return send(res, { ok: true, on: aac.globalOn(), listed: aac.info().listed, warm: aac.warmInfo() });
      return send(res, { ok: true, on: aac.setGlobal(v), listed: aac.info().listed, warm: aac.warmInfo() });
    }

    /* 预转：把要听的文件提前转好（转完就是秒开 + 可拖）。
       · ?rel=<路径>          单个文件
       · ?all=1&limit=500     整个本地音乐库（只挑判为需要转的入队）
       背景：这台 aarch64 转 24/96 只有 1~2x 实时，实时流式喂不饱播放器，
       所以体验好坏取决于「听之前有没有转好」。 */
    if (p === '/api/trans/prewarm') {
      const rel = String(u.searchParams.get('rel') || '').trim();
      const wantAll = u.searchParams.get('all') === '1';
      const lim = Math.min(Math.max(parseInt(u.searchParams.get('limit'), 10) || 500, 1), 2000);
      const prof = aac.profile(knownDevId(req));
      if (rel) {
        const a0 = local.absOf(rel) || ablocal.absOf(rel);
        if (!a0 || !fs.existsSync(a0)) return send(res, { ok: false, error: '文件不存在' }, 404);
        const j = await aac.judge(a0, rel, prof);
        const q = j.need ? aac.kick(a0, rel, prof) : false;
        return send(res, { ok: true, rel, need: j.need, why: j.why, queued: q, warm: aac.warmInfo() });
      }
      if (!wantAll) return send(res, { ok: false, error: '缺 rel，或 all=1' }, 400);
      const tracks = await local.list().catch(() => []);
      let need = 0, queued = 0, i = 0;
      for (const t of tracks) {
        if (i++ >= lim) break;
        const f = String((t && (t.file || t.rel)) || '');
        const a0 = f ? local.absOf(f) : '';
        if (!a0 || !fs.existsSync(a0)) continue;
        const j = await aac.judge(a0, f, prof);
        if (!j.need) continue;
        need++;
        if (aac.kick(a0, f, prof)) queued++;
      }
      return send(res, { ok: true, scanned: i, need, queued, warm: aac.warmInfo() });
    }

    /* 缓存上限：GET /api/trans/maxmb 查；?v=<MB> 设（0 / 空 = 回默认）。
       v1.7.53 之前这些值只出现在返回值里，enforceLimit 还读 DEF.maxMB，设了等于没设。 */
    if (p === '/api/trans/maxmb') {
      const v = u.searchParams.get('v');
      if (v === null) return send(res, { ok: true, maxMB: aac.maxMBof(), stats: await aac.stats() });
      const mb = aac.setMaxMB(v);
      return send(res, { ok: true, maxMB: mb, stats: await aac.stats() });
    }

    if (p === '/api/trans/purge') {
      const r = await aac.purge();
      return send(res, Object.assign({ ok: true }, r, { stats: await aac.stats() }));
    }

    if (p === '/api/trans/probe') {
      const rel = String(u.searchParams.get('rel') || '');
      if (!rel) return send(res, { ok: false, error: '缺 rel' }, 400);
      const a0 = local.absOf(rel) || ablocal.absOf(rel);
      if (!a0 || !fs.existsSync(a0)) return send(res, { ok: false, error: '文件不存在' }, 404);
      const inf = await aac.probe(a0, rel);
      const pf = aac.profile(knownDevId(req));
      const j = await aac.judge(a0, rel, pf);
      return send(res, { ok: true, rel, info: inf, judge: j, profile: pf });
    }

    /* 给某台设备单独设档：/api/trans/dev?id=98BB9936CD6B&br=128&lossless=0
       留空 id 表示只是预览默认档位。 */
    if (p === '/api/trans/dev') {
      const id = String(u.searchParams.get('id') || '').toUpperCase();
      if (!id) return send(res, { ok: true, def: aac.profile(''), all: aac.devList() });
      const patch = {};
      for (const k of ['on', 'codec', 'br', 'rate', 'ch', 'maxRate', 'maxBits', 'maxCh',
        'lossless', 'maxJobs', 'maxMB']) {
        const v = u.searchParams.get(k);
        if (v !== null) patch[k] = v;
      }
      return send(res, { ok: true, dev: aac.setDev(id, patch), all: aac.devList() });
    }

    // ★★ /s/<i>：曲库第 i 首。
    //     默认**流式转发**（DLNA 播放器不一定跟 302）；写 files/stream_redirect 改成 302。
    if (p.startsWith('/s/')) {
      const i = parseInt(p.slice(3), 10);
      const t = Number.isInteger(i) ? pool.at(i) : null;
      if (!t) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('曲库里没有第 ' + i + ' 首');
      }
      const r = await resolveUrl({
        rid: t.rid, source: t.source, title: t.title, artist: t.artist,
        fresh: u.searchParams.get('fresh') === '1',
      });
      if (!r.url) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('取链失败：' + (r.message || '未知原因'));
      }
      console.log('[mini-lx] /s/' + i + ' ' + t.title + ' — ' + t.artist + '  [' + r.viaSource + ']');
      songLearnPlay(t.title, t.artist, t.source, t.rid, t.album, '');   // ★ v1.7.19
      // ★ v1.4.0：AlphaPi ⇒ 必须先转码。注意**不能**走下面的 302 ——
      //   302 把设备直接甩到源站 mp3 上，等于绕过本机转码，没解码器的设备立刻哑火。
      if (isAlphaPi(req)) return serveAudio(req, res, r.url, 'url');
      if (fs.existsSync(path.join(__dirname, 'files', 'stream_redirect'))) {
        res.writeHead(302, { Location: r.url, 'Cache-Control': 'no-cache' });
        return res.end();
      }
      return pipeAudio(res, req, r.url);
    }


    // 单 URL 探针：在 NAS 上直接验某个直链/音源地址到底能不能放（排障用）
    // ★★ /r/<source>/<rid> —— 搜索结果的**惰性播放地址**（与 /s/<i> 同构，但不必入池）
    //
    //    为什么要有它：R1 语音「随机播放孙燕姿的歌」要一次推出十几首，
    //    而 /api/url 是**每条一次**取链（内部还要走 ⓪中继 → ①脚本 → ②③④⑤ 四级兜底，
    //    各级超时 12s）。十几首串行/并发下去就是几十秒，R1 那边 5s 预算一到
    //    只能拿到 0~4 首 ⇒ 「在线补充」形同虚设（用户实测：孙燕姿 0 首、周杰伦 4 首）。
    //    这里只登记 rid/source/title/artist，**真正播放那一刻**才取链并流式转发，
    //    和 /s/<i> 一样 —— 推列表从「十几秒」变成「一次搜索的工夫」。
    //    title/artist 用 query 带（跨源兜底要用，缺了就只有 rid 直取）。
    if (p === '/r/ping') return send(res, { ok: true, lazy: true, v: 1 });

    if (p.startsWith('/r/')) {
      const seg = p.slice(3).split('/').filter(Boolean);
      const src = seg[0] || 'kw';
      const rid = seg[1] || '';
      if (!rid) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('缺少 rid：/r/<source>/<rid>');
      }
      // 池里登记过这首就用池里的 title/artist（比 query 里的更准）
      const pt = pool.byRid(src, rid);
      const title = u.searchParams.get('title') || (pt && pt.title) || '';
      const artist = u.searchParams.get('artist') || (pt && pt.artist) || '';
      const t0 = Date.now();
      const r = await resolveUrl({
        rid, source: src, title, artist,
        fresh: u.searchParams.get('fresh') === '1',
      });
      if (!r.url) {
        // ★ v1.6.9：「播不了」第一现场 —— 按 rid 反查是哪本书哪一集，
        //   累计到阈值才把整本标 stale 重搜；一次网络抖动不毁永久缓存。
        const bad = abcache.badEp(src, rid, r.message || '取链失败');
        if (bad) console.log('[abcache] 取链失败 ' + bad.key + ' 第 ' + bad.ep
          + ' 集（累计 ' + bad.fails + ' 次）' + (bad.stale ? ' ⇒ 整本待重搜' : ''));
        console.log('[mini-lx] /r/' + src + '/' + rid + ' 取链失败：'
          + (r.message || '未知原因') + '  ' + (Date.now() - t0) + 'ms');
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('取链失败：' + (r.message || '未知原因'));
      }
      abcache.markRidPlay(src, rid);     // 「播过」：多设备共享同一条使用记录
      // ★ v1.7.6 设备救援回传：R1 点缺集会自己搜到 rid 直接 /r/ 播（title 还是占位
      //   文案）—— 结果此前不回传，服务端缓存永远灰着、别的设备还得重搜一遍。
      //   这里按占位文案里的集号 + 主播 + siGet 里的原始专辑信息，把 rid 学回缓存。
      //   学回成功顺手清掉该集的救援负缓存（设备都搜到了，说明值得再试）。
      let missEp = /上游没有第\s*(\d+)\s*集/.exec(String(title || ''));
      if (!missEp) {
        // ★ v1.7.9 列表简化后设备带的是「第 N 集」—— 只有当这个 rid **不在**
        //   缓存书目里（= 设备自己搜来的源）才判定为设备自救，正常集不误触发。
        const m2 = /^第\s*(\d+)\s*集$/.exec(String(title || '').trim());
        if (m2 && !abcache.bookByRid(src, rid)) missEp = m2;
      }
      if (missEp) {
        const si = siGet(src, rid);      // 设备救援经 /api/search 搜的 ⇒ 原始真信息在暂存
        const info = si ? { title: String(si.name || ''), album: String(si.albumName || ''),
                            albumId: String(si.albumId || ''), duration: String(si.interval || '') } : null;
        const epN2 = Number(missEp[1]) || 0;
        const bk = abcache.rescueFromPlay(src, rid, epN2, artist, info);
        if (bk) {
          RESCUE_FAIL.delete(bk.key + ':' + bk.ep);
          console.log('[abcache] 设备救援回传：' + bk.book + ' 第' + bk.ep + '集 ← rid=' + rid
            + (info ? '（含真标题/专辑）' : '（无暂存信息，先落兜底标题，后台精确词补真名）'));
        } else if (info) {
          // 占位已被上一次回传填掉：若当时缺暂存用了兜底标题 → 用这次的真信息补
          const pk = abcache.patchRescueMeta(src, rid, epN2, info);
          if (pk) console.log('[abcache] 救援回传补真标题：第' + epN2 + '集 ← ' + info.title);
        } else {
          // 无暂存 + 已回传过 → 后台精确词搜一次，按 rid 对上号补真标题（不挡播放）
          const rb = abcache.bookByRid(src, rid);
          if (rb && /（设备救援回传）$/.test(rb.title)) {
            abcache.once('patchmeta:' + src + ':' + rid + ':' + epN2, async () => {
              // ★ v1.7.8 补真名 = 复跑一遍常规救援（abRescueEp 四词形 + 评分）拿候选：
              //   · 候选 rid 与回传 rid **一致** → 同一条，完整补齐（title/album/时长）；
              //   · rid **不一致**（设备走的 rid 搜索里捞不出，实测遮天 260 连全量
              //     枚举都没有）→ 大概率同一集的另一个源：只借真标题贴到旧 rid 上
              //     —— 旧 rid 是设备实际播出验证过的，不能换成没播过的新 rid。
              const fullP = abcache.byKey(rb.key);
              if (!fullP || !Array.isArray(fullP.list)) return;
              const cand = await abRescueEp(fullP, epN2, src).catch(() => null);
              if (!cand || !cand.rid) return;
              if (String(cand.rid) === String(rid)) {
                const pk = abcache.patchRescueMeta(src, rid, epN2, {
                  title: String(cand.title || ''), album: String(cand.album || ''),
                  albumId: String(cand.albumId || ''), duration: String(cand.duration || ''),
                });
                if (pk) console.log('[abcache] 救援复跑对号 rid 一致，补齐真名：'
                  + rb.book + ' 第' + epN2 + '集 ← ' + cand.title);
              } else {
                const pk = abcache.patchRescueMeta(src, rid, epN2, {
                  title: String(cand.title || ''), album: String(cand.album || ''),
                });
                if (pk) console.log('[abcache] 救援复跑 rid 不一致（旧=' + rid + ' 新='
                  + cand.rid + '），借真标题保留旧 rid：' + rb.book + ' 第' + epN2 + '集 ← ' + cand.title);
              }
            }).catch(() => {});
          }
        }
      }
      // ★ v1.7.7 直链播放落记录（P1 痛点 #1：R1 的 /r/ 播放此前一次都不进 history）。
      //   rid 在缓存书目里 → kind=book（书/集/主播齐）；不在 → kind=song。
      //   /r/ 流的位置服务端无从得知（设备未接 /pos），标 stream=true、pos 留空。
      // ★ v1.7.36：改成「真播才落」——commit 闭包交给 pipeAudio，等它真实传输够
      //   PLAY_COMMIT_BYTES 才落；player 装载队列时对预取曲只发 GET 拿几 KB 就断 ⇒ 不落。
      //   HEAD（v1.7.35 probeUrl）一律不落。
      const rb7 = abcache.bookByRid(src, rid);
      const hk7 = devIdOf(req) + '|' + src + '|' + rid;
      // 占位文案不上记录标题：用缓存里的真名（回传后就有）
      const tShow = (rb7 && /上游没有第\s*\d+\s*集/.test(String(title || '')))
        ? (rb7.title || title) : (title || (rb7 && rb7.title) || rid);
      const rec7 = rb7 ? {
        kind: 'book', q: rb7.book, book: rb7.book, ep: rb7.ep,
        title: String(tShow), artist: String(artist || rb7.narrator || ''),
        source: src, rid, dur: 0, src: 'online_program',
      } : {
        kind: 'song', q: String(title || ''), title: String(tShow),
        artist: String(artist || ''), source: src, rid, dur: 0,
        src: 'online_music',
      };
      const commit7 = () => {
        // ★ v1.7.37：R1 拉流必须带 live=1（真播）才落；预取曲无标记 ⇒ 不落。
        if (!isLiveCommit(req)) return;
        /* ★ v1.7.43：会自己上报进度的设备（R1）⇒ 书不建 stream 行，行由 device 上报建。
           预载也会带 live=1，stream 记录分不出「真播 / 预载」，留着只会刷出假集号。 */
        if (rec7.kind === 'book' && isReportingDev(req)) return;
        if (HIST_SEEN.has(hk7) && Date.now() - HIST_SEEN.get(hk7) <= 120000) return;
        if (HIST_SEEN.size > 4000) HIST_SEEN.clear();
        HIST_SEEN.set(hk7, Date.now());
        histStart(req, rec7).stream = true;
      };
      const probe7 = isPlayProbe(req);
      const devTag7 = devIdOf(req);
      const liveTag7 = isLiveCommit(req) ? 'LIVE' : 'prefetch';
      console.log('[mini-lx] /r/' + src + '/' + rid + ' ' + title + ' — ' + artist
        + '  [' + r.viaSource + '] ' + (Date.now() - t0) + 'ms'
        + (probe7 ? ' (probe)' : '')
        + '  [dev=' + devTag7 + ' ' + liveTag7 + ']');
      if (!rb7) songLearnPlay(title, artist, src, rid, '', '');   // ★ v1.7.19：歌才入库（rb7=书）
      // ★ v1.4.0：同上，AlphaPi 一律本机转码，绝不 302 到源站。
      //   AlphaPi 转码路径（tc.serve）与 302 分支不走 pipeAudio，无法挂字节计数 ⇒
      //   保持原「到达即落」行为（probe 仍排除）；只有 R1 的 pipeAudio 走延迟真播判定。
      if (isAlphaPi(req)) {
        if (!probe7) commit7();
        return serveAudio(req, res, r.url, 'url');
      }
      if (fs.existsSync(path.join(__dirname, 'files', 'stream_redirect'))) {
        if (!probe7) commit7();
        res.writeHead(302, { Location: r.url, 'Cache-Control': 'no-cache' });
        return res.end();
      }
      return pipeAudio(res, req, r.url, probe7 ? null : commit7);
    }

    if (p === '/api/probe') {
      const target = u.searchParams.get('u') || '';
      if (!target) return send(res, { error: '缺少 u 参数' }, 400);
      const t0 = Date.now();
      const pr = await probeUrl(target);
      return send(res, Object.assign({ url: target, ms: Date.now() - t0 }, pr));
    }

    // ---------------------------------------------------- 音源脚本管理
    if (p === '/api/script') {
      return send(res, {
        loaded: !!rt,
        name: rtName,
        error: rtErr,
        meta: rt ? rt.meta : null,
        sources: rt ? [...rt.scripts.entries()].map(([source, v]) => ({
          source, actions: v.actions, qualitys: v.qualitys,
        })) : [],
        stored: (() => {
          try { return fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.js')); } catch { return []; }
        })(),
        current: rtName,
      });
    }

    // ★ 网易登录态 cookie：填了才能取 VIP / 无版权曲的原版直链
    //   GET  查看是否已配置（只回显前 8 位，不泄露完整 cookie）
    //   POST {cookie:"MUSIC_U=..."}  写入 files/wy_cookie 并立即生效
    if (p === '/api/cookie') {
      if (req.method === 'POST') {
        const raw = await readBody(req);
        const d = JSON.parse(raw || '{}');
        const v = String(d.cookie || '').trim();
        try {
          fs.mkdirSync(path.join(__dirname, 'files'), { recursive: true });
          if (v) fs.writeFileSync(path.join(__dirname, 'files', 'wy_cookie'), v);
          else try { fs.unlinkSync(path.join(__dirname, 'files', 'wy_cookie')); } catch { /* 本来就没有 */ }
        } catch (e) {
          return send(res, { ok: false, error: '写入失败: ' + (e && e.message || e) }, 500);
        }
        S.wySetCookie(v);
        return send(res, { ok: true, set: !!v, hint: v ? '' : '已清空，回到匿名模式' });
      }
      const c = S.wyGetCookie();
      return send(res, { set: !!c, masked: c ? c.slice(0, 12) + '…(共' + c.length + '字符)' : '' });
    }

    if (p === '/api/script/import' && req.method === 'POST') {
      const raw = await readBody(req);
      const d = JSON.parse(raw || '{}');
      let code = d.text;
      let name = d.name || '';
      if (!code && d.url) {
        // ★ 逐个镜像试（见 downloadScript 的注释：raw.githubusercontent 直连常被掐，
        //   ghproxy 现在 403，jsdelivr 通），全失败时把每个候选的原因回给 UI。
        const r = await downloadScript(String(d.url));
        if (!r.ok) {
          return send(res, {
            ok: false,
            error: '下载失败：' + (r.tried[0] ? r.tried[0].err : '无候选'),
            tried: r.tried,
            hint: /ENOTFOUND|域名解析/.test(JSON.stringify(r.tried))
              ? '域名已经解析不到了 —— 这个音源链接多半已经作废，换个源或改用「粘贴代码」导入。'
              : '直连被掐时会自动试 jsdelivr 镜像；全挂就是这条链路在你网络里不可用，可直接粘贴脚本内容导入。',
          }, 400);
        }
        code = r.code;
        name = name || decodeURIComponent(String(r.url).split('/').pop() || 'imported.js').split('?')[0];
      }
      if (!code || !String(code).trim()) return send(res, { ok: false, error: '缺少 text 或 url' }, 400);
      name = (name || 'imported.js').replace(/[\\/:*?"<>|]/g, '_');
      if (!name.endsWith('.js')) name += '.js';
      try {
        const sources = mountRuntime(code, name);
        try {
          if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
          fs.writeFileSync(path.join(SCRIPTS_DIR, name), code, 'utf8');
        } catch (e) { console.log('[mini-lx] 脚本落盘失败（不影响使用）: ' + e.message); }
        return send(res, { ok: true, name, meta: rt.meta, sources });
      } catch (e) {
        return send(res, { ok: false, error: String(e && e.message || e).slice(0, 300) }, 400);
      }
    }

    if (p === '/api/script/clear' && req.method === 'POST') {
      const was = rtName;
      if (rt) rt.clear();
      rt = null; rtName = null; rtErr = null;
      clearUrlCache();
      forgetScript();
      // ★ 只删「当前这一个」，scripts/ 里的其它脚本留着（UI 的 stored 列表还能看到）
      let removed = false;
      try {
        if (was) {
          const f = path.join(SCRIPTS_DIR, was);
          if (fs.existsSync(f)) { fs.unlinkSync(f); removed = true; }
        }
      } catch { /* 删不掉就算了，反正已 forget */ }
      return send(res, { ok: true, removed: removed ? was : '' });
    }

    // ★ 落雪 docker（lxserver）地址 —— 取链的**唯一**通道，Web 音源页直接改。
    //   以前要 SSH 进 NAS 手改 files/my_lx；现在页面上填完顺手做一次连通自检，
    //   填错地址立刻看得见（否则要等到「点一首歌没声」才发现）。
    //   内容两行：第一行 base，第二行 用户名:Token（lxserver 的持久化 API Token）。
    // ★ 落雪链路一键自检（1.1.0）：Web「测一下」按钮和远程排障都用它。
    if (p === '/api/lx/selftest') {
      return send(res, await lxSelfTest());
    }

    if (p === '/api/lx') {
      const FLAG = path.join(__dirname, 'files', 'my_lx');
      if (req.method === 'POST') {
        const body = await readBody(req).then(JSON.parse).catch(() => ({}));
        const b = String(body.base || '').trim().replace(/\/+$/, '');
        const u = String(body.user || '').trim();
        const tk = String(body.token || '').trim();
        if (!/^https?:\/\//.test(b)) {
          // 空 = 停用（删掉 flag 文件）
          try { fs.unlinkSync(FLAG); } catch { /* 本来就没有 */ }
          lxOk();
          return send(res, { ok: true, base: '', msg: '已停用落雪 docker（取链会直接报失败）' });
        }
        const t0 = Date.now();
        let probe = { status: 0, ms: 0 };
        try {
          const r = await fetch(b + '/', {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(6000),
          });
          probe = { status: r.status, ms: Date.now() - t0 };
        } catch (e) {
          probe = { status: 0, ms: Date.now() - t0, err: String((e && e.message) || e).slice(0, 90) };
        }
        const lines = [b];
        if (u && tk) lines.push(u + ':' + tk);
        try {
          fs.mkdirSync(path.dirname(FLAG), { recursive: true });
          fs.writeFileSync(FLAG, lines.join('\n') + '\n');
        } catch (e) {
          return send(res, { ok: false, error: '写 files/my_lx 失败：' + String(e && e.message || e) }, 500);
        }
        lxOk();               // 换了地址就把旧负缓存抹掉，别让上一台的错误挡着
        // ★ 1.1.0：保存后直接跑五步真自检 —— 首页连通 ≠ 取链可用
        //（威联通案例：首页秒回，/api/music/url 每档 12s 全超时）。
        const test = await lxSelfTest();
        return send(res, { ok: true, base: b, user: u, token: tk ? 'set' : '', probe, test });
      }
      const a = lxrelay.auth();
      return send(res, {
        ver: MS_VER,
        base: lxrelay.base() || '',
        has: !!lxrelay.base(),
        user: (a && a.user) || '',
        token: (a && a.token) ? 'set' : '',
        dead: lxBlocked(),
        // ★ 1.1.0：真实取链的最近成败（Web 绿灯只认这个，不再「配置了就叫正常」）
        lastOk: lxLast.ok,
        lastBad: lxLast.bad,
        lastBadErr: lxLast.badErr,
      });
    }

    // ---------------- 有声书（v1.3.262 设备侧 ab_* MCP 的数据后端） ----------------
    // ============ v1.2.0：NAS 本地有声书库（ablocal.js）================
    // 与在线书库两条腿：在线靠落雪搜平台，本地扫 /music 挂载目录里的文件。
    // 契约与在线版保持一致（books → episodes → 播放），只是 url 直接是 /m/<rel>。
    //   GET  /api/abl/books?q=          书名列表（只给书名/集数/记忆，不吐集表）
    //   GET  /api/abl/eps?id=&page=&size=&q=&ep=   某书/子书的集表（点开才拉）
    //   POST /api/abl/pos  {id,ep,pos,title}      记播放进度（按书/子书各一份）
    //   POST /api/abl/pos/clear {id}              清记忆（父级=连子书一起清）
    //   GET  /api/abl/rescan                      强制重新扫盘
    if (p === '/api/abl/books') {
      if (!mediaFlags().abLocal) return send(res, { off: true, total: 0, books: [] });
      const r = ablocal.books(u.searchParams.get('q') || '');
      /* ★ v1.2.2：封面在书列表里原本是相对地址 /m/…（ablocal 不知道自己在哪个 IP 上），
         而 R1 网页是**设备地址**打开的 ⇒ 相对路径会打到设备 8080，封面 404（图裂但
         onerror 一隐藏就看不出问题）。这里跟集表一样补成 NAS 绝对地址。 */
      const self = selfBase(req);
      const ab = c => (c && c.charAt(0) === '/' ? self + c : c);
      for (const b of (r.books || [])) {
        b.cover = ab(b.cover);
        for (const sb of (b.subs || [])) sb.cover = ab(sb.cover);
      }
      return send(res, r);
    }
    if (p === '/api/abl/eps') {
      if (!mediaFlags().abLocal) return send(res, { off: true, error: '本地有声书库已关闭', episodes: [], total: 0 });
      const r = ablocal.episodes(u.searchParams.get('id') || '', {
        q: u.searchParams.get('q') || '',
        page: u.searchParams.get('page') || 1,
        size: u.searchParams.get('size') || 100,
        ep: u.searchParams.get('ep') || 0,
      });
      // ★ 给**绝对**地址：R1 网页(8080) 拿到就能直接丢给播放器，
      //   不用在前端拼 NAS 前缀（设备侧只做透传，少一处可错的拼装）。
      if (!r.error) {
        const self = selfBase(req);
        r.episodes = (r.episodes || []).map(e => Object.assign({}, e, { url: self + e.url }));
      }
      return send(res, r, r.error ? 404 : 200);
    }
    if (p === '/api/abl/pos') {
      // GET 也认（设备侧透传用，省一个 POST 通道）：?id=&ep=&pos=&title=
      let b = {};
      if (req.method === 'POST') b = await readBody(req).then(JSON.parse).catch(() => ({}));
      else b = { id: u.searchParams.get('id'), ep: u.searchParams.get('ep'),
                 pos: u.searchParams.get('pos'), title: u.searchParams.get('title') };
      return send(res, ablocal.setPos(b.id, b.ep, b.pos, b.title));
    }
    if (p === '/api/abl/pos/clear') {
      const b = await readBody(req).then(JSON.parse).catch(() => ({}));
      return send(res, ablocal.clearPos(b.id || ''));
    }
    if (p === '/api/abl/rescan') {
      ablocal.scan();
      const r = ablocal.books('');
      return send(res, { ok: true, total: r.total, at: r.at, dir: r.dir });
    }

    // ★ v1.7.30 拼音模糊：ASR 同音字纠偏（如「写你」→「仙逆」）。
    //   只查本地库 + 磁盘缓存两级，不回源在线（回源词本身错了，搜出来也是错书）。
    //   返回 [{...asBook, match:'pinyin', pyScore, pyHint}]，按分数降序。
    const abPinyinFuzzy = (q) => {
      const out = [];
      // 第一级：本地库（abLocal 开时）
      try {
        if (mediaFlags().abLocal) {
          const lr = ablocal.fuzzyBooks(q);
          for (const b of (lr.books || [])) out.push(Object.assign({
            book: b.name, narrator: b.narrator || '', albumId: b.id, source: 'abl',
            count: b.count, preview: [], cached: true,
            match: 'pinyin', pyScore: b.pyScore, pyHint: b.pyHint, local: true,
          }));
        }
      } catch (e) { console.warn('[pinyin] 本地库 fuzzy 失败：' + (e && e.message || e)); }
      // 第二级：磁盘缓存书架
      try {
        const d = abcache.load();
        const recs = Object.values(d.books || {});
        const hits = pinyin.fuzzySearch(q, recs);
        for (const h of hits) {
          const b = abcache.asBook(h.item);
          out.push(Object.assign(b, {
            match: 'pinyin', pyScore: Math.round(h.score * 100) / 100,
            pyHint: q + ' → ' + b.book,
          }));
        }
      } catch (e) { console.warn('[pinyin] 缓存 fuzzy 失败：' + (e && e.message || e)); }
      out.sort((a, b) => (b.pyScore || 0) - (a.pyScore || 0));
      return out;
    };

    // GET /api/ab/search?q=            → 按「本」汇总（书名/播音/集数/albumId + 前3集预览）
    // GET /api/ab/episodes?q=&albumId= → 某本书的有序集数表（ep/title/rid/url 惰性地址）
    // 只读；起播与进度都在 R1 固件里做（播放推动方式，NAS 不存状态）。
    // ★ v1.6.9：两条接口都改成「永久缓存优先」。缓存挂在服务端、与 devId 无关，
    //   多设备拉同一份；无 TTL，只有 ?fresh=1 或播不了标了 stale 才回源。
    if (p === '/api/ab/search') {
      const q = u.searchParams.get('q') || '';
      if (!q) return send(res, { books: [] });
      const src = (u.searchParams.get('source') || 'kw').trim();
      const n = Math.min(parseInt(u.searchParams.get('n') || '100', 10) || 100, 100);
      const fresh = u.searchParams.get('fresh') === '1';
      const pinyinOff = u.searchParams.get('pinyin') === '0';   // ★ v1.7.30：显式关闭拼音兜底
      if (!fresh) {
        const hitBooks = abcache.search(q);
        // ★ v1.7.32：拼音纠偏越过「缓存精确命中」—— 修「缓存污染后纠偏永不触发」。
        //   翻车链（stem 实测）：① 首次「写你」回源命中《让你写卖鱼佬…》并入缓存；
        //   ② 之后每次搜「写你」都在 abcache.search 部分命中那本错书 → v1.7.30 的纠偏
        //      排在 disk 命中之后，永远轮不到 ⇒ stem 一直播错书、服务端记录也留错书名。
        //   判据（四重保险，不误伤正常书名）：
        //     · 查询必须短（≤4 字）—— ASR 同音字错词都是短词，长查询本来就够精确；
        //     · 缓存命中必须是「部分命中」而非 normQ 全等 —— 全等就是真书名，直接走 disk；
        //     · 拼音纠偏有命中（pinyin.fuzzySearch 自带 PY_MIN=3.0 阈值，误伤实测 ≤1.33）；
        //     · ★ 纠偏 Top1 与缓存 Top1 **不是同一本书** —— 这是关键：
        //        搜「凡人」时缓存部分命中《凡人修仙传》、纠偏也是它 ⇒ 说明缓存是对的，
        //        不接管；搜「写你」缓存命中《让你写卖鱼佬…》、纠偏是《仙逆》⇒ 接管。
        //   接管时把纠偏结果顶到最前（盖掉 disk 那本错书），仍早于在线回源。
        if (!pinyinOff) {
          try {
            const fz = abPinyinFuzzy(q);
            if (pinyinCacheOverride(q, hitBooks, fz)) {
              console.log('[pinyin] 越过错误缓存纠偏：' + q + ' → ' + fz[0].book
                + '(≈' + fz[0].pyScore + '，原 disk 命中 ' + hitBooks[0].book + ')');
              for (const r of hitBooks) abcache.hit(r.key);
              return send(res, { books: fz, cache: 'pinyin', fuzzy: true,
                hint: '拼音猜测（覆盖缓存部分命中）：' + fz[0].pyHint, ttl: null });
            }
          } catch (e) { console.warn('[pinyin] 越过缓存纠偏失败：' + (e && e.message || e)); }
        }
        if (hitBooks.length) {
          for (const r of hitBooks) abcache.hit(r.key);
          return send(res, { books: hitBooks.map(abcache.asBook), cache: 'disk', ttl: null });
        }
        // ★ v1.7.30：精确未命中 → 拼音模糊（本地库 → 缓存）。这里必须**早于在线回源**：
        //   ASR 把「仙逆」听成「写你」，回源搜「写你」只会得到《让你写卖鱼佬…》那本错书，
        //   所以在回源前先用读音把已缓存/本地的正确书捞回来，命中即返回、不回源。
        if (!pinyinOff) {
          const fz = abPinyinFuzzy(q);
          if (fz.length) {
            console.log('[pinyin] 搜书纠偏：' + q + ' → ' + fz.slice(0, 3)
              .map(b => b.book + '(≈' + b.pyScore + ')').join(' / '));
            return send(res, { books: fz, cache: 'pinyin', fuzzy: true,
              hint: '拼音猜测：' + fz[0].pyHint, ttl: null });
          }
        }
      }
      // ★ 单飞：多设备同时点同一本新书只回源一次（原 cached() 不去重，会并发打上游）
      const raws = await abcache.once('search:' + src + ':' + abcache.normQ(q) + ':' + n,
        () => abSearchRaw(q, src, n));
      const rawBooks = abGroupBooks(raws || []);
      const nhS = abNarratorHint(q, rawBooks);
      // ★ v1.7.23：给回源结果打「已缓存」标 —— 缓存的书不一定就是想要的版本
      //   （凡人修仙传：书架里关彦之剧场 ≠ 用户想听的光合积木），web 上要能一眼分辨。
      let cachedSet = null;
      try {
        cachedSet = new Set(abcache.search(q).map(r => r.source + '|' + r.albumId));
      } catch {}
      const books = rawBooks.sort((a, b) => {
        const ma = nhS && (a.narrator || '').indexOf(nhS) >= 0 ? 1 : 0;
        const mb = nhS && (b.narrator || '').indexOf(nhS) >= 0 ? 1 : 0;
        if (ma !== mb) return mb - ma;
        return b.count - a.count;
      }).map(b => ({
        book: b.book, narrator: b.narrator, albumId: b.albumId, source: b.source,
        count: b.count, preview: b.episodes.slice(0, 3).map(e => e.title),
        cached: !!(cachedSet && cachedSet.has(b.source + '|' + b.albumId)),
      }));
      console.log('[abcache] 搜书回源：' + q + ' → ' + books.length + ' 本（' + src + ' 全量'
        + (books.filter(b => b.cached).length ? '，' + books.filter(b => b.cached).length + ' 本已缓存' : '') + '）');
      // ★ v1.7.23：回源空手而归时回退书架 —— 上游抖一下不该把已缓存的书藏没
      if (!books.length) {
        const hits = abcache.search(q);
        if (hits.length) {
          return send(res, { books: hits.map(abcache.asBook).map(b => Object.assign(b, { cached: true })), cache: 'disk-fallback' });
        }
      }
      // ★ v1.7.2：搜索**只搜不缓存** —— 回源搜到的书不再写「仅摘要」进缓存
      //   （实测翻车：搜一次书架就多一堆没播放过的摘要条目，得手动清）。
      //   进缓存的入口收敛为三个：Web 点「＋ 缓存」/ 点开书详情（整理整本）、
      //   设备真的搜过并播过（putFull）。已缓存的书不受影响 —— 上面的
      //   abcache.search(q) 磁盘命中路径照旧（别名是 putFull 时记的）。
      return send(res, { books, cache: 'search' });
    }
    /* ★ v1.7.56：**统一播放解析口**（本地库 → 磁盘缓存 → 在线，一条链走到底）
       所有设备都调这里，不许各自实现「本地找不到怎么办」。
       背景：本地 /audiobook 里同名的书常常只是残卷（《凡人修仙传》本地 3 集、
       在线 2113 集），设备按集号去本地库一查越界，就报「没有第 N 集」，
       听感上像全书听完了 —— 实际是本地不全。
       解析逻辑只存在于 apBookItems 一处：
         · stem / 其它 AlphaPi 设备 → /ap/play?kind=book（内部同一条链）
         · R1 小智 / 网页 / 以后新增的任何设备 → GET /api/ab/pick?q=&ep=
       参数：q 书名(必填) ep 集号(0=续播) n 连播集数(1~5) ss 集内秒
       返回：{ ok, url, ep, title, dur, local, total, book, narrator, offset, epCount, items[] }
       失败：{ ok:false, tail, err } —— tail=true 才是真的听到头了 */
    if (p === '/api/ab/pick') {
      const q = (u.searchParams.get('q') || '').trim();
      const ep = Math.max(parseInt(u.searchParams.get('ep') || '0', 10) || 0, 0);
      const n = Math.min(Math.max(parseInt(u.searchParams.get('n') || '1', 10) || 1, 1), 5);
      const ss = u.searchParams.get('ss') || 0;
      if (!q) return send(res, { ok: false, err: '缺 q（书名）' }, 400);
      const rm = ep ? null : histResume(req, q, 'book');
      const resume = rm ? {
        ep: rm.ep || 1,
        off: Math.max(0, (rm.pos || 0) - 10),
        nextEp: !!rm.nextEp,
      } : null;
      const r = await apBookItems(q, ep, n, resume, ss)
        .catch(e => ({ err: String((e && e.message) || e) }));
      if (r.err) return send(res, { ok: false, tail: !!r.tail, err: r.err, book: q });
      const self = selfBase(req);
      /* ★ v1.7.56 坑：apBookItems 内部是通过 127.0.0.1 自调 /api/abl/eps 取集表的，
         那边 selfBase 只能算出 http://127.0.0.1:8100 ⇒ 本地集的 url 会带 loopback，
         设备拿到一律播不了（还会让人以为是"文件坏了"）。这里统一换回本次请求的地址。 */
      const abs = x => {
        if (!x) return '';
        let s = String(x).replace(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/i, self);
        if (!/^https?:\/\//i.test(s)) s = self + (s.charAt(0) === '/' ? s : '/' + s);
        return s;
      };
      const items = (r.items || []).map(it => ({
        ep: it.ep,
        title: it.title || '',
        url: abs(it.url || (it.kind === 'url' ? it.input : '')),
        ss: Math.round(it.ss || 0),
      })).filter(it => it.url);
      if (!items.length) return send(res, { ok: false, err: '取不到音频地址：' + (r.book || q) });
      return send(res, {
        ok: true,
        url: items[0].url,
        ep: items[0].ep,
        title: items[0].title,
        dur: Math.round(r.dur || 0),
        local: !!r.local,
        total: r.total || 0,
        book: r.bookTitle || r.book || q,
        series: r.series || '',
        narrator: r.narrator || '',
        offset: Math.round(r.off || 0),
        epCount: items.length,
        items,
      });
    }
    if (p === '/api/ab/episodes') {
      const q = (u.searchParams.get('q') || '').trim();
      const wantAlbum = (u.searchParams.get('albumId') || '').trim();
      const src = (u.searchParams.get('source') || 'kw').trim();
      const page = Math.max(parseInt(u.searchParams.get('page') || '1', 10) || 1, 1);
      const size = Math.min(Math.max(parseInt(u.searchParams.get('size') || '50', 10) || 50, 10), 200);
      const ep0 = Math.max(parseInt(u.searchParams.get('ep') || '0', 10) || 0, 0);
      if (!q && !wantAlbum) return send(res, { error: '缺 q 或 albumId' }, 400);

      // ★ v1.6.9：**永久缓存优先**。原来只有 5 分钟内存缓存（cached('abf:…')），
      //   超时 / 重启就得重跑单发全量 lxSearchAll（2101 集的书一次拉满）。
      //   现在先吃 files/ab_cache.json，无 TTL；miss / stale / fresh=1 才回源，
      //   回源后 putFull 比对内容指纹 —— 没变就一个字节都不写。
      const fresh = u.searchParams.get('fresh') === '1';
      let full = null;
      // stale 的记录也取回来（下面要标刷新，并以其真实 key 为准）
      const rec = fresh ? null : abcache.getFull(src, wantAlbum, '', q);
      if (rec && !rec.stale && Array.isArray(rec.list) && rec.list.length) {
        abcache.hit(rec.key);
        full = Object.assign(abcache.asFull(rec), { cache: 'disk' });
      }
      // ★ v1.7.30：集表拼音纠偏 —— 设备若只传了 ASR 错词 q（没带 albumId），
      //   精确 getFull 扑空后用读音找缓存里的正确书，按它的 albumId 取集表，
      //   避免拿错词回源搜到《让你写卖鱼佬…》。本地库命中的情况交给 abl 路由自身。
      if (!full && !fresh && q && u.searchParams.get('pinyin') !== '0') {
        const fz = abPinyinFuzzy(q).filter(b => !b.local && b.albumId);
        if (fz.length) {
          const top = fz[0];
          const rec2 = abcache.getFull(top.source || src, top.albumId, top.book, top.book);
          if (rec2 && !rec2.stale && Array.isArray(rec2.list) && rec2.list.length) {
            abcache.hit(rec2.key);
            full = Object.assign(abcache.asFull(rec2), {
              cache: 'pinyin', match: 'pinyin', pyHint: top.pyHint,
            });
            console.log('[pinyin] 集表纠偏：' + q + ' → ' + top.book + '（' + top.albumId + '）');
          }
        }
      }
      if (!full) {
        // ★ 单飞键与缓存键解耦：只按 albumId / 查询词去重。
        //   R1 传 source=kw、别的设备传 source=all 也只回源一次、命中同一份缓存。
        const onceKey = wantAlbum ? ('album:' + wantAlbum) : ('q:' + abcache.normQ(q || ''));
        if (rec && !fresh) abcache.markRefresh(rec.key, 'stale');
        full = await abcache.once('full:' + onceKey, async () => {
          const q1 = q || wantAlbum;
          const base = await abSearchRaw(q1, src, 100);
          const books0 = abGroupBooks(base || []);
          // 同名书不同主播（凡人修仙传：光合积木/关彦之…）优先选查询里点名的主播
          const nh = abNarratorHint(q1, books0);
          const g0 = wantAlbum ? books0.find(x => x.albumId === wantAlbum)
                      : (nh ? books0.find(x => (x.narrator || '').indexOf(nh) >= 0) || books0[0]
                            : books0[0]);
          if (!g0) return null;
          const q2 = ((g0.narrator || '') + ' ' + g0.book).trim() || g0.book || q1;
          // 单发全量（不翻页、不连发）：冷查询一次吐满整本（实测 2101/2101）
          const all = await lxSearchAll(q2, 'all', src);
          const list = (all || [])
            .filter(x => String(x.albumId || '') === String(g0.albumId))
            .map(x => ({ ep: x.ep || 0, title: String(x.title || ''), rid: String(x.rid || ''),
                         duration: String(x.duration || ''), artist: String(x.artist || ''),
                         source: String(x.source || 'kw') }));
          list.sort((a, b) => (a.ep > 0 ? a.ep : 1e9) - (b.ep > 0 ? b.ep : 1e9)
            || String(a.title).localeCompare(String(b.title), 'zh-Hans-CN', { numeric: true }));
          return { book: g0.book, narrator: g0.narrator, albumId: g0.albumId,
                   source: g0.source || src, total: list.length, list, q: q1 };
        });
        if (full && full.list && full.list.length) {
          const put = abcache.putFull(full);
          if (put && put.rec) {
            // ★ 回源路径统一换用缓存记的集表（含缺集占位 + 救援行），与磁盘缓存路径口径一致。
            //   实测翻车：原始表里没有占位行 → 救援逻辑在原始表里找不到占位 → 永不触发。
            full.list = put.rec.list;
            full.key = put.rec.key;
            full.missing = put.rec.missing || 0;
            full.rev = put.rev || put.rec.rev || 0;   // v1.7.12：重搜应答带上真实 rev
          }
          console.log('[abcache] 整本索引 ' + (put.changed ? '有变更 rev=' + put.rev : '内容未变，不写盘')
            + '：' + full.book + ' / ' + full.list.length + ' 集');
        }
        if (full) full.cache = 'search';
      }

      if (!full) {
        return send(res, { error: '没找到这本书' }, 404);
      }
      // ★ v1.7.0 缺集救援 → ★ v1.7.5 点播缺集**自动**救援：ep=N 且该集是占位就触发
      //   精确词搜索（落雪同款搜法；整本全量拉取的截断漏集靠这个补回，跨专辑同名集也能救）。
      //   不再要求显式 rescue=1 —— R1 说「播放第N集」时缺集有机会救回再播（设备零改动）；
      //   rescue=1 参数兼容保留（带了等效于自动行为）。
      //   救回 → abcache.rescueEp 填进缓存（占位换真集、missing 重算、rescued 记档，
      //   刷新经 applyRescued 自动铺回）+ 后台预热取链；救不回 → 原样返回占位保留，
      //   且记 10 分钟负缓存，反复点播不反复空搜（省上游限流预算）。
      if (ep0 > 0) {
        const tgt = full.list.find(x => (Number(x.ep) || 0) === ep0);
        // ★ v1.7.10：历史脏占位行没有 missing 字段，只看 tgt.missing 会永远跳过救援。
        //   统一口径 = 有 missing 标记 **或 rid 为空**。只在 ep=N 单点请求时进来，
        //   Keeper 整本预填走 ep=0，绝不批量回源。
        //   ★ v1.7.19：整行缺席（上游截断连占位都没给，实测遮天重拉后 2186/2187/2189
        //   等整号消失）也要救 —— rescueEp 本来就支持缺席追加，闸门却把这种场景全拒了。
        const tgtMiss = !tgt || (!!tgt.missing || !String(tgt.rid || '').trim());
        if (tgtMiss) {
          const rk = full.key || abcache.keyOf(full.source, full.albumId, full.book);
          const fk = rk + ':' + ep0;
          const fT = RESCUE_FAIL.get(fk);
          if (fT && (Date.now() - fT) < 600000) {
            console.log('[abcache] 救援负缓存（10 分钟内落空过）跳过：' + full.book + ' 第' + ep0 + '集');
          } else {
            const cand = await abcache.once('rescue:' + rk + ':' + ep0,
              () => abRescueEp(full, ep0, src));
            if (cand && cand.rid) {
              const rr = abcache.rescueEp(full.source, full.albumId, full.book, ep0, cand);
              if (rr.ok) {
                RESCUE_FAIL.delete(fk);
                full.list = rr.rec.list;        // rescueEp 内部换新数组，同步引用
                full.missing = rr.rec.missing || 0;
                full.rescued = ep0;
                console.log('[abcache] 缺集救援成功：' + full.book + ' 第' + ep0
                  + '集 ← ' + (cand.album || cand.albumId || '?') + '（rid=' + cand.rid + '）');
                // ★ v1.7.4 救援成功顺手后台预热取链：点击播放走 /r/ 惰性取链，
                //   现场取要 3.6~4s（用户实测「搜索 4s + 点击又 4s」的观感后半段）。
                //   resolveUrl 命中落盘 30 分钟缓存（lx:源:rid:音质），点这一集秒开。
                //   不 await 不挡响应；预热失败无所谓，点击时按原路现场取。
                resolveUrl({ rid: cand.rid, source: cand.source || src,
                             title: cand.title, artist: full.narrator || '' })
                  .catch(() => { /* 预热失败不影响救援结果 */ });
              }
            } else {
              RESCUE_FAIL.set(fk, Date.now());
              console.log('[abcache] 缺集救援落空：' + full.book + ' 第' + ep0 + '集（精确词搜不到，负缓存 10 分钟）');
            }
          }
        }
      }
      // ★ v1.7.20 输出层过滤 ep=0 花絮行：上游专辑列表尾部常带感言/宣传音频
      //   （标题解析不出集号 → ep=0），不属于任何「第 N 集」。R1 设备端自己滤掉了，
      //   显示正常；Web 集表却把它们渲染成列表序号（e.ep || (gi+1) → 实测遮天尾部
      //   冒出 2950-2956「都不是集」的行）。磁盘缓存原文不动（番外/序章内容保留），
      //   只在 episodes 应答里滤掉，total / 分页 / 缺集数全部按过滤后的口径算。
      const viewList = full.list.filter(x => (Number(x.ep) || 0) > 0);
      const total = viewList.length;
      // 定位目标页：指定了 ep 就返回包含该集的那一页（兼容集号缺口）；否则用 page 参数
      let pg = page;
      if (ep0 > 0) {
        let idx = -1;
        for (let i2 = 0; i2 < total; i2++) { if (Number(viewList[i2].ep) >= ep0) { idx = i2; break; } }
        if (idx < 0) idx = total - 1;
        pg = Math.floor(idx / size) + 1;
      }
      pg = Math.min(pg, Math.max(1, Math.ceil(total / size)));
      const start = (pg - 1) * size;
      const slice = viewList.slice(start, start + size);
      const self = selfBase(req);
      const episodes = slice.map(e => {
        // ★ v1.7.9 列表只要集号：缺集占位行的长文案（缺集 · 上游没有第 N 集）
        //   在**输出层**换成「第 N 集」—— R1 列表/播放列表干净；缺集提示靠 missing
        //   字段的角标，不靠文案。磁盘缓存原文不动（回传/补名逻辑照旧可识别）。
        // ★ v1.7.10：输出层与救援判定同口径 —— rid 为空一律按缺集，
        //   标题输出「第 N 集」+ missing:true，设备 / Web 列表才知道要点它触发救援。
        const isMiss = !!e.missing || !String(e.rid || '').trim();
        const tShow = isMiss ? ('第 ' + (Number(e.ep) || 0) + ' 集') : e.title;
        const t = { title: tShow, artist: full.narrator, source: full.source, rid: e.rid };
        return { ep: e.ep, title: tShow, artist: full.narrator,
                 source: e.source || full.source, rid: e.rid, duration: e.duration, url: lazyUrl(self, t),
                 missing: isMiss,           // v1.7.0 缺集占位：rid=''，设备端也能识别「这集没有」
                 rescued: !!e.rescued };    // v1.7.0 救援行：从别处补回的真集
      });
      return send(res, {
        book: full.book, narrator: full.narrator, albumId: full.albumId,
        source: full.source, total, page: pg, size,
        // ★ v1.7.10：缺集数与输出层同口径重算（磁盘 rec.missing 可能仍是旧值 0）
        missing: full.list.filter(x => !!x.missing || !String(x.rid || '').trim()).length,
        hasMore: start + size < total, episodes,
        cache: full.cache || 'disk', rev: full.rev || 0,
      });
    }
    // ★ v1.6.9：在线书目永久缓存的诊断 / 清除口（所有设备共享同一份）
    //   GET                          看缓存了哪些书、rev、集数、是否 stale
    //   GET ?key=…&full=1            ★ v1.7.0 纯缓存直读整本集表（书架用，绝不回源）
    //   DELETE ?all=1                全清（下次请求重新整理）
    //   DELETE ?key=kw|12345         只清一本
    //   DELETE ?keys=kw|1,kw|2,…     ★ v1.7.2 批量清（逗号分隔，书名带逗号会拆错位）
    //   DELETE ?keysjs=["kw|1",…]    ★ v1.7.2 批量清（JSON 数组，Web 书架批量删除用这个）
    if (p === '/api/ab/cache') {
      const key = (u.searchParams.get('key') || '').trim();
      if (req.method === 'DELETE') {
        if (key && u.searchParams.get('refresh') === '1') {
          abcache.markRefresh(key, 'manual refresh');
          return send(res, { ok: true, refreshed: key });
        }
        let ks = [];
        const keysJs = (u.searchParams.get('keysjs') || '').trim();
        if (keysJs && !key) {
          try { const a = JSON.parse(keysJs); if (Array.isArray(a)) ks = a.map(String).filter(Boolean); } catch { }
        } else {
          const keysRaw = (u.searchParams.get('keys') || '').trim();
          if (keysRaw && !key) ks = keysRaw.split(',').map(s => s.trim()).filter(Boolean);
        }
        if (ks.length) {
          let n = 0;
          for (const k of ks) {
            try { const r = abcache.clear(k); if (r && r.cleared) n++; }
            catch { /* 单本失败不拖累其它 */ }
          }
          return send(res, { ok: true, deleted: n, requested: ks.length });
        }
        return send(res, abcache.clear(u.searchParams.get('all') === '1' ? null : (key || null)));
      }
      if (key && u.searchParams.get('full') === '1') {
        const f = abcache.byKey(key);
        if (!f) return send(res, { error: '缓存里没有这本书的整本集表', key }, 404);
        // ★ v1.7.9 与 /api/ab/episodes 口径一致：缺集行输出「第 N 集」（浅拷贝，
        //   asFull 的 list 直接引用缓存记录 —— 绝不能原地改，否则把磁盘文案改掉）。
        // ★ v1.7.10：同 /api/ab/episodes —— 无 rid 也按缺集输出，并显式带 missing:true / rid:''。
        //   /api/abrev 拿到后，页面 ebRevApply 才能把设备侧「带假 rid 的旧占位行」覆盖成
        //   可救援的占位行（它靠 ne.rid || ne.missing 决定是否覆盖）。
        const listOut = f.list.map(e => {
          if (!e) return e;
          const miss = !!e.missing || !String(e.rid || '').trim();
          return miss
            ? Object.assign({}, e, { title: '第 ' + (Number(e.ep) || 0) + ' 集',
                                     missing: true, rid: '' })
            : e;
        }).filter(x => (Number(x.ep) || 0) > 0);   // ★ v1.7.20 同 episodes：ep=0 花絮行不进 Web 集表
        return send(res, Object.assign({}, f, {
          list: listOut,
          total: listOut.length, count: listOut.length,   // ★ v1.7.20 头部计数与过滤后口径一致
          // ★ v1.7.10：整本缺集数与 listOut 同口径，别让客户端看到 missing:0 却一屏灰行
          missing: listOut.filter(x => x && (!!x.missing || !String(x.rid || '').trim())).length,
        }));
      }
      return send(res, abcache.stats());
    }
    // ★ v1.7.12 书架「重搜」= 整本重拉：走 /api/ab/episodes 的 fresh=1 同款**批量**链路
    //   （一次专辑级请求拿回整本，不是逐集搜 —— 第一遍匹配怎么来的，重搜就怎么来）。
    //   putFull 防降级合并保护：新表占位行的集号若旧表有真集，旧真集原样保留 ——
    //   已匹配的集**绝不会**被刷成缺集（v1.7.1 实测上游截断 2101→2000→200 翻车后加的保护）；
    //   救援行 applyRescued 自动铺回。重拉后仍缺的集只亮数，不逐集扫上游（风控红线）——
    //   真播到哪集救哪集（v1.7.5 自动救援兜底）。
    if (p === '/api/ab/rematch') {
      const key = (u.searchParams.get('key') || '').trim();
      const f = key ? abcache.byKey(key) : null;
      if (!f) return send(res, { ok: false, error: '缓存里没有这本书', key: key }, 404);
      console.log('[abcache] 书架重搜（整本重拉）：' + f.book);
      // ★ 不走 apSelfJson（20s 超时）—— 整本重拉实测 22.6s+（遮天 2954 集），
      //   专用 120s 长超时。超时也只是这次应答失败，once() 里的整本拉取照常完成落库。
      const d = await fetch('http://127.0.0.1:' + PORT + '/api/ab/episodes?q='
        + encodeURIComponent(f.book || '') + '&albumId=' + encodeURIComponent(f.albumId || '')
        + '&source=' + encodeURIComponent(f.source || 'kw') + '&fresh=1&size=10',
        { signal: AbortSignal.timeout(120000) })
        .then(r => r.json()).catch(() => null);
      if (!d || d.error) {
        return send(res, { ok: false, error: (d && d.error) || '整本重拉失败（后台可能已完成，稍后刷新书架看结果）', book: f.book }, 502);
      }
      return send(res, { ok: true, book: d.book || f.book, total: d.total || 0,
        missing: d.missing || 0, rev: d.rev || 0, cache: d.cache || '' });
    }
    // ★ 默认音质（给 Web 用）—— /s/<i> 与 /r/<src>/<rid> 都按这一档起手取链。
    //   GET  看当前档位 + 可选档位；POST {default:'128k'} 改写 files/quality.json。
    if (p === '/api/quality') {
      if (req.method === 'POST') {
        const b = await readBody(req).then(JSON.parse).catch(() => ({}));
        const v = setDefQuality(b.default != null ? b.default : b.q);
        return send(res, { ok: true, default: v, list: QALL });
      }
      return send(res, { default: defQuality(), list: QALL });
    }

    // 三块曲库的可见性开关（给 Web 用）—— 关掉的块不会出现在 /index.json 里
    if (p === '/api/media') {
      if (req.method === 'POST') {
        const b = await readBody(req).then(JSON.parse).catch(() => ({}));
        return send(res, { ok: true, flags: setMediaFlags(b) });
      }
      return send(res, { flags: mediaFlags() });
    }

    // ★ /api/lib：Web「曲库」页的三块数据源 —— 本地 / 在线 / 网络电台一次拿全。
    //   与 /index.json（给 R1 的、本地+在线拼成一条 tracks）不同，这里**分块返回**，
    //   前端不用再靠 onlineFrom 去切；关掉的块直接给空数组（并标在 off 里）。
    if (p === '/api/lib') {
      const F = mediaFlags();
      const n = clampN(u.searchParams.get('n'), 100);
      const fresh = u.searchParams.get('fresh') === '1';
      const [locals, poolList] = await Promise.all([
        F.local ? local.list().catch(() => []) : [],
        // ★ v1.7.12.1：Web「换一批」走 deal() —— 全池洗牌抽 n 条，同步零上游请求，
        //   秒回且每次内容都不同（冷却到期时 get(fresh) 只在后台重建，不阻塞本次响应）。
        F.online ? (fresh ? pool.deal(n) : pool.get(n, false)) : [],
      ]);
      const self = selfBase(req);
      const enc = f => String(f).split('/').map(encodeURIComponent).join('/');
      return send(res, {
        updatedAt: new Date().toISOString(),
        off: { local: !F.local, online: !F.online, radio: !F.radio },
        counts: {
          local: locals.length,
          online: poolList.length,
          radio: F.radio ? local.radios().length : 0,
        },
        local: locals.map(t => ({
          src: 'local', title: t.title, artist: t.artist, album: t.album,
          file: 'm/' + t.file, url: self + '/m/' + enc(t.file),
        })),
        online: poolList.map(t => ({
          src: 'online', title: t.title, artist: t.artist, album: t.album,
          source: t.source, rid: t.rid,
          file: lazyFile(t), url: lazyUrl(self, t),
        })),
        radios: F.radio
          ? local.radios().map(r => ({
            src: 'radio', name: r.name, title: r.name,
            url: RADIO_PROXY ? radioUrl(self, r.url) : r.url,
          }))
          : [],
      });
    }

    // ★ /api/radios：网络电台清单的读 / 写（Web 上自己加台、删台）。
    //   GET 返回当前清单；POST 用传来的数组**整体覆盖** files/radios.json。
    //   （整体覆盖而不是逐条增删，是为了让前端「拖动排序 / 批量删」也能一次搞定。）
    //   ★ 这里必须是**原始 URL**（见 radioUrl 的注释）：返回值会被前端原样 POST 回来。
    if (p === '/api/radios') {
      if (req.method === 'POST') {
        const b = await readBody(req).then(JSON.parse).catch(() => ({}));
        const list = Array.isArray(b) ? b : (b.list || []);
        const r = local.saveRadios(list);
        return send(res, r.ok
          ? { ok: true, count: r.count, radios: local.radios() }
          : { ok: false, err: r.err || '写入失败' });
      }
      return send(res, { radios: local.radios() });
    }

    // ★ v1.7.31：来源权威查询口 —— R1/工具直接问「当前这首是什么来源」，不用自己猜 URL。
    //   GET /api/src?url=<当前曲地址>&q=<关键词>&title=<曲名>
    //   返回 { src, srcLabel, radio, name, via }；全部本地判定，零回源、零网络。
    if (p === '/api/src') {
      const uUrl = String(u.searchParams.get('url') || '').slice(0, 2048);
      const uQ = String(u.searchParams.get('q') || u.searchParams.get('title') || '').slice(0, 200);
      let radios = [];
      try { radios = local.radios() || []; } catch { radios = []; }
      let books = [];
      try { books = Object.values(abcache.load().books || {}); } catch { books = []; }
      const r = srcFromUrl(uUrl, uQ, radios, books);
      return send(res, Object.assign({
        ok: true, ver: MS_VER, url: uUrl.slice(0, 300), q: uQ,
        count: { radios: radios.length, books: books.length },
      }, r));
    }

    // ★ v1.6.0：各设备的播放记录（Web「播放记录」页读它）。
    //   DELETE ?dev=<id> 清一台；DELETE ?all=1 全清。
    //   ★ v1.7.13：GET 附带 books（书级共享进度，P1）—— Web 渲染「书级续播」区。
    if (p === '/api/history') {
      if (req.method === 'DELETE') {
        // ★ v1.7.20 清一本书的续播进度（books 表 + 各设备列表同名条目一起删）。
        //   用途实测：救援毒行期（圣墟 3373/3374 顶替遮天）设备把书级进度写坏，
        //   需要「重置这本书的续播点」。与 dev/all 清理口同端点共存。
        const bookDel = String(u.searchParams.get('book') || '').trim();
        if (bookDel) {
          const d = histLoad();
          const bk = bookKeyOf(bookDel, bookDel);
          let n = 0;
          // ★ v1.7.38：共享表键带组前缀，清一本书要把**所有组**里的同名键一起删
          for (const k of Object.keys(d.books || {})) {
            const suffix = k.indexOf('g:') === 0 ? k.slice(k.indexOf('|') + 1) : k;
            if (suffix === bk) { delete d.books[k]; n++; }
          }
          for (const dv of Object.values(d.devices || {})) {
            if (!Array.isArray(dv.list)) continue;
            const before = dv.list.length;
            dv.list = dv.list.filter(e => bookKeyOf(e.book, e.q) !== bk);
            if (dv.list.length !== before) {
              n += before - dv.list.length;
              if (dv.last && bookKeyOf(dv.last.book, dv.last.q) === bk) {
                dv.last = dv.list[0] || null;
              }
            }
          }
          histFlush();
          return send(res, { ok: true, clearedBook: bookDel, removed: n });
        }
        const dev = String(u.searchParams.get('dev') || '').trim();
        if (/^(1|all|yes)$/i.test(String(u.searchParams.get('all') || ''))) {
          histLoad().devices = {};
          histFlush();
          return send(res, { ok: true, cleared: 'all' });
        }
        if (!dev) return send(res, { ok: false, err: '缺 dev（设备 id），或用 all=1 全清' }, 400);
        const d = histLoad();
        if (!d.devices[dev]) return send(res, { ok: false, err: '没有这台设备的记录：' + dev }, 404);
        delete d.devices[dev];
        histFlush();
        return send(res, { ok: true, cleared: dev });
      }
      // ★ v1.7.38：附带设备分组（Web 播放记录页可展示归属组）
      return send(res, Object.assign(histSnapshot(), {
        books: histBooksSnapshot(),
        groups: dgSnapshot().groups,
      }));
    }

    // ★ v1.7.38 设备分组：GET 读分组与设备归属；POST 建组/改名/删组/移设备。
    if (p === '/api/devgroups') {
      if (req.method === 'POST') {
        const body = await readBody(req).then(JSON.parse).catch(() => ({}));
        const act = String(body.action || '').toLowerCase();
        const d = dgLoad();
        if (!d.groups) d.groups = {};
        const G = d.groups;
        const gid = String(body.gid || '').trim();
        const dev = String(body.dev || '').trim().slice(0, 40);
        if (act === 'create') {
          const name = String(body.name || '').trim().slice(0, 24) || '新分组';
          const ngid = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
          G[ngid] = { name, devs: [], createdAt: Date.now() };
          if (dev) G[ngid].devs.push(dev);
          dgFlush();
          console.log('[grp] 新建分组「' + name + '」' + (dev ? '（含 ' + dev + '）' : ''));
          return send(res, Object.assign({ ok: true, gid: ngid }, dgSnapshot()));
        }
        if (act === 'rename') {
          if (!G[gid]) return send(res, { ok: false, err: '没有这个分组：' + gid }, 404);
          const name = String(body.name || '').trim().slice(0, 24);
          if (!name) return send(res, { ok: false, err: '分组名不能为空' }, 400);
          G[gid].name = name;
          dgFlush();
          return send(res, Object.assign({ ok: true }, dgSnapshot()));
        }
        if (act === 'delete') {
          if (!G[gid]) return send(res, { ok: false, err: '没有这个分组：' + gid }, 404);
          if (gid === DG_DEFAULT) return send(res, { ok: false, err: '默认组是系统组，不能删除（可把设备移出）' }, 400);
          delete G[gid];                 // 成员自动回到各自的独立组
          dgFlush();
          console.log('[grp] 删除分组 ' + gid + '（成员回到独立组）');
          return send(res, Object.assign({ ok: true }, dgSnapshot()));
        }
        if (act === 'assign') {
          if (!dev) return send(res, { ok: false, err: '缺 dev' }, 400);
          for (const k of Object.keys(G)) {
            G[k].devs = (G[k].devs || []).filter(x => x !== dev);
          }
          let to = '';
          if (gid && G[gid]) { G[gid].devs = (G[gid].devs || []).concat([dev]); to = gid; }
          dgFlush();
          console.log('[grp] 设备 ' + dev + ' → ' + (to ? ('组 ' + to) : '独立组'));
          return send(res, Object.assign({ ok: true }, dgSnapshot()));
        }
        return send(res, { ok: false, err: '未知 action：' + act }, 400);
      }
      return send(res, Object.assign({ ok: true, ver: MS_VER }, dgSnapshot()));
    }

    // ★ v1.7.13 P1 统一进度中枢：GET /v1/history —— 设备维度 + 书维度聚合（新客户端只学这一套）
    //   ★ v1.7.38：books 按请求设备所在组过滤；识别不出设备（R1 匿名 GET）则不筛。
    if (p === '/v1/history') {
      const devQ = String(u.searchParams.get('dev') || '').trim();
      const grp = devQ ? devGroupId(devQ) : reqGroupId(req);
      if (devQ) console.log('[grp] /v1/history dev=' + devQ + ' → ' + (grp || 'ALL'));
      return send(res, {
        ver: MS_VER,
        devices: histSnapshot().devices,
        books: histBooksSnapshot(grp),
        grp: grp || '',
        file: 'files/history.json',
      });
    }

    // ★ v1.7.13 P1 统一进度中枢：POST /v1/pos —— 通用位置上报（新客户端 / 直链播放用）。
    //   body: { devId?, kind:'book'|'song'|'radio', q, book?, ep, pos, dur?, fin?, title?, rid? }
    //   ★ v1.7.27 P1 收尾：kind=book 收下后顺带反查补齐该设备最近的 /r/ stream 记录
    //     （直链播放位置补齐）；song（ep=第几首）/ radio 也进共享表，不再 ignored。
    //   老固件继续走 GET /ap/…/pos，一个字不用改。
    if (p === '/v1/pos' && req.method === 'POST') {
      const body = await readBody(req).then(JSON.parse).catch(() => ({}));
      const kind = String(body.kind || 'book').trim().toLowerCase();
      const q = String(body.q || body.book || '').trim();
      if (!q || (kind !== 'book' && kind !== 'song' && kind !== 'radio')) {
        return send(res, { ok: true, ignored: 'kind=' + kind + ' 不支持或缺 q' });
      }
      // ★ v1.7.17 防误报（stem /ap/pos 同口径）：非 fin 的位置上报 pos<5s 不落账 ——
      //   防止「刚起播还没出声」的客户端把书级进度打回 0 开头。fin=1（含换集补 fin
      //   的 pos=0）不受此限，那是「本集听完」的合法语义。
      // ★ v1.7.44：带 devId 的上报**不拦** —— 它是 R1 自己（device 1.3.349+）在
      //   「起播那一拍」主动报的，为的就是让播放记录立刻出现。这道门槛当年防的是
      //   网页那路的匿名上报，不该把设备权威上报也挡掉。
      const finRaw = !!(body.fin);
      const posRaw = Number(body.pos) || 0;
      const dev = String(body.devId || devIdOf(req)).slice(0, 40);
      const fromDev = !!String(body.devId || '').trim();
      if (!finRaw && posRaw < 5 && !fromDev) {
        return send(res, { ok: true, ignored: 'pos too small (' + posRaw + 's)' });
      }
      /* ★ v1.7.43：**集号只认上报方**，服务端不再二次纠正。
         以前（v1.7.39/42）这里拿 `/r/` LIVE stream 记录的集号去改上报值，为的是遮住
         「网页那路写死旧集号」的坑。但 stream 记录本身不可靠 —— 引擎预载下一首也走
         setDataSource（带 live 标记），实测播放第 1 集时会落下第 2 集的 stream 记录，
         于是把正确的 ep=1 改成了 2。现在 R1 的 ProgProgress 直接从 player 队列项的
         itemId/album 读身份（device 1.3.348 + player pl-1.6.162），是唯一权威 ⇒
         服务端把上报值原样落库，既不改集号也不删别人的记录。 */
      const epUse = body.ep;
      const cur = histBookSave({
        book: body.book || q, q, kind, ep: epUse, pos: body.pos,
        dur: body.dur, fin: body.fin, title: body.title, dev,
        // ★ v1.7.31：设备上报不覆盖起播时的权威来源（本地/在线/电台）
        // ★ v1.7.43：设备没给 src 时，书在本地库里就是本地节目 —— 用服务端权威名单判，
        //   不再按 kind 一律推成「在线节目」（本地书被标错来源的老问题）。
        src: body.src || (kind === 'book' && isAblBook(q) ? 'local_program' : '')
          || (kind === 'radio' ? 'radio' : ''),
      });
      console.log('[v1/pos] ' + dev + ' ' + kind + '「' + (cur ? cur.book : q) + '」'
        + (kind === 'radio' ? '' : '第 ' + (cur ? cur.ep : body.ep))
        + ' → pos=' + (cur ? cur.pos : body.pos) + 's' + (body.fin ? '（播完）' : ''));
      // ★ v1.7.16：带显式 devId 的上报（R1 1.3.342+）→ 设备列表也记，播放记录能认出是谁播的
      if (cur && body.devId) {
        histDevTouch(dev, String(body.devName || '').slice(0, 24), {
          kind, q, title: body.title || cur.book,
          ep: cur.ep, pos: cur.pos, off: 0, done: !!body.fin, src: cur.src,
        });
        /* ★ v1.7.42：顺手刷新设备来源 IP —— 这是 devByIp 反查的依据（本地节目 /m/ 不带 dev
           时靠它认回设备）。设备换 IP 后只要上报一次进度就自动修正。 */
        const hd = histLoad();
        const dv = hd.devices && hd.devices[dev];
        const ipNow = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
        if (dv && ipNow && dv.ip !== ipNow) { dv.ip = ipNow; histTouch(); }
      }
      // ★ v1.7.43：集号纠正与「错标残影清理」整层已删除 —— 上报方（device 1.3.348）
      //   现在直接从 player 队列项读身份，服务端不该再有第二套判断。
      // ★ v1.7.27 P1 收尾：直链播放位置补齐 —— 同设备最近的 /r/ stream 记录反查补 pos
      //   ★ v1.7.28：R1 的 stream 记录归属 ip-*（/r/ 不带 MAC 头），MAC 查不到时按来源 IP 兜底
      if (kind === 'book' || kind === 'song') {
        const bf = histBackfillStreamAuto(dev, req, { q: (cur && cur.book) || q, ep: (cur ? cur.ep : body.ep),
          pos: (cur ? cur.pos : posRaw), dur: body.dur, fin: finRaw,
          rid: body.rid ? String(body.rid) : '' });
        if (bf) console.log('[v1/pos] stream 记录补位置：「' + bf.q + '」ep=' + bf.ep
          + ' → pos=' + bf.pos + 's（/r/ 起播事实 → 真实进度）');
      }
      return send(res, { ok: true, ep: cur ? cur.ep : 0, pos: cur ? cur.pos : 0 });
    }

    // ★ v1.7.15：GET /v1/resume?q=<书名> —— R1 设备端续播的轻量查询口。
    //   只做书级共享匹配（histResumeShared，与 AlphaPi /ap/play ep=0 同源同口径），
    //   不带设备维度 —— 设备自己的本地记忆由设备自己兜底。off 预算好（pos-10），
    //   设备拿 ep/pos 写回本地记忆后走原有起播链路。
    if (p === '/v1/resume') {
      const q = String(u.searchParams.get('q') || '').trim();
      if (!q) return send(res, { ok: false, err: '缺 q（书名）' }, 400);
      // ★ v1.7.38：?dev= 或设备标识头存在时按组隔离；都没有（R1 当前匿名调用）则不筛，
      //   保证 R1 续播不断。device 侧补 ?dev=<MAC> 后即为严格组隔离。
      const devQ = String(u.searchParams.get('dev') || '').trim();
      const grp = devQ ? devGroupId(devQ) : reqGroupId(req);
      if (devQ) console.log('[grp] /v1/resume dev=' + devQ + ' q=' + q + ' → ' + (grp || 'ALL'));
      const r = histResumeShared(q, 'book', grp);
      if (!r) return send(res, { ok: true, found: false });
      return send(res, {
        ok: true, found: true, ver: MS_VER,
        book: r.book, q: r.q || q,
        ep: r.ep || 1, pos: r.pos || 0, dur: r.dur || 0,
        off: Math.max(0, Math.round((r.pos || 0) - 10)),
        fin: !!r.fin, nextEp: !!r.nextEp,
        dev: r.dev || '', at: r.ts || 0, grp: grp || '',
      });
    }

    /* ★ v1.6.3 `GET /api/devlog?lines=60` —— 把设备上报的事件（files/devlog.txt）读出来。
       设备串口是 USB-Serial-JTAG，跑应用时收不到任何日志，以前只能上 NAS 里 cat；
       有了这个口，浏览器/curl 就能看到 `[DEND] why=...`，定位"播几分钟就停""续播没声"。 */
    if (p === '/api/devlog') {
      const n = Math.min(Math.max(parseInt(u.searchParams.get('lines') || '60', 10) || 60, 1), 400);
      let txt = '';
      try { txt = fs.readFileSync(path.join(__dirname, 'files', 'devlog.txt'), 'utf8'); } catch { txt = ''; }
      const lines = txt ? txt.split('\n').filter(Boolean).slice(-n) : [];
      if (String(u.searchParams.get('raw') || '') === '1') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(lines.join('\n'));
      }
      return send(res, { ok: true, lines, count: lines.length });
    }

    // ★ v1.4.0：当前这条请求被当成什么设备 —— 设备侧「点了没声音」时第一步就看它。
    if (p === '/api/whoami') {
      return send(res, {
        device: isAlphaPi(req) ? 'alphapi' : 'r1',
        devId: devIdOf(req),                    // ★ v1.6.0：播放记录里的设备身份
        by: req.__ap ? 'path:/ap'
          : (u.searchParams.get('fmt') ? 'query:fmt'
            : (u.searchParams.get('dev') ? 'query:dev'
              : (AP_FORCE ? 'env:AP_TRANSCODE' : 'ua'))),
        ua: String(req.headers['user-agent'] || ''),
        mode: AP_MODE,
        transcode: tc.info(),
        apEndpoints: {
          index: selfBase(req) + '/ap/index.json',
          online: selfBase(req) + '/ap/online.json',
          radios: selfBase(req) + '/ap/radios.json',
        },
      });
    }

    // ★ v1.4.0：转码自检 —— 用 ffmpeg 自带正弦波跑一遍完整链路，不依赖任何外部音源。
    //   「有 ffmpeg、能出字节、字节率对得上」三件事一次问清。
    if (p === '/api/ap/selftest') {
      const r = await tc.selftest(u.searchParams.get('sec'));
      return send(res, r, r.ok ? 200 : 500);
    }

    if (p === '/api/health') {
      return send(res, {
        ok: true,
        ver: MS_VER,
        searchSources: S.ids(),
        lx: lxrelay.base() || '',
        lxDead: lxBlocked(),
        lxFailN: lxFailAt.n,
        lxLastOk: lxLast.ok,
        lxLastBad: lxLast.bad,
        quality: defQuality(),
        qualityList: QALL,
        media: mediaFlags(),
        // ★ v1.4.0：AlphaPi 兼容层状态（ffmpeg 有没有、转成什么格式）
        ap: Object.assign({ mode: AP_MODE }, tc.info()),
        // ★ v1.7.49：受限终端降档转码（缓存目录/并发/档位；命中率看 /api/trans/stats）
        aac: aac.info(),
        // ★ v1.2.0 本地有声书库：认出了几本、扫的哪个目录（0 本先看目录挂没挂上）
        abl: (() => { try { const r = ablocal.books(''); return { on: mediaFlags().abLocal, dir: r.dir, books: r.total, at: r.at }; } catch (e) { return { err: String(e && e.message || e) }; } })(),
        localCount: mediaFlags().local ? (await local.list().catch(() => [])).length : 0,
        // 自检：本地库 0 首时一眼看出是「没挂上 / 空的 / 扩展名不认 / 权限」
        local: (() => { try { return local.diag(); } catch (e) { return { err: String(e && e.message || e) }; } })(),
        scriptSources: rt ? [...rt.scripts.keys()] : [],
        script: rtName, scriptError: rtErr,
        // ★ v1.6.9：在线书目永久缓存（无 TTL，多设备共享同一份）
        abCache: abcache.stats(),
      });
    }

    // ★ 电台代理的现场体检：每个电台的上游是否还在、重试过几次、水库最低水位。
    //   「同一句话反复播」/「听着在加速」这类问题，先看这里的 minBuf 与 live。
    if (p === '/api/radio/stat') {
      // warm = 常热集合（后台替用户在源站攒着的那些台）——看电台卡不卡，
      // 最关键的数字就是用户要听的那个台在不在里面、ring 攒了多少。
      return send(res, { ok: true, stats: radioproxy.stats(), warm: radioproxy.warmInfo() });
    }

    return send(res, { error: 'not found' }, 404);
  } catch (e) {
    return send(res, { error: String(e && e.message || e) }, 500);
  }
});

// ★ 端口被占是部署期最常见的二次踩坑（旧进程没退干净）。给一句人话，别甩裸堆栈。
server.on('error', e => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('\n[mini-lx] 启动失败：端口 ' + PORT + ' 已被占用（多半是上一个 node server.js 还没退）。');
    console.error('[mini-lx] 先杀掉旧进程（Synology DSM 精简套件通常没有 ss / fuser，用下面这几条）：');
    console.error('           ps -ef | grep "[s]erver.js"                     # 看 node 进程');
    console.error('           kill -9 <PID>                                   # 杀掉它');
    console.error('           netstat -tlnp 2>/dev/null | grep ' + PORT + '   # 备选：看是谁占着');
    console.error('[mini-lx] 或者干脆换个端口： node server.js --port 8100\n');
    process.exit(1);
  }
  console.error('[mini-lx] 服务异常: ' + (e && e.message || e));
  process.exit(1);
});

// ★ v1.6.0：`require.main === module` 守卫 —— 直接跑（node server.js）行为一字不变；
//   被测试/工具 require 时**不监听端口**、不预热电台，只暴露函数（_tests/ap-history.js 用）。
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
  console.log('[mini-lx] Web UI  http://localhost:' + PORT + '  (v' + MS_VER + ')');
  /* ★ v1.7.49：降档转码缓存初始化。
     缓存放 files 子目录（files 已经是宿主机挂载 ⇒ 容器重建不丢），
     不为它单独改 compose —— 那套 Podroid 版 compose 一动就踩外网/挂载的坑。
     设备档位单独一个 json，改了即时生效（不用重启）。 */
  aac.init({
    dir: process.env.AAC_CACHE_DIR || path.join(__dirname, 'files', 'aac_cache'),
    confFile: path.join(__dirname, 'files', 'audio_profiles.json'),
    sendFile: sendLocalFile,
  });
  /* ★ v1.7.53：默认**关**。日志要写清楚，免得以后有人看到「flac 没被转」以为是坏了。 */
  {
    const ai = aac.info();
    console.log('[aac] 降档转码（按设备白名单）：' + (ai.master ? '总闸开' : '总闸关')
      + '，名单 ' + ai.listed + ' 台'
      + '（→ MP3 ' + aac.DEF.br + 'k；缓存上限 ' + ai.maxMB + ' MB）'
      + (ai.listed ? '' : ' —— 名单为空，所有设备一律原样直发；在 Web「音源 → 音频转码」里勾设备'));
  }
  migrateR1DeviceIdentity();   // ★ v1.7.35：存量 R1 播放记录归位（一次性，带标记）
  dgInit();                    // ★ v1.7.38：设备分组首次迁移（现有设备并入默认组 + 旧进度键加组前缀）
  // ★ v1.4.0：启动就探一次 ffmpeg —— 缺了要马上在日志里喊出来，
  //   而不是等用户对着 AlphaPi「点了没声音」再来猜。
  tc.check().then(s => {
    if (s.ok) {
      console.log('[ap] 转码就绪：ffmpeg ' + s.ver + ' → ' + tc.info().format
        + '（AlphaPi 的 /ap/… 与识别到小智的请求都会走这里）');
    } else {
      console.warn('[ap] ⚠ 没有可用的 ffmpeg（' + s.err + '）—— R1 不受影响，'
        + '但 AlphaPi 请求会返回 503。Dockerfile 已内置 ffmpeg，'
        + '直接跑 node 的话先装 ffmpeg 或设 FFMPEG_PATH。');
    }
  });
});

/**
 * ★ v4 电台预热（解释在 radioproxy.js 文件头的取证里）
 *
 * 源站是 8KB/s 的实时流，供给速率**等于**播放速率 ⇒ 设备没有天然余量，
 * 只能靠「点播那一刻一次性给到手的量」。冷启动只有源开场那 65KB（≈8 秒）
 * ⇒ 实测必采购人每 6 秒卡 3 秒。
 *
 * 所以容器一起来就把前 RADIO_WARM_N 个电台的上游烧热：听众还没来，
 * ring 已经在后台攒着几十秒的内容了 ⇒ 他点下去那一瞬间就是一大坨。
 * 听过的新台会自动进 LRU（radioproxy.touch），不需要配置。
 */
setTimeout(() => {
  try {
    const w = radioproxy.setWarm(local.radios());
    console.log('[radio] warm-up ' + JSON.stringify(w));
  } catch (e) {
    console.error('[radio] warm-up failed: ' + (e && e.message || e));
  }
}, 4000);
}   // ← if (require.main === module) 结束

// ★ v1.6.0：给测试用的最小出口（不改变运行行为）
module.exports = {
  MS_VER, SRC_LABELS, srcNorm, srcOf, withSrc, radioNorm, radioMatchUrl, srcFromUrl,
  pinyinCacheOverride, shouldCommitPlay, isPlayProbe, isLiveCommit,
  devIdOf, devByIp, histStart, histEnd, histResume, histResumeOwn, histResumeShared,
  histBookSave, histBooksSnapshot, histSnapshot, histLoad, histFlush, HIST_FILE,
  histDevTouch,   // ★ v1.7.39：给「同书两路错标上报合并」的测试用
  // ★ v1.7.38 设备分组（测试出口）
  DG_FILE, DG_DEFAULT, dgLoad, dgFlush, dgInit, dgSnapshot, dgGrpName,
  devGroupId, reqGroupId, isPseudoDev, bookKeyOf,
  histBackfillStream,
  histBackfillStreamAuto,
  isAblBook, _setAblNamesForTest,       // ★ v1.7.43：本地书判定（/v1/pos 来源标签用）
  apBookItems, apFinSane, apApplyPos, apSeekClamp,
  abcache,
  songcache,
};

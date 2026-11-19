# MyXiaoZhi_MediaServer

> **v1.7.55**（2026-11-19）· 一个容器、一个端口 **8100**，给 R1 音箱 + AlphaPi（小智）供曲：
> 本地音乐 + 在线音乐 + 网络电台 + 本地有声书 + 播放记录 / 有声书续播 + 多设备分组共享进度 + 按设备降档转码。
>
> 本项目原名 `R1XiaoZhi_MediaServer`，v1.6.8 起更名为 `MyXiaoZhi_MediaServer`。
> **x86_64 与 ARM（arm64 / armv7）通用**，一套 compose；差异只在换源和构建耗时，见第二节开头的对照表。
> 已部署的旧目录 / 旧容器名可以照常继续用，`files/` 挂卷数据不受改名影响。

---

## 一、整套方案长什么样

| 部件 | 跑在哪 | 端口 | 作用 |
|---|---|---|---|
| **MyXiaoZhi_MediaServer** | x86 NAS / 小主机、ARM 板子、任意 Docker 机 | **8100** | 曲库总出口：本地音乐、在线音乐、网络电台、有声书、播放记录 |
| **落雪音乐 lxserver** | 同上（三架构镜像） | **9527** | 在线取链通道（搜索和取播放链接都走它）；不装 = 在线歌播不了 |
| 小智服务端 | 官方或自建 | 8003 / 8000 | 语音大脑；官方 `api.tenclass.net`，自建即 xiaozhi-esp32-server |
| 设备端 | R1 音箱 / AlphaPi STEM | — | 播放器；控制台或配网门户指到 8100 |

```
设备 ──语音 WS── 小智服务端
  │
  ├─ R1 音箱        → http://<NAS IP>:8100/index.json       （原始 mp3/m4a，音箱自己解码）
  └─ AlphaPi STEM   → http://<NAS IP>:8100/ap/play          （服务端 ffmpeg 现转 8bit/24k 裸 PCM）

8100 MediaServer ── 落雪 lxserver:9527 ── 各音乐平台
```

服务端会**按客户端身份自动分流**：R1 拿原始 mp3/m4a；AlphaPi 一律转成
**8bit / 24000Hz / 单声道**（协控芯片 1 字节 = 1 样本，只认这个格式）。
识别依据优先级：`?fmt=` 参数 → `/ap/` 路径前缀 → `AP_TRANSCODE` → `?dev=ap` → UA。

---

## 二、快速安装（5 步）

**架构无关**：镜像基于官方 `node:20-alpine`（多架构 `amd64` / `arm64` / `arm/v7`），落雪
`xcq0607/lxserver` 同样是三架构镜像 —— **x86 和 ARM 是同一条命令、同一份 compose**，
差别只在换源和构建耗时：

| | **x86_64 / amd64**<br>群晖、飞牛、威联通、绿联、PVE、N100 小主机、Windows/Mac 上的 Docker Desktop | **ARM**<br>树莓派 4/5、香橙派、RK3399、以及 **Podroid**（Android 设备上跑 Linux VM 的 App，本项目开发机就是它） |
|---|---|---|
| 基础镜像 | `node:20-alpine` 的 amd64 层 | arm64 层 |
| ffmpeg | apk 装 amd64 包（连带依赖几十 MB） | aarch64 包 |
| 换源 | 一般**不用**；国内网络拉 npm 慢时再加 `AP_MIRROR` / `NPM_REGISTRY` | **建议换源**（官方源国内实测拖到十几分钟） |
| 首次构建 | 2 核小主机约一两分钟 | arm64 VM 实测 5~15 分钟 |
| 降档转码速度<br>（24/96 → 44.1k） | 实测 **20~40 倍**实时，远快于播放 | aarch64 4 核实测约 **2.1 倍**实时，够用但不宽裕 |
| 该用哪份 compose | 根目录 `docker-compose.yml` | 通用 ARM 机同上；Podroid VM 用 `docs/docker-compose.podroid.yml` |

> **两边镜像不能混用**：ARM 上 `docker save` 出来的镜像 `load` 到 x86 会 `exec format error`，反之亦然。
> 本项目是**本地构建**，`docker compose up -d --build` 天然产出本机架构，不需要 `--platform`；
> 只有搬别人导出的镜像才要留意。`files/` 是纯 JSON（音频标签缓存也是纯 JS 读的），**跨架构可以直接搬**。

1. **一台能跑 Docker 的机器**，与设备同一局域网。
   - **x86**：NAS（群晖 Container Manager / 飞牛 / 威联通 / 绿联）、PVE、N100 小主机、软路由、Windows/Mac 上的 Docker Desktop 都行；
   - **ARM**：树莓派 4/5、香橙派、RK3399 板子；**Podroid**（安卓设备上的 Linux VM App，跑 arm64）也属于这类，
     但**虚拟机要先在 App 设置里加两条端口映射 `8100→8100`、`9527→9527`**（App 默认只转发 SSH 的 `9922→22`），
     详细步骤（QEMU SLIRP、`r1net`、落雪服务名、apk/npm 换源、旧版迁移）见
     [`docs/Podroid部署教程_MyXiaoZhi_MediaServer与落雪.md`](docs/Podroid部署教程_MyXiaoZhi_MediaServer与落雪.md)，
     配套 compose 用 [`docs/docker-compose.podroid.yml`](docs/docker-compose.podroid.yml)。**x86 部署不需要这些。**
2. **装落雪 lxserver**（第三节）—— 只有在线音乐需要，本地曲库 / 有声书 / 电台不受影响。
3. 把 `MyXiaoZhi_MediaServer/` 整个目录拷到机器上，编辑 `docker-compose.yml` 里两个挂载（左边 = **宿主机**真实路径）：

   ```yaml
   - /volume1/music:/music                    # 群晖；飞牛 /vol1/...、威联通 /share/...、x86 小主机 /mnt/music
   - /volume2/.../有声读物:/audiobook          # 有声书目录（没有就删掉这一行）
   ```

   | 系统 | 左边怎么写 |
   |---|---|
   | 群晖 DSM | `/volume1/music`（DSM 7 可能是 `/volume1/…` 下的共享文件夹） |
   | 飞牛 fnOS | `/vol1/1000/Music` |
   | 威联通 QTS | `/share/Multimedia/Music` |
   | 普通 x86 Linux / PVE | `/mnt/music`、`/data/music` |
   | Windows Docker Desktop | `D:/Music`（先在 Settings → Resources → File sharing 里共享该盘），**别用 `\\NAS\share` 这类网络路径** |

   > 也可以用 `.env` 覆盖，不改编 compose：`MUSIC_HOST=/mnt/music` / `ABL_HOST=/mnt/audiobook`。
4. 起容器（会占用 8100；如果上面还跑着旧的 `r1-music` / `mini-lx` 容器，先 `docker stop r1-music mini-lx && docker rm r1-music mini-lx`）：

   ```bash
   cd /volume1/docker/MyXiaoZhi_MediaServer     # 换成你放代码的目录
   docker compose up -d --build
   ```

   - **x86 首次构建**：只拉官方 Alpine 源和 npm 包，通常一两分钟就好，什么都不用改；国内拉 npm 卡住再加
     `NPM_REGISTRY: "https://registry.npmmirror.com"` 到 compose 的 `build.args`。
   - **ARM 首次构建**（尤其 Podroid VM）：务必带上 `AP_MIRROR: "mirrors.aliyun.com"` +
     `NPM_REGISTRY: "https://registry.npmmirror.com"`，否则 apk 那 100 来个包能磨十几分钟。
   - **只接 R1、不接 AlphaPi**：把 `WITH_FFMPEG` 改 `"0"`，镜像小约 60 MB，构建也快一截
     （AlphaPi 的 8bit/24k 兼容层才需要 ffmpeg）。
5. 浏览器打开 `http://<机器 IP>:8100` → **音源** 页：填落雪地址、开三块开关、选默认音质；再到 **曲库** 页确认本地歌和电台都在。
   设备侧填的也是这个 IP（如真机是 `http://192.168.2.10:8100/index.json`）。

> Windows / Mac 上用 Docker Desktop 试跑时，记得让**防火墙放行 8100、9527**，否则本机能开页面、
> 音箱却拿不到曲库。`localhost` 只能本机用，设备要填局域网 IP。

> `files/` 是挂卷：音源配置、在线池、标签缓存、电台清单、播放记录都在里面，**容器重建不丢**。
> 首次扫 1000+ 首本地歌要等一会儿，扫完自动缓存秒回；往机器里传了新歌就在 Web 点 `/reindex`。
> 从旧版升级：因为目录名和 `container_name` 都变了，先在旧目录执行 `docker compose down`（只删容器，不动 `files/`），再到新目录 `up -d --build`。

---

## 三、落雪音乐 lxserver 安装（在线取链通道）

> 在线歌不是本容器自己爬源，而是**把取链整体中继给落雪**。落雪没部署 / 没在 8100 音源页填上地址
> = 播不了在线歌；本地曲库、有声书、网络电台**照常用**。

### 3.1 docker-compose（推荐）

在一个空目录建 `docker-compose.yml`：

```yaml
services:
  lxserver:
    image: xcq0607/lxserver:latest
    container_name: lxserver
    restart: unless-stopped
    ports:
      - "9527:9527"
    volumes:
      - ./data:/server/data
      - ./logs:/server/logs
      - ./cache:/server/cache
    environment:
      - TZ=Asia/Shanghai
```

```bash
docker compose up -d
```

### 3.2 或单条 docker run

```bash
docker run -d -p 9527:9527 \
  -v $(pwd)/lxdata:/server/data -v $(pwd)/lxlogs:/server/logs -v $(pwd)/lxcache:/server/cache \
  --name lx-sync-server --restart unless-stopped xcq0607/lxserver:latest
```

### 3.3 装完必做

1. 打开 `http://<NAS IP>:9527/admin` → 系统配置 → **改掉默认管理员密码 `123456`**。
2. 有自定义音源（订阅源）的，在后台按落雪桌面版同样的方式配进去 —— 服务端跑的就是落雪原版 `musicSdk`，手机上用什么源这里就认什么源。
3. 用**具名用户**的话，在落雪后台建一个持久化 API Token，后面 8100 音源页要填「用户名 + Token」；用 open 公开用户就都留空。

### 3.4 在 8100 音源页接上

浏览器 `http://<NAS IP>:8100` → **音源** 页：

| 项 | 填什么 |
|---|---|
| 落雪 docker（lxserver） | `http://<NAS IP>:9527` → 保存（保存时会自动跑一遍连通自检） |
| 用户名 / Token | 具名用户必填；open 用户留空 |
| 三块开关 | 本地音乐 / 在线音乐 / 网络电台，关掉哪块设备上立刻「没有」，不用重启 |
| 默认音质 | `128k`（默认，最稳最快）/ `192k` / `320k` |

搜索也走落雪：`/api/search` 先问落雪，一个都没搜到才回落脚本音源，这样「搜到的 rid」和「取链」同源，不会出现搜得到却播不了。

### 3.5 验一下

```bash
curl http://<NAS IP>:8100/api/health                       # 曲库服务活着没，看 ver / lx / ap
curl "http://<NAS IP>:9527/api/music/search?name=晴天&limit=5"   # 落雪通不通
curl "http://<NAS IP>:8100/api/lx/selftest"                # 五步自检：首页→出网→搜索→取链→直链验真
```

Web 音源页还有「测一下」按钮，跑的就是 `/api/lx/selftest`，断在哪一环会直接显示。
在线歌播不了 / 每 30 秒切一首，基本都是落雪没配或挂了；总在缓冲就把默认音质改回 `128k`。

---

## 四、compose 挂载与环境变量

### 挂载卷

| 路径 | 内容 | 能不能删 |
|---|---|---|
| `./files:/app/files` | 音源配置（`my_lx`/`media_flags.json`）、在线池 `pool.json`、本地标签缓存、电台清单、`history.json`、**在线书目永久缓存 `ab_cache.json`** | **不能删**，删了配置全丢 |
| `/volume1/music:/music` | 本地音乐库 | 按自己机器改（x86 上可能是 `/mnt/music`、`/share/…`、`D:/Music`） |
| `...:/audiobook` | 本地有声书库（**独立目录，只放有声书**） | 不听本地书可删掉挂载 + `ABL_DIR` 两处 |

### 环境变量（`docker-compose.yml` 的 `environment` 段）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MUSIC_DIR` | `/music` | 容器内音乐目录，与挂载点一致 |
| `ABL_DIR` | `/audiobook` | 容器内有声书目录；换目录要同时改挂载点 |
| `RADIOS_FILE` | `/app/files/radios.json` | 电台清单 |
| `AB_CACHE_FILE` | `files/ab_cache.json` | 在线书目永久缓存落盘位置（一般不用改；回归测试可覆盖） |
| `RADIO_PROXY` | `0` | 电台是否走本机代理；默认直连源站（对照实验结论，别随便开） |
| `AP_TRANSCODE` | `auto` | 设备识别：`auto` / `on`（全部当小智转码）/ `off`（退回纯 R1） |
| `AP_RATE` / `AP_BITS` / `AP_CH` | `24000` / `8` / `1` | 小智侧唯一能吃的格式，**不要改** |
| `AP_GAIN_DB` | `0` | 8bit 量化后音量偏小可给 `3` 或 `6`（dB） |
| `AP_START_TIMEOUT_MS` / `AP_IDLE_TIMEOUT_MS` | `20000` / `20000` | 首字节 / 传输期空闲超时 |
| `AP_PACE` | `1` | 匀速发送；设 `0` 回退旧的「ffmpeg 给多少发多少」 |
| `AP_PACE_TICK_MS` / `AP_PREBUF_MS` / `AP_MAXQ_MS` | `20` / `200` / `2000` | 发送节拍 / 预缓冲 / 队列上限（毫秒） |
| `AP_DOWN_TIMEOUT_MS` | `60000` | 「下游不读」多久才收场；**下游没读 ≠ 上游断流**，别调太小 |

> 构建参数：`WITH_FFMPEG=1` 装 ffmpeg（小智侧必需，约 60MB；只给 R1 用可改 `0`）；
> `AP_MIRROR` / `NPM_REGISTRY` 可换 apk / npm 源 —— **只有 ARM（尤其 Podroid VM）首次构建需要**，
> 那边要装 100 来个包，实测阿里云 + npmmirror 比官方源快一倍以上；**x86 上默认留空（官方源）就够快，不用传**。
> 用法见 Podroid 部署教程 §6.2。
> 容器默认 `user: "0:0"`，因为 SSH 建的 `files/` 常是 root 属主，用 node 用户会写不进配置。

---

## 五、Web 控制台

`http://<NAS IP>:8100`，顶栏显示版本号与三块状态，共六个页：

| 页 | 能做什么 |
|---|---|
| **曲库** | 本地 / 在线 / 电台三块分开看、都能试听；电台增删；`/reindex` 重扫本地曲库和有声书 |
| **电台** | 电台列表试听 / 增删 / 排序，改完立刻生效 |
| **我的节目** | 在线书目永久缓存书架：点开即播、可拖进度、批量删缓存；缺集标灰，点一下触发缺集救援 |
| **音源** | 落雪地址与 Token、三块开关、默认音质、**R1 曲库地址一键复制**、**按设备的音频转码名单**、转码缓存上限 / 清空 |
| **播放记录** | 按设备 / 分组看播放记录（内容 / 集号 / 进度 / 多久以前），可单台清或全清 |
| **设备分组** | 新建分组、把设备放进同一组共享进度（换台设备能接着听） |

三块开关的口径：关本地 → `/index.json` 里本地曲目为 0、`/m/*` 全 404；关在线 → `/online.json` 回 `off:true`；关电台 → `radios` 为空数组、语音点电台 = 没有。

**播放记录**：设备靠固件上报的 WiFi MAC（`X-Dev-Mac` 头）区分，老固件没报就退回按来源 IP（换 IP 会被当成新设备）。
只有**有声书**从这里续播，从停下位置**往前 10 秒**起播；歌曲和电台不续。
播放中每 30 秒上报一次心跳位置，意外断电最坏只丢 30 秒。
`GET /api/history` 取记录，`DELETE /api/history?dev=<id>` 清一台，`DELETE /api/history?all=1` 全清。

---

## 六、设备侧怎么接

### 6.1 R1 音箱（小智客户端）

音箱控制台 `http://<音箱IP>:8080` → **音乐源**，粘贴一行（就是 Web「音源 → 斐讯 R1」里那个地址）：

```
http://<NAS IP>:8100/index.json
```

点 **保存并重载**（只改了开关的话点「仅重载」也行）。改过开关 / 点过「换一批」后同样要重载一次。
`index.json` 一次吐出本地 + 在线 + 电台，8010 那行删掉。
默认**原样直发**（24/96 FLAC 它自己也能解）；想让 R1 走降档转码，去 Web「音源 → 音频转码」点 ＋ 把它加进列表。

### 6.2 AlphaPi STEM（小智固件 V2.4.13）

配网门户 `192.168.4.1`（长按 A 键 2 秒）→ 「我的媒体库」填 **NAS 的 IP**（端口默认 8100）→ 说一句 **「启用我的媒体库」**。设备 IP 由 DHCP 分配会变，别写死。
配套固件 V2.4.13 的 9 个设备侧 MCP 工具：语音点歌 / 电台 / 有声书、下一首（集）、停止、查正在播放、语音调进度、读时长与剩余、查 WiFi 信号。
播一集自动接下一集；有声书按 C 暂停会立即上报位置。音频走 `/ap/play` → 8bit/24k 裸 PCM 直进设备 FIFO，设备端零解码零重采样。

---

## 七、接口速查

| 路径 | 用途 |
|---|---|
| `/index.json` | R1 用：本地 + 在线 + 电台一次吐完 |
| `/ap/index.json` | 小智版曲库，`tracks[].url` 已带 `/ap` 前缀 |
| `/ap/play?kind=song\|radio\|book&q=&ep=&idx=&n=&ss=` | 小智统一播放口，返回 8bit/24k 单声道裸 PCM |
| `/ap/pos?q=&ep=&sec=&abs=&fin=&beat=` | 设备上报播放位置 / 播完 / 30s 心跳 |
| `/ap/song?q=` | 语音点歌一步口（搜一首直接推流） |
| `/api/history` | 播放记录（GET / DELETE） |
| `/api/ab/search` / `/api/ab/episodes` | 在线有声书：按本汇总 / 有序集表（`?fresh=1` 强制回源） |
| `/api/ab/cache` | **v1.6.9** 在线书目永久缓存：GET 查看（v1.7.0 支持 `?key=…&full=1` 纯缓存直读整本集表）、DELETE 清除 / 标刷新 |
| `/api/health` | 体检：`ver`、`lx`、`media`、`localCount`、`ap` 转码状态、`abCache` 缓存统计 |
| `/api/whoami` | 这条请求被识别成 `r1` 还是 `alphapi`、依据是什么 |
| `/api/lx/selftest` | 落雪五步自检 |
| `/api/ap/selftest` | ffmpeg 转码自检（正弦波） |
| `/api/search` / `/api/url` | 在线搜歌 / 取链（只走落雪） |
| `/api/lx` / `/api/media` / `/api/quality` | 落雪地址 / 三块开关 / 默认音质读写 |
| `/api/radios` | 电台清单读写（POST 用数组整体覆盖） |
| `/reindex` | 重扫本地曲库 |
| `/m/<path>` / `/r/<source>/<rid>` / `/radio/<b64url>` | 本地文件 / 在线惰性取链 / 电台 |

### 7.1 在线书目永久缓存（v1.6.9）

有声书的 `albumId` / `source` / `rid` / 集表基本不变，所以**搜过、整理过、播过的书统一缓存在服务端
`files/ab_cache.json`，没有过期时间，所有设备拉同一份**。进程重启、容器升级都不用重新搜。
回源后先比对内容指纹：没变就一个字节都不写，真增删集才 `rev++`。只有「播不了」（取链失败累计
到阈值 / 整本取链全空）或显式 `?fresh=1` 才会重新搜一次。直链不落盘（会过期），仍现取。

```bash
curl 'http://<NAS>:8100/api/ab/cache'                                  # 看缓存了哪些书、rev、集数、stale
curl 'http://<NAS>:8100/api/ab/cache?key=kw|A123&full=1'                # ★ v1.7.0 纯缓存直读整本集表（不回源，书架用）
curl -X DELETE 'http://<NAS>:8100/api/ab/cache?all=1'                   # 全清
curl -X DELETE 'http://<NAS>:8100/api/ab/cache?key=kw|A123'             # ★ 手动删掉不要的书（书架页删除按钮同款，带二次确认）
curl -X DELETE 'http://<NAS>:8100/api/ab/cache?key=kw|A123&refresh=1'    # 只让一本下次重搜
curl 'http://<NAS>:8100/api/ab/episodes?q=三体&fresh=1'                 # 主动同步新集
```

### 7.2 Web 书架页（v1.7.0）

Web UI 改成落雪音乐风格的**移动端 / 桌面端自适应**（≥860px 宽屏出多栏网格，手机保持单列）。
新增「**书架**」页：

- **有声书搜索就在书架里**（曲库页只搜歌）：结果按「本」出封面卡片，点「＋ 缓存」直接整理整本进缓存
  （v1.7.2 起纯搜索**不写缓存** —— 点开 / ＋缓存 / 设备播过才进，书架不再堆积「仅摘要」条目）；
- **批量管理**：右上「批量管理」进勾选模式 —— 点卡片勾选、全选 / 选全部仅摘要 / 清空选择、
  「🗑 删除所选」双重确认后走 DELETE /api/ab/cache?keysjs=[…] 批量接口真删缓存；
- **点书 = 整页切到详情视图**（落雪点歌单式），顶部「← 返回」，不再把列表追加在页面底部；
- 直接看到已缓存的全部书目（书名 / 主播 / 集数 / 最近播放 / stale 标记），点开即播任意一集；
- **缺集占位**：上游没有的集（如仙逆 110 → 114）会在集表里插灰色占位行
  （`{missing:true}` 落进 `ab_cache.json`，R1 / AlphaPi / 网页共享同一份都能看到）；
  点占位行触发**缺集救援**（`/api/ab/episodes?…&ep=N&rescue=1`，v1.7.1 起不再整本重搜、
  直接精确词救援，秒级响应）：缓存里该集仍是占位时，用「演播 书名 第N集」等四种词形
  回源精确搜这一集（整本全量拉取会截断漏集，但单集
  精确词能搜到 —— 落雪同款搜法）。救回即占位换真集（`rescued:true` 带「补」角标），
  缓存刷新自动保留；上游自己补了真集则救援行让位。设备端也能带 `rescue=1` 调同一接口；
  救援失败提示占位保留，以后可再试；
- 进度条**可点击 / 可拖动**调进度（电台直播流除外）；
- 每本书带「删除」按钮（**二次确认**）、「重搜」按钮；页尾「清空书架」需**双重确认**。

补洞规则：只看集号 > 0 的条目找断档；单档 > 30 集不补（换季重编号）；一本书补洞总量上限 5000。
升级前缓存的书首次启动自动迁移补洞（`gv` 版本章，补洞被截断的不盖章下次重试）。

上游新增的集不会自动探测（探测本身就是一次重搜），要同步用 `fresh=1` / `refresh=1`。
多设备同时 miss 由服务端单飞去重，只回源一次；不同设备传不同 `source` 也命中同一本。
完整改造路线见 `docs/多设备改造路线.md`。

临时改档位：`?fmt=wav|pcm|mp3`、`?rate=&bits=&ch=&gain=&raw=1`（单次覆盖，不影响全局）。
`/ap/` 前缀下的同名接口一律强制转码。

---

## 八、常见问题

| 现象 | 处理 |
|---|---|
| 在线歌播不了 / 每 30 秒切一首 | 落雪没配或挂了：查 8100 音源页地址 → `curl http://<NAS>:9527/api/music/search?name=x&limit=5` → `/api/lx/selftest` 看断在哪一步 |
| 在线歌总在缓冲 | 音源页把默认音质改回 `128k` |
| 本地中文歌显示成 `ÖÜ½ÜÂ×` 乱码 | 老 MP3 的 ID3 标签声明 ISO-8859-1 实际是 GBK，服务端已自动还原；`files/local_cache.json` 里的旧乱码加载时就地修，不用重扫 |
| 电台播几秒停一下 / 同一句反复播 | 默认 `RADIO_PROXY=0` 直连源站；别开代理，也别让多个设备抢同一路流 |
| 小智侧无声 / 只有杂音 | 确认 `WITH_FFMPEG=1`、`AP_RATE=24000`/`AP_BITS=8`/`AP_CH=1` 三项保持默认，`/api/whoami` 看识别结果，`/api/ap/selftest` 看转码 |
| 播放记录位置不对 / 续播往回跳 | 位置只认设备 `/ap/pos` 上报；「这集播完」只认 `fin=1`，不要拿服务端推出去的字节数判断（ffmpeg 比实时快十几倍）。v1.6.8 已把集尾断点夹值从 `dur-30` 改为 `dur-3`，配套固件 V2.4.13 |
| 容器重建后配置全没了 | `files/` 没挂卷，或被 `docker cp` 到镜像里了；compose 里必须有 `- ./files:/app/files` |
| 在线书每次都要重新搜 / 集表没更新 | v1.6.9 起是永久缓存，正常响应带 `cache:'disk'`；一直 `cache:'search'` 就查 `files/` 挂卷与写权限。上游新增集用 `?fresh=1` 同步 |
| 两个容器互相隔离、取链每档超时 | 落雪与曲库要能互相访问；用 `/api/lx/selftest` 五步定位，别只凭绿灯判断 |

日志在 `docker logs MyXiaoZhi_MediaServer`；`/ap/log` 会把设备日志追加到 `files/devlog.txt`，Web 播放记录页也能看。

---

## 九、版本与升级

| 版本 | 要点 |
|---|---|
| **v1.7.55** | 转码名单只显示**已加入**的设备，加设备走 **＋ 弹层**（候选来自「设备分组」）；AlphaPi 默认就转（`/ap/` 8bit/24k），不进候选；页脚加项目地址 |
| **v1.7.54** | 转码从「全局开关」改成**按设备白名单**：只有加入名单的设备降档，其余原样直发（名单为空 = 全都不转） |
| **v1.7.52 / 53** | 音源页新增 **R1 曲库地址一键复制**；转码缓存上限可在 Web 改 / 清空；`/api/trans/*` 只对 `stats` / `probe` 开 CORS |
| **v1.7.50 / 51** | 伪 VOD：`Content-Length = 时长 × 16000` + 真 `206 / Content-Range`，转码流也能显示时长、可拖动（拖到未转区自动 `-ss` 续转） |
| **v1.7.49** | 受限终端**降档转码**（`aacache.js`）：无损 / 超采样率按需转 MP3 128k，边转边发，转完落缓存 |
| **v1.7.48** | 合集书身份改为**子书名**（合集名只作系列展示），修「三部曲糊成一条」 |
| **v1.7.38 / 41** | 播放记录带**组维度**（`g:<grp>\|<base>`），设备分组内共享进度；组 id 展示成可读名 |
| **v1.7.31 ~ 47** | 记录身份全面收紧：真播判据（`live=1` / 传输字节）、按来源 IP 反查真实设备、书名归一化、电台并入当前条、本地书名以本地库为准 |
| **v1.7.30** | ASR 同音字纠偏（拼音模糊搜索，`pinyin.js`）：「凡人休仙传」也能搜到《凡人修仙传》 |
| **v1.7.22 ~ 29** | 所有 API JSON 一律 `no-store`；在线集支持集内偏移（前进 / 后退 / 跳到第 N 分钟）；歌单本机续播；`dur` 不跨集继承 |
| **v1.7.10 ~ 21** | 缺集判定以 `rid` 为准、在线书目缓存与真名回填、`GET /v1/resume` 轻量续播查询、歌曲取链 rid 缓存 |
| v1.4.0 | R1 / AlphaPi 双设备共用一套地址，按身份分流 + ffmpeg 转码 |
| v1.5.x | `/ap/song` 语音点歌、`/ap/play` 三类统一出口（歌单 / 电台 / 有声书） |
| v1.6.0 | 按 MAC 分设备的播放记录、有声书续播、Web 播放记录页 |
| v1.6.3 | 播放位置只认设备上报，不再信服务端字节数 |
| v1.6.4 | 30 秒心跳 + 墙钟封顶，意外断电最多丢 30 秒 |
| v1.6.6 | 匀速发送（墙钟补量）+ 撤销 fin 拦截，修在线歌偶发卡顿 |
| v1.6.7 | 下游 60s 未读单独超时，避免起流 20s 被误杀 |
| v1.6.8 | 集尾起点夹值 `dur-30` → `dur-3`，修「播完不跳下一集、倒回 28 秒循环」；项目更名 `MyXiaoZhi_MediaServer` |
| **v1.6.9** | 在线有声书整本索引**永久缓存**（`abookcache.js`）：无 TTL、变了才写盘、播不了才重搜、多设备共享同一份；新增 `/api/ab/cache` 与 `abCache` 体检字段 |
| **v1.7.9** | **缺集列表只要集号 + 真名自动同步**：/api/ab/episodes 与 /api/ab/cache?full=1 输出层把缺集占位标题统一成「第 N 集」（磁盘原文不动，缺集提示靠 missing 字段）；/r/ 回传识别兼容新标题（rid 不在缓存书目才判为设备自救）；Web 书架详情页 15s 轮询 full=1（纯缓存直读零回源），rev 变了原地重渲染保留页码/滚动 |
| **v1.7.8** | **回传补真名 · 借标题兜底**：设备走的 rid 在搜索里捞不出时（实测遮天 260 连全量枚举都没有），补名搜索改取同集号候选借真标题（书名/主播加分），只补 title/album 不动已验证可播的 rid |
| **v1.7.7** | **直链播放落记录 + 回传补真名**：/r/ 与 /m/ 成功播放落 history（rid 反查书目→kind=book 书/集/主播齐，非书目→song；本地书按路径记书名/集号；120s 去重防 Range 刷）；设备救援回传缺暂存时先落兜底标题、后台精确词按 rid 对号补真名（真名落定不再被覆盖） |
| **v1.7.6** | **设备救援回传**：R1 点缺集自己搜 rid 直接 /r/ 播（结果此前不回传，服务端永远灰着）—— /r/ 成功且 title 是缺集占位文案 ⇒ 按集号+主播+albumId 找占位书 rescueEp 学回缓存；设备端零改动 |
| **v1.7.5** | **点播缺集自动救援（R1 零改动适配）**：/api/ab/episodes 带 ep=N 且该集是占位就自动触发救援再应答（rescue=1 兼容保留）；救援落空记 10 分钟负缓存，反复点播不反复空搜 |
| **v1.7.4** | **救援成功顺手预热取链**：点击播放不是重搜 —— 是 /r/ 惰性取链（3.6~4s）；救援落盘成功后立刻后台 resolveUrl 预热（30 分钟缓存），点这一集秒开 |
| **v1.7.3** | **缺集救援提速**：abRescueEp 词形搜索从 lxSearchAll 全量枚举（单趟 19s）改为限量 50 快搜（3~4s），四趟全落空才对「书名 第N集」做一次全量兜底 —— 实测救援从 27s 降到 ~4s |
| **v1.7.2** | **书架批量管理 + 搜索不写摘要缓存**：书架新增「批量管理」勾选模式（全选 / 选全部仅摘要 / 清空选择 / 删除所选，双重确认真删缓存，DELETE /api/ab/cache?keysjs=[…]）；/api/ab/search 回源路径不再把搜到的书写成「仅摘要」—— 没播放 / 没点开的书不进缓存（进缓存收敛为：＋缓存 / 点开书 / 设备播过） |
| **v1.7.1** | **缺集救援提速 + 缓存防降级**（实测翻车两连修）：缺集重试不再带 `fresh=1` 整本重搜（几十秒）—— 直接吃缓存集表走精确词救援，秒级出结果；`putFull` 防降级 —— 上游对重复查询吐截断缓存（2101→2000→200）时旧表真集优先补回新表占位行，好集不再被降级成「缺」；_tests ⑪ 防降级回归 |
| **v1.7.0** | Web UI 自适应改版（落雪风格，手机/桌面双形态）+ **书架页**：缓存书单直接看、点开即播、进度条可点/可拖；网页搜过 / 点开过的书同样进永久缓存；书架支持单本删除（二次确认，**真删缓存**）与清空书架（双重确认）；`/api/ab/cache?key=…&full=1` 纯缓存直读整本集表 |

> **v1.7.0 无需迁移**：纯前端 + 一条只读接口扩展，`files/ab_cache.json` 原样兼容。
>
> **从旧版升级 / 更名**：v1.6.8 起目录与 `container_name` 改为 `MyXiaoZhi_MediaServer`。
> 若 NAS 上原来以 `R1XiaoZhi_MediaServer` 部署过，先在旧目录执行 `docker compose down`
> （只停容器，**不删 `files/`**），再到新目录 `docker compose up -d --build`，否则两个容器会抢
> 8100 端口。也可以保留旧目录名、把 `container_name` 改回旧值，功能完全一致。

改完代码部署：`docker compose up -d --build`。回归测试：

```bash
npm test                       # ab-cache.js + ap-play-args.js + ap-history.js（纯逻辑，不联网）
node _tests/ap-transcode.js    # 需要 ffmpeg，单独跑
```

---

## 十、免责

本项目为个人研究性质的自建媒体服务，仅供学习交流。
音乐、有声书资源因版权原因不随包提供，请自备；在线音源请遵守各平台条款。使用本方案产生的任何后果由使用者自行承担。

---

## 十一、许可（License）

本项目采用 **GNU Affero General Public License v3.0**（SPDX：`AGPL-3.0-only`，全文见仓库根目录 `LICENSE`）：
<https://www.gnu.org/licenses/agpl-3.0.html>

直白说：

- **可以**自由使用、修改、分发，**也允许商业使用**；
- **但是**只要把改过的版本分发出去、或者**通过网络给用户提供**（第 13 条，SaaS / 自建盒子都算），就必须以 AGPL 公开全部源码；
- 不想开源又要商用 —— 请单独联系作者获取商业授权。

选 AGPL 而不是 MIT 的原因：这东西本来就是拿来跑在别人家服务器 / 小主机上的，网络条款能保证改动回流，也挡住「拿它做个闭源成品去卖」这类用法。

**不随包分发的部分**

- **在线音源脚本不随仓库分发**。落雪系音源（如「幻音」）版权归各作者、按其原条款使用，需要时请在 Web「音源」页自行导入；
- 运行时依赖 `music-metadata` 为 MIT 许可，版权归其作者；
- 容器内的 ffmpeg 等外部程序按其自身许可（LGPL / GPL）分发。

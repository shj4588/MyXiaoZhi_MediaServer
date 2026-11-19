'use strict';
/**
 * 转码「按设备白名单」纯逻辑回归（V1.7.54）—— 不起 ffmpeg、不碰真实 files/。
 *
 *   node _tests/aac-whitelist.js
 *
 * 覆盖：
 *   ① 名单为空 ⇒ 任何设备 listed=false / on=false，judge 直接 not-listed（不探针）
 *   ② addDev 大小写不敏感、12 位归一；加进来之后 listed/on 都为真
 *   ③ 无损扩展名判 need=true（不需要 ffprobe）；delDev 后立刻回落 false
 *   ④ 单台设备 `on:false` = 留在名单里但不转
 *   ⑤ 缓存上限优先级：_maxMB（Web）> 设备档位最大值 > DEF 2048
 *   ⑥ 总闸：setGlobal(0) ⇒ judge = master-off；恢复后白名单照旧
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMPDIR = path.join(os.tmpdir(), 'aac-wl-' + process.pid);
const CONF = path.join(TMPDIR, 'audio_profiles.json');
try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* ignore */ }

const aac = require('../aacache');
aac.init({ dir: TMPDIR, confFile: CONF, sendFile: null });

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
};

const R1 = '98BB9936CD6B';
const FAKE = path.join(TMPDIR, 'x.flac');          // 不存在的文件也无所谓：命中 lossless 分支前不 stat

(async () => {
  console.log('== ① 空名单：谁都不转 ==');
  const p0 = aac.profile(R1);
  ok(p0.listed === false && p0.on === false, '未登记设备 listed=false / on=false', p0);
  const j0 = await aac.judge(FAKE, 'x.flac', p0);
  ok(j0.need === false && j0.why === 'not-listed', 'judge = not-listed（不探针）', j0);
  const e0 = await aac.judge(FAKE, 'x.flac');
  ok(e0.need === false && e0.why === 'not-listed', '不传 prof 也按「空名单」处理', e0);
  ok(aac.info().listed === 0 && aac.info().on === false, 'info: listed=0 / on=false', aac.info());

  console.log('== ② addDev 归一 + 生效 ==');
  aac.addDev('98bb9936cd6b');
  const l1 = aac.devList();
  ok(!!l1[R1], '小写 id 归一成大写后入名单', Object.keys(l1));
  const p1 = aac.profile(R1);
  ok(p1.listed === true && p1.on === true, '登记后 listed/on 都为真', p1);
  ok(p1.devId === R1 && p1.tag === 'mp3128k44100x2', '档位默认 MP3 128k/44.1k/stereo', p1);
  ok(aac.info().listed === 1 && aac.info().on === true, 'info: listed=1 / on=true', aac.info());

  console.log('== ③ 无损判定 + delDev 立刻失效 ==');
  const j1 = await aac.judge(FAKE, 'x.flac', p1);
  ok(j1.need === true && /^lossless:/.test(j1.why), 'flac ⇒ need=true（无需 ffprobe）', j1);
  const j2 = await aac.judge(FAKE, 'x.mp3', p1);
  ok(j2.need === false, 'mp3 且探针失败 ⇒ 宁可直发', j2);
  ok(aac.delDev(R1) === true, 'delDev 返回 true');
  ok(aac.profile(R1).listed === false, '移出后 listed 立刻回落 false');
  ok(Object.keys(aac.devList()).length === 0, '名单清空');

  console.log('== ④ 单台 on:false：在名单里但不转 ==');
  aac.addDev(R1);
  aac.setDev(R1, { on: 0 });
  const p2 = aac.profile(R1);
  ok(p2.listed === true && p2.on === false, 'listed=true / on=false', p2);
  const j3 = await aac.judge(FAKE, 'x.flac', p2);
  ok(j3.need === false && j3.why === 'off', 'judge = off', j3);
  aac.setDev(R1, { on: 1 });

  console.log('== ⑤ 缓存上限优先级 ==');
  ok(aac.maxMBof() === 2048, '默认 2048', aac.maxMBof());
  aac.setMaxMB(512);
  ok(aac.maxMBof() === 512, 'Web 设 _maxMB=512 生效', aac.maxMBof());
  aac.setMaxMB(0);
  ok(aac.maxMBof() === 2048, '清掉 _maxMB 回默认', aac.maxMBof());
  aac.setDev(R1, { maxMB: 4096 });
  ok(aac.maxMBof() === 4096, '设备档位 maxMB=4096 抬到全局上限', aac.maxMBof());
  aac.setMaxMB(1024);
  ok(aac.maxMBof() === 1024, '_maxMB 优先于设备档位', aac.maxMBof());
  aac.setMaxMB(0);
  aac.setDev(R1, { maxMB: 2048 });
  ok(aac.maxMBof() === 2048, '都回默认', aac.maxMBof());

  console.log('== ⑥ 总闸 ==');
  aac.setGlobal(0);
  const j4 = await aac.judge(FAKE, 'x.flac', aac.profile(R1));
  ok(j4.need === false && j4.why === 'master-off', '总闸关 ⇒ master-off', j4);
  ok(aac.info().on === false, 'info.on=false');
  aac.setGlobal(1);
  const j5 = await aac.judge(FAKE, 'x.flac', aac.profile(R1));
  ok(j5.need === true, '总闸开回来 ⇒ 名单设备照旧转', j5);

  console.log('== ⑦ 落盘：重启后名单还在 ==');
  const raw = JSON.parse(fs.readFileSync(CONF, 'utf8'));
  ok(!!raw[R1], 'audio_profiles.json 里有这台设备', raw);
  ok(raw._master === true, '总闸状态也持久化', raw);

  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();

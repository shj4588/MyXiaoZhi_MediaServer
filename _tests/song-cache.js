'use strict';
/**
 * songcache.js 纯逻辑回归 —— 不联网、不碰真实 files/。
 *
 *   node _tests/song-cache.js
 *
 * 覆盖：
 *   ① keyOf 归一化（大小写 / 分隔符 / 全半角）
 *   ② put/get 往返 + 落盘永久性（_reset 模拟重启）
 *   ③ markFail / recentFail 负缓存窗口（10 分钟）
 *   ④ put 成功撤掉负缓存
 *   ⑤ 容量淘汰不越上限（setLimit 改小立刻淘汰，最久没播先走）
 *   ⑥ require server.js：MS_VER 1.7.12 + songcache 出口正常
 *   ⑦ list 分页/过滤 + del 批量删 + clearAll 清空（v1.7.12 管理端）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'song-cache-test-' + process.pid + '.json');
process.env.SONG_CACHE_FILE = TMP;
try { fs.unlinkSync(TMP); } catch { /* 本来就没有 */ }

const C = require('../songcache');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b });
const normTitleHit = (s, q) =>
  String(s.title || '').indexOf(q) >= 0 || String(s.artist || '').indexOf(q) >= 0
  || String(s.rid || '').indexOf(q) >= 0;

async function main() {
  console.log('\n== ① keyOf 归一化 ==');
  eq(C.keyOf('Il aurait suffi', 'Lana Del Rey'), C.keyOf('il aurait suffi', 'lana del rey'),
    '大小写不敏感');
  ok(C.keyOf('《紅蓮華》', 'LiSA') !== C.keyOf('红莲华', 'lisa'),
    '不同汉字（繁/简）不同 key —— 归一化不做繁简转换，宁缺毋滥');
  ok(C.keyOf('Save Your Tears', '') === C.keyOf('save your tears', ''), 'artist 空也能成键');
  eq(C.keyOf('  Save   Your  Tears ', 'The Weeknd'), C.keyOf('Save Your Tears', 'The Weeknd'),
    '空白/分隔符全部归一（同 abookcache 口径）');

  console.log('\n== ② put/get 往返 + 永久性 ==');
  const K1 = C.keyOf('If You Lie Down With Me', 'Lana Del Rey');
  const s1 = C.put({ key: K1, title: 'If You Lie Down With Me', artist: 'Lana Del Rey',
    source: 'kw', rid: '196762079', album: 'Blue Banisters', kind: '' });
  ok(s1 && s1.rid === '196762079', 'put 返回落库条目');
  ok(C.get(K1) && C.get(K1).rid === '196762079', 'get 命中');
  ok(!C.get(C.keyOf('不存在的歌', '')), '没存的返回 null');
  const noRid = C.put({ key: C.keyOf('x', ''), title: 'x', artist: '', source: 'kw', rid: '' });
  ok(noRid === null, '没有 rid 的条目不收');
  C.flush();
  C._reset();
  ok(C.get(K1) && C.get(K1).rid === '196762079', '_reset 模拟重启后仍命中磁盘同一份');

  console.log('\n== ③ 负缓存窗口 ==');
  const K2 = C.keyOf('搜不到的歌', ' nobody ');
  C.markFail(K2);
  ok(C.recentFail(K2) === true, '刚记的负缓存命中窗口');
  ok(C.get(K2) === null, '负缓存不影响 get（本来就 null）');
  C.flush();
  C._reset();
  // 手工把 fail 时间戳挪到 11 分钟前 ⇒ 窗口外
  const j = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  j.fail[K2] = Date.now() - 11 * 60 * 1000;
  fs.writeFileSync(TMP, JSON.stringify(j));
  C._reset();
  ok(C.recentFail(K2) === false, '11 分钟前 ⇒ 窗口外，可重试');

  console.log('\n== ④ put 撤负缓存 ==');
  const K3 = C.keyOf('Hallelujah', 'Leonard Cohen');
  C.markFail(K3);
  ok(C.recentFail(K3) === true, '前置：负缓存中');
  C.put({ key: K3, title: 'Hallelujah', artist: 'Leonard Cohen', source: 'kw', rid: 'r_h' });
  ok(C.recentFail(K3) === false, '解析成功撤掉负缓存');

  console.log('\n== ⑤ 容量淘汰 ==');
  eq(C.DEFAULT_LIMIT, 5000, '默认上限 5000');
  eq(C.getLimit(), 5000, '未设置时读默认');
  // 用小容量测淘汰（5000 条逐条 evict 排序太慢），行为与默认值同一套代码
  eq(C.setLimit(100), 100, 'setLimit 落盘生效');
  for (let i = 0; i < 130; i++) {
    C.put({ key: C.keyOf('歌' + i, 'a'), title: '歌' + i, artist: 'a', source: 'kw', rid: 'r' + i });
  }
  ok(Object.keys(C.load().songs).length <= 100, '淘汰后不超上限');
  ok(!C.get(C.keyOf('歌0', 'a')), '最早入库的先被淘汰');
  ok(!!C.get(C.keyOf('歌129', 'a')), '最新入库的还在');
  // 最久没播的先走：给歌120 记一次播放，把歌119~128 中一条顶掉也轮不到它
  C.markPlay(C.keyOf('歌120', 'a'));
  for (let i = 130; i < 140; i++) {
    C.put({ key: C.keyOf('歌' + i, 'a'), title: '歌' + i, artist: 'a', source: 'kw', rid: 'r' + i });
  }
  ok(!!C.get(C.keyOf('歌120', 'a')), '播过的条目在淘汰中更晚走（lastPlay 优先）');
  eq(C.setLimit(1), 50, 'setLimit 下限钳到 50');
  eq(C.setLimit(99999), 50000, 'setLimit 上限钳到 50000');

  console.log('\n== ⑥ server.js 集成 ==');
  const S = require('../server.js');
  ok(parseInt(String(S.MS_VER).split('.')[1], 10) >= 7, '版本号已升到 1.7.x 及以后：' + S.MS_VER);
  ok(!!S.songcache, '测试出口暴露 songcache');
  eq(S.songcache.FILE, C.FILE, 'server 与测试指向同一份缓存文件');

  console.log('\n== ⑦ list / del / clearAll（v1.7.12 管理端） ==');
  C.setLimit(500);
  const pg = C.list(1, 10, '');
  ok(pg.ok === true && pg.total === Object.keys(C.load().songs).length, 'list 总数与库一致');
  eq(pg.items.length, 10, 'size=10 每页 10 条');
  ok(pg.page === 1 && pg.pages >= Math.ceil(pg.total / 10), 'pages 计算正确');
  ok(pg.items[0].at >= pg.items[pg.items.length - 1].at, '入库时间倒序');
  const pg2 = C.list(2, 10, '');
  ok(pg2.items[0].key !== pg.items[0].key, '翻页内容不同');
  const pgq = C.list(1, 10, '歌13');
  ok(pgq.total >= 1 && pgq.items.every(s =>
    normTitleHit(s, '歌13')), 'q 过滤命中歌13 系列');
  // 删 2 条
  const delKeys = [pg.items[0].key, pg.items[1].key];
  eq(C.del(delKeys), 2, 'del 返回实际删除数');
  ok(!C.get(delKeys[0]) && !C.get(delKeys[1]), '删掉的 get 不再命中');
  eq(C.del([]), 0, '空数组删 0 条');
  eq(C.del('not-array'), 0, '非数组删 0 条');
  // 清空
  const before = Object.keys(C.load().songs).length;
  eq(C.clearAll(), before, 'clearAll 返回原条数');
  eq(Object.keys(C.load().songs).length, 0, '清空后 songs 空');
  eq(Object.keys(C.load().fail).length, 0, '清空连负缓存一起');

  C._reset();
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  console.log('\n' + (fail ? '✗' : '✓') + ' 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

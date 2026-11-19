'use strict';
/** v1.7.30 拼音模糊搜索引擎回归测试（node 直跑，无需起服务） */
const py = require('../pinyin');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}

const BOOKS = [
  "遮天",
  "琅琊榜+琅琊榜之风起长林",
  "仙逆丨多人剧丨曲中人有故事丨动漫热播原著丨耳根丨完结",
  "凡人修仙传",
  "让你写卖鱼佬，你现场写高启强？",
];

console.log('\n[1] 拼音表加载');
const map = py.loadMap();
ok(Object.keys(map).length > 40000, '全字表 > 40000 字（实际 ' + Object.keys(map).length + '）');
ok(py.toPinyin('仙逆') === 'xianni', '仙逆 → xianni（实际 ' + py.toPinyin('仙逆') + '）');
ok(py.toPinyin('写你') === 'xieni', '写你 → xieni（实际 ' + py.toPinyin('写你') + '）');

console.log('\n[2] 核心场景：ASR 同音字误识别纠偏');
for (const q of ['写你', '邪逆', '先逆']) {
  const hits = py.fuzzySearch(q, BOOKS);
  ok(hits.length >= 1, '「' + q + '」有拼音命中');
  if (hits.length) ok(hits[0].book.indexOf('仙逆') === 0, '「' + q + '」Top1 = 仙逆（实际 ' + hits[0].book.slice(0, 6) + '）');
}

console.log('\n[3] 精确词仍命中自己（不误伤正常搜索）');
for (const [q, want] of [['仙逆', '仙逆'], ['遮天', '遮天'], ['琅琊榜', '琅琊榜'], ['凡人', '凡人']]) {
  const hits = py.fuzzySearch(q, BOOKS);
  ok(hits.length && hits[0].book.indexOf(want) === 0, '「' + q + '」Top1 = ' + want);
}

console.log('\n[4] 阈值安全边界：错书不冒头');
{
  const hits = py.fuzzySearch('写你', BOOKS);
  const seller = hits.find(h => h.book.indexOf('卖鱼佬') >= 0);
  ok(!seller, '「写你」不会命中《卖鱼佬》（无误伤）');
  const bad = py.matchScore('写你', BOOKS[4]);
  ok(bad.score < py.PY_MIN, '卖鱼佬得分 ' + bad.score.toFixed(2) + ' < 阈值 ' + py.PY_MIN);
}

console.log('\n[5] 无关查询不乱命中');
for (const q of ['量子', '财税', '世界杯']) {
  const hits = py.fuzzySearch(q, BOOKS);
  ok(hits.length === 0, '「' + q + '」无命中（实际 ' + hits.length + '）');
}

console.log('\n[6] v1.7.32 纠偏越过错误缓存（pinyinCacheOverride 纯函数）');
{
  const S = require('../server.js');
  const f = S.pinyinCacheOverride;
  // abcache.search() 返回 rec 数组（rec 自带 .book/.key），不是 {rec,score}
  const diskHit = (name) => [{ book: name, key: 'kw|' + name }];
  const pyHit = (name, score) => [{ book: name, pyScore: score }];
  const SELLER = '让你写卖鱼佬，你现场写高启强？';
  const XIANNI = '仙逆丨多人剧丨曲中人有故事丨动漫热播原著丨耳根丨完结';
  const FANREN = '凡人修仙传丨光合积木';

  ok(f('写你', diskHit(SELLER), pyHit(XIANNI, 4.2)) === true,
    'ASR 错词「写你」被《卖鱼佬》缓存截胡 ⇒ 纠偏接管（核心 bug）');
  ok(f('邪逆', diskHit(SELLER), pyHit(XIANNI, 4.2)) === true,
    '同音变体「邪逆」同样接管');
  ok(f('凡人', diskHit(FANREN), pyHit(FANREN, 7.0)) === false,
    '缓存与纠偏指向同一本《凡人修仙传》⇒ 不接管（零误伤）');
  ok(f('仙逆', diskHit(XIANNI), pyHit(XIANNI, 7.0)) === false,
    '缓存 normQ 全等命中真书名 ⇒ 直接走 disk，不接管');
  ok(f('让你写卖鱼佬', diskHit(SELLER), pyHit(SELLER, 7.0)) === false,
    '长查询(>4 字)不接管');
  ok(f('写你', diskHit(SELLER), []) === false,
    '无拼音命中不接管（没有纠偏可用）');
  ok(f('写你', [], pyHit(XIANNI, 4.2)) === false,
    '缓存无命中不接管（交给 v1.7.30 原有未命中纠偏链）');
  ok(f('', diskHit(SELLER), pyHit(XIANNI, 4.2)) === false,
    '空查询不接管');
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

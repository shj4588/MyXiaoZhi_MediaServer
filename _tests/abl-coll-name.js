'use strict';
/**
 * v1.7.48 合集子书的**书身份**回归 —— 纯本地，不联网、不转码。
 *
 *   node _tests/abl-coll-name.js
 *
 * 规则（用户拍板）：「后面的名字才是书名，三体只是系列」。
 *   · 三部曲共用一目录（D 型命名 `三体139-【黑暗森林Ⅱ】第85集.mp3`）⇒ 合集
 *   · 合集列表项叫「三体」（系列名），点开是三部子书
 *   · **子书集表响应的 name 必须是子书名**（「黑暗森林Ⅱ」），series 才是「三体」
 *   · bookOfRel（/m/ 直链反查）与 books() 的 hitSub 同口径，也是子书名
 *
 * 以前 name=x.name 让三部共用「三体」一个书键：书级进度、播放记录、续播点
 * 全糊成一本，看不出在听哪一部（本次改动要防的就是这个回退）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.tmpdir(), 'abl-coll-' + process.pid);
process.env.ABL_DIR = ROOT;
process.env.ABL_CACHE = path.join(os.tmpdir(), 'abl-coll-cache-' + process.pid + '.json');
process.env.ABL_POS = path.join(os.tmpdir(), 'abl-coll-pos-' + process.pid + '.json');
for (const f of [process.env.ABL_CACHE, process.env.ABL_POS]) {
  try { fs.unlinkSync(f); } catch { /* 本来就没有 */ }
}
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
fs.mkdirSync(ROOT, { recursive: true });

/** 300KB 的假音频：walk() 会滤掉 <200KB 的试听片段 */
const buf = Buffer.alloc(300 * 1024, 7);
const FILES = [
  '三体001-【地球往事Ⅰ】第01集.mp3',
  '三体002-【地球往事Ⅰ】第02集.mp3',
  '三体100-【黑暗森林Ⅱ】第01集.mp3',
  '三体101-【黑暗森林Ⅱ】第02集.mp3',
  '三体200-【死神永生Ⅲ】第01集.mp3',
  '三体201-【死神永生Ⅲ】第02集.mp3',
  // 普通书（非合集）也要保住老行为：name = 目录/文件名里的书名
  '道诡异仙-第1集-引子.m4a',
];
for (const f of FILES) fs.writeFileSync(path.join(ROOT, f), buf);

const A = require('../ablocal');

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m, { got: a, want: b });

const MEM = A.scan();
console.log('\n== ① 扫盘：三体是合集，三部子书 ==');
const coll = (MEM.books || []).find(b => b.name === '三体');
ok(!!coll, '三体被识别为合集');
eq(coll && coll.kind, 'coll', 'kind=coll');
eq((coll && coll.subs || []).map(s => s.name).sort(), ['地球往事Ⅰ', '黑暗森林Ⅱ', '死神永生Ⅲ'].sort(), '三部子书齐全');

console.log('\n== ② 列表项：系列名仍是三体 ==');
const books = A.books('三体').books || [];
eq(books.length, 1, '「三体」搜到一条（合集行）');
eq(books[0] && books[0].name, '三体', '合集行 name=三体（系列名）');
eq((books[0] && books[0].subs || []).map(s => s.name).sort(), ['地球往事Ⅰ', '黑暗森林Ⅱ', '死神永生Ⅲ'].sort(), 'subs 带各部书名');

console.log('\n== ③ 集表：书名 = 子书名，系列单独给 ==');
const sub = coll.subs.find(s => s.name === '黑暗森林Ⅱ');
const ep = A.episodes(sub.id, { page: 1, size: 10 });
eq(ep.name, '黑暗森林Ⅱ', '子书集表 name=子书名（不是三体）');
eq(ep.series, '三体', 'series=合集名（只作系列展示）');
eq(ep.sub, '黑暗森林Ⅱ', 'sub 同为子书名');
eq(ep.kind, 'book', 'kind=book（子书就是一本可播的书）');
eq((ep.episodes || []).length, 2, '集表两集');
ok((ep.episodes || []).every(e => String(e.title || '').length > 0), '每集 title 非空（文件名兜底）');

console.log('\n== ④ 合集父级：name/series 都是三体，不下发集表 ==');
const parent = A.episodes(coll.id, {});
eq(parent.kind, 'coll', '合集父级 kind=coll');
eq(parent.name, '三体', '父级 name=三体');
eq((parent.episodes || []).length, 0, '父级不吐集表（要点进子书）');
ok((parent.subs || []).every(s => s.series === '三体'), '子书清单也带 series=三体');

console.log('\n== ⑤ 直链反查：/m/ 归属到子书名 ==');
const target = sub.episodes[0].rel;
const bo = A.bookOfRel(target);
eq(bo && bo.name, '黑暗森林Ⅱ', 'bookOfRel 返回子书名');
eq(bo && bo.coll, '三体', 'bookOfRel 的 coll=合集名');

console.log('\n== ⑥ 语音点部名：hitSub 认出是哪一部 ==');
const hit = (A.books('三体死神永生').books || [])[0] || {};
eq(hit.hitSub, '死神永生Ⅲ', '整句「三体死神永生」认到死神永生Ⅲ');
const hit2 = (A.books('死亡永生').books || [])[0] || {};
ok(!hit2.hitSub || hit2.hitSub === '死神永生Ⅲ', '近似词不会认到别的部');

console.log('\n== ⑦ 普通书不受影响 ==');
const plain = (A.books('道诡异仙').books || [])[0] || {};
eq(plain.name, '道诡异仙', '普通书 name=书名');
eq(plain.kind, 'book', '普通书 kind=book');
const pep = A.episodes(plain.id, {});
eq(pep.name, '道诡异仙', '普通书集表 name 仍是书名');
eq(pep.series, '', '普通书没有系列名');

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
for (const f of [process.env.ABL_CACHE, process.env.ABL_POS]) {
  try { fs.unlinkSync(f); } catch { /* ignore */ }
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

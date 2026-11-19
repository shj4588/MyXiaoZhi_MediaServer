'use strict';
/* V1.7.28 兜底验证辅助：node bf_test.js inject | clean
 * inject —— 在 history.json 造一台 ip-127.0.0.1 设备，带一条「V1728兜底测试书」
 *           ep=3 的 stream 记录（模拟 R1 /r/ 直链落在 ip- 名下的起播事实）。
 * clean —— 删测试设备、测试书共享条目、MAC 设备里测试书的列表项（真实数据不动）。 */
const fs = require('fs');
const p = '/app/files/history.json';
const mode = process.argv[2] || '';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.devices = j.devices || {};
j.books = j.books || {};
const DEV = 'ip-172.18.0.1';   // docker 端口映射下所有外部请求的真实 devIdOf
const Q = 'V1728兜底测试书';

if (mode === 'inject') {
  const d = j.devices[DEV] || (j.devices[DEV] = { id: DEV, name: '网页 / 未报 MAC 的设备', ip: '172.18.0.1', seen: Date.now(), list: [] });
  d.list.unshift({ id: 'bftest1', ts: Date.now(), kind: 'book', q: Q, book: Q, title: '第3集',
    ep: 3, pos: 0, off: 0, done: false, stream: true, source: 'kw', rid: '0' });
  console.log('injected into ' + DEV + '（list 顶部，list.length=' + d.list.length + '）');
} else if (mode === 'clean') {
  let n = 0;
  if (j.devices['ip-127.0.0.1']) { delete j.devices['ip-127.0.0.1']; n++; }  // 上一次注错的桶
  if (j.books[Q]) { delete j.books[Q]; n++; }
  for (const k of Object.keys(j.devices)) {
    const d = j.devices[k];
    if (Array.isArray(d.list) && d.list.some(e => e && e.id === 'bftest1')) {
      d.list = d.list.filter(e => !(e && e.id === 'bftest1')); n++;
    }
    if (Array.isArray(d.list) && d.list.some(e => e && (e.q === Q || e.book === Q))) {
      d.list = d.list.filter(e => !(e && (e.q === Q || e.book === Q))); n++;
    }
  }
  console.log('cleaned ' + n + ' 处');
} else if (mode === 'merge') {
  // R1 旧 watcher 身份（R1-cd6b）并入 MAC 身份（98BB9936CD6B）；TESTDEV000001 是
  // v1.7.27 测试残留，直接删。历史 ip-* 桶保留（真实历史展示）。
  const OLD = 'R1-cd6b', MAC = '98BB9936CD6B', TEST = 'TESTDEV000001';
  let moved = 0;
  if (j.devices[OLD]) {
    const t = j.devices[MAC] || (j.devices[MAC] = { id: MAC, name: 'R1-CD6B', list: [] });
    t.name = t.name === MAC ? 'R1-CD6B' : (t.name || 'R1-CD6B');
    t.list = (Array.isArray(t.list) ? t.list : []);
    const ids = new Set(t.list.map(e => e && e.id));
    for (const e of (j.devices[OLD].list || [])) {
      if (e && e.id && !ids.has(e.id)) { t.list.push(e); moved++; }
    }
    t.seen = Math.max(t.seen || 0, j.devices[OLD].seen || 0);
    delete j.devices[OLD];
    console.log('merged R1-cd6b → ' + MAC + '（迁 ' + moved + ' 条）');
  } else { console.log('R1-cd6b 不存在，跳过合并'); }
  if (j.devices[TEST]) { delete j.devices[TEST]; console.log('删除 ' + TEST); }
} else if (mode === 'status') {
  console.log('devices:', Object.keys(j.devices).join(','));
  const mac = j.devices['98BB9936CD6B'];
  console.log('R1-CD6B list:', Array.isArray(mac && mac.list) ? mac.list.length : '无设备');
  console.log('books 测试残留:', Object.keys(j.books).filter(k => k.indexOf(Q) >= 0).length);
} else if (mode === 'book') {
  // 只读：打印共享表里书名含 argv[3] 的条目，不回写文件（服务端在跑，防 clobber）
  const name = process.argv[3] || '凡人修仙传';
  let n = 0;
  for (const k of Object.keys(j.books)) {
    if (k.indexOf(name) >= 0) { console.log('[' + k + '] ' + JSON.stringify(j.books[k])); n++; }
  }
  if (!n) console.log('books 里没有含「' + name + '」的条目');
  process.exit(0);
} else {
  console.log('用法: node bf_test.js inject|clean|merge|status|book [书名]');
  process.exit(1);
}
fs.writeFileSync(p, JSON.stringify(j));

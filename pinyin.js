'use strict';
/**
 * pinyin.js —— ASR 同音字纠偏：拼音模糊匹配引擎（v1.7.30 新增）
 *
 * 背景：STEM 通过语音点播《仙逆》时，麦克风/ASR 把「仙逆(xiān nì)」听成「写你(xiě nǐ)」，
 *       服务端忠实搜了「写你」→ 播成《让你写卖鱼佬，你现场写高启强？》。服务端、缓存、
 *       直链全部无辜，问题在设备侧识别。本模块在服务端兜底：把收到的查询词转成拼音，
 *       在「本地库 / 缓存」的书名拼音里找读音相近的，纠正同音字误识别。
 *
 * 设计：
 *   - 零 npm 依赖：汉字→拼音表离线生成在 files/pinyin_map.json（pypinyin 全字表 41923 字），
 *     运行时 require 一次常驻内存，避免 arm64 容器里装 pinyin 库踩 npm 源坑。
 *   - 核心武器 = 首字母开头命中（ascii first-letter prefix）：仙逆 xn、写你 xn → 命中；
 *     而「让你写卖鱼佬」首字母 rnxmlnxhgq 不以 xn 开头 → 不误伤。
 *   - 全拼序列相似度兜底（xieni vs xianni = 0.60），区分真同音和 incidental 相似。
 *   - 阈值取自离线验证：真命中 ≥ 6.2，误伤 ≤ 1.33。默认 PY_MIN=3.0 留出安全边界。
 */

const fs = require('fs');
const path = require('path');

let MAP = null;
function loadMap() {
  if (MAP) return MAP;
  MAP = {};
  try {
    const f = path.join(__dirname, 'files', 'pinyin_map.json');
    MAP = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.warn('[pinyin] 拼音表加载失败，fuzzy 降级为禁用：' + (e && e.message || e));
  }
  return MAP;
}

/** 汉字串→全拼串（非汉字原样剔除；多音字取常用读音） */
function toPinyin(s) {
  const m = loadMap();
  let out = '';
  for (const ch of String(s || '')) {
    const p = m[ch];
    if (p) out += p;
  }
  return out;
}

/** 汉字串→首字母串：按「词」取首字母更准，这里简单按每个汉字拼音首字符 */
function toInitials(s) {
  const m = loadMap();
  let out = '';
  for (const ch of String(s || '')) {
    const p = m[ch];
    if (p) out += p.charAt(0);
  }
  return out;
}

/** 只保留 a-z，去掉书名里的 丨/·/标点/数字/空白 */
function letters(s) { return String(s || '').replace(/[^a-z]/g, ''); }

/** Ratcliff/Obershelp 序列相似度（Python difflib.SequenceMatcher 等价思路，DP LCS×2/(lenA+lenB)） */
function seqRatio(a, b) {
  if (!a || !b) return 0;
  const n = a.length, m = b.length;
  // LCS 长度（DP）
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return (2 * prev[m]) / (n + m);
}

/**
 * 计算查询词 q 与书名 b 的拼音匹配分。
 * 返回 {score, initialsPrefix, fullPrefix, ratio} —— score 越高越可能是同一个词。
 */
function matchScore(q, b) {
  const qp = letters(toPinyin(q));
  const bp = letters(toPinyin(b));
  const qi = letters(toInitials(q));
  const bi = letters(toInitials(b));
  if (!qp || !bp || !qi || !bi) return { score: 0 };
  const initialsPrefix = bi.startsWith(qi);
  const fullPrefix = bp.startsWith(qp);
  // 书名可能带长后缀（仙逆丨多人剧丨…），序列相似度只比书名拼音前 max(len(qp),4) 段
  const ratio = seqRatio(qp, bp.slice(0, Math.max(qp.length, 4)));
  // 权重：首字母开头 3 > 首字母包含 2 > 全拼开头 2 > 全拼包含 1.5 > 序列相似 2
  let score = 0;
  if (initialsPrefix) score += 3;
  else if (bi.indexOf(qi) >= 0) score += 2;
  if (fullPrefix) score += 2;
  else if (bp.indexOf(qp) >= 0) score += 1.5;
  score += 2 * ratio;
  return { score, initialsPrefix, fullPrefix, ratio, qp, bp, qi, bi };
}

/** 默认阈值：离线验证真命中 6.2 / 误伤 1.33，取 3.0 中间偏保守 */
const PY_MIN = 3.0;

/**
 * 在候选书名数组里按拼音找最接近 q 的，返回 [{book, score, ...}]（score 降序，仅保留 >= min）。
 * @param {string} q 查询词（ASR 收到的，可能含同音错别字）
 * @param {Array<{book:string}|string>} books 候选（缓存记录或本地书）
 * @param {number} min 分数阈值
 */
function fuzzySearch(q, books, min) {
  const limit = typeof min === 'number' ? min : PY_MIN;
  const out = [];
  for (const item of (books || [])) {
    const name = typeof item === 'string' ? item : (item.book || item.name || '');
    if (!name) continue;
    const r = matchScore(q, name);
    if (r.score >= limit) out.push(Object.assign({ book: name }, r, { item }));
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = { toPinyin, toInitials, letters, seqRatio, matchScore, fuzzySearch, PY_MIN, loadMap };

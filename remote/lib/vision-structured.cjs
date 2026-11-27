'use strict';

/**
 * Vision 结构化语义比较（B13）。
 *
 * 目的：不再依赖“无限扩大正则窗口”扫描，而是：
 *  1) 对 before/after 做轻量结构化扫描（注释/script/style 等敏感标签的平衡与顺序）；
 *  2) 抽取危险能力特征（脚本、外链、内联事件、javascript:/data:、CSS 执行等）；
 *  3) 只拒绝“after 相对 before **新增**的能力”，基线既有内容不重复扫描。
 *
 * 这解决了：
 *  - 真实 Spacer 基线里的既有 inline script / data URI 不误报；
 *  - 删除 `-->` / `</style>` 造成结构失衡会被拒；
 *  - 跨行拆分标签/协议（`<scr`+`ipt>`、`java`+`script:`）在去空白归一后被识别。
 *
 * 它不是完整 HTML 解析器；Vision 结构化 allowlist 仍是主控制，本模块是宿主 backstop。
 */

class StructuredPolicyError extends Error {
  constructor(message, code = 'DELTA_STRUCTURE_REJECTED') {
    super(message);
    this.name = 'StructuredPolicyError';
    this.code = code;
  }
}

function compact(text) {
  return String(text || '').replace(/\s+/g, '');
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = text.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function urlsOf(text) {
  const set = new Set();
  const re = /https?:\/\/[^\s"'<>`]+/gi;
  let match;
  while ((match = re.exec(text)) !== null) set.add(match[0]);
  return set;
}

function analyzeDangerousFeatures(text) {
  const c = compact(text);
  const features = {
    'script-tag': countOccurrences(c, '<script'),
    'iframe-tag': countOccurrences(c, '<iframe'),
    'object-tag': countOccurrences(c, '<object'),
    'embed-tag': countOccurrences(c, '<embed'),
    'link-tag': countOccurrences(c, '<link'),
    'meta-tag': countOccurrences(c, '<meta'),
    'form-tag': countOccurrences(c, '<form'),
    'base-tag': countOccurrences(c, '<base'),
    'svg-tag': countOccurrences(c, '<svg'),
    'inline-handler': (c.match(/on[a-z]{3,}=/gi) || []).length,
    'javascript-scheme': countOccurrences(c.toLowerCase(), 'javascript:'),
    'data-scheme': countOccurrences(c.toLowerCase(), 'data:'),
    'data-html': countOccurrences(c.toLowerCase(), 'data:text/html'),
    'srcdoc-attr': countOccurrences(c.toLowerCase(), 'srcdoc='),
    'css-import': countOccurrences(c.toLowerCase(), '@import'),
    'css-url': countOccurrences(c.toLowerCase(), 'url('),
    'css-expression': countOccurrences(c.toLowerCase(), 'expression('),
    'css-behavior': countOccurrences(c.toLowerCase(), 'behavior:'),
    'moz-binding': countOccurrences(c.toLowerCase(), '-moz-binding'),
    'meta-refresh': (text.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh/gi) || []).length,
    'srcset-attr': countOccurrences(c.toLowerCase(), 'srcset='),
    'ping-attr': countOccurrences(c.toLowerCase(), 'ping='),
    'formaction-attr': countOccurrences(c.toLowerCase(), 'formaction='),
    'poster-attr': countOccurrences(c.toLowerCase(), 'poster='),
    'background-attr': countOccurrences(c.toLowerCase(), 'background='),
    'manifest-attr': countOccurrences(c.toLowerCase(), 'manifest='),
    'protocol-relative-attr': (
      c.match(/(?:src|href|action|srcset|poster|ping|background|manifest)=["']?\/\//gi) || []
    ).length,
  };
  return { features, urls: urlsOf(text) };
}

const DANGEROUS_KEYS = [
  'script-tag',
  'iframe-tag',
  'object-tag',
  'embed-tag',
  'link-tag',
  'meta-tag',
  'form-tag',
  'base-tag',
  'svg-tag',
  'inline-handler',
  'javascript-scheme',
  'data-scheme',
  'data-html',
  'srcdoc-attr',
  'css-import',
  'css-expression',
  'css-behavior',
  'moz-binding',
  'meta-refresh',
  'srcset-attr',
  'ping-attr',
  'formaction-attr',
  'poster-attr',
  'background-attr',
  'manifest-attr',
  'protocol-relative-attr',
];

function depthProblems(c, open, close) {
  const problems = [];
  const token = new RegExp(`${open}|${close}`, 'g');
  let depth = 0;
  let match;
  while ((match = token.exec(c)) !== null) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth < 0) problems.push(`${open}-close-before-open`);
    } else {
      depth += 1;
    }
  }
  if (depth !== 0) problems.push(`${open}-unbalanced`);
  return problems;
}

function structureProblems(text) {
  const c = compact(text);
  const problems = [];
  const commentOpen = countOccurrences(c, '<!--');
  const commentClose = countOccurrences(c, '-->');
  if (commentOpen !== commentClose) problems.push('comment-unbalanced');
  problems.push(...depthProblems(c, '<script', '</script'));
  problems.push(...depthProblems(c, '<style', '</style'));
  problems.push(...depthProblems(c, '<textarea', '</textarea'));
  problems.push(...depthProblems(c, '<title', '</title'));
  const bracesOpen = countOccurrences(c, '{');
  const bracesClose = countOccurrences(c, '}');
  if (bracesOpen !== bracesClose) problems.push('css-braces-unbalanced');
  // compact 后若出现 `<!--` 在 `-->` 之后，说明注释顺序被破坏
  const firstOpen = c.indexOf('<!--');
  const firstClose = c.indexOf('-->');
  if (firstOpen >= 0 && firstClose >= 0 && firstClose < firstOpen && commentOpen > 0) {
    problems.push('comment-order');
  }
  return problems;
}

function analyzeDocument(text) {
  const structure = structureProblems(text);
  const { features, urls } = analyzeDangerousFeatures(text);
  return { structure, features, urls };
}

/**
 * 语义比较：after 只允许保留/减少基线能力，不允许新增危险能力。
 * @throws {StructuredPolicyError}
 */
function assertSemanticDelta(before, after, file = '<memory>') {
  const beforeDoc = analyzeDocument(before);
  const afterDoc = analyzeDocument(after);
  // 只拒绝“after 新增的结构问题”，避免基线自身的语法/字符串造成误报
  const newStructure = afterDoc.structure.filter(
    (problem) => !beforeDoc.structure.includes(problem),
  );
  if (newStructure.length) {
    throw new StructuredPolicyError(
      `after structure invalid (${newStructure.join(',')}): ${file}`,
      'DELTA_STRUCTURE_REJECTED',
    );
  }
  const hits = [];
  for (const key of DANGEROUS_KEYS) {
    const delta = (afterDoc.features[key] || 0) - (beforeDoc.features[key] || 0);
    if (delta > 0) hits.push(`${key}+${delta}`);
  }
  for (const url of afterDoc.urls) {
    if (!beforeDoc.urls.has(url)) hits.push(`new-url:${url.slice(0, 80)}`);
  }
  // `url(` 只允许减少；新增 CSS 外部 url 由 new-url 覆盖，同源相对 url 不放宽
  const cssUrlDelta =
    (afterDoc.features['css-url'] || 0) - (beforeDoc.features['css-url'] || 0);
  if (cssUrlDelta > 0) hits.push(`css-url+${cssUrlDelta}`);
  if (hits.length) {
    throw new StructuredPolicyError(
      `delta content rejected (${hits.slice(0, 8).join(',')}): ${file}`,
      'DELTA_CONTENT_REJECTED',
    );
  }
  return {
    ok: true,
    before: { structure: beforeDoc.structure },
    after: { structure: afterDoc.structure },
    features: afterDoc.features,
    urls: [...afterDoc.urls],
  };
}

module.exports = {
  StructuredPolicyError,
  analyzeDocument,
  assertSemanticDelta,
  compact,
};

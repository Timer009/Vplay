'use strict';

/**
 * Vision 0.2.2 结构/差分规则的宿主 CJS 参考（E10 `src/patch/structure.mjs` 的等价实现）。
 *
 * 单一规则集：宿主 delta 与 `vision-policy.cjs` 的降级路径都使用这里，
 * 不再维护 B13 `vision-structured.cjs` 的另一套差异规则。
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', period: '.',
  tab: '\t', newline: '\n', semi: ';', lpar: '(', rpar: ')',
};

function normalizeStructural(text) {
  let value = String(text || '');
  value = value.replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
    try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _; }
  });
  value = value.replace(/&#(\d+);?/g, (_, dec) => {
    try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _; }
  });
  value = value.replace(/&([a-z]+);?/gi, (match, name) => {
    const key = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
  });
  return value.replace(/\s+/g, '').toLowerCase();
}

const STRUCTURAL_RULES = [
  { id: 'script-tag', re: /<script\b/ },
  { id: 'script-close', re: /<\/script\b/ },
  { id: 'iframe', re: /<iframe\b/ },
  { id: 'object-embed', re: /<(object|embed)\b/ },
  { id: 'link-tag', re: /<link\b/ },
  { id: 'meta-tag', re: /<meta\b/ },
  { id: 'form-tag', re: /<form\b/ },
  { id: 'base-tag', re: /<base\b/ },
  { id: 'svg-tag', re: /<svg\b/ },
  { id: 'inline-handler', re: /\bon[a-z]{3,}\s*=/ },
  { id: 'url-attribute', re: /(?:src|srcset|href|action|formaction|poster|ping|data|srcdoc|manifest|background|cite|longdesc|usemap|http-equiv)\s*=/ },
  { id: 'javascript-url', re: /javascript\s*:/ },
  { id: 'vbscript-url', re: /vbscript\s*:/ },
  { id: 'data-url', re: /\bdata\s*:/ },
  { id: 'css-import', re: /@import\b/ },
  { id: 'css-url', re: /\burl\s*\(/ },
  { id: 'css-expression', re: /expression\s*\(|behavior\s*:|-moz-binding/ },
  { id: 'comment', re: /<!--|-->/ },
  { id: 'doctype', re: /<!doctype/ },
];

function structuralFindings(text) {
  const normalized = normalizeStructural(text);
  return STRUCTURAL_RULES.filter((rule) => rule.re.test(normalized)).map((rule) => rule.id);
}

function mergeRanges(ranges) {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end >= range.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function changedRangesFromOperations(operations) {
  const ranges = [];
  let delta = 0;
  for (const operation of [...operations].sort((a, b) => a.start - b.start)) {
    const afterStart = operation.start + delta;
    ranges.push({ start: afterStart, end: afterStart + String(operation.newString || '').length });
    delta += String(operation.newString || '').length - String(operation.oldString || '').length;
  }
  return mergeRanges(ranges);
}

function countOccurrences(text, token) {
  return (String(text).match(new RegExp(token, 'g')) || []).length;
}

/**
 * 只检查 after 是否留下未闭合注释/style/script。
 * 完整平衡的块删除仍然允许。
 */
function unclosedFindings(after) {
  const findings = [];
  if (countOccurrences(after, '<!--') !== countOccurrences(after, '-->')) {
    findings.push('unclosed-comment');
  }
  for (const [name, open, close] of [['style', '<style', '</style'], ['script', '<script', '</script']]) {
    if (countOccurrences(after, open) !== countOccurrences(after, close)) {
      findings.push(`unclosed-${name}`);
    }
  }
  return findings;
}

module.exports = {
  normalizeStructural,
  structuralFindings,
  changedRangesFromOperations,
  unclosedFindings,
};

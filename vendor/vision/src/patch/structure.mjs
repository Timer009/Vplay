/**
 * E10 / 0.2.2 structural and differential validation.
 *
 * Fixes C12-P1-01/02/03 (and the C12-P1-06 false rejection):
 *   - matching is done on whitespace/entity-normalized text, so `<scr` +
 *     `ipt>` and `java` + `script:` cannot hide across lines;
 *   - changed tags are scanned in place, so baseline + added line context is
 *     covered without scanning unchanged neighbouring `<script>` tags;
 *   - deletion of comment/style closers and unbalanced style/script/comment
 *     tokens is rejected (context recombination / style escape);
 *   - CSS changed regions are checked for executable constructs.
 *
 * This module is pure and does not write files.
 */

const TAG_RE = /<[^>]*>/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

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
  { id: 'inline-handler', re: /\son[a-z]{3,}\s*=/ },
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

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', period: '.',
  tab: '\t', newline: '\n', semi: ';', lpar: '(', rpar: ')',
};

/** Raw-tag rules are needed because normalization removes attribute spaces. */
const RAW_RULES = [
  { id: 'url-attribute', re: /\b(?:src|srcset|href|action|formaction|poster|ping|data|srcdoc|manifest|background|cite|longdesc|usemap|http-equiv)\s*=/i },
  { id: 'inline-handler', re: /\bon[a-z]{3,}\s*=/i },
  { id: 'javascript-url', re: /javascript\s*:/i },
  { id: 'vbscript-url', re: /vbscript\s*:/i },
  { id: 'data-url', re: /\bdata\s*:/i },
  { id: 'css-url', re: /\burl\s*\(/i },
  { id: 'css-expression', re: /expression\s*\(|behavior\s*:|-moz-binding/i },
];

function rawFindings(text) {
  return RAW_RULES.filter((rule) => rule.re.test(String(text || ''))).map((rule) => rule.id);
}

/** Normalize for structural matching only (never for rewriting). */
export function normalizeStructural(text) {
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

export function structuralFindings(text) {
  const normalized = normalizeStructural(text);
  return STRUCTURAL_RULES.filter((rule) => rule.re.test(normalized)).map((rule) => rule.id);
}

/** Combined findings for a tag or a new fragment. */
export function combinedFindings(text) {
  return [...new Set([...structuralFindings(text), ...rawFindings(text)])];
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

/** Compute AFTER-content changed ranges from Vision operations. */
export function changedRangesFromOperations(operations) {
  const ranges = [];
  let delta = 0;
  for (const operation of [...(operations || [])].sort((a, b) => a.start - b.start)) {
    const afterStart = operation.start + delta;
    const afterEnd = afterStart + String(operation.newString ?? '').length;
    ranges.push({ start: afterStart, end: afterEnd });
    delta += String(operation.newString ?? '').length - String(operation.oldString ?? '').length;
  }
  return mergeRanges(ranges);
}

function overlaps(a, b) {
  return a.start < b.end && a.end > b.start;
}

function count(text, token) {
  return (text.match(new RegExp(token, 'g')) || []).length;
}

function styleRanges(text) {
  const ranges = [];
  let match;
  STYLE_RE.lastIndex = 0;
  while ((match = STYLE_RE.exec(text)) !== null) {
    ranges.push({
      start: match.index + match[0].indexOf('>') + 1,
      end: match.index + match[0].length - '</style>'.length,
    });
  }
  return ranges;
}

/**
 * Differential structural scan. `changedRanges` are AFTER offsets from
 * changedRangesFromOperations (or a host-computed equivalent).
 */
export function validateStructureDelta({ before = '', after = '', changedRanges = [] } = {}) {
  const violations = [];
  const changed = mergeRanges(changedRanges);

  // 1) Changed tags: catches cross-line tags and baseline-context assembly.
  TAG_RE.lastIndex = 0;
  let tag;
  while ((tag = TAG_RE.exec(after)) !== null) {
    const range = { start: tag.index, end: tag.index + tag[0].length };
    if (!changed.some((item) => overlaps(item, range))) continue;
    const findings = combinedFindings(tag[0]);
    for (const id of findings) violations.push({ code: 'tag-structural', id, range });
  }

  // 2) Comments: an unpaired closer or an unclosed comment is rejected.
  // Deleting a complete balanced comment (open+close) is a legitimate removal.
  const afterCommentOpen = count(after, '<!--');
  const afterCommentClose = count(after, '-->');
  if (afterCommentOpen !== afterCommentClose) violations.push({ code: 'unclosed-comment' });

  // 3) style/script balance. Deleting a complete balanced block is allowed;
  //    deleting only a closer leaves an unclosed token and is rejected.
  for (const [name, open, close] of [['style', '<style', '</style'], ['script', '<script', '</script']]) {
    const afterOpen = count(after, open);
    const afterClose = count(after, close);
    if (afterOpen !== afterClose) violations.push({ code: `unclosed-${name}`, open: afterOpen, close: afterClose });
  }

  // 4) CSS changed regions inside <style>.
  for (const block of styleRanges(after)) {
    for (const range of changed) {
      if (!overlaps(range, block)) continue;
      const start = Math.max(range.start, block.start);
      const end = Math.min(range.end, block.end);
      if (end <= start) continue;
      const findings = structuralFindings(after.slice(start, end));
      for (const id of findings) violations.push({ code: 'css-structural', id, range: { start, end } });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    changedRanges: changed,
  };
}

/** Validate a single new HTML/CSS fragment before it reaches a file. */
export function validateFragmentStructure(fragment) {
  const findings = combinedFindings(fragment);
  const violations = findings.map((id) => ({ code: 'fragment-structural', id }));
  return { ok: violations.length === 0, violations, findings };
}

export const __internal = { STRUCTURAL_RULES, mergeRanges, overlaps, styleRanges };

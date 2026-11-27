import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * E05 / C07-P0-05: structured allowlist, not a keyword blacklist.
 *
 * Vision may adjust visual HTML/CSS only:
 *  - .html/.htm/.css files, existing regular files, inside the project root;
 *  - no symlinks/dot segments/JS files;
 *  - removals are allowed;
 *  - CSS must be declaration/rule content without @-rules, url(), escapes,
 *    image-set, behavior/expression;
 *  - new HTML must be a safe fragment with an allowlisted tag/attribute set and
 *    no URL-bearing attributes, event handlers, scripts, frames, forms, SVG.
 *
 * The host still owns lock, snapshot, atomic write, journal, full manifest
 * validation and rollback. This module never writes files.
 */
const ALLOWED_EXT = new Set(['.html', '.htm', '.css']);
const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'section', 'article', 'header', 'footer', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'br', 'hr',
  'strong', 'em', 'b', 'i', 'small', 'label', 'button', 'canvas',
]);
const ALLOWED_ATTRS = new Set([
  'id', 'class', 'role', 'hidden', 'disabled', 'title', 'style', 'type',
]);
const URL_KEYS = /^(href|src|srcset|action|formaction|poster|data|srcdoc|ping|manifest|background|cite|longdesc|usemap|content|http-equiv)$/i;
const DANGEROUS_VALUE = /(?:https?:|\/\/|javascript\s*:|data\s*:|blob\s*:|vbscript\s*:|\\|`|<|>|&)/i;

export function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function scriptRanges(text) {
  const ranges = [];
  const re = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
  let match;
  while ((match = re.exec(text)) !== null) ranges.push({ start: match.index, end: match.index + match[0].length });
  return ranges;
}

export function styleRanges(text) {
  const ranges = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    ranges.push({ start: match.index, contentStart: match.index + match[0].indexOf('>') + 1, end: match.index + match[0].length });
  }
  return ranges;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function normalizeRel(file) {
  if (typeof file !== 'string' || !file.trim() || path.isAbsolute(file)) return null;
  const normalized = file.replace(/\\/g, '/');
  if (normalized.split('/').some((part) => !part || part === '..' || part.startsWith('.'))) return null;
  return normalized;
}

function resolveExisting(root, file, allowedFiles) {
  const rel = normalizeRel(file);
  if (!rel) return { error: 'file must be a safe relative path without dot segments' };
  if (!allowedFiles.includes(rel)) return { error: `file is not in allowed_files: ${rel}` };
  const ext = path.extname(rel).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return { error: `extension not allowed for Vision UI patches: ${ext || '(none)'}` };
  const realRoot = fs.realpathSync(root);
  const absolute = path.resolve(realRoot, rel);
  if (absolute !== realRoot && !absolute.startsWith(realRoot + path.sep)) return { error: `file escapes workspace: ${rel}` };
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    return { error: `file does not exist: ${rel}` };
  }
  // realpath differs if the file OR any parent component is a symlink/junction.
  if (real !== absolute) return { error: `symlink/junction not allowed: ${rel}` };
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) return { error: `not a regular file: ${rel}` };
  return { absolute, rel, ext };
}

/**
 * CSS subset: no @-rules, no url()/image-set/behavior/expression, no escapes,
 * no comments, no HTML delimiters. Intentionally restrictive security boundary.
 */
export function validateCss(css, { maxChars = 12000 } = {}) {
  const errors = [];
  if (typeof css !== 'string') return { ok: false, errors: ['CSS must be a string'] };
  if (css.length > maxChars) errors.push('CSS fragment too large');
  if (/@/i.test(css)) errors.push('CSS @-rules are not allowed');
  if (/url\s*\(/i.test(css)) errors.push('CSS url() is not allowed');
  if (/image-set\s*\(|cross-fade\s*\(|element\s*\(/i.test(css)) errors.push('CSS image functions are not allowed');
  if (/expression\s*\(|behavior\s*:|binding\s*:/i.test(css)) errors.push('CSS legacy executable properties are not allowed');
  if (/javascript\s*:|vbscript\s*:|data\s*:|https?:|\/\//i.test(css)) errors.push('CSS external/protocol content is not allowed');
  if (/[\\`<>]/.test(css)) errors.push('CSS escapes/HTML delimiters are not allowed');
  if (/\/\*/.test(css)) errors.push('CSS comments are not allowed');
  if (/\b(?:-moz-binding|behavior)\b/i.test(css)) errors.push('CSS binding is not allowed');
  return { ok: errors.length === 0, errors };
}

function parseAttrs(raw) {
  const attrs = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    attrs.push({ name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? match[4] ?? '' });
  }
  const leftovers = raw.replace(re, '').replace(/\s+/g, '');
  if (leftovers) throw new Error(`unparseable attribute syntax: ${leftovers.slice(0, 40)}`);
  return attrs;
}

function validateAttribute(attr, tag) {
  const errors = [];
  if (attr.name.startsWith('on')) errors.push(`event attribute not allowed: ${attr.name}`);
  if (URL_KEYS.test(attr.name)) errors.push(`URL/form attribute not allowed: ${attr.name}`);
  if (attr.name === 'type') {
    if (tag !== 'button' || !/^(button|submit|reset)$/i.test(attr.value)) errors.push(`type attribute not allowed: ${attr.value}`);
    return errors;
  }
  if (attr.name === 'style') {
    const result = validateCss(attr.value);
    if (!result.ok) errors.push(...result.errors.map((item) => `style="${item}"`));
    return errors;
  }
  const isAria = attr.name.startsWith('aria-');
  const isData = attr.name.startsWith('data-');
  if (!isAria && !isData && !ALLOWED_ATTRS.has(attr.name)) errors.push(`attribute not allowed: ${attr.name}`);
  if (DANGEROUS_VALUE.test(attr.value)) errors.push(`attribute value contains URL/protocol/markup: ${attr.name}`);
  if ((attr.name === 'id' || attr.name === 'class') && !/^[A-Za-z0-9_\-\s]+$/.test(attr.value)) {
    errors.push(`id/class value contains invalid characters: ${attr.name}`);
  }
  if (isAria || isData) {
    if (!/^[A-Za-z0-9 _.:-]*$/.test(attr.value)) errors.push(`aria/data value contains invalid characters: ${attr.name}`);
  }
  return errors;
}

export function validateHtmlFragment(fragment, { maxChars = 12000 } = {}) {
  const errors = [];
  if (typeof fragment !== 'string') return { ok: false, errors: ['HTML must be a string'] };
  if (fragment.length > maxChars) errors.push('HTML fragment too large');
  if (/<!--|<!\[CDATA\[|<!DOCTYPE|<\?/i.test(fragment)) errors.push('comments/doctype/processing instructions are not allowed');

  const styleRe = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
  let styleMatch;
  while ((styleMatch = styleRe.exec(fragment)) !== null) {
    if (styleMatch[1].trim()) errors.push('style tag attributes are not allowed');
    const css = validateCss(styleMatch[2], { maxChars });
    if (!css.ok) errors.push(...css.errors.map((item) => `style content: ${item}`));
  }
  const rest = fragment.replace(styleRe, '');
  if (/<style\b/i.test(rest)) errors.push('unclosed style tag is not allowed');

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\s*\/?>/g;
  let last = 0;
  let match;
  while ((match = tagRe.exec(rest)) !== null) {
    const between = rest.slice(last, match.index);
    if (/[<>&]/.test(between)) errors.push('text content contains markup/entity delimiters');
    last = tagRe.lastIndex;
    const closing = match[0].startsWith('</');
    const tag = match[1].toLowerCase();
    if (closing) {
      if (!ALLOWED_TAGS.has(tag) && tag !== 'style') errors.push(`closing tag not allowed: ${tag}`);
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      errors.push(`tag not allowed: ${tag}`);
      continue;
    }
    const rawAttrs = match[2] || '';
    try {
      for (const attr of parseAttrs(rawAttrs)) errors.push(...validateAttribute(attr, tag));
    } catch (error) {
      errors.push(error.message);
    }
  }
  const tail = rest.slice(last);
  if (/[<>&]/.test(tail)) errors.push('trailing text contains markup/entity delimiters');
  return { ok: errors.length === 0, errors };
}

function validatePlannedContent({ oldString, newString, source, ext, styleBlockRanges, maxChars }) {
  const errors = [];
  if (!newString.trim()) return errors; // removal cannot introduce a URL/script
  if (ext === '.css') {
    const css = validateCss(newString, { maxChars });
    if (!css.ok) errors.push(...css.errors.map((item) => `CSS: ${item}`));
    return errors;
  }
  const fullStyle = newString.match(/^\s*<style\b[^>]*>([\s\S]*?)<\/style>\s*$/i);
  if (fullStyle) {
    const css = validateCss(fullStyle[1], { maxChars });
    if (!css.ok) errors.push(...css.errors.map((item) => `CSS: ${item}`));
    return errors;
  }
  const oldStart = source.indexOf(oldString);
  const oldEnd = oldStart + oldString.length;
  const styleHit = styleBlockRanges.some((range) => oldStart >= range.contentStart && oldEnd <= range.end);
  if (styleHit && !/[<>]/.test(newString)) {
    const css = validateCss(newString, { maxChars });
    if (!css.ok) errors.push(...css.errors.map((item) => `CSS: ${item}`));
    return errors;
  }
  if (!/[<>&]/.test(newString) && !DANGEROUS_VALUE.test(newString)) return errors;
  const html = validateHtmlFragment(newString, { maxChars });
  if (!html.ok) errors.push(...html.errors);
  return errors;
}

export function validatePatchPlan({ plan, root, allowedFiles = ['index.html'], maxPatches = 3, maxChars = 12000 }) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan must be an object'], operations: [], files: {} };
  const patches = Array.isArray(plan.patches) ? plan.patches : [];
  if (!patches.length) errors.push('patches must be a non-empty array');
  if (patches.length > maxPatches) errors.push(`patches must contain at most ${maxPatches} entries`);
  const files = {};
  const operations = [];
  let totalChars = 0;

  for (const [index, patch] of patches.entries()) {
    const prefix = `patches[${index}]`;
    if (!patch || typeof patch !== 'object') {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const resolved = resolveExisting(root, patch.file, allowedFiles);
    if (resolved.error) {
      errors.push(`${prefix}: ${resolved.error}`);
      continue;
    }
    const oldString = typeof patch.old_string === 'string' ? patch.old_string : '';
    const newString = typeof patch.new_string === 'string' ? patch.new_string : '';
    if (!oldString) errors.push(`${prefix}.old_string is required`);
    if (oldString.length > maxChars) errors.push(`${prefix}.old_string exceeds ${maxChars} chars`);
    if (newString.length > maxChars) errors.push(`${prefix}.new_string exceeds ${maxChars} chars`);
    if (oldString === newString) errors.push(`${prefix} is a no-op`);
    totalChars += oldString.length + newString.length;
    if (totalChars > 30000) errors.push('total patch size exceeds 30000 chars');

    if (!files[resolved.absolute]) {
      files[resolved.absolute] = { file: resolved.rel, content: fs.readFileSync(resolved.absolute, 'utf8') };
    }
    const source = files[resolved.absolute].content;
    const first = source.indexOf(oldString);
    const last = source.lastIndexOf(oldString);
    const count = first === -1 ? 0 : first === last ? 1 : 2;
    if (count !== 1) {
      errors.push(`${prefix}.old_string must occur exactly once (found ${count === 2 ? '2+' : count})`);
      continue;
    }
    const end = first + oldString.length;
    if (scriptRanges(source).some((range) => overlaps(first, end, range.start, range.end))) {
      errors.push(`${prefix} intersects <script> game logic (refusing)`);
    }
    const contentErrors = validatePlannedContent({
      oldString,
      newString,
      source,
      ext: resolved.ext,
      styleBlockRanges: styleRanges(source),
      maxChars,
    });
    errors.push(...contentErrors.map((item) => `${prefix}: ${item}`));
    operations.push({
      file: resolved.rel,
      absolute: resolved.absolute,
      oldString,
      newString,
      reason: typeof patch.reason === 'string' ? patch.reason : '',
      start: first,
      end,
      sha256Before: hashContent(source),
    });
  }

  const byFile = new Map();
  for (const operation of operations) {
    const list = byFile.get(operation.absolute) || [];
    list.push(operation);
    byFile.set(operation.absolute, list);
  }
  for (const [absolute, list] of byFile) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].start < list[i - 1].end) errors.push(`overlapping patches in ${path.basename(absolute)}`);
    }
  }
  return { ok: errors.length === 0, errors, operations, files };
}

/** Compute exact post-patch contents in memory. No writes/snapshots. */
export function materializePatch({ operations, files }) {
  const byFile = new Map();
  for (const operation of operations) {
    const list = byFile.get(operation.absolute) || [];
    list.push(operation);
    byFile.set(operation.absolute, list);
  }
  const result = [];
  for (const [absolute, list] of byFile) {
    let content = files[absolute]?.content;
    if (typeof content !== 'string') throw new Error(`missing source content for ${absolute}`);
    const before = hashContent(content);
    for (const operation of [...list].sort((a, b) => b.start - a.start)) {
      if (content.slice(operation.start, operation.end) !== operation.oldString) {
        throw new Error(`source changed under patch: ${operation.file}`);
      }
      content = content.slice(0, operation.start) + operation.newString + content.slice(operation.end);
    }
    result.push({
      file: list[0].file,
      absolute,
      content,
      sha256Before: before,
      sha256After: hashContent(content),
      bytes: Buffer.byteLength(content),
    });
  }
  return { files: result };
}

/**
 * E07: describe the exact changed hunks for host-side delta scanning.
 *
 * The host must not scan a full file with a keyword blacklist (it rejects
 * legitimate inline scripts), and must not skip scanning either. This helper
 * returns:
 *   - sha256Before / sha256After per file (digest binding),
 *   - the exact old/new fragments and offsets of every operation,
 *   - the fully materialized `after` content (self-checked).
 *
 * The host verifies the file on disk still matches `sha256Before`, then scans
 * the changed fragments (plus their surrounding lines) before writing.
 */
export function describeDelta({ operations, files, materialized = null }) {
  const expected = new Map();
  if (Array.isArray(materialized)) {
    for (const item of materialized) expected.set(item.file, item);
  }
  const byFile = new Map();
  for (const operation of operations) {
    const list = byFile.get(operation.absolute) || [];
    list.push(operation);
    byFile.set(operation.absolute, list);
  }
  const result = [];
  for (const [absolute, list] of byFile) {
    const source = files[absolute]?.content;
    if (typeof source !== 'string') throw new Error(`missing source content for ${absolute}`);
    const sha256Before = hashContent(source);
    let content = source;
    for (const operation of [...list].sort((a, b) => b.start - a.start)) {
      if (content.slice(operation.start, operation.end) !== operation.oldString) {
        throw new Error(`source changed under patch: ${operation.file}`);
      }
      content = content.slice(0, operation.start) + operation.newString + content.slice(operation.end);
    }
    const sha256After = hashContent(content);
    const item = expected.get(list[0].file);
    if (item && (item.sha256After !== sha256After || item.sha256Before !== sha256Before)) {
      throw new Error(`materialized digest mismatch: ${list[0].file}`);
    }
    result.push({
      file: list[0].file,
      absolute,
      sha256Before,
      sha256After,
      bytes: Buffer.byteLength(content),
      hunks: list
        .map((operation) => ({
          start: operation.start,
          end: operation.end,
          before: operation.oldString,
          after: operation.newString,
          reason: operation.reason || '',
        }))
        .sort((a, b) => a.start - b.start),
      content,
      after: content,
    });
  }
  return { files: result };
}

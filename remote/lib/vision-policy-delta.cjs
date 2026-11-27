'use strict';

/**
 * 宿主侧 Vision delta 校验与 digest 绑定（B11，移植自 E07 参考实现）。
 *
 * 与 B10 `applyPatchAtomically`（整文件 + 新增行扫描）的分工：
 *  - Vision 0.2.1 会通过 `host.applyFiles(files, { operations, plan, round })`
 *    提供精确的 operation 列表（start/end/oldString/newString）；
 *  - 本模块按 operation 逐段重放，验证「模型看到的源文件」与「宿主当前文件」一致，
 *    并对新增片段 + 上下文窗口做宿主独立扫描；
 *  - 若调用方没有 operations（旧适配层/降级路径），vision-service 回退到 B10 增量校验。
 *
 * 不提供任何客户端「跳过校验/prevalidated」开关。
 * 结构化 HTML/CSS allowlist 仍由 Vision 包负责；本模块是宿主 backstop。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_EXT = /\.(html?|css)$/i;

class DeltaPolicyError extends Error {
  constructor(message, code = 'DELTA_POLICY') {
    super(message);
    this.name = 'DeltaPolicyError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const STRUCTURAL_RULES = [
  { id: 'script-tag', re: /<script\b/i },
  { id: 'iframe', re: /<iframe\b/i },
  { id: 'object-embed', re: /<(object|embed)\b/i },
  { id: 'link-tag', re: /<link\b/i },
  { id: 'meta-tag', re: /<meta\b/i },
  { id: 'form-tag', re: /<form\b/i },
  { id: 'base-tag', re: /<base\b/i },
  { id: 'svg-tag', re: /<svg\b/i },
  { id: 'inline-handler', re: /\son[a-z]{3,}\s*=/i },
  {
    id: 'url-attribute',
    re: /\b(?:src|srcset|href|action|formaction|poster|ping|data|srcdoc|manifest|background|cite|longdesc|usemap|http-equiv)\s*=/i,
  },
  { id: 'javascript-url', re: /javascript\s*:/i },
  { id: 'data-url', re: /\bdata\s*:/i },
  { id: 'srcdoc', re: /\bsrcdoc\s*=/i },
  { id: 'css-import', re: /@import\b/i },
  { id: 'css-url', re: /\burl\s*\(/i },
  { id: 'css-expression', re: /expression\s*\(|behavior\s*:|-moz-binding/i },
  { id: 'comment', re: /<!--|<!\[CDATA\[|<!DOCTYPE/i },
];

function createDeltaPolicy({ policy, contextLines = 2 } = {}) {
  if (
    !policy ||
    typeof policy.assertSafeRelPath !== 'function' ||
    typeof policy.scanPatchContent !== 'function'
  ) {
    throw new DeltaPolicyError('createDeltaPolicy requires vision-policy', 'DELTA_CONFIG');
  }
  const { assertSafeRelPath, scanPatchContent } = policy;

  function expandWindow(text, start, end) {
    let s = text.lastIndexOf('\n', Math.max(0, start - 1));
    s = s === -1 ? 0 : s + 1;
    let e = text.indexOf('\n', end);
    e = e === -1 ? text.length : e;
    for (let i = 0; i < contextLines; i += 1) {
      if (s === 0) break;
      const previous = text.lastIndexOf('\n', s - 2);
      s = previous === -1 ? 0 : previous + 1;
    }
    for (let i = 0; i < contextLines; i += 1) {
      if (e >= text.length) break;
      const next = text.indexOf('\n', e + 1);
      e = next === -1 ? text.length : next;
    }
    return { start: s, end: e, text: text.slice(s, e) };
  }

  function mergeRanges(ranges) {
    const sorted = ranges.slice().sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    return merged;
  }

  function scanDelta({ before, after, operations, file = '<memory>' }) {
    if (typeof before !== 'string' || typeof after !== 'string') {
      throw new DeltaPolicyError('before/after must be strings', 'DELTA_INPUT');
    }
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new DeltaPolicyError('operations must be a non-empty array', 'DELTA_INPUT');
    }
    const ordered = operations.slice().sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const operation of ordered) {
      if (!Number.isInteger(operation.start) || !Number.isInteger(operation.end)) {
        throw new DeltaPolicyError(`operation offsets must be integers: ${file}`, 'DELTA_OPERATION');
      }
      if (
        operation.start < cursor ||
        operation.end <= operation.start ||
        operation.end > before.length
      ) {
        throw new DeltaPolicyError(`operation overlaps or out of range: ${file}`, 'DELTA_OPERATION');
      }
      if (
        typeof operation.oldString !== 'string' ||
        before.slice(operation.start, operation.end) !== operation.oldString
      ) {
        throw new DeltaPolicyError(`operation oldString mismatch: ${file}`, 'DELTA_SOURCE_CHANGED');
      }
      cursor = operation.end;
    }

    let computed = before;
    for (const operation of ordered.slice().reverse()) {
      computed =
        computed.slice(0, operation.start) + operation.newString + computed.slice(operation.end);
    }
    if (computed !== after) {
      throw new DeltaPolicyError(
        `materialized content does not match operations: ${file}`,
        'DELTA_DIGEST_MISMATCH',
      );
    }

    const hunks = [];
    let delta = 0;
    for (const operation of ordered) {
      const afterStart = operation.start + delta;
      const afterEnd = afterStart + operation.newString.length;
      delta += operation.newString.length - operation.oldString.length;
      hunks.push({
        file,
        start: operation.start,
        end: operation.end,
        afterStart,
        afterEnd,
        before: operation.oldString,
        after: operation.newString,
      });
    }

    const findings = [];
    for (const hunk of hunks) {
      const scan = scanPatchContent(hunk.after);
      if (!scan.ok) findings.push({ scope: 'fragment', ...hunk, hits: scan.hits });
      const structural = STRUCTURAL_RULES.filter((rule) => rule.re.test(hunk.after)).map(
        (rule) => rule.id,
      );
      if (structural.length) {
        findings.push({ scope: 'fragment-structural', ...hunk, hits: structural });
      }
    }
    const windows = mergeRanges(
      hunks.map((hunk) => expandWindow(after, hunk.afterStart, hunk.afterEnd)),
    ).map((range) => ({ ...range, text: after.slice(range.start, range.end) }));
    for (const window of windows) {
      const scan = scanPatchContent(window.text);
      if (!scan.ok) findings.push({ scope: 'window', start: window.start, end: window.end, hits: scan.hits });
    }
    if (findings.length) {
      const hits = [...new Set(findings.flatMap((item) => item.hits))];
      throw new DeltaPolicyError(
        `delta content rejected (${hits.join(',')}): ${file}`,
        'DELTA_CONTENT_REJECTED',
      );
    }
    return { file, hunks, windows: windows.map((item) => ({ start: item.start, end: item.end })) };
  }

  function verifyFile({ root, file, content, sha256Before, sha256After, operations }) {
    const rel = String(file || '').replace(/\\/g, '/');
    if (!ALLOWED_EXT.test(rel)) {
      throw new DeltaPolicyError(`extension not allowed: ${rel}`, 'DELTA_FILE_NOT_ALLOWED');
    }
    const target = assertSafeRelPath(root, rel);
    const current = fs.readFileSync(target, 'utf8');
    if (sha256Before && sha256(current) !== sha256Before) {
      throw new DeltaPolicyError(`source changed since patch validation: ${rel}`, 'DELTA_SOURCE_CHANGED');
    }
    if (sha256(content) !== sha256After) {
      throw new DeltaPolicyError(`after digest mismatch: ${rel}`, 'DELTA_DIGEST_MISMATCH');
    }
    const delta = scanDelta({ before: current, after: content, operations, file: rel });
    return { target, current, delta };
  }

  function writeAtomic(target, content) {
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(target)}.delta-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, content);
      try {
        fs.fsyncSync(fd);
      } catch {
        // 某些文件系统不支持 fsync
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  }

  /**
   * files: [{ file, content, sha256Before, sha256After }]（describeDelta 输出）
   * operations: [{ file, start, end, oldString, newString }]（validatePatchPlan 输出）
   * keepJournal: 保留 `verified` journal，等 buildPreview + verifyPreview 通过后 finalize。
   */
  function applyDelta({
    root,
    files,
    operations,
    allowedFiles = [],
    journalFile = null,
    keepJournal = false,
  }) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new DeltaPolicyError('no files to apply', 'DELTA_INPUT');
    }
    const allowed = new Set(
      (allowedFiles || []).map((item) => String(item).replace(/\\/g, '/')),
    );
    const byFile = new Map();
    for (const operation of operations || []) {
      const rel = String(operation.file || '').replace(/\\/g, '/');
      if (!allowed.has(rel)) throw new DeltaPolicyError(`file not allowed: ${rel}`, 'DELTA_FILE_NOT_ALLOWED');
      const list = byFile.get(rel) || [];
      list.push(operation);
      byFile.set(rel, list);
    }

    const planned = [];
    for (const file of files) {
      const rel = String(file.file || '').replace(/\\/g, '/');
      if (!allowed.has(rel)) throw new DeltaPolicyError(`file not allowed: ${rel}`, 'DELTA_FILE_NOT_ALLOWED');
      const ops = byFile.get(rel) || [];
      if (ops.length === 0) {
        throw new DeltaPolicyError(`missing operations for ${rel}`, 'DELTA_OPERATION');
      }
      const verified = verifyFile({
        root,
        file: rel,
        content: file.content,
        sha256Before: file.sha256Before,
        sha256After: file.sha256After,
        operations: ops,
      });
      planned.push({ ...file, file: rel, ...verified });
    }

    if (journalFile) {
      fs.mkdirSync(path.dirname(journalFile), { recursive: true });
      fs.writeFileSync(
        journalFile,
        JSON.stringify(
          {
            state: 'applying',
            at: new Date().toISOString(),
            root: path.resolve(root),
            files: planned.map((item) => ({
              file: item.file,
              sha256Before: item.sha256Before,
              sha256After: item.sha256After,
            })),
          },
          null,
          2,
        ),
        'utf8',
      );
    }

    const written = [];
    try {
      for (const item of planned) {
        writeAtomic(item.target, item.content);
        written.push(item);
      }
      for (const item of planned) {
        const actual = sha256(fs.readFileSync(item.target));
        if (actual !== item.sha256After) {
          throw new DeltaPolicyError(`post-write digest mismatch: ${item.file}`, 'DELTA_DIGEST_MISMATCH');
        }
      }
      if (journalFile) {
        fs.writeFileSync(
          journalFile,
          JSON.stringify(
            {
              state: 'verified',
              at: new Date().toISOString(),
              root: path.resolve(root),
              files: planned.map((item) => ({ file: item.file, sha256After: item.sha256After })),
            },
            null,
            2,
          ),
          'utf8',
        );
        if (!keepJournal) fs.rmSync(journalFile, { force: true });
      }
      return {
        files: planned.map((item) => ({
          file: item.file,
          bytes: Buffer.byteLength(item.content),
          sha256Before: item.sha256Before,
          sha256After: item.sha256After,
          hunks: item.delta.hunks.length,
          windows: item.delta.windows,
        })),
        journalFile,
        journalState: journalFile ? (keepJournal ? 'verified' : 'deleted') : null,
      };
    } catch (error) {
      for (const item of written.reverse()) {
        try {
          writeAtomic(item.target, item.current);
        } catch {
          // 保留 journal 供人工/启动恢复
        }
      }
      throw error;
    }
  }

  function finalizeApply(journalFile) {
    if (journalFile) fs.rmSync(journalFile, { force: true });
  }

  return { scanDelta, applyDelta, finalizeApply, expandWindow };
}

module.exports = { createDeltaPolicy, DeltaPolicyError, sha256 };

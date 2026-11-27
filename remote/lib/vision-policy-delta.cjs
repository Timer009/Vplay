'use strict';

/**
 * 宿主侧 Vision delta 校验与 digest 绑定（B14，移植 E10 `host/vision-policy-delta.cjs`）。
 *
 * 与 Vision 0.2.2 的关系：
 *  - `validatePatchPlan` 已返回 `structure` 并拒绝结构破坏；本模块是宿主的
 *    独立 backstop（防止适配层/传输层绕过），规则使用同一 CJS 参考
 *    `vision-structure.cjs`，不再维护第二套窗口规则。
 *  - 保留 B12/B13 的精确检查：operations 重放、before/after digest、
 *    路径边界、目标必须是已存在的普通文件、journal 与原子写。
 *
 * 不提供任何客户端「跳过校验/prevalidated」开关。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  structuralFindings,
  changedRangesFromOperations,
  unclosedFindings,
} = require('./vision-structure.cjs');

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

function overlaps(a, b) {
  return a.start < b.end && a.end > b.start;
}

function styleRanges(text) {
  const ranges = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    ranges.push({ start: match.index + match[0].indexOf('>') + 1, end: match.index + match[0].length - 8 });
  }
  return ranges;
}

function createDeltaPolicy({ policy } = {}) {
  if (
    !policy ||
    typeof policy.assertSafeRelPath !== 'function' ||
    typeof policy.scanPatchContent !== 'function'
  ) {
    throw new DeltaPolicyError('createDeltaPolicy requires vision-policy', 'DELTA_CONFIG');
  }
  const { assertSafeRelPath, scanPatchContent } = policy;

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
      if (operation.start < cursor || operation.end <= operation.start || operation.end > before.length) {
        throw new DeltaPolicyError(`operation overlaps or is out of range: ${file}`, 'DELTA_OPERATION');
      }
      if (typeof operation.oldString !== 'string' || before.slice(operation.start, operation.end) !== operation.oldString) {
        throw new DeltaPolicyError(`operation oldString mismatch: ${file}`, 'DELTA_SOURCE_CHANGED');
      }
      cursor = operation.end;
    }

    let computed = before;
    for (const operation of ordered.slice().reverse()) {
      computed = computed.slice(0, operation.start) + operation.newString + computed.slice(operation.end);
    }
    if (computed !== after) {
      throw new DeltaPolicyError(`materialized content does not match operations: ${file}`, 'DELTA_DIGEST_MISMATCH');
    }

    const hunks = [];
    let delta = 0;
    for (const operation of ordered) {
      const afterStart = operation.start + delta;
      const afterEnd = afterStart + String(operation.newString).length;
      delta += String(operation.newString).length - String(operation.oldString).length;
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

    const changedRanges = changedRangesFromOperations(ordered);
    const violations = [];
    const addFindings = (scope, ids, detail = {}) => {
      for (const id of ids) violations.push({ scope, id, ...detail });
    };

    // 1) 新增片段：宿主内容规则 + 去空白/实体的结构规则（跨行安全）。
    for (const hunk of hunks) {
      const raw = scanPatchContent(hunk.after);
      if (!raw.ok) addFindings('fragment', raw.hits, { range: { start: hunk.afterStart, end: hunk.afterEnd } });
      addFindings('fragment-normalized', structuralFindings(hunk.after), { range: { start: hunk.afterStart, end: hunk.afterEnd } });
    }

    // 2) AFTER 中被修改的 tag：覆盖“基线上下文 + 一行新增”的拼接绕过，
    //    不扫描未变化的邻近 <script src>（修复 C12-P1-06 误拒）。
    const tagRe = /<[^>]*>/g;
    let tag;
    while ((tag = tagRe.exec(after)) !== null) {
      const range = { start: tag.index, end: tag.index + tag[0].length };
      if (!changedRanges.some((item) => overlaps(item, range))) continue;
      const raw = scanPatchContent(tag[0]);
      if (!raw.ok) addFindings('changed-tag', raw.hits, { range });
      addFindings('changed-tag-normalized', structuralFindings(tag[0]), { range });
    }

    // 3) <style> 内被修改的 CSS 区域。
    for (const block of styleRanges(after)) {
      for (const range of changedRanges) {
        if (!overlaps(range, block)) continue;
        const start = Math.max(range.start, block.start);
        const end = Math.min(range.end, block.end);
        if (end <= start) continue;
        const text = after.slice(start, end);
        const raw = scanPatchContent(text);
        if (!raw.ok) addFindings('css-changed', raw.hits, { range: { start, end } });
        addFindings('css-changed-normalized', structuralFindings(text), { range: { start, end } });
      }
    }

    // 4) 未闭合注释/style/script（完整平衡块删除仍合法）。
    addFindings('structure', unclosedFindings(after));

    if (violations.length) {
      const ids = [...new Set(violations.map((item) => item.id))];
      const error = new DeltaPolicyError(
        `delta content rejected (${ids.join(',')}): ${file}`,
        'DELTA_CONTENT_REJECTED',
      );
      error.violations = violations;
      throw error;
    }
    return { file, hunks, changedRanges, violations: [] };
  }

  function verifyFile({ root, file, content, sha256Before, sha256After, operations }) {
    const rel = String(file || '').replace(/\\/g, '/');
    if (!ALLOWED_EXT.test(rel)) {
      throw new DeltaPolicyError(`extension not allowed: ${rel}`, 'DELTA_FILE_NOT_ALLOWED');
    }
    const target = assertSafeRelPath(root, rel);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new DeltaPolicyError(`target file missing: ${rel}`, 'DELTA_TARGET_MISSING');
    }
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
    const allowed = new Set((allowedFiles || []).map((item) => String(item).replace(/\\/g, '/')));
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
          changedRanges: item.delta.changedRanges,
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

  return { scanDelta, applyDelta, finalizeApply };
}

module.exports = {
  createDeltaPolicy,
  DeltaPolicyError,
  sha256,
  structuralFindings,
  changedRangesFromOperations,
};

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
const { assertSemanticDelta } = require('./vision-structured.cjs');

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

function createDeltaPolicy({ policy } = {}) {
  if (
    !policy ||
    typeof policy.assertSafeRelPath !== 'function' ||
    typeof policy.scanPatchContent !== 'function'
  ) {
    throw new DeltaPolicyError('createDeltaPolicy requires vision-policy', 'DELTA_CONFIG');
  }
  const { assertSafeRelPath } = policy;

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

    // B13：结构化语义比较（替代无限扩大正则窗口）
    //  - 只拒绝 after 相对 before 新增的危险能力；
    //  - 检查注释/敏感标签/花括号结构是否新增失衡；
    //  - 精确 operations 重放与 digest 已在上面完成。
    assertSemanticDelta(before, after, file);
    return { file, hunks, windows: [] };
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

  return { scanDelta, applyDelta, finalizeApply };
}

module.exports = { createDeltaPolicy, DeltaPolicyError, sha256 };

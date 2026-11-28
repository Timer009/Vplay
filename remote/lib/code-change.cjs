'use strict';

/**
 * B22-C：受控代码变更通道（最小通用实现）。
 *
 * 边界：
 *  - 只接受结构化 change-set（完整文件内容），不接受任意 shell/补丁命令；
 *  - 仅允许已授权隔离实验项目（VPLAY_CODE_CHANGE_PROJECTS）；
 *  - 仅允许 .js/.mjs/.cjs/.html/.htm/.css；禁止隐藏路径、vendor、依赖、系统文件；
 *  - 基线树哈希 + diff 哈希 + 文件哈希由审批签名绑定；
 *  - 写入使用临时文件 + journal，失败自动回滚；
 *  - 固定检查：JS `node --check`，HTML/CSS 存在性；不安装依赖、不联网。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { hashTree } = require('./paths.cjs');
const { canonicalJson, sha256Hex } = require('./approval.cjs');

const MAX_FILES = 20;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const ALLOWED_EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.htm', '.css']);
const DENY_SEGMENTS = new Set([
  '.git',
  '.qwen',
  '.opengame',
  '.snapshots',
  'node_modules',
  'vendor',
  '.env',
]);

class CodeChangeError extends Error {
  constructor(message, code = 'CODE_CHANGE_REJECTED') {
    super(message);
    this.name = 'CodeChangeError';
    this.code = code;
  }
}

function safeProjectId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,39}$/.test(value);
}

/** 允许的项目白名单（逗号分隔）；为空 = 通道关闭。 */
function parseProjectAllowlist(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(safeProjectId);
}

function normalizeRel(value) {
  const rel = String(value || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || path.isAbsolute(rel)) {
    throw new CodeChangeError(`invalid path: ${value}`, 'CODE_CHANGE_PATH_INVALID');
  }
  const segments = rel.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new CodeChangeError(`invalid path segment: ${value}`, 'CODE_CHANGE_PATH_INVALID');
    }
    if (segment.startsWith('.')) {
      throw new CodeChangeError(`hidden paths are not allowed: ${value}`, 'CODE_CHANGE_HIDDEN_PATH');
    }
    if (DENY_SEGMENTS.has(segment)) {
      throw new CodeChangeError(`path is denied: ${value}`, 'CODE_CHANGE_PATH_DENIED');
    }
  }
  const ext = path.extname(rel).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new CodeChangeError(`extension is not allowed: ${rel}`, 'CODE_CHANGE_TYPE_DENIED');
  }
  return rel;
}

/** 逐段拒绝 symlink/junction 父目录，并拒绝目标本身是链接。 */
function assertNoSymlinkPath(root, rel) {
  const realRoot = fs.realpathSync.native(path.resolve(root));
  let current = realRoot;
  const segments = rel.split('/');
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      break; // 目标尚不存在：父目录已逐段检查
    }
    if (stat.isSymbolicLink()) {
      throw new CodeChangeError(`symlink path is not allowed: ${rel}`, 'CODE_CHANGE_SYMLINK');
    }
  }
  const parent = path.dirname(path.join(realRoot, ...segments));
  let realParent;
  try {
    realParent = fs.realpathSync.native(parent);
  } catch {
    return; // 父目录尚未创建
  }
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
    throw new CodeChangeError(`path escapes project: ${rel}`, 'CODE_CHANGE_PATH_ESCAPE');
  }
}

function validateChangeSet({ projectId, files, allowlist = [] }) {
  if (!safeProjectId(projectId)) {
    throw new CodeChangeError('invalid projectId', 'CODE_CHANGE_PROJECT_INVALID');
  }
  if (!allowlist.includes(projectId)) {
    throw new CodeChangeError(
      'project is not in VPLAY_CODE_CHANGE_PROJECTS',
      'CODE_CHANGE_PROJECT_DENIED',
    );
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    throw new CodeChangeError(
      `files must contain 1..${MAX_FILES} entries`,
      'CODE_CHANGE_FILES_INVALID',
    );
  }
  const seen = new Set();
  let total = 0;
  const normalized = files.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new CodeChangeError('file entry must be an object', 'CODE_CHANGE_FILES_INVALID');
    }
    const rel = normalizeRel(item.path);
    if (seen.has(rel)) throw new CodeChangeError(`duplicate path: ${rel}`, 'CODE_CHANGE_FILES_INVALID');
    seen.add(rel);
    if (typeof item.content !== 'string') {
      throw new CodeChangeError(`content must be a string: ${rel}`, 'CODE_CHANGE_FILES_INVALID');
    }
    if (/[\u0000]/.test(item.content)) {
      throw new CodeChangeError(`content contains NUL: ${rel}`, 'CODE_CHANGE_FILES_INVALID');
    }
    const bytes = Buffer.byteLength(item.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      throw new CodeChangeError(`file too large: ${rel}`, 'CODE_CHANGE_FILE_TOO_LARGE');
    }
    total += bytes;
    return { path: rel, content: item.content, sha256: sha256Hex(item.content), bytes };
  });
  if (total > MAX_TOTAL_BYTES) {
    throw new CodeChangeError('change-set too large', 'CODE_CHANGE_TOO_LARGE');
  }
  return normalized;
}

/** 基线树哈希：与审批签名绑定的“执行前状态”。 */
function computeTreeHash(root) {
  return sha256Hex(canonicalJson(hashTree(path.resolve(root))));
}

function readProjectFile(root, rel) {
  try {
    const file = path.join(root, ...rel.split('/'));
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new CodeChangeError(`not a regular file: ${rel}`, 'CODE_CHANGE_SYMLINK');
    }
    return fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if (error instanceof CodeChangeError) throw error;
    return null;
  }
}

/** 展示用 diff（前缀/后缀裁剪，中间以 -/+ 行展示）；不用于 apply。 */
function renderDiff({ root, files, maxLines = 400 }) {
  const chunks = [];
  for (const file of files) {
    assertNoSymlinkPath(root, file.path);
    const before = readProjectFile(root, file.path);
    const after = file.content;
    if (before === after) continue;
    chunks.push(`--- a/${file.path}`);
    chunks.push(`+++ b/${file.path}`);
    const beforeLines = before === null ? [] : before.split(/\r?\n/);
    const afterLines = after.split(/\r?\n/);
    let prefix = 0;
    while (
      prefix < beforeLines.length &&
      prefix < afterLines.length &&
      beforeLines[prefix] === afterLines[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < beforeLines.length - prefix &&
      suffix < afterLines.length - prefix &&
      beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
    const added = afterLines.slice(prefix, afterLines.length - suffix);
    chunks.push(`@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`);
    for (const line of removed.slice(0, maxLines)) chunks.push(`-${line}`);
    for (const line of added.slice(0, maxLines)) chunks.push(`+${line}`);
    if (chunks.length > maxLines * 2) {
      chunks.push('... diff truncated ...');
      break;
    }
  }
  return chunks.join('\n');
}

function writeAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.vplay-tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
  } catch {
    fs.rmSync(target, { force: true });
    fs.renameSync(tmp, target);
  }
}

/**
 * 原子应用 + journal。失败时按 journal 恢复，绝不留半写状态。
 * journalFile 由调用方放在项目外（runtime 目录）。
 */
function applyChangeSet({ root, files, journalFile, taskId }) {
  const resolvedRoot = fs.realpathSync.native(path.resolve(root));
  const entries = [];
  for (const file of files) {
    assertNoSymlinkPath(resolvedRoot, file.path);
    const target = path.join(resolvedRoot, ...file.path.split('/'));
    if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new CodeChangeError(`path escapes project: ${file.path}`, 'CODE_CHANGE_PATH_ESCAPE');
    }
    const before = readProjectFile(resolvedRoot, file.path);
    entries.push({ path: file.path, target, before, after: file.content });
  }

  const journal = {
    schemaVersion: 1,
    taskId: taskId || null,
    root: resolvedRoot,
    state: 'applying',
    at: new Date().toISOString(),
    files: entries.map((entry) => ({
      path: entry.path,
      existed: entry.before !== null,
      before: entry.before,
    })),
  };
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2), 'utf-8');

  try {
    for (const entry of entries) {
      writeAtomic(entry.target, entry.after);
      const actual = crypto.createHash('sha256').update(fs.readFileSync(entry.target)).digest('hex');
      if (actual !== sha256Hex(entry.after)) {
        throw new CodeChangeError(`write verification failed: ${entry.path}`, 'CODE_CHANGE_WRITE_FAILED');
      }
    }
    journal.state = 'applied';
    journal.finishedAt = new Date().toISOString();
    fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2), 'utf-8');
    return { ok: true, journalFile, files: entries.map((entry) => entry.path) };
  } catch (error) {
    rollbackChangeSet({ journalFile, root: resolvedRoot });
    throw error;
  }
}

function rollbackChangeSet({ journalFile, root }) {
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf-8'));
  const targetRoot = fs.realpathSync.native(path.resolve(root || journal.root));
  for (const file of journal.files || []) {
    const target = path.join(targetRoot, ...String(file.path).split('/'));
    if (!target.startsWith(`${targetRoot}${path.sep}`)) continue;
    if (file.existed) writeAtomic(target, file.before);
    else fs.rmSync(target, { force: true });
  }
  journal.state = 'rolled_back';
  journal.rolledBackAt = new Date().toISOString();
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2), 'utf-8');
  return { ok: true, files: (journal.files || []).map((file) => file.path) };
}

/** 提取 HTML 内嵌 <script>（无 src）内容；用于语法检查，不执行。 */
function extractInlineScripts(html) {
  const scripts = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const attrs = match[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const body = match[2] || '';
    if (!body.trim()) continue;
    scripts.push({
      module: /\btype\s*=\s*["']module["']/i.test(attrs),
      content: body,
    });
  }
  return scripts;
}

function checkInlineScripts(file, html, checks, timeoutMs) {
  const scripts = extractInlineScripts(html);
  scripts.forEach((script, index) => {
    const tmp = path.join(
      os.tmpdir(),
      `vplay-inline-${crypto.randomBytes(6).toString('hex')}${script.module ? '.mjs' : '.js'}`,
    );
    try {
      fs.writeFileSync(tmp, script.content, 'utf-8');
      const result = spawnSync(process.execPath, ['--check', tmp], {
        encoding: 'utf-8',
        timeout: timeoutMs,
        windowsHide: true,
      });
      checks.push({
        path: `${file.path}#inline-script-${index + 1}`,
        ok: result.status === 0,
        error:
          result.status === 0
            ? null
            : String(result.stderr || result.error || '').slice(0, 400),
      });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
}

/** 固定检查：只允许 node --check 与存在性；不执行项目代码、不装依赖。 */
function runFixedChecks({ root, files, timeoutMs = 15000 }) {
  const checks = [];
  for (const file of files) {
    const target = path.join(root, ...file.path.split('/'));
    const ext = path.extname(file.path).toLowerCase();
    if (!fs.existsSync(target)) {
      checks.push({ path: file.path, ok: false, error: 'missing after write' });
      continue;
    }
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const result = spawnSync(process.execPath, ['--check', target], {
        encoding: 'utf-8',
        timeout: timeoutMs,
        windowsHide: true,
      });
      checks.push({
        path: file.path,
        ok: result.status === 0,
        error: result.status === 0 ? null : String(result.stderr || result.error || '').slice(0, 400),
      });
    } else {
      checks.push({ path: file.path, ok: true, error: null });
      if (ext === '.html' || ext === '.htm') {
        checkInlineScripts(file, fs.readFileSync(target, 'utf-8'), checks, timeoutMs);
      }
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

module.exports = {
  CodeChangeError,
  parseProjectAllowlist,
  validateChangeSet,
  computeTreeHash,
  renderDiff,
  applyChangeSet,
  rollbackChangeSet,
  runFixedChecks,
  normalizeRel,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
};

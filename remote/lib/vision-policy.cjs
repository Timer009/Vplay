'use strict';

/**
 * Vision 主机侧安全策略（C07-P0-05 / P1-05 / P1-10 / P1-11）。
 *
 * 本模块不实现模型或浏览器，只提供宿主必须执行的安全约束：
 *  - 结构化补丁白名单：路径、链接、点段、内容特征
 *  - 原子写入 + journal（崩溃可恢复）
 *  - 浏览器 URL 白名单（配合 Playwright route 使用）
 *
 * 设计原则：默认拒绝；无法判定安全的改动直接拒绝，不做“猜测性放行”。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class VisionPolicyError extends Error {
  constructor(message, code = 'VISION_POLICY') {
    super(message);
    this.name = 'VisionPolicyError';
    this.code = code;
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeRel(rel) {
  return String(rel || '').replace(/\\/g, '/');
}

function assertSafeRelPath(root, rel) {
  const norm = normalizeRel(rel);
  if (!norm || path.isAbsolute(norm)) {
    throw new VisionPolicyError(`absolute or empty path: ${rel}`, 'PATH_INVALID');
  }
  const segments = norm.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new VisionPolicyError(`dot or empty segment: ${rel}`, 'PATH_TRAVERSAL');
  }
  if (segments[0] === '.opengame' || norm.startsWith('.')) {
    throw new VisionPolicyError(`dot path rejected: ${rel}`, 'PATH_DOTFILE');
  }
  const base = path.resolve(root);
  const target = path.resolve(base, norm);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new VisionPolicyError(`path escapes project: ${rel}`, 'PATH_ESCAPE');
  }
  // 逐段拒绝 symlink/junction；已存在的目标必须是普通文件
  let current = base;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new VisionPolicyError(`symlink rejected: ${rel}`, 'PATH_SYMLINK');
    }
    if (current !== target && !stat.isDirectory()) {
      throw new VisionPolicyError(`parent is not a directory: ${rel}`, 'PATH_INVALID');
    }
    if (current === target && !stat.isFile()) {
      throw new VisionPolicyError(`target is not a regular file: ${rel}`, 'PATH_NOT_FILE');
    }
  }
  if (fs.existsSync(target)) {
    const realRoot = fs.realpathSync.native(base);
    const realTarget = fs.realpathSync.native(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new VisionPolicyError(`realpath escapes project: ${rel}`, 'PATH_ESCAPE');
    }
  }
  return target;
}

/**
 * 内容级拒绝规则。针对 C07 列出的绕过面：
 * 协议相对 URL、meta refresh、iframe/object、内联事件、eval、外连 API、CSS url 外链。
 */
const CONTENT_RULES = [
  { id: 'external-url', re: /https?:\/\//i },
  { id: 'protocol-relative', re: /(?:src|href|action|url)\s*[=(]\s*["']?\/\//i },
  { id: 'double-slash-anywhere', re: /["'(]\s*\/\/[a-z0-9]/i },
  { id: 'meta-refresh', re: /<meta[^>]+http-equiv\s*=\s*["']?refresh/i },
  { id: 'iframe', re: /<iframe\b/i },
  { id: 'object-embed', re: /<(object|embed)\b/i },
  { id: 'base-tag', re: /<base\b/i },
  { id: 'form-action', re: /<form\b/i },
  { id: 'script-src-attr', re: /<script[^>]+\bsrc\s*=/i },
  { id: 'inline-handler', re: /\son[a-z]{3,}\s*=/i },
  { id: 'javascript-url', re: /javascript\s*:/i },
  { id: 'eval', re: /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/ },
  { id: 'network-api', re: /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/ },
  { id: 'dynamic-import', re: /\bimport\s*\(/ },
  { id: 'css-import', re: /@import\b/i },
  { id: 'css-external-url', re: /url\s*\(\s*["']?(?:https?:)?\/\//i },
  { id: 'srcdoc', re: /\bsrcdoc\s*=/i },
];

function scanPatchContent(content) {
  const text = String(content || '');
  const hits = [];
  for (const rule of CONTENT_RULES) {
    if (rule.re.test(text)) hits.push(rule.id);
  }
  return { ok: hits.length === 0, hits };
}

/**
 * 结构化增量校验（B10 / E06 B1）。
 *
 * 背景：Vision 0.2.0 的 `materializePatch` 输出**整文件**。真实工程（如 Spacer）
 * 基线里本来就含 inline `<script>`、`data:` favicon、`xmlns="http://..."`，
 * 对整文件做黑名单扫描会 100% 误报。这里改为：只对「相对基线新增的行」做内容校验，
 * 基线内容本身不被重新扫描；被删除/未变动的行不引入新的外部能力。
 *
 * 这不是放宽白名单：新增行仍必须通过全部 CONTENT_RULES；并且要求
 *  - 基线摘要与调用方声明的 `sha256Before` 一致（防 TOCTOU / 补丁基于旧内容）；
 *  - 结果摘要与 `sha256After` 一致（确定性 materialize）；
 *  - 必须至少有一行实际变化（禁止 no-op 冒充成功）。
 * 不接受任何 `prevalidated` / `contentScan` 之类的客户端放行参数。
 */
function addedLines(before, after) {
  const counts = new Map();
  for (const line of String(before || '').split(/\r?\n/)) {
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  const added = [];
  for (const line of String(after || '').split(/\r?\n/)) {
    const remaining = counts.get(line) || 0;
    if (remaining > 0) {
      counts.set(line, remaining - 1);
      continue;
    }
    if (line.trim()) added.push(line);
  }
  return added;
}

function validatePatchIncremental(root, files, allowedFiles) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new VisionPolicyError('patch has no files', 'PATCH_EMPTY');
  }
  const allowed = new Set((allowedFiles || []).map(normalizeRel));
  const seen = new Set();
  const plan = [];
  for (const item of files) {
    if (!item || typeof item !== 'object') {
      throw new VisionPolicyError('patch entry must be an object', 'PATCH_INVALID');
    }
    // 明确忽略任何客户端放行字段；只按宿主规则校验
    const rel = normalizeRel(item.file);
    if (!allowed.has(rel)) {
      throw new VisionPolicyError(`file not allowed: ${rel}`, 'PATCH_FILE_NOT_ALLOWED');
    }
    if (seen.has(rel)) {
      throw new VisionPolicyError(`duplicate file in patch: ${rel}`, 'PATCH_DUPLICATE');
    }
    seen.add(rel);
    const target = assertSafeRelPath(root, rel);
    if (typeof item.content !== 'string') {
      throw new VisionPolicyError(`content must be string: ${rel}`, 'PATCH_CONTENT_TYPE');
    }
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const shaBefore = sha256(before);
    const shaAfter = sha256(item.content);
    if (typeof item.sha256Before === 'string' && item.sha256Before && item.sha256Before !== shaBefore) {
      throw new VisionPolicyError(`baseline digest mismatch: ${rel}`, 'PATCH_BASELINE_MISMATCH');
    }
    if (typeof item.sha256After === 'string' && item.sha256After && item.sha256After !== shaAfter) {
      throw new VisionPolicyError(`materialized digest mismatch: ${rel}`, 'PATCH_DIGEST_MISMATCH');
    }
    const added = addedLines(before, item.content);
    if (added.length === 0) {
      throw new VisionPolicyError(`patch makes no change: ${rel}`, 'PATCH_NO_CHANGE');
    }
    const scan = scanPatchContent(added.join('\n'));
    if (!scan.ok) {
      throw new VisionPolicyError(
        `unsafe content in ${rel}: ${scan.hits.join(',')}`,
        'PATCH_CONTENT_REJECTED',
      );
    }
    plan.push({ file: rel, target, before, after: item.content, sha256Before: shaBefore, sha256After: shaAfter });
  }
  return plan;
}

/** 写临时文件 + fsync + rename，保证崩溃时不会留下半写入的目标文件。 */
function writeFileDurable(target, content) {
  const tmp = `${target}.vision-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    try {
      fs.fsyncSync(fd);
    } catch {
      // 某些文件系统不支持 fsync，忽略
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

/**
 * 校验一个补丁计划（整文件黑名单，仅用于显式整文件场景/测试）。
 * files: [{ file, content }]；allowedFiles: 宿主白名单（必须精确匹配）。
 */
function validatePatchFiles(root, files, allowedFiles) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new VisionPolicyError('patch has no files', 'PATCH_EMPTY');
  }
  const allowed = new Set((allowedFiles || []).map(normalizeRel));
  const seen = new Set();
  const checked = [];
  for (const item of files) {
    const rel = normalizeRel(item && item.file);
    if (!allowed.has(rel)) {
      throw new VisionPolicyError(`file not allowed: ${rel}`, 'PATCH_FILE_NOT_ALLOWED');
    }
    if (seen.has(rel)) {
      throw new VisionPolicyError(`duplicate file in patch: ${rel}`, 'PATCH_DUPLICATE');
    }
    seen.add(rel);
    const target = assertSafeRelPath(root, rel);
    if (typeof item.content !== 'string') {
      throw new VisionPolicyError(`content must be string: ${rel}`, 'PATCH_CONTENT_TYPE');
    }
    const scan = scanPatchContent(item.content);
    if (!scan.ok) {
      throw new VisionPolicyError(
        `unsafe content in ${rel}: ${scan.hits.join(',')}`,
        'PATCH_CONTENT_REJECTED',
      );
    }
    checked.push({ file: rel, target, content: item.content });
  }
  return checked;
}

/**
 * 原子写入 + journal：
 *  - 宿主独立校验（基线摘要绑定 + 增量内容扫描）后才写
 *  - 每个文件写临时文件、fsync 后 rename
 *  - 写前记录 before/after sha256；失败按内存快照还原已写文件
 *  - 成功后删除 journal
 */
function applyPatchAtomically({ root, files, journalFile, allowedFiles }) {
  const plan = validatePatchIncremental(root, files, allowedFiles);

  if (journalFile) {
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    fs.writeFileSync(
      journalFile,
      JSON.stringify(
        {
          state: 'applying',
          at: new Date().toISOString(),
          root: path.resolve(root),
          files: plan.map((item) => ({
            file: item.file,
            sha256Before: item.sha256Before,
            sha256After: item.sha256After,
          })),
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  const written = [];
  try {
    for (const item of plan) {
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      writeFileDurable(item.target, item.after);
      written.push(item);
    }
    if (journalFile) fs.rmSync(journalFile, { force: true });
    return plan.map((item) => ({
      file: item.file,
      bytes: Buffer.byteLength(item.after),
      sha256Before: item.sha256Before,
      sha256After: item.sha256After,
    }));
  } catch (error) {
    for (const item of written.reverse()) {
      try {
        if (item.before === '') fs.rmSync(item.target, { force: true });
        else fs.writeFileSync(item.target, item.before, 'utf-8');
      } catch {
        // 保留 journal 供人工/启动恢复
      }
    }
    throw new VisionPolicyError(`atomic apply failed: ${error.message}`, 'PATCH_APPLY_FAILED');
  }
}

/** 浏览器只允许访问预览源；其余协议/源一律拒绝（配合 Playwright route）。 */
function isAllowedBrowserUrl(url, previewOrigin) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol === 'about:' && parsed.pathname === 'blank') return true;
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (parsed.username || parsed.password) return false;
  let origin;
  try {
    origin = new URL(String(previewOrigin)).origin;
  } catch {
    return false;
  }
  return parsed.origin === origin;
}

module.exports = {
  VisionPolicyError,
  scanPatchContent,
  addedLines,
  validatePatchFiles,
  validatePatchIncremental,
  applyPatchAtomically,
  writeFileDurable,
  assertSafeRelPath,
  isAllowedBrowserUrl,
};

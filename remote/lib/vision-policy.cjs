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
 * 校验一个补丁计划。
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
 *  - 先全部校验（路径/白名单/内容）再写
 *  - 每个文件写临时文件后 rename
 *  - 写前记录 before/after sha256；失败按内存快照还原已写文件
 *  - 成功后删除 journal
 */
function applyPatchAtomically({ root, files, journalFile, allowedFiles }) {
  const checked = validatePatchFiles(root, files, allowedFiles);
  const plan = checked.map((item) => {
    const before = fs.existsSync(item.target) ? fs.readFileSync(item.target, 'utf8') : null;
    return {
      file: item.file,
      target: item.target,
      before,
      after: item.content,
      sha256Before: before === null ? null : sha256(before),
      sha256After: sha256(item.content),
    };
  });

  if (journalFile) {
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    fs.writeFileSync(
      journalFile,
      JSON.stringify(
        { state: 'vision-apply', at: new Date().toISOString(), files: plan.map((item) => ({
          file: item.file,
          sha256Before: item.sha256Before,
          sha256After: item.sha256After,
        })) },
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
      const tmp = `${item.target}.vision-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, item.after, 'utf-8');
      fs.renameSync(tmp, item.target);
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
        if (item.before === null) fs.rmSync(item.target, { force: true });
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
  validatePatchFiles,
  applyPatchAtomically,
  assertSafeRelPath,
  isAllowedBrowserUrl,
};

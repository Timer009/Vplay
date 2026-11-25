'use strict';

/**
 * 路径与文件系统安全工具（Sprint 02）。
 *
 * 所有「把 URL/任务参数映射到磁盘」的地方都必须经过这里：
 *  - 拒绝点文件（.env / .git / .opengame）
 *  - 拒绝路径穿越（../、%2e%2e、..%5c）
 *  - realpath 后再做边界判断，挡住 symlink / junction 逃逸
 *  - 前缀相同但不同目录（ws 与 ws-evil）不会被误判为「在工作区内」
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { spawnSync } = require('child_process');

/** 快照/哈希/复制时默认忽略的目录：非源码，且体积大或属于运行时状态。 */
const DEFAULT_EXCLUDES = new Set([
  '.git',
  'node_modules',
  '.opengame',
  '.snapshots',
  'dist',
]);

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

function realpathSafe(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

/**
 * 把静态 URL 解析成 rootDir 内的真实文件。
 * 返回 { ok, status, file | error }。
 */
function resolveStaticFile(rootDir, urlPath, options = {}) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || '').split('?')[0]);
  } catch {
    return { ok: false, status: 400, error: 'invalid path encoding' };
  }

  const relative = decoded.replace(/^[/\\]+/, '');
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  // 任何以 "." 开头的段都拒绝：..、.env、.git、.opengame
  if (segments.some((segment) => segment.startsWith('.'))) {
    return { ok: false, status: 403, error: 'dot paths are not served' };
  }
  if (segments.some((segment) => /^[a-zA-Z]:$/.test(segment))) {
    return { ok: false, status: 403, error: 'absolute paths are not served' };
  }

  const rootReal = realpathSafe(rootDir);
  if (!rootReal) return { ok: false, status: 404, error: 'preview not found' };

  const target = path.resolve(rootReal, segments.join(path.sep) || '.');
  if (!isInside(rootReal, target)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  const targetReal = realpathSafe(target);
  if (!targetReal) return { ok: false, status: 404, error: 'not found' };
  // symlink / junction 指向工作区外：拒绝
  if (!isInside(rootReal, targetReal)) {
    return { ok: false, status: 403, error: 'symlink escape denied' };
  }

  let stat;
  try {
    stat = fs.statSync(targetReal);
  } catch {
    return { ok: false, status: 404, error: 'not found' };
  }

  if (stat.isDirectory()) {
    const indexReal = realpathSafe(path.join(targetReal, 'index.html'));
    if (indexReal && isInside(rootReal, indexReal)) {
      return { ok: true, status: 200, file: indexReal };
    }
    return { ok: false, status: 404, error: 'not found' };
  }
  if (!stat.isFile()) return { ok: false, status: 404, error: 'not found' };
  // 扩展名白名单：只放行游戏确实需要的静态类型
  if (options.whitelist !== false && !isPreviewable(targetReal)) {
    return { ok: false, status: 403, error: 'file type is not previewable' };
  }
  return { ok: true, status: 200, file: targetReal };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 递归列出文件（相对路径，正斜杠），跳过 excludes。 */
function walkFiles(rootDir, options = {}) {
  const excludes = options.excludes || DEFAULT_EXCLUDES;
  const maxFiles = options.maxFiles || 50000;
  const out = [];

  function walk(current, depth) {
    if (out.length >= maxFiles || depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (excludes.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  walk(path.resolve(rootDir), 0);
  return out;
}

/** 目录内容哈希表：{ "相对路径": "sha256" } */
function hashTree(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const manifest = {};
  for (const file of walkFiles(root, options)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    try {
      manifest[rel] = sha256File(file);
    } catch {
      manifest[rel] = 'unreadable';
    }
  }
  return manifest;
}

function compareManifests(before, after) {
  const added = [];
  const removed = [];
  const modified = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) added.push(key);
    else if (before[key] !== after[key]) modified.push(key);
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) removed.push(key);
  }
  added.sort();
  removed.sort();
  modified.sort();
  return { added, removed, modified };
}

/** 复制目录（跳过 excludes）。 */
function copyTree(sourceDir, targetDir, options = {}) {
  const excludes = options.excludes || DEFAULT_EXCLUDES;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(path.resolve(sourceDir), path.resolve(targetDir), {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (src) => {
      const name = path.basename(src);
      // 只按目录名过滤，允许顶层自身
      if (path.resolve(src) === path.resolve(sourceDir)) return true;
      return !excludes.has(name);
    },
  });
}

/** 清空目录内容（保留目录本身），跳过 excludes。 */
function emptyTree(rootDir, options = {}) {
  const excludes = options.excludes || DEFAULT_EXCLUDES;
  if (!fs.existsSync(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (excludes.has(entry.name)) continue;
    fs.rmSync(path.join(rootDir, entry.name), { recursive: true, force: true });
  }
}

const TEXT_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.ts', '.tsx',
  '.jsx', '.md', '.txt', '.svg', '.yml', '.yaml', '.map', '.xml', '.csv',
]);

/**
 * 预览产物允许的扩展名白名单（P0-1）。
 * 未列入的类型一律 403，避免 .pem / .key / .sh / .bat 等被静态预览读走。
 */
const PREVIEW_EXTENSIONS = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.map',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.avif',
  '.mp3', '.ogg', '.wav', '.m4a', '.aac', '.mp4', '.webm',
  '.glb', '.gltf', '.bin', '.wasm', '.data',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.txt', '.xml', '.csv', '.atlas', '.fnt', '.dds', '.ktx2', '.hdr', '.exr',
]);

function isPreviewable(relPath) {
  return PREVIEW_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function looksTextual(relPath) {
  return TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function commonAncestor(a, b) {
  const left = path.resolve(a).split(path.sep);
  const right = path.resolve(b).split(path.sep);
  const shared = [];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i].toLowerCase() !== right[i].toLowerCase()) break;
    shared.push(left[i]);
  }
  return shared.join(path.sep) || path.sep;
}

function readTextLines(file) {
  try {
    return fs.readFileSync(file, 'utf-8').split(/\r?\n/);
  } catch {
    return [];
  }
}

function newFileDiff(rel, file) {
  const lines = readTextLines(file);
  const body = lines.map((line) => `+${line}`).join('\n');
  return (
    `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n` +
    `@@ -0,0 +1,${lines.length} @@\n${body}\n`
  );
}

function deletedFileDiff(rel, file) {
  const lines = readTextLines(file);
  const body = lines.map((line) => `-${line}`).join('\n');
  return (
    `diff --git a/${rel} b/${rel}\ndeleted file mode 100644\n--- a/${rel}\n+++ /dev/null\n` +
    `@@ -1,${lines.length} +0,0 @@\n${body}\n`
  );
}

/**
 * 生成两个目录之间的 unified diff。
 * 修改文件交给 `git diff --no-index`（cwd 设为两者共同祖先，避免绝对路径）；
 * 新增/删除文件由这里直接生成，避免往用户工程里塞临时文件。
 */
function unifiedDiff(aDir, bDir, files, options = {}) {
  // 单文件上限放宽到 512KB：游戏常常是单个大 HTML，但差异本身很小。
  const maxFileBytes = options.maxFileBytes || 512 * 1024;
  const maxTotalBytes = options.maxTotalBytes || 400 * 1024;

  let output = '';
  const omitted = [];
  for (const { path: rel, status } of files) {
    if (output.length > maxTotalBytes) {
      omitted.push(rel);
      continue;
    }
    if (!looksTextual(rel)) {
      omitted.push(rel);
      continue;
    }
    const aPath = path.join(aDir, rel);
    const bPath = path.join(bDir, rel);
    let size = 0;
    try {
      size = Math.max(
        status === 'added' ? 0 : fs.statSync(aPath).size,
        status === 'removed' ? 0 : fs.statSync(bPath).size,
      );
    } catch {
      size = 0;
    }
    if (size > maxFileBytes) {
      omitted.push(rel);
      continue;
    }

    if (status === 'added') {
      output += newFileDiff(rel, bPath);
      continue;
    }
    if (status === 'removed') {
      output += deletedFileDiff(rel, aPath);
      continue;
    }

    const common = commonAncestor(aPath, bPath);
    const aRel = path.relative(common, aPath).split(path.sep).join('/');
    const bRel = path.relative(common, bPath).split(path.sep).join('/');
    const result = spawnSync(
      'git',
      ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', aRel, bRel],
      { cwd: common, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    let chunk = result.stdout || '';
    // 把快照/工作区路径换成 a/<rel> b/<rel>，便于阅读
    chunk = chunk.split(`a/${aRel}`).join(`a/${rel}`).split(`b/${bRel}`).join(`b/${rel}`);
    output += chunk;
  }
  return {
    patch: output,
    truncated: omitted.length > 0 || output.length > maxTotalBytes,
    omitted,
  };
}

/**
 * 复制「可预览」文件到独立预览目录（P0-1 / P0-3）：
 * - 跳过任何以 "." 开头的目录/文件（.env/.git/.opengame）
 * - 只复制扩展名白名单内的文件
 * - 保留相对目录结构，便于 ../assets 这类相对引用
 */
function copyPreviewTree(sourceDir, targetDir, options = {}) {
  const root = path.resolve(sourceDir);
  const dest = path.resolve(targetDir);
  const maxFiles = options.maxFiles || 5000;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  let copied = 0;
  let skipped = 0;

  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        skipped += 1;
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          skipped += 1;
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.isFile()) {
        // symlink / junction：不跟随
        skipped += 1;
        continue;
      }
      if (!isPreviewable(entry.name)) {
        skipped += 1;
        continue;
      }
      if (copied >= maxFiles) {
        skipped += 1;
        continue;
      }
      const rel = path.relative(root, full);
      const target = path.join(dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.copyFileSync(full, target);
        copied += 1;
      } catch {
        skipped += 1;
      }
    }
  }

  walk(root);
  return { copied, skipped };
}

module.exports = {
  DEFAULT_EXCLUDES,
  PREVIEW_EXTENSIONS,
  isPreviewable,
  isInside,
  realpathSafe,
  resolveStaticFile,
  sha256File,
  walkFiles,
  hashTree,
  compareManifests,
  copyTree,
  copyPreviewTree,
  emptyTree,
  unifiedDiff,
  looksTextual,
};

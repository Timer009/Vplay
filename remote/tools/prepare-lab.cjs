#!/usr/bin/env node
'use strict';

/**
 * C18 P-3 / B21：跨平台独立实验副本准备（Windows/Linux 通用）。
 *
 * - 不修改源仓库；只读取 git blob / 工作树文件；
 * - 双哈希：git blob sha256（官方源码） + 工作树 sha256（平台换行差异）；
 * - 生成 manifest.json（提交、入口、字节数、双哈希、完整文件清单）；
 * - B21：--all-tracked 复制 HEAD 全部 tracked 文件（逐文件双哈希 + 保真复核），
 *   保证真实 Spacer 项目除 .git 外的文件集合与官方提交一致；
 * - 可选注册独立 project（--register --home <VPLAY_HOME>）；
 * - labRoot 必须与 sourceDir 分离，拒绝 symlink/junction 目标。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function git(args, cwd) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function realpathOrResolve(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function safeRelPath(value) {
  const rel = String(value || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || path.isAbsolute(rel)) {
    throw new Error(`unsafe tracked path: ${value}`);
  }
  const segments = rel.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`unsafe tracked path: ${value}`);
  }
  return rel;
}

/** 读取 HEAD 的全部 tracked 文件（mode/type/object/path）。 */
function listTrackedEntries(source) {
  const result = spawnSync(
    'git',
    ['-C', source, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60000 },
  );
  if (result.status !== 0) {
    throw new Error('--all-tracked requires a git repository with a HEAD commit');
  }
  const entries = [];
  for (const record of result.stdout.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    const mode = meta[0];
    const type = meta[1];
    const object = meta[2];
    const rel = safeRelPath(record.slice(tab + 1));
    if (type !== 'blob' || mode === '120000' || mode === '160000') {
      throw new Error(`tracked entry is not a regular file (mode=${mode}, type=${type}): ${rel}`);
    }
    entries.push({ mode, type, object, rel });
  }
  if (entries.length === 0) throw new Error('source repository has no tracked files');
  return entries;
}

/** 一次 cat-file --batch 读取多个 blob，避免每文件启动一个 git 进程。 */
function readGitBlobs(source, objects) {
  const input = `${objects.join('\n')}\n`;
  const result = spawnSync('git', ['-C', source, 'cat-file', '--batch'], {
    input,
    maxBuffer: 512 * 1024 * 1024,
    timeout: 120000,
  });
  if (result.status !== 0) {
    throw new Error('git cat-file --batch failed while reading tracked blobs');
  }
  const buffer = result.stdout;
  const blobs = new Map();
  let offset = 0;
  for (const object of objects) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`unexpected cat-file output for ${object}`);
    const header = buffer.slice(offset, newline).toString('utf8').split(' ');
    if (header[1] !== 'blob') {
      throw new Error(`blob unavailable for ${object} (${header.slice(0, 3).join(' ')})`);
    }
    const size = Number(header[2]);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`invalid blob size for ${object}`);
    }
    const start = newline + 1;
    const end = start + size;
    if (end > buffer.length) throw new Error(`truncated blob for ${object}`);
    blobs.set(object, buffer.slice(start, end));
    offset = end + 1; // 跳过内容后的换行
  }
  return blobs;
}

function walkFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
    else throw new Error(`unexpected non-regular file in lab copy: ${full}`);
  }
  return out;
}

function prepareLab({
  sourceDir,
  labRoot,
  entry = 'vector-lander/index.html',
  projectId = 'spacer-lab',
  home = null,
  register = false,
  allTracked = false,
}) {
  if (!sourceDir || !labRoot) throw new Error('sourceDir and labRoot are required');
  const source = realpathOrResolve(sourceDir);
  const target = path.resolve(labRoot);
  if (target === source || target.startsWith(source + path.sep)) {
    throw new Error('labRoot must not be inside sourceDir');
  }
  if (source.startsWith(target + path.sep)) {
    throw new Error('sourceDir must not be inside labRoot');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(projectId)) {
    throw new Error(`invalid projectId: ${projectId}`);
  }
  const rel = safeRelPath(entry);
  const sourceEntry = path.join(source, ...rel.split('/'));
  if (!fs.existsSync(sourceEntry)) throw new Error(`entry not found: ${sourceEntry}`);
  const sourceStat = fs.lstatSync(sourceEntry);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(`entry must be a regular file: ${sourceEntry}`);
  }

  const worktree = fs.readFileSync(sourceEntry);
  const worktreeSha256 = sha256(worktree);
  const commit = git(['rev-parse', 'HEAD'], source);

  const tracked = allTracked ? listTrackedEntries(source) : null;
  if (tracked && !tracked.some((item) => item.rel === rel)) {
    throw new Error(`entry is not tracked in HEAD: ${rel}`);
  }

  const entries = tracked || [
    { mode: '100644', type: 'blob', object: null, rel },
  ];
  const blobs = new Map();
  let entryBlobSource = 'worktree';
  if (tracked) {
    const objects = [...new Set(entries.map((item) => item.object))];
    const byObject = readGitBlobs(source, objects);
    for (const item of entries) blobs.set(item.rel, byObject.get(item.object));
    entryBlobSource = 'git-blob';
  } else {
    // 单入口模式：优先使用 HEAD:entry blob（官方 LF 版本），否则复制工作树。
    const blob = commit
      ? spawnSync('git', ['-C', source, 'cat-file', 'blob', `HEAD:${rel}`], {
          encoding: 'buffer',
          timeout: 30000,
          maxBuffer: 50 * 1024 * 1024,
        })
      : null;
    if (blob && blob.status === 0) {
      blobs.set(rel, blob.stdout);
      entryBlobSource = 'git-blob';
    } else {
      blobs.set(rel, worktree);
    }
  }

  if (fs.existsSync(target)) {
    const existing = fs.readdirSync(target);
    if (existing.length > 0) throw new Error(`labRoot is not empty: ${target}`);
  }
  fs.mkdirSync(target, { recursive: true });

  const files = [];
  for (const item of entries) {
    const bytes = blobs.get(item.rel);
    if (!bytes) throw new Error(`no content for tracked file: ${item.rel}`);
    const blobSha256 = sha256(bytes);
    const dest = path.join(target, ...item.rel.split('/'));
    if (dest !== target && !dest.startsWith(target + path.sep)) {
      throw new Error(`tracked path escapes labRoot: ${item.rel}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    const copied = fs.readFileSync(dest);
    const copiedSha256 = sha256(copied);
    if (copiedSha256 !== blobSha256) {
      throw new Error(`fidelity check failed for ${item.rel}`);
    }
    let worktreeFileSha256 = null;
    try {
      const sourceFile = path.join(source, ...item.rel.split('/'));
      const stat = fs.lstatSync(sourceFile);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        worktreeFileSha256 = sha256(fs.readFileSync(sourceFile));
      }
    } catch {
      // 工作树缺文件不影响官方 blob 副本
    }
    files.push({
      path: item.rel,
      mode: item.mode,
      blobSha256,
      blobBytes: bytes.length,
      worktreeSha256: worktreeFileSha256,
      copiedSha256,
    });
  }

  // 保真复核：目标目录文件集合必须与 tracked 清单完全一致（manifest.json 除外）。
  const copiedPaths = walkFiles(target).filter((name) => name !== 'manifest.json');
  const expected = files.map((file) => file.path);
  if (copiedPaths.length !== expected.length) {
    throw new Error(`lab copy file count mismatch: ${copiedPaths.length} != ${expected.length}`);
  }
  for (const name of expected) {
    if (!copiedPaths.includes(name)) throw new Error(`lab copy missing file: ${name}`);
  }

  const entryFile = files.find((file) => file.path === rel);
  const totalBytes = files.reduce((sum, file) => sum + file.blobBytes, 0);
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sourceDir: source,
    labRoot: target,
    commit,
    mode: allTracked ? 'all-tracked' : 'entry',
    entry: rel,
    source: {
      blobSha256: entryFile ? entryFile.blobSha256 : sha256(worktree),
      blobBytes: entryFile ? entryFile.blobBytes : worktree.length,
      blobSource: entryBlobSource,
      worktreeSha256,
      worktreeBytes: worktree.length,
    },
    copied: {
      path: target,
      sha256: entryFile ? entryFile.copiedSha256 : null,
      bytes: entryFile ? entryFile.blobBytes : 0,
      files: files.map((file) => file.path),
      fileCount: files.length,
      totalBytes,
    },
    fidelity: {
      verified: true,
      fileCount: files.length,
      totalBytes,
      includesManifest: false,
    },
    files,
  };
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));

  let project = null;
  if (register) {
    if (!home) throw new Error('--home is required with --register');
    const { createProjectRegistry } = require('../lib/projects.cjs');
    const registry = createProjectRegistry({ home: path.resolve(home) });
    project = registry.importProject({ sourceDir: target, id: projectId, entry: rel });
  }
  return { manifest, project };
}

function readFlag(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) {
    console.log(
      'usage: node remote/tools/prepare-lab.cjs --source <dir> --lab-root <dir> ' +
      '[--entry vector-lander/index.html] [--all-tracked] [--project spacer-lab] ' +
      '[--register --home <VPLAY_HOME>]',
    );
    process.exit(0);
  }
  const result = prepareLab({
    sourceDir: readFlag(argv, 'source'),
    labRoot: readFlag(argv, 'lab-root'),
    entry: readFlag(argv, 'entry', 'vector-lander/index.html'),
    projectId: readFlag(argv, 'project', 'spacer-lab'),
    home: readFlag(argv, 'home', null),
    register: argv.includes('--register'),
    allTracked: argv.includes('--all-tracked'),
  });
  console.log(JSON.stringify({
    ok: true,
    labRoot: result.manifest.labRoot,
    mode: result.manifest.mode,
    commit: result.manifest.commit,
    fileCount: result.manifest.copied.fileCount,
    totalBytes: result.manifest.copied.totalBytes,
    blobSha256: result.manifest.source.blobSha256,
    worktreeSha256: result.manifest.source.worktreeSha256,
    project: result.project ? result.project.project.id : null,
  }, null, 2));
}

module.exports = { prepareLab, sha256, listTrackedEntries };

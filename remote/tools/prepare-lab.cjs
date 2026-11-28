#!/usr/bin/env node
'use strict';

/**
 * C18 P-3：跨平台独立实验副本准备（Windows/Linux 通用）。
 *
 * - 不修改源仓库；只读取 git blob / 工作树文件；
 * - 双哈希：git blob sha256（官方源码） + 工作树 sha256（平台换行差异）；
 * - 生成 manifest.json（提交、入口、字节数、双哈希、文件清单）；
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

function prepareLab({
  sourceDir,
  labRoot,
  entry = 'vector-lander/index.html',
  projectId = 'spacer-lab',
  home = null,
  register = false,
}) {
  if (!sourceDir || !labRoot) throw new Error('sourceDir and labRoot are required');
  const source = realpathOrResolve(sourceDir);
  const target = path.resolve(labRoot);
  if (target === source || target.startsWith(source + path.sep)) {
    throw new Error('labRoot must not be inside sourceDir');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(projectId)) {
    throw new Error(`invalid projectId: ${projectId}`);
  }
  const rel = String(entry).replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error(`invalid entry: ${entry}`);
  }
  const sourceEntry = path.join(source, ...rel.split('/'));
  if (!fs.existsSync(sourceEntry)) throw new Error(`entry not found: ${sourceEntry}`);
  const sourceStat = fs.lstatSync(sourceEntry);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(`entry must be a regular file: ${sourceEntry}`);
  }

  const worktree = fs.readFileSync(sourceEntry);
  const worktreeSha256 = sha256(worktree);
  const commit = git(['rev-parse', 'HEAD'], source);
  let blobSha256 = worktreeSha256;
  let blobBytes = worktree.length;
  let blobSource = 'worktree';
  if (commit) {
    const blob = spawnSync('git', ['-C', source, 'cat-file', 'blob', `HEAD:${rel}`], {
      encoding: 'buffer',
      timeout: 30000,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (blob.status === 0) {
      blobSha256 = sha256(blob.stdout);
      blobBytes = blob.stdout.length;
      blobSource = 'git-blob';
    }
  }

  if (fs.existsSync(target)) {
    const existing = fs.readdirSync(target);
    if (existing.length > 0) throw new Error(`labRoot is not empty: ${target}`);
  }
  fs.mkdirSync(target, { recursive: true });
  const targetEntry = path.join(target, ...rel.split('/'));
  fs.mkdirSync(path.dirname(targetEntry), { recursive: true });
  // 用 git blob 写出 LF 版本；若不可用则复制工作树。
  const bytes = blobSource === 'git-blob'
    ? spawnSync('git', ['-C', source, 'cat-file', 'blob', `HEAD:${rel}`], { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 }).stdout
    : worktree;
  fs.writeFileSync(targetEntry, bytes);
  const copiedSha256 = sha256(fs.readFileSync(targetEntry));

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceDir: source,
    labRoot: target,
    commit,
    entry: rel,
    source: {
      blobSha256,
      blobBytes,
      blobSource,
      worktreeSha256,
      worktreeBytes: worktree.length,
    },
    copied: {
      path: targetEntry,
      sha256: copiedSha256,
      bytes: fs.statSync(targetEntry).size,
      files: [rel],
    },
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
      '[--entry vector-lander/index.html] [--project spacer-lab] [--register --home <VPLAY_HOME>]',
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
  });
  console.log(JSON.stringify({
    ok: true,
    labRoot: result.manifest.labRoot,
    commit: result.manifest.commit,
    blobSha256: result.manifest.source.blobSha256,
    worktreeSha256: result.manifest.source.worktreeSha256,
    project: result.project ? result.project.project.id : null,
  }, null, 2));
}

module.exports = { prepareLab, sha256 };

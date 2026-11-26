'use strict';

/**
 * 项目注册表与版本管理（Sprint 02 · Adopt Mode）。
 *
 * 目录布局（VPLAY_HOME，默认 ~/.vplay）：
 *   projects.json                 受控 projectId -> 工作区映射（HTTP 只能引用 id）
 *   runtime/                      任务状态、日志、锁（由 server 使用）
 *   projects/<id>/src             工作副本（AI 只改这里）
 *   projects/<id>/.snapshots/     每次修改前的可恢复快照
 *   projects/<id>/profile.json    项目画像（入口/框架/关键文件/构建方式）
 *   projects/<id>/memory.json     连续开发记忆（最近 N 轮）
 *
 * 约束：
 *  - 导入只读原始工程：先哈希、复制、再哈希，前后必须一致
 *  - 禁止通过 HTTP 传系统路径：所有接口只接受 projectId
 *  - 快照/回退不覆盖 .git、node_modules、dist、.opengame
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  DEFAULT_EXCLUDES,
  isInside,
  isSensitivePath,
  hashTree,
  compareManifests,
  copyTree,
  copyPreviewTree,
  emptyTree,
  unifiedDiff,
  walkFiles,
} = require('./paths.cjs');

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const SNAPSHOT_DIR_PATTERN = /^\d{3,}-[a-z0-9-]+$/;
const MAX_SNAPSHOTS = 50;
const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/** 只删除链接本身（junction/symlink），绝不跟随到目标目录。 */
function removeLinkOnly(target) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) return;
    try {
      fs.unlinkSync(target);
    } catch {
      fs.rmdirSync(target);
    }
  } catch {
    // 不存在或已被删除
  }
}

/** 找出目录中的 symlink / junction（不跟随），用于导入前显式拒绝（NEW-03）。 */
function findLinks(rootDir) {
  const links = [];
  function walk(current, depth) {
    if (depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (DEFAULT_EXCLUDES.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        links.push(path.relative(rootDir, full).split(path.sep).join('/'));
        continue;
      }
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  }
  walk(path.resolve(rootDir), 0);
  return links;
}

class ProjectError extends Error {
  constructor(message, statusCode = 400, code = 'PROJECT_ERROR') {
    super(message);
    this.name = 'ProjectError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function defaultHome() {
  return process.env.VPLAY_HOME || path.join(os.homedir(), '.vplay');
}

function digestManifest(manifest) {
  const keys = Object.keys(manifest).sort();
  const hash = crypto.createHash('sha256');
  for (const key of keys) hash.update(`${key}\u0000${manifest[key]}\n`);
  return hash.digest('hex');
}

function slugify(label) {
  return String(label || 'snapshot')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'snapshot';
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function validateProjectId(id) {
  if (typeof id !== 'string' || !PROJECT_ID_PATTERN.test(id)) {
    throw new ProjectError(
      'projectId 必须为 2-40 位小写字母/数字/连字符，且以字母或数字开头',
      400,
      'INVALID_PROJECT_ID',
    );
  }
  return id;
}

/** 检测已有工程：零依赖 HTML/JS、子目录入口、Vite。 */
function detectProject(srcDir) {
  const absolute = path.resolve(srcDir);
  if (!fs.existsSync(absolute)) {
    throw new ProjectError(`目录不存在: ${absolute}`, 404, 'SOURCE_NOT_FOUND');
  }
  if (!fs.statSync(absolute).isDirectory()) {
    throw new ProjectError(`不是目录: ${absolute}`, 400, 'SOURCE_NOT_DIR');
  }

  const pkgPath = path.join(absolute, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath, null) : null;
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };

  const hasViteConfig = ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.cjs']
    .some((name) => fs.existsSync(path.join(absolute, name)));
  const isVite = hasViteConfig || Boolean(deps.vite);

  // 找出入口 index.html：优先根目录，其次浅层子目录
  const candidates = [];
  const files = walkFiles(absolute, { excludes: new Set(['.git', 'node_modules', '.opengame', 'dist']) });
  for (const file of files) {
    if (path.basename(file).toLowerCase() !== 'index.html') continue;
    const rel = path.relative(absolute, file).split(path.sep).join('/');
    const depth = rel.split('/').length - 1;
    if (depth > 3) continue;
    candidates.push({ rel, depth });
  }
  candidates.sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel));

  const framework = deps.phaser
    ? 'phaser'
    : deps.three
      ? 'three'
      : deps.react
        ? 'react'
        : deps.vue
          ? 'vue'
          : isVite
            ? 'vite'
            : 'vanilla';

  const buildCommand = isVite
    ? (pkg?.scripts?.build ? 'npm run build' : 'npx vite build')
    : null;

  const keyFiles = files
    .map((file) => path.relative(absolute, file).split(path.sep).join('/'))
    .filter((rel) => !rel.includes('/'))
    .sort()
    .slice(0, 12);

  return {
    kind: isVite ? 'vite' : 'static',
    entry: candidates.length > 0 ? candidates[0].rel : null,
    entryCandidates: candidates.map((item) => item.rel),
    framework,
    buildCommand,
    keyFiles,
    hasPackageJson: Boolean(pkg),
  };
}

function createProjectRegistry(options = {}) {
  const home = path.resolve(options.home || defaultHome());
  const projectsRoot = path.join(home, 'projects');
  const registryFile = path.join(home, 'projects.json');
  const runtimeDir = path.join(home, 'runtime');
  const locksDir = path.join(runtimeDir, 'locks');

  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });

  const registry = readJson(registryFile, { version: 1, projects: [] });
  if (!Array.isArray(registry.projects)) registry.projects = [];

  function saveRegistry() {
    writeJson(registryFile, registry);
  }

  /**
   * 注册表 / 快照 / 回退的统一互斥锁（NEW-06）。
   * 同进程内 JS 单线程已串行；文件锁用于多进程（CLI + server）并发时防止丢更新。
   */
  function withRegistryLock(fn) {
    const dir = path.join(home, '.opengame');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'registry.lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        fs.closeSync(fd);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let info = null;
        try {
          info = JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch {
          info = null;
        }
        let alive = false;
        if (info && info.pid) {
          try {
            process.kill(info.pid, 0);
            alive = true;
          } catch {
            alive = false;
          }
        }
        const stale = !alive || (info && Date.now() - Number(info.at || 0) > LOCK_STALE_MS);
        if (stale) {
          try {
            fs.rmSync(file, { force: true });
          } catch {
            // 继续重试
          }
          continue;
        }
        if (Date.now() > deadline) {
          throw new ProjectError('registry is busy', 409, 'REGISTRY_LOCKED');
        }
        sleepSync(50);
      }
    }
    try {
      return fn();
    } finally {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 忽略
      }
    }
  }

  function projectDirOf(id) {
    return path.join(projectsRoot, id);
  }

  function raw(id) {
    return registry.projects.find((item) => item.id === id) || null;
  }

  function requireProject(id) {
    validateProjectId(id);
    const found = raw(id);
    if (!found) throw new ProjectError(`未知项目: ${id}`, 404, 'PROJECT_NOT_FOUND');
    return found;
  }

  function profilePath(id) {
    return path.join(projectDirOf(id), 'profile.json');
  }

  function memoryPath(id) {
    return path.join(projectDirOf(id), 'memory.json');
  }

  function snapshotsFile(id) {
    return path.join(projectDirOf(id), 'snapshots.json');
  }

  function snapshotsDir(id) {
    return path.join(projectDirOf(id), '.snapshots');
  }

  function list() {
    return registry.projects.map((item) => ({
      ...item,
      profile: readJson(profilePath(item.id), null),
      locked: Boolean(readLock(item.id)),
    }));
  }

  function get(id) {
    const record = requireProject(id);
    return {
      ...record,
      profile: readJson(profilePath(id), null),
      memory: readJson(memoryPath(id), { rounds: [] }),
      snapshots: listSnapshots(id),
      locked: Boolean(readLock(id)),
    };
  }

  function importProject(args) {
    return withRegistryLock(() => importProjectUnlocked(args));
  }

  function importProjectUnlocked({ sourceDir, id, name, entry }) {
    const source = path.resolve(sourceDir);
    validateProjectId(id);
    if (raw(id)) throw new ProjectError(`项目 ID 已存在: ${id}`, 409, 'PROJECT_EXISTS');

    const detected = detectProject(source);
    if (!detected.entry) {
      throw new ProjectError(
        '未找到入口 index.html（深度 <= 3），请用 --entry 指定',
        400,
        'ENTRY_NOT_FOUND',
      );
    }
    // NEW-03：含 symlink / junction 的工程在复制前显式拒绝，原工程不受影响
    const links = findLinks(source);
    if (links.length > 0) {
      throw new ProjectError(
        `工程包含不支持的符号链接/目录联接（${links.length} 个）：${links.slice(0, 5).join(', ')}`,
        400,
        'SYMLINK_UNSUPPORTED',
      );
    }
    let resolvedEntry = detected.entry;
    if (entry) {
      const normalized = String(entry).replace(/\\/g, '/').replace(/^\/+/, '');
      if (normalized.split('/').some((part) => part === '..' || part.startsWith('.'))) {
        throw new ProjectError('--entry 不能包含 .. 或点文件', 400, 'INVALID_ENTRY');
      }
      if (!fs.existsSync(path.join(source, normalized))) {
        throw new ProjectError(`入口不存在: ${normalized}`, 400, 'ENTRY_NOT_FOUND');
      }
      resolvedEntry = normalized;
    }

    const dir = projectDirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    const srcDir = path.join(dir, 'src');

    // 1) 导入前哈希原始工程（NEW-05：敏感文件统一排除，与快照/Diff/预览一致）
    const sourceFiles = walkFiles(source, { includeSensitive: true });
    const skippedSensitive = sourceFiles
      .map((file) => path.relative(source, file).split(path.sep).join('/'))
      .filter((rel) => isSensitivePath(rel));
    const before = hashTree(source);
    const beforeDigest = digestManifest(before);

    // 2) 复制到受控工作区（不改原始工程）
    //    注意：dist 是预览产物，必须一起复制；快照/哈希仍会忽略它。
    copyTree(source, srcDir, {
      excludes: new Set(['.git', 'node_modules', '.opengame', '.snapshots']),
    });

    // 3) 复制结果必须与原始工程一致
    const copied = hashTree(srcDir);
    const copiedDigest = digestManifest(copied);
    if (copiedDigest !== beforeDigest) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new ProjectError('导入复制校验失败：工作副本与原始工程不一致', 500, 'COPY_MISMATCH');
    }

    // 4) 原始工程在导入后必须保持原样
    const afterDigest = digestManifest(hashTree(source));

    const preview = resolvePreviewTarget(srcDir, resolvedEntry, detected.kind);

    const record = {
      id,
      name: name || id,
      source: 'import',
      managed: true,
      srcDir,
      originalPath: source,
      kind: detected.kind,
      framework: detected.framework,
      entry: resolvedEntry,
      createdAt: new Date().toISOString(),
    };
    registry.projects.push(record);
    saveRegistry();

    writeJson(profilePath(id), {
      ...record,
      detected,
      preview,
      import: {
        importedAt: record.createdAt,
        fileCount: Object.keys(before).length,
        hashDigest: beforeDigest,
        originalUnchanged: afterDigest === beforeDigest,
        skippedSensitive,
      },
    });
    writeJson(memoryPath(id), { rounds: [] });
    writeJson(snapshotsFile(id), { seq: 0, snapshots: [] });

    // 5) 初始快照 = 导入时的状态，可随时回退
    const initial = snapshotInternal(id, 'initial');

    return {
      project: get(id),
      import: {
        fileCount: Object.keys(before).length,
        hashDigest: beforeDigest,
        originalUnchanged: afterDigest === beforeDigest,
        skippedSensitive,
        initialSnapshot: initial.seq,
      },
    };
  }

  /** Create Mode：直接以现有工作区注册一个受控项目（不复制）。 */
  function registerWorkspace(args) {
    return withRegistryLock(() => registerWorkspaceUnlocked(args));
  }

  function registerWorkspaceUnlocked({ id = 'default', name = 'Create Mode workspace', workspaceDir, entry }) {
    const src = path.resolve(workspaceDir);
    validateProjectId(id);
    const existing = raw(id);
    const detected = detectProject(src);
    const resolvedEntry = entry || detected.entry || 'index.html';

    if (existing) {
      existing.srcDir = src;
      existing.kind = detected.kind;
      existing.framework = detected.framework;
      existing.entry = resolvedEntry;
      saveRegistry();
    } else {
      registry.projects.push({
        id,
        name,
        source: 'create',
        managed: false,
        srcDir: src,
        originalPath: null,
        kind: detected.kind,
        framework: detected.framework,
        entry: resolvedEntry,
        createdAt: new Date().toISOString(),
      });
      saveRegistry();
      writeJson(profilePath(id), {
        ...raw(id),
        detected,
        preview: resolvePreviewTarget(src, resolvedEntry, detected.kind),
      });
      writeJson(memoryPath(id), { rounds: [] });
      writeJson(snapshotsFile(id), { seq: 0, snapshots: [] });
    }
    return get(id);
  }

  function resolvePreviewTarget(srcDir, entry, kind) {
    if (kind === 'vite') {
      const dist = path.join(srcDir, 'dist');
      if (fs.existsSync(path.join(dist, 'index.html'))) {
        return { kind: 'vite-dist', root: dist, entry: 'index.html', source: 'dist' };
      }
      return {
        kind: 'vite-dist',
        root: null,
        entry: 'index.html',
        source: 'dist',
        hint: '未找到 dist/，请先在项目内执行构建（npm run build）',
      };
    }
    const entryDir = path.dirname(entry || 'index.html');
    return {
      kind: 'static',
      root: entryDir === '.' ? srcDir : path.join(srcDir, entryDir),
      entry: path.basename(entry || 'index.html'),
      source: 'src',
    };
  }

  function previewSourceDir(record) {
    if (record.kind === 'vite') {
      const dist = path.join(record.srcDir, 'dist');
      return fs.existsSync(path.join(dist, 'index.html')) ? dist : null;
    }
    return record.srcDir;
  }

  function previewDirOf(id) {
    return path.join(projectDirOf(id), '.preview');
  }

  function previewRootPath(record, dest) {
    if (record.kind === 'vite') return dest;
    const entryDir = path.dirname(record.entry || 'index.html');
    return entryDir === '.' ? dest : path.join(dest, entryDir);
  }

  /**
   * 生成独立预览产物目录（P0-1/P0-3）：
   * 只复制可预览类型、跳过点文件与 node_modules，预览面只读这里，
   * 永远不直接读 src。
   */
  function buildPreview(id) {
    const record = requireProject(id);
    const dest = previewDirOf(id);
    const source = previewSourceDir(record);
    if (!source) {
      fs.rmSync(dest, { recursive: true, force: true });
      return null;
    }
    let result;
    try {
      result = copyPreviewTree(source, dest);
    } catch {
      return null;
    }
    // NEW-04：发布清单落盘，便于审计「发布了什么、跳过了什么」
    try {
      writeJson(path.join(projectDirOf(id), '.publish-manifest.json'), {
        projectId: id,
        ...result.manifest,
      });
    } catch {
      // 清单写入失败不影响预览
    }
    const entryRel = record.kind === 'vite' ? 'index.html' : record.entry || 'index.html';
    if (!fs.existsSync(path.join(dest, entryRel))) return null;
    return previewRootPath(record, dest);
  }

  function previewRoot(id) {
    const record = requireProject(id);
    const dest = previewDirOf(id);
    const entryRel = record.kind === 'vite' ? 'index.html' : record.entry || 'index.html';
    if (!fs.existsSync(path.join(dest, entryRel))) {
      buildPreview(id);
    }
    if (!fs.existsSync(path.join(dest, entryRel))) return null;
    return previewRootPath(record, dest);
  }

  function listSnapshots(id) {
    return readJson(snapshotsFile(id), { snapshots: [] }).snapshots || [];
  }

  /** NEW-02：快照目录必须落在 .snapshots 内且命名合法，否则一律拒绝。 */
  function snapshotPath(id, entry) {
    if (!entry || typeof entry.dir !== 'string' || !SNAPSHOT_DIR_PATTERN.test(entry.dir)) {
      throw new ProjectError('快照目录名非法，拒绝回退', 409, 'SNAPSHOT_PATH_INVALID');
    }
    const base = snapshotsDir(id);
    const resolved = path.resolve(base, entry.dir);
    if (!isInside(base, resolved)) {
      throw new ProjectError('快照目录越界，拒绝回退', 409, 'SNAPSHOT_PATH_INVALID');
    }
    return resolved;
  }

  function manifestPathOf(id, seq) {
    return path.join(snapshotsDir(id), `${String(seq).padStart(3, '0')}.manifest.json`);
  }

  /** 清单缺失/损坏必须报错，绝不回退为 {}（否则会把工作区删空）。 */
  function manifestOf(id, entry) {
    const file = manifestPathOf(id, entry.seq);
    if (!fs.existsSync(file)) {
      throw new ProjectError('快照清单缺失，拒绝回退', 409, 'SNAPSHOT_MANIFEST_MISSING');
    }
    const parsed = readJson(file, null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ProjectError('快照清单损坏，拒绝回退', 409, 'SNAPSHOT_MANIFEST_INVALID');
    }
    if (Object.keys(parsed).length === 0) {
      throw new ProjectError('快照清单为空，拒绝回退', 409, 'SNAPSHOT_MANIFEST_EMPTY');
    }
    return parsed;
  }

  /**
   * 回退前的完整预验证（NEW-02）：目录边界、清单、摘要、实际内容必须全部一致。
   * 任何一项不通过都在「删除/写入之前」抛出。
   */
  function validateSnapshot(id, seq) {
    const entry = listSnapshots(id).find((item) => Number(item.seq) === Number(seq));
    if (!entry) throw new ProjectError(`快照不存在: ${seq}`, 404, 'SNAPSHOT_NOT_FOUND');
    const dir = snapshotPath(id, entry);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new ProjectError('快照目录缺失，拒绝回退', 409, 'SNAPSHOT_DIR_MISSING');
    }
    const manifest = manifestOf(id, entry);
    const digest = digestManifest(manifest);
    if (entry.digest && entry.digest !== digest) {
      throw new ProjectError('快照摘要与清单不一致，拒绝回退', 409, 'SNAPSHOT_DIGEST_MISMATCH');
    }
    if (digestManifest(hashTree(dir)) !== digest) {
      throw new ProjectError('快照内容与清单不一致，拒绝回退', 409, 'SNAPSHOT_CORRUPT');
    }
    return { entry, dir, manifest, digest };
  }

  function snapshot(id, label) {
    return withRegistryLock(() => snapshotInternal(id, label));
  }

  function snapshotInternal(id, label) {
    const record = requireProject(id);
    const state = readJson(snapshotsFile(id), { seq: 0, snapshots: [] });
    const maxSeq = (state.snapshots || []).reduce(
      (max, item) => Math.max(max, Number(item.seq) || 0),
      0,
    );
    const seq = Math.max(Number(state.seq || 0), maxSeq) + 1;
    const dirName = `${String(seq).padStart(3, '0')}-${slugify(label)}`;
    const dir = path.join(snapshotsDir(id), dirName);
    fs.mkdirSync(dir, { recursive: true });

    try {
      const links = findLinks(record.srcDir);
      const { skippedLinks } = copyTree(record.srcDir, dir);
      // 兜底：某些平台 cpSync 会把链接本身复制过去，这里只删链接、不跟随目标
      for (const rel of links) {
        removeLinkOnly(path.join(dir, rel));
      }
      const manifest = hashTree(dir);
      if (Object.keys(manifest).length === 0) {
        throw new Error('snapshot is empty');
      }
      const entry = {
        seq,
        label: label || `snapshot-${seq}`,
        dir: dirName,
        createdAt: new Date().toISOString(),
        fileCount: Object.keys(manifest).length,
        digest: digestManifest(manifest),
        skippedLinks: [...new Set([...(skippedLinks || []), ...links])].slice(0, 20),
      };
      writeJson(manifestPathOf(id, seq), manifest);

      state.seq = seq;
      state.snapshots = (state.snapshots || []).concat(entry);
      if (state.snapshots.length > MAX_SNAPSHOTS) {
        state.snapshots = state.snapshots.slice(-MAX_SNAPSHOTS);
      }
      writeJson(snapshotsFile(id), state);
      return entry;
    } catch (error) {
      // NEW-03：失败时清理半成品目录，避免累积并挤占配额
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(manifestPathOf(id, seq), { force: true });
      throw error;
    }
  }

  function diff(id, fromSeq, to = 'current') {
    const record = requireProject(id);
    const from = listSnapshots(id).find((item) => Number(item.seq) === Number(fromSeq));
    if (!from) throw new ProjectError(`快照不存在: ${fromSeq}`, 404, 'SNAPSHOT_NOT_FOUND');
    const fromDir = snapshotPath(id, from);
    const before = manifestOf(id, from);

    let after;
    let afterDir;
    let toLabel;
    if (to === 'current' || to === null || to === undefined) {
      afterDir = record.srcDir;
      after = hashTree(record.srcDir);
      toLabel = 'current';
    } else {
      const target = listSnapshots(id).find((item) => Number(item.seq) === Number(to));
      if (!target) throw new ProjectError(`快照不存在: ${to}`, 404, 'SNAPSHOT_NOT_FOUND');
      afterDir = snapshotPath(id, target);
      after = manifestOf(id, target);
      toLabel = Number(to);
    }

    const compared = compareManifests(before, after);
    const files = [
      ...compared.added.map((p) => ({ path: p, status: 'added' })),
      ...compared.removed.map((p) => ({ path: p, status: 'removed' })),
      ...compared.modified.map((p) => ({ path: p, status: 'modified' })),
    ];
    const diffResult = unifiedDiff(fromDir, afterDir, files);
    return {
      projectId: id,
      from: Number(fromSeq),
      to: toLabel,
      counts: {
        added: compared.added.length,
        removed: compared.removed.length,
        modified: compared.modified.length,
      },
      files,
      patch: diffResult.patch,
      truncated: diffResult.truncated,
      omitted: diffResult.omitted,
    };
  }

  /**
   * 把一棵已校验的树写入工作区：
   *  - 删除「当前有、目标没有」的文件（只限 manifest 内、非敏感、非排除目录）
   *  - 写回目标树全部文件
   *  - 返回执行后的摘要与是否一致
   */
  function applyTree(id, treeDir, treeManifest) {
    const record = requireProject(id);
    const current = hashTree(record.srcDir);
    const compared = compareManifests(current, treeManifest);
    const removed = [];

    for (const rel of compared.removed) {
      if (isSensitivePath(rel)) continue;
      const full = path.resolve(record.srcDir, rel);
      if (!isInside(record.srcDir, full)) {
        throw new ProjectError('回退路径越界', 500, 'ROLLBACK_PATH_INVALID');
      }
      fs.rmSync(full, { force: true });
      removed.push(rel);
      let parent = path.dirname(full);
      while (isInside(record.srcDir, parent) && parent !== path.resolve(record.srcDir)) {
        try {
          if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
          else break;
        } catch {
          break;
        }
        parent = path.dirname(parent);
      }
    }

    const restored = [];
    for (const rel of Object.keys(treeManifest)) {
      if (isSensitivePath(rel)) continue;
      const from = path.join(treeDir, rel);
      const to = path.resolve(record.srcDir, rel);
      if (!isInside(record.srcDir, to)) {
        throw new ProjectError('回退写入路径越界', 500, 'ROLLBACK_PATH_INVALID');
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      restored.push(rel);
    }

    const digest = digestManifest(hashTree(record.srcDir));
    return {
      removed,
      restored,
      digest,
      equal: digest === digestManifest(treeManifest),
    };
  }

  function journalPathOf(id) {
    return path.join(projectDirOf(id), '.rollback-journal.json');
  }

  /** NEW-02：回退 = 预验证 → 备份 → 暂存目录 → 校验 → 应用 → 失败自动还原。 */
  function rollback(id, seq) {
    return withRegistryLock(() => rollbackUnlocked(id, seq));
  }

  function rollbackUnlocked(id, seq) {
    // 预验证：目录边界 / 清单存在 / 摘要一致 / 内容未被篡改
    const target = validateSnapshot(id, seq);

    // 先备份当前状态，并验证备份可用
    const backup = snapshotInternal(id, `pre-rollback-${target.entry.seq}`);
    const backupTree = validateSnapshot(id, backup.seq);

    const staging = path.join(
      projectDirOf(id),
      `.rollback-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const journal = journalPathOf(id);

    try {
      fs.mkdirSync(staging, { recursive: true });
      copyTree(target.dir, staging);
      if (digestManifest(hashTree(staging)) !== target.digest) {
        throw new ProjectError('暂存恢复目录校验失败，已中止', 500, 'ROLLBACK_STAGE_MISMATCH');
      }

      writeJson(journal, {
        state: 'applying',
        targetSeq: target.entry.seq,
        backupSeq: backup.seq,
        staging,
        startedAt: new Date().toISOString(),
      });

      const applied = applyTree(id, staging, target.manifest);
      if (!applied.equal) {
        throw new ProjectError('回退后完整性校验失败', 500, 'ROLLBACK_VERIFY_FAILED');
      }

      fs.rmSync(journal, { force: true });
      let preview = null;
      try {
        preview = buildPreview(id);
      } catch {
        preview = null;
      }

      return {
        projectId: id,
        restoredSeq: target.entry.seq,
        backupSeq: backup.seq,
        files: { removed: applied.removed, restored: applied.restored },
        verified: true,
        previewReady: Boolean(preview),
        digest: applied.digest,
      };
    } catch (error) {
      // 失败恢复：用刚建立的备份把工作区还原，保证不丢文件
      let recovered = false;
      try {
        const restoredTree = applyTree(id, backupTree.dir, backupTree.manifest);
        recovered = restoredTree.equal;
      } catch {
        recovered = false;
      }
      try {
        buildPreview(id);
      } catch {
        // 忽略
      }
      if (!recovered) {
        // 保留 journal，供服务重启时再次恢复
        throw new ProjectError(
          `回退失败且自动还原未通过校验，请查看 ${journal}`,
          500,
          'ROLLBACK_RECOVERY_FAILED',
        );
      }
      fs.rmSync(journal, { force: true });
      if (error instanceof ProjectError) throw error;
      throw new ProjectError(`回退失败，已从备份 #${backup.seq} 恢复`, 500, 'ROLLBACK_FAILED');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** 服务启动时调用：上次回退中途崩溃，按 journal 用备份还原。 */
  function recoverInterruptedRollbacks() {
    const results = [];
    for (const record of registry.projects) {
      const journal = journalPathOf(record.id);
      if (!fs.existsSync(journal)) continue;
      let info = null;
      try {
        info = readJson(journal, null);
      } catch {
        info = null;
      }
      try {
        if (!info || !info.backupSeq) throw new Error('journal has no backup seq');
        const tree = validateSnapshot(record.id, info.backupSeq);
        const applied = applyTree(record.id, tree.dir, tree.manifest);
        buildPreview(record.id);
        results.push({ id: record.id, recovered: applied.equal, backupSeq: tree.entry.seq });
      } catch (error) {
        results.push({ id: record.id, recovered: false, reason: error.message });
      }
      fs.rmSync(journal, { force: true });
    }
    return results;
  }

  function appendRound(id, round) {
    const memory = readJson(memoryPath(id), { rounds: [] });
    memory.rounds.push({ ...round, at: new Date().toISOString() });
    if (memory.rounds.length > 20) memory.rounds = memory.rounds.slice(-20);
    writeJson(memoryPath(id), memory);
    return memory.rounds.length;
  }

  // ---- 项目锁：同一项目同一时间只允许一个任务写入 ----
  function lockFile(id) {
    return path.join(locksDir, `${id}.lock`);
  }

  function readLock(id) {
    const file = lockFile(id);
    if (!fs.existsSync(file)) return null;
    const info = readJson(file, null);
    if (!info) return null;
    const alive = (() => {
      try {
        process.kill(info.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (!alive) {
      fs.rmSync(file, { force: true });
      return null;
    }
    return info;
  }

  function acquireLock(id, meta = {}) {
    validateProjectId(id);
    const existing = readLock(id);
    if (existing) {
      throw new ProjectError(
        `项目正在被任务 ${existing.taskId || '?'} 占用`,
        409,
        'PROJECT_LOCKED',
      );
    }
    const info = { id, pid: process.pid, taskId: meta.taskId || null, at: new Date().toISOString() };
    fs.writeFileSync(lockFile(id), JSON.stringify(info, null, 2), 'utf-8');
    return info;
  }

  function releaseLock(id) {
    try {
      fs.rmSync(lockFile(id), { force: true });
    } catch {
      // 忽略
    }
  }

  function removeProject(id) {
    return withRegistryLock(() => removeProjectUnlocked(id));
  }

  function removeProjectUnlocked(id) {
    const record = requireProject(id);
    if (record.managed) {
      const dir = projectDirOf(id);
      emptyTree(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    registry.projects = registry.projects.filter((item) => item.id !== id);
    saveRegistry();
    return true;
  }

  return {
    home,
    projectsRoot,
    registryFile,
    runtimeDir,
    list,
    get,
    importProject,
    registerWorkspace,
    detect: detectProject,
    snapshot,
    validateSnapshot,
    recoverInterruptedRollbacks,
    listSnapshots,
    diff,
    rollback,
    previewRoot,
    previewDir: previewDirOf,
    buildPreview,
    memory: (id) => readJson(memoryPath(id), { rounds: [] }),
    appendRound,
    acquireLock,
    releaseLock,
    readLock,
    removeProject,
    digestManifest,
  };
}

module.exports = {
  createProjectRegistry,
  detectProject,
  defaultHome,
  validateProjectId,
  ProjectError,
  digestManifest,
  DEFAULT_EXCLUDES,
};

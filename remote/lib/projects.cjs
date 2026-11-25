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
  hashTree,
  compareManifests,
  copyTree,
  emptyTree,
  unifiedDiff,
  walkFiles,
} = require('./paths.cjs');

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_SNAPSHOTS = 50;

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

  function importProject({ sourceDir, id, name, entry }) {
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

    // 1) 导入前哈希原始工程
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
      },
    });
    writeJson(memoryPath(id), { rounds: [] });
    writeJson(snapshotsFile(id), { seq: 0, snapshots: [] });

    // 5) 初始快照 = 导入时的状态，可随时回退
    const initial = snapshot(id, 'initial');

    return {
      project: get(id),
      import: {
        fileCount: Object.keys(before).length,
        hashDigest: beforeDigest,
        originalUnchanged: afterDigest === beforeDigest,
        initialSnapshot: initial.seq,
      },
    };
  }

  /** Create Mode：直接以现有工作区注册一个受控项目（不复制）。 */
  function registerWorkspace({ id = 'default', name = 'Create Mode workspace', workspaceDir, entry }) {
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

  function previewRoot(id) {
    const record = requireProject(id);
    const kind = record.kind;
    if (kind === 'vite') {
      const dist = path.join(record.srcDir, 'dist');
      if (fs.existsSync(path.join(dist, 'index.html'))) return dist;
      return null;
    }
    const entryDir = path.dirname(record.entry || 'index.html');
    const root = entryDir === '.' ? record.srcDir : path.join(record.srcDir, entryDir);
    return fs.existsSync(root) ? root : null;
  }

  function listSnapshots(id) {
    return readJson(snapshotsFile(id), { snapshots: [] }).snapshots || [];
  }

  function snapshotPath(id, entry) {
    return path.join(snapshotsDir(id), entry.dir);
  }

  function snapshot(id, label) {
    const record = requireProject(id);
    const state = readJson(snapshotsFile(id), { seq: 0, snapshots: [] });
    const seq = Number(state.seq || 0) + 1;
    const dirName = `${String(seq).padStart(3, '0')}-${slugify(label)}`;
    const dir = path.join(snapshotsDir(id), dirName);
    fs.mkdirSync(dir, { recursive: true });

    copyTree(record.srcDir, dir);
    const manifest = hashTree(dir);
    const entry = {
      seq,
      label: label || `snapshot-${seq}`,
      dir: dirName,
      createdAt: new Date().toISOString(),
      fileCount: Object.keys(manifest).length,
      digest: digestManifest(manifest),
    };
    writeJson(path.join(snapshotsDir(id), `${String(seq).padStart(3, '0')}.manifest.json`), manifest);

    state.seq = seq;
    state.snapshots.push(entry);
    if (state.snapshots.length > MAX_SNAPSHOTS) state.snapshots = state.snapshots.slice(-MAX_SNAPSHOTS);
    writeJson(snapshotsFile(id), state);
    return entry;
  }

  function requireSnapshot(id, seq) {
    const found = listSnapshots(id).find((item) => Number(item.seq) === Number(seq));
    if (!found) throw new ProjectError(`快照不存在: ${seq}`, 404, 'SNAPSHOT_NOT_FOUND');
    return found;
  }

  function manifestOf(id, entry) {
    const file = path.join(snapshotsDir(id), `${String(entry.seq).padStart(3, '0')}.manifest.json`);
    return readJson(file, {});
  }

  function diff(id, fromSeq, to = 'current') {
    const record = requireProject(id);
    const from = requireSnapshot(id, fromSeq);
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
      const target = requireSnapshot(id, to);
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
   * 回退到指定快照：
   *  - 先备份当前状态（pre-rollback-*）
   *  - 恢复新增/修改/删除全部文件
   *  - 回退后哈希必须与目标快照一致
   *  - 不使用 git reset --hard / git clean -fd
   */
  function rollback(id, seq) {
    const record = requireProject(id);
    const target = requireSnapshot(id, seq);
    const targetManifest = manifestOf(id, target);
    const targetDir = snapshotPath(id, target);

    const backup = snapshot(id, `pre-rollback-${target.seq}`);

    const current = hashTree(record.srcDir);
    const compared = compareManifests(current, targetManifest);

    // 删除「目标里没有」的文件
    for (const rel of compared.removed) {
      const full = path.resolve(record.srcDir, rel);
      if (!isInside(record.srcDir, full)) continue;
      fs.rmSync(full, { recursive: false, force: true });
      // 清理空目录（不越过工作区）
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

    // 写回目标快照中的所有文件
    for (const rel of Object.keys(targetManifest)) {
      const from = path.join(targetDir, rel);
      const to = path.resolve(record.srcDir, rel);
      if (!isInside(record.srcDir, to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }

    const restored = hashTree(record.srcDir);
    const verified = digestManifest(restored) === digestManifest(targetManifest);

    return {
      projectId: id,
      restoredSeq: Number(seq),
      backupSeq: backup.seq,
      files: {
        removed: compared.removed,
        restored: compared.added.concat(compared.modified),
      },
      verified,
      digest: digestManifest(restored),
    };
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
    listSnapshots,
    diff,
    rollback,
    previewRoot,
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

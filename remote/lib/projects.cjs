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
const { spawnSync, spawn } = require('child_process');

const {
  DEFAULT_EXCLUDES,
  isInside,
  isSensitivePath,
  hashTree,
  compareManifests,
  copyTree,
  copyPreviewTreeStaged,
  previewManifestOf,
  emptyTree,
  unifiedDiff,
  walkFiles,
} = require('./paths.cjs');

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const SNAPSHOT_DIR_PATTERN = /^\d{3,}-[a-z0-9-]+$/;
const MAX_SNAPSHOTS = 200;
const LOCK_TIMEOUT_MS = 20000;
const LOCK_RETRY_MS = 15;
const LOCK_HARD_TTL_MS = 5 * 60 * 1000;
const LOCK_EMPTY_GRACE_MS = 5000;

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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 终止整个构建进程树（异步构建超时/回退失败时使用）。 */
function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出
    }
  }
}

function readLockInfo(file) {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseLockRaw(raw) {
  if (!raw || !String(raw).trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 观察锁文件（两次读取 + stat）。
 *
 * B10 / C09 B-01 关键修复：**绝不允许把「读不到 / 刚创建还没写入」判为陈旧**。
 * 只有同时满足下列之一才允许回收：
 *  - 读到完整内容，且持有者 pid 不存在，或超过 5 分钟硬上限；
 *  - 文件确实存在，两次读取内容完全一致，且「空文件持续 >5s」或「损坏内容持续 >5min」。
 */
function observeLock(file) {
  const now = () => Date.now();
  const started = now();
  let firstRaw = null;
  let firstStat = null;
  try {
    firstRaw = fs.readFileSync(file, 'utf-8');
    firstStat = fs.statSync(file);
  } catch {
    firstStat = null;
  }
  sleepSync(20);
  let secondRaw = null;
  let secondStat = null;
  try {
    secondRaw = fs.readFileSync(file, 'utf-8');
    secondStat = fs.statSync(file);
  } catch {
    secondStat = null;
  }
  const info = secondStat ? parseLockRaw(secondRaw) : null;
  const stableSame =
    Boolean(firstStat && secondStat) && String(firstRaw) === String(secondRaw);
  const empty = !String(secondRaw || '').trim();
  const stat = secondStat || firstStat;
  const fileAgeMs = stat ? now() - stat.mtimeMs : Infinity;
  const ageMs = info ? now() - Number(info.at || 0) : Infinity;
  return {
    observedAt: started,
    exists: Boolean(stat),
    info,
    stableSame,
    empty,
    fileAgeMs,
    ageMs,
  };
}

/**
 * 跨进程互斥（NEW-C04-02）。
 * 同一 VPLAY_HOME 下的所有写入方（CLI / server / 脚本）都走这里。
 */
function withHomeLock(home, fn, options = {}) {
  const timeoutMs = Number(options.timeoutMs || LOCK_TIMEOUT_MS);
  const dir = path.join(home, '.opengame');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'registry.lock');
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const payload = JSON.stringify({ pid: process.pid, token, at: Date.now() });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      // Windows 并发删除/改名锁文件会抛 EPERM/EACCES，一律按竞争处理
      if (!['EEXIST', 'EPERM', 'EACCES', 'ENOENT', 'EBUSY'].includes(error.code)) {
        throw error;
      }

      const observed = observeLock(file);
      const info = observed.info;
      let stale = false;
      if (info) {
        const pid = Number(info.pid);
        if (!Number.isFinite(pid) || pid <= 0) {
          // 损坏的 pid：只有文件稳定存在够久才回收
          stale = observed.stableSame && observed.fileAgeMs > LOCK_EMPTY_GRACE_MS;
        } else if (!pidAlive(pid)) {
          stale = true; // 持有者已退出（含 SIGKILL）
        } else if (observed.ageMs > LOCK_HARD_TTL_MS) {
          stale = true; // 唯一允许的「活进程超时」回收：5 分钟硬上限
        }
      } else if (observed.exists && observed.stableSame) {
        // 空文件：刚打开还没写完，必须等够宽限期；损坏内容只有在硬上限后才回收
        if (observed.empty && observed.fileAgeMs > LOCK_EMPTY_GRACE_MS) stale = true;
        else if (!observed.empty && observed.fileAgeMs > LOCK_HARD_TTL_MS) stale = true;
      }
      // 读不到（ENOENT）或内容不稳定：一律只重试，绝不回收

      if (process.env.VPLAY_LOCK_DEBUG === '1') {
        try {
          fs.appendFileSync(
            path.join(dir, 'lock-debug.log'),
            `${JSON.stringify({
              at: Date.now(),
              pid: process.pid,
              observed,
              stale,
              code: error.code,
            })}\n`,
          );
        } catch {
          // 忽略
        }
      }

      if (stale) {
        // 原子抢占：rename 到唯一 stale 名，再按「观察到的 token」逐字校验
        const trash = `${file}.stale-${token}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          fs.renameSync(file, trash);
        } catch (renameError) {
          if (!['ENOENT', 'EPERM', 'EACCES'].includes(renameError.code)) throw renameError;
          continue;
        }
        const moved = readLockInfo(trash);
        const movedToken = moved ? String(moved.token || '') : '';
        const observedToken = info ? String(info.token || '') : '';
        const matchesObserved = info ? Boolean(moved) && movedToken === observedToken : !moved;
        const stillStale = !moved
          ? true
          : !Number.isFinite(Number(moved.pid)) ||
            !pidAlive(Number(moved.pid)) ||
            Date.now() - Number(moved.at || 0) > LOCK_HARD_TTL_MS;
        if (!matchesObserved || !stillStale) {
          // 误抢活锁 / 内容在观察后被替换：绝不删除，尽量放回原处
          try {
            if (!fs.existsSync(file)) fs.renameSync(trash, file);
          } catch {
            // 放回失败时保留 trash 文件，交给人工处理
          }
          sleepSync(LOCK_RETRY_MS + Math.floor(Math.random() * 15));
          continue;
        }
        try {
          fs.rmSync(trash, { force: true });
        } catch {
          // 忽略
        }
        continue;
      }

      if (Date.now() > deadline) {
        throw new ProjectError('registry is busy', 409, 'REGISTRY_LOCKED');
      }
      sleepSync(LOCK_RETRY_MS + Math.floor(Math.random() * 15));
    }
  }

  try {
    return fn();
  } finally {
    // 只释放自己持有的锁；被他人回收/替换时绝不删除
    const info = readLockInfo(file);
    if (info && info.token === token) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          fs.rmSync(file, { force: true });
          break;
        } catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) break;
          sleepSync(10 + Math.floor(Math.random() * 15));
        }
      }
    }
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
  // 原子写：随机临时名避免多进程撞名；rename 在 Windows 上遇 EPERM 重试
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // 忽略
        }
        throw error;
      }
      sleepSync(10 + Math.floor(Math.random() * 20));
    }
  }
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
   * 注册表 / 快照 / 回退的统一互斥锁（NEW-06 / NEW-C04-02）。
   *
   * 设计要点：
   *  - EPERM/EACCES/ENOENT/EBUSY 都视为「抢锁失败」，退避重试，绝不上抛；
   *  - 陈旧判定必须「连续两次读到同一 owner」且 pid 已死/超硬上限，避免 TOCTOU；
   *  - 回收用 rename 抢占到唯一 stale 名，再校验归属：若误抢活锁则尝试放回；
   *  - 释放前核对 token，只删自己持有的锁；
   *  - 所有跨进程写操作（CLI 与 server）都只能经由此锁。
   */
  function withRegistryLock(fn, options = {}) {
    return withHomeLock(home, fn, options);
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

    // 6) 预热预览（失败不影响导入；GET 不再按需构建）
    //    Vite：导入时若已有 dist，视为「与当前源码对应的首次构建」，写入构建摘要；
    //    之后任何源码修改都必须重新构建才能再次发布（B10 / C09 B-03）。
    if (record.kind === 'vite' && fs.existsSync(path.join(srcDir, 'dist', 'index.html'))) {
      writeBuildStamp(record, '(imported dist)');
    }
    try {
      buildPreview(id);
    } catch {
      // 忽略
    }

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

  /** 构建命令与最小环境（只传系统必需变量，不传任何模型 Key）。 */
  function buildSpec(record) {
    const detected = (record.profile && record.profile.detected) || {};
    const command = detected.buildCommand || 'npm run build';
    const env = {};
    for (const key of [
      'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec',
      'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
      'NODE_ENV', 'LANG', 'LC_ALL',
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const nodeDir = path.dirname(process.execPath);
    env.PATH = `${nodeDir}${path.delimiter}${env.PATH || env.Path || ''}`;
    if (process.platform === 'win32') env.Path = env.PATH;
    const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    return { command, env, shell, args };
  }

  /** 同步构建（仅用于启动期恢复等不可并发的路径）。 */
  function buildProject(record) {
    const spec = buildSpec(record);
    const result = spawnSync(spec.shell, spec.args, {
      cwd: record.srcDir,
      env: spec.env,
      timeout: 5 * 60 * 1000,
      windowsHide: true,
      encoding: 'utf-8',
    });
    if (result.status === 0) writeBuildStamp(record, spec.command);
    return {
      ok: result.status === 0,
      status: result.status,
      command: spec.command,
      stderr: String(result.stderr || '').slice(-4000),
    };
  }

  /**
   * 异步构建（B10 / C09 B-04）：spawn 不阻塞事件循环，
   * 回退/ Vision 构建期间 SSE 心跳与其它 HTTP 请求仍可响应。
   */
  function buildProjectAsync(record, options = {}) {
    const spec = buildSpec(record);
    const timeoutMs = Number(options.timeoutMs || 5 * 60 * 1000);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(spec.shell, spec.args, {
          cwd: record.srcDir,
          env: spec.env,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error) {
        resolve({ ok: false, status: null, command: spec.command, stderr: String(error.message) });
        return;
      }
      let stderr = '';
      let timedOut = false;
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-8000);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, status: null, command: spec.command, stderr: String(error.message) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (!timedOut && code === 0) writeBuildStamp(record, spec.command);
        resolve({
          ok: !timedOut && code === 0,
          status: code,
          command: spec.command,
          timedOut,
          stderr: stderr.slice(-4000),
        });
      });
    });
  }

  /** 源码输入摘要：可预览文件集合，Vite 排除 dist（绑定「产物 ← 源码」）。 */
  function sourceInputManifest(record) {
    return previewManifestOf(record.srcDir, {
      excludeDirs: new Set(['dist', '.preview', '.snapshots']),
    });
  }

  function currentSrcDigest(record) {
    return digestManifest(sourceInputManifest(record).files);
  }

  function buildStampPath(id) {
    return path.join(projectDirOf(id), '.build-stamp.json');
  }

  /** Vite 构建成功后记录「构建输入摘要」；发布时要求摘要仍与当前源码一致。 */
  function writeBuildStamp(record, command) {
    try {
      writeJson(buildStampPath(record.id), {
        srcDigest: currentSrcDigest(record),
        command,
        at: new Date().toISOString(),
      });
    } catch {
      // 摘要写入失败会导致后续发布被拒绝（更安全）
    }
  }

  /**
   * 全量预览新鲜度校验（C07-P1-06 / ORD-11 / B10 B-03）：
   *  - 发布清单中每个文件必须存在，且预览哈希 == 清单哈希 == 当前产物哈希；
   *  - manifest.srcDigest 必须等于当前源码输入摘要（Vite 改源码未构建 ⇒ 失败）；
   *  - manifest.buildDigest 必须等于当前构建产物（dist / static src）的可预览摘要。
   */
  function verifyPreview(id, record = requireProject(id)) {
    const source = previewSourceDir(record);
    if (!source) return { ok: false, reason: 'SOURCE_MISSING', mismatches: [] };
    const manifest = readJson(path.join(projectDirOf(id), '.publish-manifest.json'), null);
    if (!manifest || !manifest.files || typeof manifest.files !== 'object') {
      return { ok: false, reason: 'MANIFEST_MISSING', mismatches: [] };
    }
    const dest = previewDirOf(id);
    const mismatches = [];

    if (manifest.srcDigest) {
      const actual = digestManifest(sourceInputManifest(record).files);
      if (actual !== manifest.srcDigest) {
        mismatches.push({ rel: '<src>', reason: 'src-digest-mismatch' });
      }
    } else {
      mismatches.push({ rel: '<src>', reason: 'src-digest-missing' });
    }

    if (manifest.buildDigest) {
      const actual = digestManifest(previewManifestOf(source).files);
      if (actual !== manifest.buildDigest) {
        mismatches.push({ rel: '<build>', reason: 'build-digest-mismatch' });
      }
    } else {
      mismatches.push({ rel: '<build>', reason: 'build-digest-missing' });
    }

    for (const [rel, hash] of Object.entries(manifest.files)) {
      const published = path.join(dest, rel);
      const sourceFile = path.join(source, rel);
      if (!fs.existsSync(published)) {
        mismatches.push({ rel, reason: 'preview-missing' });
        continue;
      }
      if (!fs.existsSync(sourceFile)) {
        mismatches.push({ rel, reason: 'source-missing' });
        continue;
      }
      const publishedHash = crypto.createHash('sha256').update(fs.readFileSync(published)).digest('hex');
      const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
      if (publishedHash !== hash) {
        mismatches.push({ rel, reason: 'preview-hash', expected: hash, actual: publishedHash });
      }
      if (publishedHash !== sourceHash) {
        mismatches.push({ rel, reason: 'source-preview-mismatch' });
      }
    }
    const entryRel = record.kind === 'vite' ? 'index.html' : record.entry || 'index.html';
    if (!fs.existsSync(path.join(dest, entryRel))) {
      mismatches.push({ rel: entryRel, reason: 'entry-missing' });
    }
    return {
      ok: mismatches.length === 0,
      reason: mismatches.length ? 'MISMATCH' : 'OK',
      mismatches: mismatches.slice(0, 50),
      checked: Object.keys(manifest.files).length,
    };
  }

  /**
   * 生成独立预览产物目录（P0-1/P0-3 / C09 B-02）：
   *  1) 只构建到 staging，不切换；
   *  2) 在 staging 内完成全量哈希校验 + 入口存在 + 清单写入临时文件；
   *  3) 校验通过才原子切换预览目录与 manifest；
   *  4) 切换后再次全量校验；任一失败恢复旧版本并返回 null。
   * 预览面只读 .preview，永远不直接读 src。
   */
  function buildPreview(id) {
    const record = requireProject(id);
    const dest = previewDirOf(id);
    const source = previewSourceDir(record);
    if (!source) return null;
    const manifestFile = path.join(projectDirOf(id), '.publish-manifest.json');
    let previousManifestRaw = null;
    try {
      previousManifestRaw = fs.readFileSync(manifestFile, 'utf-8');
    } catch {
      previousManifestRaw = null;
    }

    // B10 / C09 B-03：Vite 只有「当前源码摘要 == 最近一次成功构建的输入摘要」才允许发布
    const srcDigest = currentSrcDigest(record);
    if (record.kind === 'vite') {
      const stamp = readJson(buildStampPath(id), null);
      if (!stamp || stamp.srcDigest !== srcDigest) {
        try {
          writeJson(path.join(projectDirOf(id), '.preview-stale.json'), {
            at: new Date().toISOString(),
            reason: 'BUILD_STALE',
            detail: 'source changed since last successful build; run build before publishing',
          });
        } catch {
          // 忽略
        }
        return null;
      }
    }

    let staged;
    try {
      staged = copyPreviewTreeStaged(source, dest);
    } catch {
      return null;
    }

    try {
      const expected = staged.manifest.files;
      const entryRel = record.kind === 'vite' ? 'index.html' : record.entry || 'index.html';
      if (Object.keys(expected).length === 0) throw new Error('PREVIEW_EMPTY');
      const stagedEntry = path.join(staged.stagedDir, entryRel);
      if (!fs.existsSync(stagedEntry) || !fs.statSync(stagedEntry).isFile()) {
        throw new Error('PREVIEW_ENTRY_MISSING');
      }
      // staging 全量校验：重新哈希 staging 目录，必须与清单逐文件一致
      const stagedCheck = previewManifestOf(staged.stagedDir);
      if (
        Object.keys(stagedCheck.files).length !== Object.keys(expected).length ||
        digestManifest(stagedCheck.files) !== digestManifest(expected)
      ) {
        throw new Error('PREVIEW_STAGE_HASH_MISMATCH');
      }

      const newManifest = {
        projectId: id,
        generatedAt: new Date().toISOString(),
        published: staged.copied,
        skipped: staged.skipped,
        files: expected,
        entry: entryRel,
        srcDigest,
        buildDigest: digestManifest(expected),
      };
      const tmpManifest = `${manifestFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
      fs.writeFileSync(tmpManifest, JSON.stringify(newManifest, null, 2), 'utf-8');

      // 原子切换预览目录，再原子替换 manifest
      staged.commit();
      for (let attempt = 0; ; attempt += 1) {
        try {
          fs.renameSync(tmpManifest, manifestFile);
          break;
        } catch (error) {
          if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
          sleepSync(10 + Math.floor(Math.random() * 20));
        }
      }

      const check = verifyPreview(id, record);
      if (!check.ok) {
        throw new ProjectError(
          `preview verify failed: ${check.reason}`,
          500,
          'PREVIEW_VERIFY_FAILED',
        );
      }
      staged.finalize();
      try {
        fs.rmSync(path.join(projectDirOf(id), '.preview-stale.json'), { force: true });
      } catch {
        // 忽略
      }
      return previewRootPath(record, dest);
    } catch (error) {
      // 失败不发布：恢复旧预览与旧 manifest
      try {
        staged.restore();
      } catch {
        // 忽略
      }
      try {
        if (previousManifestRaw === null) fs.rmSync(manifestFile, { force: true });
        else fs.writeFileSync(manifestFile, previousManifestRaw, 'utf-8');
      } catch {
        // 忽略
      }
      try {
        writeJson(path.join(projectDirOf(id), '.preview-stale.json'), {
          at: new Date().toISOString(),
          reason: error.code || 'PREVIEW_PUBLISH_FAILED',
          detail: error.message,
        });
      } catch {
        // 证据写入失败不影响返回
      }
      return null;
    }
  }

  /**
   * 读取现有预览；C07-P1-01：GET 不触发构建。
   * B10：入口哈希必须与 manifest 一致，否则视为不可用（防止发布后目录被篡改）。
   */
  function previewRoot(id) {
    const record = requireProject(id);
    const dest = previewDirOf(id);
    const entryRel = record.kind === 'vite' ? 'index.html' : record.entry || 'index.html';
    const entryFile = path.join(dest, entryRel);
    if (!fs.existsSync(entryFile) || !fs.statSync(entryFile).isFile()) return null;
    const manifest = readJson(path.join(projectDirOf(id), '.publish-manifest.json'), null);
    if (!manifest || !manifest.files || !manifest.files[entryRel]) return null;
    const actual = crypto.createHash('sha256').update(fs.readFileSync(entryFile)).digest('hex');
    if (actual !== manifest.files[entryRel]) return null;
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

  /** 清单按 uid 命名：全局唯一，不会因序号竞争而互相覆盖。 */
  function manifestFile(id, entry) {
    if (entry && entry.uid) {
      return path.join(snapshotsDir(id), `${entry.uid}.manifest.json`);
    }
    return manifestPathOf(id, entry ? entry.seq : 0);
  }

  /** 清单缺失/损坏必须报错，绝不回退为 {}（否则会把工作区删空）。 */
  function manifestOf(id, entry) {
    const candidates = [manifestFile(id, entry)];
    if (!entry.uid) candidates.push(manifestPathOf(id, entry.seq));
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    if (!file) {
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
  function validateSnapshot(id, ref) {
    const entries = listSnapshots(id);
    const byUid = typeof ref === 'string';
    const entry = byUid
      ? entries.find((item) => item.uid === ref)
      : entries.find((item) => Number(item.seq) === Number(ref));
    if (!entry) {
      if (byUid) {
        // 本次写入已被并发覆盖：必须让调用方重试，绝不能报告成功
        throw new ProjectError('snapshot entry lost during write', 409, 'LOCK_LOST');
      }
      throw new ProjectError(`快照不存在: ${ref}`, 404, 'SNAPSHOT_NOT_FOUND');
    }
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
    let lastError = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return withRegistryLock(() => snapshotInternal(id, label));
      } catch (error) {
        lastError = error;
        if (error.code !== 'LOCK_LOST' && error.code !== 'EEXIST') throw error;
      }
    }
    throw lastError || new ProjectError('snapshot failed', 500, 'SNAPSHOT_FAILED');
  }

  function snapshotInternal(id, label) {
    const record = requireProject(id);
    fs.mkdirSync(snapshotsDir(id), { recursive: true });

    let state;
    let seq;
    let dir;
    let dirName;
    let maxDirSeq = 0;
    try {
      for (const item of fs.readdirSync(snapshotsDir(id), { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        const match = /^(\d{3,})-/.exec(item.name);
        if (match) maxDirSeq = Math.max(maxDirSeq, Number(match[1]));
      }
    } catch {
      maxDirSeq = 0;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      state = readJson(snapshotsFile(id), { seq: 0, snapshots: [] });
      const maxSeq = (state.snapshots || []).reduce(
        (max, item) => Math.max(max, Number(item.seq) || 0),
        0,
      );
      seq = Math.max(Number(state.seq || 0), maxSeq, maxDirSeq) + 1;
      dirName = `${String(seq).padStart(3, '0')}-${slugify(label)}`;
      dir = path.join(snapshotsDir(id), dirName);
      try {
        // 非递归创建：同名目录已存在说明序号冲突，必须重新分配而不是覆盖
        fs.mkdirSync(dir);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt === 4) throw error;
        maxDirSeq = Math.max(maxDirSeq, seq);
      }
    }

    let entry = null;
    try {
      const links = findLinks(record.srcDir);
      copyTree(record.srcDir, dir);
      // 兜底：某些平台 cpSync 会把链接本身复制过去，这里只删链接、不跟随目标
      for (const rel of links) {
        removeLinkOnly(path.join(dir, rel));
      }
      const manifest = hashTree(dir);
      if (Object.keys(manifest).length === 0) {
        throw new Error('snapshot is empty');
      }
      const entryData = {
        seq,
        uid: `${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
        label: label || `snapshot-${seq}`,
        dir: dirName,
        createdAt: new Date().toISOString(),
        fileCount: Object.keys(manifest).length,
        digest: digestManifest(manifest),
        skippedLinks: links.slice(0, 20),
      };
      entry = entryData;
      writeJson(manifestFile(id, entry), manifest);

      // OCC 合并写：写入前重读注册表并合并，写后核对 uid。
      // 即使跨进程临界区短暂重叠，也不会静默丢条目或产生「虚假成功」。
      let persisted = false;
      for (let round = 0; round < 8 && !persisted; round += 1) {
        const current = readJson(snapshotsFile(id), { seq: 0, snapshots: [] });
        const existing = current.snapshots || [];
        if (existing.some((item) => item.uid === entry.uid)) {
          persisted = true;
          break;
        }
        const used = new Set(existing.map((item) => Number(item.seq)));
        if (used.has(Number(entry.seq))) {
          // 序号被并发占用：换号并同步改名目录与清单
          const next = Math.max(Number(current.seq) || 0, ...[...used], 0) + 1;
          const nextName = `${String(next).padStart(3, '0')}-${slugify(label)}`;
          try {
            fs.renameSync(
              path.join(snapshotsDir(id), entry.dir),
              path.join(snapshotsDir(id), nextName),
            );
            entry.seq = next;
            entry.dir = nextName;
            seq = next;
            dir = path.join(snapshotsDir(id), nextName);
          } catch {
            sleepSync(10 + Math.floor(Math.random() * 20));
            continue;
          }
        }
        const merged = existing.concat(entry);
        if (merged.length > MAX_SNAPSHOTS) {
          const dropped = merged.splice(0, merged.length - MAX_SNAPSHOTS);
          for (const item of dropped) {
            fs.rmSync(path.join(snapshotsDir(id), item.dir), { recursive: true, force: true });
            fs.rmSync(manifestFile(id, item), { force: true });
          }
        }
        writeJson(snapshotsFile(id), {
          seq: Math.max(Number(current.seq) || 0, entry.seq),
          snapshots: merged,
        });
        const check = readJson(snapshotsFile(id), { snapshots: [] });
        persisted = (check.snapshots || []).some((item) => item.uid === entry.uid);
        if (persisted) {
          // 二次确认：给并发写入者一个落盘窗口，防止「我先验证、随后被覆盖」
          sleepSync(20 + Math.floor(Math.random() * 20));
          const confirm = readJson(snapshotsFile(id), { snapshots: [] });
          persisted = (confirm.snapshots || []).some((item) => item.uid === entry.uid);
        }
        if (!persisted) sleepSync(10 + Math.floor(Math.random() * 20));
      }
      if (!persisted) {
        throw new ProjectError('registry update lost, retrying', 409, 'LOCK_LOST');
      }

      validateSnapshot(id, entry.uid);
      return entry;
    } catch (error) {
      // NEW-03：失败时清理半成品目录，避免累积并挤占配额
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(manifestFile(id, entry || { seq }), { force: true });
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

  /**
   * NEW-02 / B10 / C09 B-04：回退 = 预验证 → 备份 → 暂存 → 校验 → 应用 → 失败自动还原。
   *
   * 锁语义：
   *  - 默认自行获取**项目锁**，覆盖重建、验证、发布全过程；与任务/其它回退互斥；
   *  - 调用方（worker / Vision）已持锁时传 `lockToken`，宿主只校验 token，不重复加锁；
   *  - 构建使用异步 spawn，回退期间事件循环不被阻塞（SSE 心跳可用）。
   */
  async function rollback(id, seq, options = {}) {
    const providedToken = options.lockToken || null;
    if (providedToken) {
      const current = readLock(id);
      if (!current || current.token !== providedToken) {
        throw new ProjectError('回退需要持有当前项目锁', 409, 'PROJECT_LOCKED');
      }
      return rollbackLocked(id, seq);
    }
    const lock = acquireLock(id, { taskId: options.taskId || `rollback-${seq}` });
    try {
      return await rollbackLocked(id, seq);
    } finally {
      releaseLock(id, lock.token);
    }
  }

  async function rollbackLocked(id, seq) {
    // 预验证：目录边界 / 清单存在 / 摘要一致 / 内容未被篡改
    const target = validateSnapshot(id, seq);

    // 先备份当前状态，并验证备份可用（通过 registry 锁，避免与并发快照互相覆盖）
    const backup = snapshot(id, `pre-rollback-${target.entry.seq}`);
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

      // C07-P0-04：Vite 回退后必须重新构建，不能用回退前的旧 dist
      const record = requireProject(id);
      let build = null;
      if (record.kind === 'vite') {
        build = await buildProjectAsync(record);
        if (!build.ok) {
          throw new ProjectError(
            `回退后构建失败（${build.command}，exit=${build.status}）`,
            500,
            'ROLLBACK_BUILD_FAILED',
          );
        }
      }

      const preview = buildPreview(id);
      const previewCheck = verifyPreview(id, record);
      if (!preview || !previewCheck.ok) {
        throw new ProjectError(
          `回退后预览校验失败（${previewCheck.reason}）`,
          500,
          'ROLLBACK_PREVIEW_MISMATCH',
        );
      }

      // 全部校验通过后才删除 journal（OBS-C04-01）
      fs.rmSync(journal, { force: true });

      return {
        projectId: id,
        restoredSeq: target.entry.seq,
        backupSeq: backup.seq,
        files: { removed: applied.removed, restored: applied.restored },
        verified: true,
        previewReady: true,
        digest: applied.digest,
        build: build ? { ok: build.ok, command: build.command } : null,
        previewChecked: previewCheck.checked,
      };
    } catch (error) {
      // 失败恢复：用刚建立的备份把工作区还原，保证不丢文件
      let recovered = false;
      try {
        const restoredTree = applyTree(id, backupTree.dir, backupTree.manifest);
        recovered = restoredTree.equal;
        if (recovered) {
          // 若回退过程中已重建 dist，必须按还原后的源码再构建一次
          const current = requireProject(id);
          if (current.kind === 'vite') {
            const rebuilt = await buildProjectAsync(current);
            if (!rebuilt.ok) recovered = false;
          }
          buildPreview(id);
        }
      } catch {
        recovered = false;
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

  function appendRecoveryEvidence(id, payload) {
    try {
      fs.appendFileSync(
        path.join(projectDirOf(id), '.rollback-recovery.log'),
        `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`,
        'utf-8',
      );
    } catch {
      // 证据写入失败不影响主流程
    }
  }

  /**
   * 服务启动时调用：上次回退中途崩溃，按 journal 用备份还原。
   * OBS-C04-01：只有「完整校验通过」才删除 journal；失败则保留 journal 并留证据，
   * 以便下一次启动继续重试。
   */
  function recoverInterruptedRollbacks() {
    return withRegistryLock(() => {
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
          if (!applied.equal) {
            throw new Error('recovered tree does not match backup digest');
          }
          // B10：崩溃恢复后 Vite 必须按恢复后的源码重建，避免发布陈旧 dist
          if (record.kind === 'vite') {
            const rebuilt = buildProject(record);
            if (!rebuilt.ok) throw new Error(`rebuild failed: ${rebuilt.command} exit=${rebuilt.status}`);
          }
          buildPreview(record.id);
          fs.rmSync(journal, { force: true });
          results.push({
            id: record.id,
            recovered: true,
            backupSeq: tree.entry.seq,
            journalKept: false,
          });
        } catch (error) {
          // 保留 journal + 证据，下一次启动继续尝试
          appendRecoveryEvidence(record.id, {
            event: 'rollback-recovery-failed',
            backupSeq: info && info.backupSeq ? info.backupSeq : null,
            reason: error.message,
            journalKept: true,
          });
          results.push({
            id: record.id,
            recovered: false,
            reason: error.message,
            journalKept: true,
          });
        }
      }
      return results;
    });
  }

  /**
   * 启动时隔离未登记的孤儿快照目录（NEW-C04-02 验收项：无孤儿目录）。
   * 不删除数据，只移动到 <project>/.snapshot-orphans/ 便于人工处理。
   */
  function recoverOrphanSnapshots() {
    return withRegistryLock(() => {
      const results = [];
      for (const record of registry.projects) {
        const base = snapshotsDir(record.id);
        if (!fs.existsSync(base)) continue;
        const state = readJson(snapshotsFile(record.id), { snapshots: [] });
        const known = new Set((state.snapshots || []).map((item) => item.dir));
        let entries = [];
        try {
          entries = fs.readdirSync(base, { withFileTypes: true });
        } catch {
          continue;
        }
        const orphans = entries
          .filter((item) => item.isDirectory() && !known.has(item.name))
          .map((item) => item.name);
        if (orphans.length === 0) continue;
        const trashDir = path.join(projectDirOf(record.id), '.snapshot-orphans');
        fs.mkdirSync(trashDir, { recursive: true });
        for (const name of orphans) {
          try {
            fs.renameSync(
              path.join(base, name),
              path.join(trashDir, `${name}-${Date.now()}`),
            );
          } catch {
            // 单个目录移动失败不影响其他
          }
        }
        appendRecoveryEvidence(record.id, {
          event: 'orphan-snapshots-quarantined',
          dirs: orphans,
        });
        results.push({ id: record.id, quarantined: orphans });
      }
      return results;
    });
  }

  function appendRound(id, round) {
    const memory = readJson(memoryPath(id), { rounds: [] });
    memory.rounds.push({ ...round, at: new Date().toISOString() });
    if (memory.rounds.length > 20) memory.rounds = memory.rounds.slice(-20);
    writeJson(memoryPath(id), memory);
    return memory.rounds.length;
  }

  // ---- 项目锁：原子抢锁 + owner token + 崩溃恢复（C07-P0-03）----
  const PROJECT_LOCK_TTL_MS = 10 * 60 * 1000;

  function lockFile(id) {
    return path.join(locksDir, `${id}.lock`);
  }

  function lockInfoOf(file) {
    return readJson(file, null);
  }

  function lockAgeMs(info) {
    const stamp = info && (info.heartbeatAt || info.at);
    const parsed = stamp ? Date.parse(stamp) : NaN;
    return Number.isFinite(parsed) ? Date.now() - parsed : Infinity;
  }

  /** 只在「持有者已死」或「超过硬 TTL」时隔离锁；隔离后复核归属，避免误删活锁。 */
  function quarantineLock(file) {
    const trash = `${file}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(file, trash);
    } catch {
      return;
    }
    const moved = lockInfoOf(trash);
    const alive = moved && pidAlive(Number(moved.pid));
    if (alive && lockAgeMs(moved) <= PROJECT_LOCK_TTL_MS) {
      try {
        if (!fs.existsSync(file)) fs.renameSync(trash, file);
      } catch {
        // 放回失败则保留隔离文件，交人工处理
      }
      return;
    }
    try {
      fs.rmSync(trash, { force: true });
    } catch {
      // 忽略
    }
  }

  function readLock(id) {
    const file = lockFile(id);
    if (!fs.existsSync(file)) return null;
    const info = lockInfoOf(file);
    if (!info) {
      // 空/损坏锁：超过 5 秒才视为残留
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > 5000) quarantineLock(file);
      } catch {
        // 忽略
      }
      return null;
    }
    const alive = pidAlive(Number(info.pid));
    const fresh = lockAgeMs(info) <= PROJECT_LOCK_TTL_MS;
    if (!alive || !fresh) {
      quarantineLock(file);
      return null;
    }
    return info;
  }

  /** 原子抢锁：O_EXCL 创建，返回带 owner token 的锁信息；失败 409。 */
  function acquireLock(id, meta = {}) {
    validateProjectId(id);
    const token = crypto.randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const info = {
      id,
      pid: process.pid,
      taskId: meta.taskId || null,
      token,
      at: now,
      heartbeatAt: now,
    };
    fs.mkdirSync(locksDir, { recursive: true });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const fd = fs.openSync(lockFile(id), 'wx');
        try {
          fs.writeSync(fd, JSON.stringify(info, null, 2));
        } finally {
          fs.closeSync(fd);
        }
        return { ...info };
      } catch (error) {
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        const existing = readLock(id);
        if (existing) {
          throw new ProjectError(
            `项目正在被任务 ${existing.taskId || '?'} 占用`,
            409,
            'PROJECT_LOCKED',
          );
        }
        sleepSync(10 + Math.floor(Math.random() * 20));
      }
    }
    throw new ProjectError('项目锁竞争失败，请重试', 409, 'PROJECT_LOCKED');
  }

  /** 只释放自己 token 的锁；token 不匹配时绝不删除（C07-P0-03 / ORD-02）。 */
  function releaseLock(id, token) {
    if (!token) return false;
    const file = lockFile(id);
    const info = lockInfoOf(file);
    if (!info || info.token !== token) return false;
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** 心跳：长任务定期刷新，避免被硬 TTL 误回收。 */
  function touchLock(id, token) {
    if (!token) return false;
    const file = lockFile(id);
    const info = lockInfoOf(file);
    if (!info || info.token !== token) return false;
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(
        tmp,
        JSON.stringify({ ...info, heartbeatAt: new Date().toISOString() }, null, 2),
        'utf-8',
      );
      fs.renameSync(tmp, file);
      return true;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 忽略
      }
      return false;
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
    recoverOrphanSnapshots,
    listSnapshots,
    diff,
    rollback,
    previewRoot,
    previewDir: previewDirOf,
    previewManifest: (id) => {
      const manifest = readJson(path.join(projectDirOf(id), '.publish-manifest.json'), null);
      if (!manifest || !manifest.files || typeof manifest.files !== 'object') return null;
      return manifest;
    },
    buildPreview,
    verifyPreview,
    buildProject,
    buildProjectAsync,
    memory: (id) => readJson(memoryPath(id), { rounds: [] }),
    appendRound,
    acquireLock,
    releaseLock,
    readLock,
    touchLock,
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
  withHomeLock,
  DEFAULT_EXCLUDES,
};

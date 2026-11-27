'use strict';

/**
 * B12 / C11-01 + C11-02：
 *  - 跨越 MAX_SNAPSHOTS=200 的裁剪事务顺序
 *  - 保留记录 → 目录 / manifest / uid / 文件哈希 / 可回退性
 *  - 服务 + CLI 多进程并发；裁剪期间 diff/rollback 的租约保护
 *  - 运行时安全孤儿回收：写入标记、宽限期、只隔离不删除、幂等、配额
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createProjectRegistry } = require('../lib/projects.cjs');
const { makeWorkspace, removeWorkspace } = require('./helpers.cjs');

const MAX = 200;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeProject(root) {
  write(path.join(root, 'index.html'), '<h1>v1</h1>\n');
  write(path.join(root, 'assets', 'a.txt'), 'asset');
  return root;
}

function stateOf(home) {
  return JSON.parse(
    fs.readFileSync(path.join(home, 'projects', 'demo', 'snapshots.json'), 'utf-8'),
  );
}

function dirsOf(home) {
  const base = path.join(home, 'projects', 'demo', '.snapshots');
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{3,}-/.test(entry.name))
    .map((entry) => entry.name);
}

function assertRetainedRecords(registry, home) {
  const state = stateOf(home);
  const entries = state.snapshots || [];
  const dirs = dirsOf(home);
  const registered = new Set(entries.map((item) => item.dir));
  const dangling = entries.filter((item) => !fs.existsSync(path.join(home, 'projects', 'demo', '.snapshots', item.dir)));
  assert.equal(dangling.length, 0, `dangling entries: ${dangling.slice(0, 5).map((i) => i.dir).join(',')}`);
  assert.equal(dirs.length, entries.length, `dirs=${dirs.length} entries=${entries.length}`);
  assert.equal(
    dirs.filter((name) => !registered.has(name)).length,
    0,
    'unregistered snapshot dirs must be reaped',
  );
  const seqs = entries.map((item) => Number(item.seq));
  assert.equal(new Set(seqs).size, seqs.length, 'duplicate seq');
  const uids = entries.map((item) => item.uid);
  assert.equal(new Set(uids).size, uids.length, 'duplicate uid');
  for (const entry of entries) {
    const validated = registry.validateSnapshot('demo', entry.uid);
    assert.equal(validated.digest, entry.digest, `digest mismatch ${entry.dir}`);
    const manifest = path.join(
      home,
      'projects',
      'demo',
      '.snapshots',
      `${entry.uid}.manifest.json`,
    );
    assert.ok(fs.existsSync(manifest), `manifest missing ${entry.dir}`);
    const actual = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    assert.equal(Object.keys(actual).length, entry.fileCount, `fileCount mismatch ${entry.dir}`);
    const entryFile = path.join(
      home,
      'projects',
      'demo',
      '.snapshots',
      entry.dir,
      'index.html',
    );
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(entryFile)).digest('hex'),
      actual['index.html'],
      `file hash mismatch ${entry.dir}`,
    );
  }
  return entries;
}

test('B12-C11-01: crossing MAX_SNAPSHOTS keeps registry and disk consistent', async () => {
  const root = makeWorkspace('vplay-b12-cap-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home, snapshotGraceMs: 0 });
    registry.importProject({ sourceDir: makeProject(path.join(root, 'src')), id: 'demo' });
    for (let i = 0; i < MAX + 12; i += 1) {
      registry.snapshot('demo', `cap-${i}`);
    }
    registry.reapSnapshots({ graceMs: 0 });
    const entries = assertRetainedRecords(registry, home);
    assert.equal(entries.length, MAX, `registered=${entries.length}`);
    assert.equal(dirsOf(home).length, MAX);
    const quota = registry.snapshotQuota('demo');
    assert.equal(quota.registered, MAX);
    assert.equal(quota.max, MAX);
    assert.equal(quota.onDisk, MAX);

    // 真实可回退性：对保留的中间快照执行回退并校验
    const target = entries[Math.floor(entries.length / 2)];
    const rolled = await registry.rollback('demo', target.seq);
    assert.equal(rolled.verified, true);
    assert.equal(rolled.previewReady, true);
  } finally {
    removeWorkspace(root);
  }
});

test('B12-C11-01: lease prevents pruning a snapshot being read', () => {
  const root = makeWorkspace('vplay-b12-lease-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home, snapshotGraceMs: 0 });
    registry.importProject({ sourceDir: makeProject(path.join(root, 'src')), id: 'demo' });
    for (let i = 0; i < MAX; i += 1) registry.snapshot('demo', `fill-${i}`);
    const oldest = registry.listSnapshots('demo')[0];
    const release = registry.acquireSnapshotLease('demo', oldest.uid, 'test-reader');
    try {
      for (let i = 0; i < 5; i += 1) registry.snapshot('demo', `after-${i}`);
      registry.reapSnapshots({ graceMs: 0 });
      const entries = registry.listSnapshots('demo');
      assert.ok(entries.some((item) => item.uid === oldest.uid), 'leased snapshot must survive prune');
      assert.equal(registry.validateSnapshot('demo', oldest.uid).entry.uid, oldest.uid);
      const diff = registry.diff('demo', oldest.seq, 'current');
      assert.equal(diff.from, oldest.seq);
    } finally {
      release();
    }
    for (let i = 0; i < 10; i += 1) registry.snapshot('demo', `post-${i}`);
    registry.reapSnapshots({ graceMs: 0 });
    assert.equal(
      registry.listSnapshots('demo').some((item) => item.uid === oldest.uid),
      false,
      'lease release should allow pruning',
    );
    assertRetainedRecords(registry, home);
  } finally {
    removeWorkspace(root);
  }
});

test('B12-C11-02: active writer is never quarantined; stale unknown dir is only quarantined', () => {
  const root = makeWorkspace('vplay-b12-orphan-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home, snapshotGraceMs: 0 });
    registry.importProject({ sourceDir: makeProject(path.join(root, 'src')), id: 'demo' });
    const base = path.join(home, 'projects', 'demo', '.snapshots');

    // 模拟正在写入的目录：新 mtime + 活 pid marker
    const active = path.join(base, '900-active');
    write(path.join(active, 'index.html'), '<h1>writing</h1>');
    write(path.join(active, '.writing.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    let results = registry.reapSnapshots({ graceMs: 0 });
    assert.equal(results[0].quarantinedDirs.includes('900-active'), false);
    assert.ok(results[0].activeWriters.includes('900-active'));

    // 模拟崩溃残留：marker 指死 pid 且时间很旧
    const crashed = path.join(base, '901-crashed');
    write(path.join(crashed, 'index.html'), '<h1>crashed</h1>');
    write(
      path.join(crashed, '.writing.json'),
      JSON.stringify({ pid: 999999, at: new Date(Date.now() - 3600_000).toISOString() }),
    );
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(crashed, '.writing.json'), old, old);
    fs.utimesSync(crashed, old, old);
    registry.reapSnapshots({ graceMs: 0 });
    const trash = path.join(home, 'projects', 'demo', '.snapshot-orphans');
    const moved = fs.readdirSync(trash);
    assert.ok(moved.some((name) => name.startsWith('901-crashed')), 'crashed writer must be quarantined');
    assert.ok(fs.existsSync(path.join(trash, moved.find((name) => name.startsWith('901-crashed')), 'index.html')));
    assert.equal(fs.existsSync(crashed), false);

    // 幂等 + 未知目录不删除
    const before = fs.readdirSync(trash).length;
    registry.reapSnapshots({ graceMs: 0 });
    registry.reapSnapshots({ graceMs: 0 });
    assert.equal(fs.readdirSync(trash).length, before);
    const quota = registry.snapshotQuota('demo');
    assert.equal(quota.registered, registry.listSnapshots('demo').length);
    assert.ok(quota.activeWriters.includes('900-active'));
  } finally {
    removeWorkspace(root);
  }
});

test('B12-C11: killed writer leaves no dangling entries; half-written dir is quarantined', async () => {
  const root = makeWorkspace('vplay-b12-crash-');
  const home = path.join(root, 'home');
  try {
    const source = path.join(root, 'src');
    for (let i = 0; i < 40; i += 1) {
      write(path.join(source, 'files', `f${i}.txt`), `file-${i}-${'x'.repeat(200)}`);
    }
    write(path.join(source, 'index.html'), '<h1>crash</h1>\n');
    createProjectRegistry({ home }).importProject({ sourceDir: source, id: 'demo' });

    const worker = path.join(__dirname, 'fixtures', 'snapshot-worker.cjs');
    const child = spawn(process.execPath, [worker, home, 'demo', '500'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));

    const registry = createProjectRegistry({ home, snapshotGraceMs: 0 });
    const reaped = registry.reapSnapshots({ graceMs: 0 });
    assert.ok(reaped.length === 1);
    const entries = assertRetainedRecords(registry, home);
    // 所有仍被注册的条目必须可校验（崩溃最多留下未登记目录，不能留下悬空引用）
    for (const entry of entries) registry.validateSnapshot('demo', entry.uid);
    // 未登记的半成品不得被直接删除：要么已被 quarantine，要么不存在于 .snapshots
    const base = path.join(home, 'projects', 'demo', '.snapshots');
    const registered = new Set(entries.map((item) => item.dir));
    const unknowns = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((item) => item.isDirectory() && /^\d{3,}-/.test(item.name))
      .map((item) => item.name)
      .filter((name) => !registered.has(name));
    assert.equal(unknowns.length, 0, `unknown dirs remain: ${unknowns.join(',')}`);
  } finally {
    removeWorkspace(root);
  }
});

test('B12-C11-01: 10 CLI workers + parent snapshots across MAX stay fully valid', async () => {
  const root = makeWorkspace('vplay-b12-conc-');
  const home = path.join(root, 'home');
  try {
    createProjectRegistry({ home, snapshotGraceMs: 0 }).importProject({
      sourceDir: makeProject(path.join(root, 'src')),
      id: 'demo',
    });
    const worker = path.join(__dirname, 'fixtures', 'snapshot-worker.cjs');
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, home, 'demo', '25'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (out += c));
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(out))));
      });
    const parent = createProjectRegistry({ home });
    const parentSnapshots = (async () => {
      for (let i = 0; i < 30; i += 1) {
        parent.snapshot('demo', `parent-${i}`);
        if (i % 5 === 0) {
          const entries = parent.listSnapshots('demo');
          if (entries.length) parent.diff('demo', entries[0].seq, 'current');
        }
        if (i === 10) {
          // 裁剪压力下执行回退：租约 + 项目锁必须保证目标可用
          const entries = parent.listSnapshots('demo');
          const target = entries[Math.max(0, entries.length - 3)];
          try {
            const rolled = await parent.rollback('demo', target.seq);
            assert.equal(rolled.verified, true);
          } catch (error) {
            if (error.code !== 'SNAPSHOT_NOT_FOUND') throw error;
          }
        }
      }
    })();
    await Promise.all([parentSnapshots, ...Array.from({ length: 10 }, run)]);

    const registry = createProjectRegistry({ home, snapshotGraceMs: 0 });
    registry.reapSnapshots({ graceMs: 0 });
    const entries = assertRetainedRecords(registry, home);
    assert.equal(entries.length, MAX, `registered=${entries.length}`);
    assert.equal(dirsOf(home).length, MAX);
    assert.equal(registry.snapshotQuota('demo').tombstones, 0);
  } finally {
    removeWorkspace(root);
  }
});

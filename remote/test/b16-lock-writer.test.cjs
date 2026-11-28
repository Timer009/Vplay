'use strict';

/**
 * B16 / C15 G1 定向测试：
 *  - S06：活进程的长租约（>10min）不得导致快照被裁剪；死 pid 才失效
 *  - S14：旧版活 pid 写入标记不得永久占用磁盘；新标记用 owner + 心跳区分
 *  - S24：released 标记后下一次写入 <1000ms
 *  - 并发 reaper 幂等、异常残留可恢复
 *  - trusted-lab：默认路径移出正式工程；cleanup 拒绝正式工程子目录/用户主目录/
 *    磁盘根/路径穿越/reparse point；默认 DryRun
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { createProjectRegistry } = require('../lib/projects.cjs');
const { makeWorkspace, removeWorkspace } = require('./helpers.cjs');

const LAB_SCRIPT = path.join(__dirname, '..', 'tools', 'trusted-lab', 'cleanup-lab.ps1');
const LAB_BASE = 'G:\\vplay-lab-b16-tests';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeProject(prefix, options = {}) {
  const root = makeWorkspace(prefix);
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home, snapshotGraceMs: 0, ...options });
  write(path.join(root, 'src', 'index.html'), '<h1>v1</h1>');
  registry.importProject({ sourceDir: path.join(root, 'src'), id: 'demo' });
  return { root, home, registry };
}

function rawLease(home, id, uid, payload) {
  const dir = path.join(home, 'runtime', 'snapshot-leases');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.${uid}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.lease`);
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return file;
}

test('B16-S06: a live lease older than 10 minutes still protects its snapshot', () => {
  const { root, home, registry } = makeProject('vplay-b16-s06-', { maxSnapshots: 3 });
  try {
    const first = registry.snapshot('demo', 'first');
    registry.snapshot('demo', 'second');
    registry.snapshot('demo', 'third');
    rawLease(home, 'demo', first.uid, {
      pid: process.pid,
      uid: first.uid,
      label: 'long-diff',
      at: Date.now() - 11 * 60 * 1000,
    });
    registry.snapshot('demo', 'over-old-lease');
    const kept = registry.listSnapshots('demo').some((item) => item.uid === first.uid);
    assert.equal(kept, true, 'live lease must not expire by elapsed time');
  } finally {
    removeWorkspace(root);
  }
});

test('B16-S06: a dead-pid lease is invalid and is removed', () => {
  const { root, home, registry } = makeProject('vplay-b16-dead-lease-', { maxSnapshots: 3 });
  try {
    const first = registry.snapshot('demo', 'first');
    registry.snapshot('demo', 'second');
    registry.snapshot('demo', 'third');
    const lease = rawLease(home, 'demo', first.uid, {
      pid: 999999,
      uid: first.uid,
      label: 'dead',
      at: Date.now(),
    });
    registry.snapshot('demo', 'over-dead-lease');
    assert.equal(registry.listSnapshots('demo').some((item) => item.uid === first.uid), false);
    assert.equal(fs.existsSync(lease), false);
  } finally {
    removeWorkspace(root);
  }
});

test('B16-S14: legacy live-pid marker cannot pin an unknown dir forever', () => {
  const { root, home, registry } = makeProject('vplay-b16-s14-', { maxSnapshots: 5 });
  try {
    const base = path.join(home, 'projects', 'demo', '.snapshots');
    const dir = path.join(base, '903-live-forever');
    fs.mkdirSync(dir);
    write(path.join(dir, 'index.html'), 'preserve-me');
    fs.writeFileSync(path.join(dir, '.writing.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);

    registry.reapSnapshots({ graceMs: 0 });
    registry.reapSnapshots({ graceMs: 0 });
    registry.reapSnapshots({ graceMs: 0 });
    assert.equal(fs.existsSync(dir), false, 'unowned stale marker must be quarantined');
    const trash = path.join(home, 'projects', 'demo', '.snapshot-orphans');
    const moved = fs.existsSync(trash) ? fs.readdirSync(trash) : [];
    assert.ok(moved.length >= 1);
    assert.ok(fs.readFileSync(path.join(trash, moved[0], 'index.html'), 'utf8').includes('preserve-me'));
  } finally {
    removeWorkspace(root);
  }
});

test('B16-S14: owner heartbeat keeps a long writer active; stale unowned marker is bounded', () => {
  const { root, home, registry } = makeProject('vplay-b16-owner-', { maxSnapshots: 5 });
  try {
    const base = path.join(home, 'projects', 'demo', '.snapshots');
    const active = path.join(base, '904-owner-active');
    fs.mkdirSync(active);
    write(path.join(active, 'index.html'), 'active');
    fs.writeFileSync(path.join(active, '.writing.json'), JSON.stringify({
      pid: process.pid,
      owner: 'b16-owner-token-0123456789',
      startedAt: Date.now() - 13 * 60 * 60 * 1000,
      at: Date.now(),
      op: 'snapshot',
    }));
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(active, old, old);
    registry.reapSnapshots({ graceMs: 0 });
    assert.equal(fs.existsSync(active), true, 'fresh heartbeat means the writer is still active');

    const stale = path.join(base, '905-owner-stale');
    fs.mkdirSync(stale);
    write(path.join(stale, 'index.html'), 'stale');
    fs.writeFileSync(path.join(stale, '.writing.json'), JSON.stringify({
      pid: process.pid,
      owner: 'b16-owner-token-0123456789',
      startedAt: Date.now() - 13 * 60 * 60 * 1000,
      at: Date.now() - 6 * 60 * 1000,
      op: 'snapshot',
    }));
    fs.utimesSync(stale, old, old);
    registry.reapSnapshots({ graceMs: 0 });
    registry.reapSnapshots({ graceMs: 0 });
    assert.equal(fs.existsSync(stale), false, 'stale heartbeat beyond the conservative window is quarantined');
  } finally {
    removeWorkspace(root);
  }
});

test('B16-S24: released marker recovers in under 1000ms and concurrent reaps stay idempotent', () => {
  const { root, home, registry } = makeProject('vplay-b16-s24-', { maxSnapshots: 5 });
  try {
    const lockFile = path.join(home, 'runtime', 'registry.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 0, token: 'released', at: Date.now() }), 'utf8');
    const started = Date.now();
    registry.snapshot('demo', 'after-released');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `elapsed=${elapsed}ms`);

    const r1 = registry.reapSnapshots({ graceMs: 0 });
    const r2 = registry.reapSnapshots({ graceMs: 0 });
    assert.equal(r1.length, r2.length);
    assert.ok(r1.every((item) => Number.isFinite(item.onDisk)));
  } finally {
    removeWorkspace(root);
  }
});

function runCleanup({ config, labRoot }) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LAB_SCRIPT,
    '-Config', config, '-LabRoot', labRoot,
  ], { encoding: 'utf8', timeout: 30000 });
}

test('B16-lab: cleanup only accepts an authorized labRoot outside the formal workspace', () => {
  fs.mkdirSync(LAB_BASE, { recursive: true });
  const base = fs.mkdtempSync(path.join(LAB_BASE, 'case-'));
  const lab = path.join(base, 'lab');
  const other = path.join(base, 'other');
  const config = path.join(base, 'lab-config.json');
  try {
    fs.mkdirSync(lab, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    write(path.join(lab, 'index.html'), 'x');
    fs.writeFileSync(path.join(lab, '.vplay-lab-marker'), JSON.stringify({ schemaVersion: 1, labRoot: lab }));
    fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, labRoot: lab, publicMode: false }));

    const dry = runCleanup({ config, labRoot: lab });
    assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`);
    assert.ok(fs.existsSync(lab));

    // 正式工程子目录 → 拒绝
    const formalConfig = path.join(base, 'formal.json');
    fs.writeFileSync(formalConfig, JSON.stringify({ schemaVersion: 1, labRoot: 'G:\\AI_GAME\\b16-not-allowed' }));
    const formal = runCleanup({ config: formalConfig, labRoot: 'G:\\AI_GAME\\b16-not-allowed' });
    assert.notEqual(formal.status, 0);
    assert.match(`${formal.stdout}${formal.stderr}`, /inside formal workspace root/i);

    // 用户主目录子目录 → 拒绝
    const userConfig = path.join(base, 'user.json');
    const userLab = path.join(process.env.USERPROFILE, 'vplay-lab-b16-not-allowed');
    fs.writeFileSync(userConfig, JSON.stringify({ schemaVersion: 1, labRoot: userLab }));
    const user = runCleanup({ config: userConfig, labRoot: userLab });
    assert.notEqual(user.status, 0);
    assert.match(`${user.stdout}${user.stderr}`, /inside user home/i);

    // 磁盘根 → 拒绝
    const rootConfig = path.join(base, 'root.json');
    fs.writeFileSync(rootConfig, JSON.stringify({ schemaVersion: 1, labRoot: 'G:\\' }));
    const drive = runCleanup({ config: rootConfig, labRoot: 'G:\\' });
    assert.notEqual(drive.status, 0);
    assert.match(`${drive.stdout}${drive.stderr}`, /broad root/i);

    // 路径穿越 → 拒绝
    const traversalConfig = path.join(base, 'traversal.json');
    const traversalLab = 'G:\\vplay-lab\\..\\escape';
    fs.writeFileSync(traversalConfig, JSON.stringify({ schemaVersion: 1, labRoot: traversalLab }));
    const traversal = runCleanup({ config: traversalConfig, labRoot: traversalLab });
    assert.notEqual(traversal.status, 0);
    assert.match(`${traversal.stdout}${traversal.stderr}`, /path traversal/i);

    // reparse point（junction）→ 拒绝
    const junction = path.join(lab, 'link-out');
    const made = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `New-Item -ItemType Junction -Path '${junction}' -Target '${other}' | Out-Null`,
    ], { encoding: 'utf8', timeout: 30000 });
    if (made.status === 0) {
      const reparse = runCleanup({ config, labRoot: lab });
      assert.notEqual(reparse.status, 0);
      assert.match(`${reparse.stdout}${reparse.stderr}`, /reparse point/i);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

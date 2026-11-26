'use strict';

/**
 * C04 定向回归：注册表锁高并发一致性、崩溃锁回收、正常资源不误伤、
 * 恢复失败保留 journal。全部使用虚拟工程与凭据。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  createProjectRegistry,
  withHomeLock,
  digestManifest,
} = require('../lib/projects.cjs');
const { hashTree } = require('../lib/paths.cjs');
const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  jsonHeaders,
} = require('./helpers.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const TOKEN = 'c04-token';
const REPO = path.join(__dirname, '..', '..');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeGame(root) {
  write(path.join(root, 'index.html'), '<style>:root{--bg:#101014}</style><h1>g</h1>');
  write(path.join(root, 'js', 'game.js'), 'console.log("v1")');
  return root;
}

function runWorker(home, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(FIXTURES, 'snapshot-worker.cjs'), home, 'demo', String(count)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    child.on('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`exit ${code}: ${output}`)),
    );
  });
}

function countDirs(home) {
  const base = path.join(home, 'projects', 'demo', '.snapshots');
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{3,}-/.test(entry.name)).length;
}

function readState(home) {
  return JSON.parse(
    fs.readFileSync(path.join(home, 'projects', 'demo', 'snapshots.json'), 'utf-8'),
  );
}

async function assertConsistent(home, expected) {
  const state = readState(home);
  assert.equal(state.snapshots.length, expected, `registry entries: ${state.snapshots.length}`);
  assert.equal(countDirs(home), expected, `snapshot dirs: ${countDirs(home)}`);
  const seqs = state.snapshots.map((item) => Number(item.seq));
  assert.equal(new Set(seqs).size, seqs.length, `duplicate seq: ${seqs.join(',')}`);

  const registry = createProjectRegistry({ home });
  for (const entry of state.snapshots) {
    const validated = registry.validateSnapshot('demo', entry.seq);
    assert.equal(validated.digest, entry.digest, `snapshot ${entry.seq} must verify`);
  }
  const rolled = registry.rollback('demo', 1);
  assert.equal(rolled.verified, true);
}

test('C04-11A: 5 workers × 10 snapshots stay consistent and rollbackable', async () => {
  const root = makeWorkspace('vplay-c04-5x10-');
  const home = path.join(root, 'home');
  try {
    createProjectRegistry({ home }).importProject({
      sourceDir: makeGame(path.join(root, 'source')),
      id: 'demo',
    });
    await Promise.all([0, 1, 2, 3, 4].map(() => runWorker(home, 10)));
    await assertConsistent(home, 51);
  } finally {
    removeWorkspace(root);
  }
});

test('C04-11B: 10 workers × 10 snapshots stay consistent and rollbackable', async () => {
  const root = makeWorkspace('vplay-c04-10x10-');
  const home = path.join(root, 'home');
  try {
    createProjectRegistry({ home }).importProject({
      sourceDir: makeGame(path.join(root, 'source')),
      id: 'demo',
    });
    await Promise.all(
      Array.from({ length: 10 }).map(() => runWorker(home, 10)),
    );
    await assertConsistent(home, 101);
  } finally {
    removeWorkspace(root);
  }
});

test('C04-mixed: CLI and server snapshots share one lock without loss', async () => {
  const root = makeWorkspace('vplay-c04-mixed-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: makeGame(path.join(root, 'source')), id: 'demo' });

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_AUTORUN: '0' },
  });

  const cliSnapshot = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(REPO, 'remote', 'cli.cjs'), 'project', 'snapshot', 'demo'],
        {
          cwd: REPO,
          env: { ...process.env, VPLAY_HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let output = '';
      child.stdout.on('data', (c) => (output += c));
      child.stderr.on('data', (c) => (output += c));
      child.on('exit', (code) =>
        code === 0 ? resolve(output) : reject(new Error(`cli exit ${code}: ${output}`)),
      );
    });

  try {
    await Promise.all([
      ...Array.from({ length: 3 }).flatMap(() =>
        Array.from({ length: 5 }).map(() => cliSnapshot()),
      ),
      (async () => {
        for (let i = 0; i < 5; i += 1) {
          const res = await request(
            server.port,
            'GET',
            '/projects/demo/diff?from=1&to=current',
            { headers: jsonHeaders(TOKEN) },
          );
          assert.equal(res.status, 200);
        }
      })(),
    ]);

    const state = readState(home);
    assert.equal(state.snapshots.length, 16, `entries: ${state.snapshots.length}`);
    assert.equal(countDirs(home), 16);
    const rollback = await request(server.port, 'POST', '/projects/demo/rollback', {
      headers: jsonHeaders(TOKEN),
      body: JSON.stringify({ seq: 1 }),
    });
    assert.equal(rollback.status, 200);
    assert.equal(rollback.json.verified, true);
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('C04-lock: crashed holder is reclaimed; a live lock is never deleted', async () => {
  const root = makeWorkspace('vplay-c04-lock-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    registry.importProject({ sourceDir: makeGame(path.join(root, 'source')), id: 'demo' });

    // 活锁：当前进程持有 → 外部 acquire 必须超时且不得删除
    const lockFile = path.join(home, '.opengame', 'registry.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const liveToken = 'live-holder-token';
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, token: liveToken, at: Date.now() }),
    );
    assert.throws(
      () => withHomeLock(home, () => 'never', { timeoutMs: 300 }),
      /registry is busy/,
    );
    const stillThere = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
    assert.equal(stillThere.token, liveToken, 'live lock must not be removed');
    fs.rmSync(lockFile, { force: true });

    // 崩溃锁：子进程持锁后被 SIGKILL，下一次快照应自动回收
    const ready = path.join(root, 'ready.txt');
    const holder = spawn(
      process.execPath,
      [path.join(FIXTURES, 'lock-holder.cjs'), home, ready],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    for (let i = 0; i < 100 && !fs.existsSync(ready); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(ready), 'holder did not acquire the lock');
    holder.kill('SIGKILL');
    await new Promise((r) => holder.on('exit', r));

    const started = Date.now();
    const snap = registry.snapshot('demo', 'after-crash');
    assert.ok(snap.seq >= 2);
    assert.ok(Date.now() - started < 10000, 'stale lock was not reclaimed quickly');
  } finally {
    removeWorkspace(root);
  }
});

test('NEW-C04-01: normal assets with token/secret/credentials names are preserved', async () => {
  const root = makeWorkspace('vplay-c04-assets-');
  const home = path.join(root, 'home');
  const source = makeGame(path.join(root, 'source'));
  write(path.join(source, 'assets', 'token.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  write(path.join(source, 'assets', 'token-icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5]));
  write(path.join(source, 'assets', 'secret-door.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 6]));
  write(path.join(source, 'data', 'credentials-ui.json'), '{"layout":"auth"}');
  write(path.join(source, 'credentials.json'), '{"client_secret":"fake"}');

  const imported = createProjectRegistry({ home }).importProject({
    sourceDir: source,
    id: 'demo',
  });
  const src = imported.project.srcDir;
  for (const rel of [
    'assets/token.png',
    'assets/token-icon.png',
    'assets/secret-door.png',
    'data/credentials-ui.json',
  ]) {
    assert.ok(fs.existsSync(path.join(src, rel)), `${rel} must be kept`);
  }
  assert.equal(fs.existsSync(path.join(src, 'credentials.json')), false);

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_AUTORUN: '0' },
  });
  try {
    for (const rel of [
      'assets/token.png',
      'assets/token-icon.png',
      'assets/secret-door.png',
      'data/credentials-ui.json',
    ]) {
      const res = await request(server.previewPort, 'GET', `/p/demo/${rel}`);
      assert.equal(res.status, 200, `${rel} should be previewable`);
    }
    assert.ok(
      [403, 404].includes(
        (await request(server.previewPort, 'GET', '/p/demo/credentials.json')).status,
      ),
    );
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('OBS-C04-01: failed startup recovery keeps journal and evidence, retry succeeds', async () => {
  const root = makeWorkspace('vplay-c04-obs-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    registry.importProject({ sourceDir: makeGame(path.join(root, 'source')), id: 'demo' });

    const journal = path.join(home, 'projects', 'demo', '.rollback-journal.json');
    fs.writeFileSync(
      journal,
      JSON.stringify({ state: 'applying', targetSeq: 1, backupSeq: 999, at: Date.now() }),
    );

    const first = registry.recoverInterruptedRollbacks();
    assert.equal(first[0].recovered, false);
    assert.equal(first[0].journalKept, true);
    assert.ok(fs.existsSync(journal), 'journal must survive a failed recovery');
    const logFile = path.join(home, 'projects', 'demo', '.rollback-recovery.log');
    assert.ok(fs.existsSync(logFile));
    assert.match(fs.readFileSync(logFile, 'utf-8'), /rollback-recovery-failed/);

    // 修正 journal 指向可用备份后再次启动恢复
    fs.writeFileSync(
      journal,
      JSON.stringify({ state: 'applying', targetSeq: 1, backupSeq: 1, at: Date.now() }),
    );
    const second = registry.recoverInterruptedRollbacks();
    assert.equal(second[0].recovered, true);
    assert.equal(second[0].journalKept, false);
    assert.equal(fs.existsSync(journal), false);
    assert.equal(
      digestManifest(hashTree(path.join(home, 'projects', 'demo', 'src'))),
      registry.get('demo').snapshots[0].digest,
    );
  } finally {
    removeWorkspace(root);
  }
});

test('NEW-C05-01: extensionless private keys never reach workspace, snapshots or preview', async () => {
  const root = makeWorkspace('vplay-c05-keys-');
  const home = path.join(root, 'home');
  const source = makeGame(path.join(root, 'source'));
  const fakeKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n';
  write(path.join(source, 'keys', 'id_rsa'), fakeKey);
  write(path.join(source, 'keys', 'id_ed25519'), fakeKey);
  write(path.join(source, 'keys', 'id_ecdsa'), fakeKey);
  write(path.join(source, 'keys', 'id_dsa'), fakeKey);
  write(path.join(source, 'keys', 'id_rsa.pub'), 'ssh-rsa AAAAB3NzaC1yc2E fake');
  write(path.join(source, 'assets', 'token.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]));
  write(path.join(source, 'data', 'credentials-ui.json'), '{"layout":"auth"}');
  write(
    path.join(source, 'data', 'app-config.json'),
    '{"private_key":"-----BEGIN PRIVATE KEY-----\\nfake\\n"}',
  );

  const registry = createProjectRegistry({ home });
  const imported = registry.importProject({ sourceDir: source, id: 'demo' });
  const src = imported.project.srcDir;

  for (const rel of [
    'keys/id_rsa',
    'keys/id_ed25519',
    'keys/id_ecdsa',
    'keys/id_dsa',
    'keys/id_rsa.pub',
  ]) {
    assert.equal(fs.existsSync(path.join(src, rel)), false, `${rel} must not be copied`);
  }
  for (const rel of ['assets/token.png', 'data/credentials-ui.json']) {
    assert.ok(fs.existsSync(path.join(src, rel)), `${rel} must be kept`);
  }

  const entry = registry.get('demo').snapshots[0];
  const manifestPath = path.join(home, 'projects', 'demo', '.snapshots', `${entry.uid}.manifest.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  for (const key of Object.keys(manifest)) {
    assert.doesNotMatch(key, /id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, `snapshot leaked ${key}`);
  }

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_AUTORUN: '0' },
  });
  try {
    for (const rel of ['keys/id_rsa', 'keys/id_ed25519', 'keys/id_rsa.pub']) {
      assert.equal((await request(server.previewPort, 'GET', `/p/demo/${rel}`)).status, 404);
    }
    assert.equal(
      (await request(server.previewPort, 'GET', '/p/demo/data/app-config.json')).status,
      404,
      'content-level secret must stay out of previews',
    );
    assert.equal((await request(server.previewPort, 'GET', '/p/demo/assets/token.png')).status, 200);
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

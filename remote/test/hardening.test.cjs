'use strict';

/**
 * C03 六项安全/完整性回归（NEW-01 ~ NEW-06）。
 * 全部使用临时工程与虚拟凭据，不访问外部系统。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const { createProjectRegistry } = require('../lib/projects.cjs');
const { hashTree } = require('../lib/paths.cjs');
const { digestManifest } = require('../lib/projects.cjs');
const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  jsonHeaders,
} = require('./helpers.cjs');

const TOKEN = 'hardening-token';
const FIXTURES = path.join(__dirname, 'fixtures');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

function makeGame(root) {
  write(path.join(root, 'index.html'), '<style>:root{--bg:#101014}</style><h1>g</h1>');
  write(path.join(root, 'js', 'game.js'), 'console.log("v1")');
  return root;
}

function digestOf(dir) {
  return digestManifest(hashTree(dir));
}

test('NEW-01: malformed Host cannot crash control or preview planes', async () => {
  const workspace = makeWorkspace('vplay-n1-');
  makeGame(workspace);
  const server = await startServer({ workspace, token: TOKEN, env: { REMOTE_AUTORUN: '0' } });
  try {
    const evil = await request(server.port, 'GET', '/health', {
      headers: { Host: 'attacker.example.127.0.0.1' },
    });
    assert.equal(evil.status, 400);
    const evilPreview = await request(server.previewPort, 'GET', '/legacy/index.html', {
      headers: { Host: 'attacker.example.127.0.0.1' },
    });
    assert.equal(evilPreview.status, 400);

    // 仍存活，且正常请求可用
    const health = await request(server.port, 'GET', '/health');
    assert.equal(health.status, 200);
    const preview = await request(server.previewPort, 'GET', '/legacy/index.html');
    assert.equal(preview.status, 200);

    // raw socket：空 Host 头
    await new Promise((resolve) => {
      const socket = net.connect(server.port, '127.0.0.1', () => {
        socket.write('GET /health HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n');
      });
      socket.on('data', () => {});
      socket.on('close', resolve);
      socket.on('error', resolve);
    });
    const afterRaw = await request(server.port, 'GET', '/health');
    assert.equal(afterRaw.status, 200);
  } finally {
    await server.stop();
    removeWorkspace(workspace);
  }
});

test('NEW-02: corrupted snapshot registry or content is rejected before touching the workspace', async () => {
  const root = makeWorkspace('vplay-n2-');
  const home = path.join(root, 'home');
  const source = makeGame(path.join(root, 'source'));
  write(path.join(source, 'notes.txt'), 'notes');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: source, id: 'demo' });
  const project = registry.get('demo');
  const before = digestOf(project.srcDir);

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_AUTORUN: '0' },
  });

  const rollback = (seq) =>
    request(server.port, 'POST', '/projects/demo/rollback', {
      headers: jsonHeaders(TOKEN),
      body: JSON.stringify({ seq }),
    });

  try {
    // A. 越界 dir
    const snapshotsPath = path.join(home, 'projects', 'demo', 'snapshots.json');
    const state = JSON.parse(fs.readFileSync(snapshotsPath, 'utf-8'));
    state.snapshots.push({ seq: 77, label: 'evil', dir: '../../escape', createdAt: new Date().toISOString(), fileCount: 1, digest: 'x' });
    state.seq = 77;
    fs.writeFileSync(snapshotsPath, JSON.stringify(state, null, 2));

    const escaped = await rollback(77);
    assert.ok([400, 409].includes(escaped.status), `expected 4xx, got ${escaped.status}`);
    assert.equal(digestOf(project.srcDir), before, 'workspace must be untouched');
    assert.ok(fs.existsSync(path.join(project.srcDir, 'index.html')));

    // B. 清单缺失
    const manifestPath = path.join(home, 'projects', 'demo', '.snapshots', '001.manifest.json');
    const manifest = fs.readFileSync(manifestPath, 'utf-8');
    fs.rmSync(manifestPath, { force: true });
    const missing = await rollback(1);
    assert.equal(missing.status, 409);
    assert.equal(digestOf(project.srcDir), before);

    // C. 快照内容被篡改（恢复清单后再改内容）
    fs.writeFileSync(manifestPath, manifest, 'utf-8');
    fs.writeFileSync(path.join(home, 'projects', 'demo', '.snapshots', '001-initial', 'index.html'), 'tampered');
    const corrupted = await rollback(1);
    assert.equal(corrupted.status, 409);
    assert.equal(digestOf(project.srcDir), before);
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('NEW-03: unsupported links are rejected at import; later links are skipped safely', async () => {
  const root = makeWorkspace('vplay-n3-');
  const home = path.join(root, 'home');
  const outside = makeWorkspace('vplay-n3-out-');
  write(path.join(outside, 'secret.txt'), 'OUTSIDE');

  const linked = makeGame(path.join(root, 'linked'));
  fs.symlinkSync(outside, path.join(linked, 'outlink'), 'junction');
  const linkedDigest = digestOf(linked);
  const registry = createProjectRegistry({ home });

  assert.throws(
    () => registry.importProject({ sourceDir: linked, id: 'linked-demo' }),
    /符号链接|junction|SYMLINK/i,
  );
  assert.equal(digestOf(linked), linkedDigest, 'original must be untouched');
  assert.equal(fs.existsSync(path.join(home, 'projects', 'linked-demo')), false);

  // 导入后再加 junction：快照应跳过链接而不是 EPERM
  const source = makeGame(path.join(root, 'source'));
  registry.importProject({ sourceDir: source, id: 'demo' });
  const project = registry.get('demo');
  fs.symlinkSync(outside, path.join(project.srcDir, 'outlink'), 'junction');
  const initial = digestOf(project.srcDir);

  const snap = registry.snapshot('demo', 'with-link');
  assert.ok(snap.skippedLinks && snap.skippedLinks.includes('outlink'));
  assert.equal(
    fs.existsSync(path.join(home, 'projects', 'demo', '.snapshots', `${String(snap.seq).padStart(3, '0')}-with-link`, 'outlink')),
    false,
  );

  const rolled = registry.rollback('demo', 1);
  assert.equal(rolled.verified, true);
  assert.equal(digestOf(project.srcDir), initial);
  assert.ok(fs.existsSync(path.join(project.srcDir, 'outlink')), 'link itself must survive');
});

test('NEW-04: preview publishes an explicit manifest and filters credential files', async () => {
  const root = makeWorkspace('vplay-n4-');
  const home = path.join(root, 'home');
  const source = makeGame(path.join(root, 'source'));
  write(path.join(source, 'gameConfig.json'), '{"speed":1}');
  write(path.join(source, 'config.json'), '{"apiKey":"sk-dummy-firebase-config-000000"}');
  write(path.join(source, 'firebase-config.js'), 'window.firebaseKey="sk-dummy-firebase-config-000000"');
  write(path.join(source, 'service-account.json'), '{"private_key":"-----BEGIN PRIVATE KEY-----"}');

  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: source, id: 'demo' });
  const project = registry.get('demo');

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_AUTORUN: '0' },
  });
  try {
    const base = `/p/demo/`;
    assert.equal((await request(server.previewPort, 'GET', `${base}index.html`)).status, 200);
    assert.equal((await request(server.previewPort, 'GET', `${base}gameConfig.json`)).status, 200);
    assert.ok([403, 404].includes((await request(server.previewPort, 'GET', `${base}config.json`)).status));
    assert.ok([403, 404].includes((await request(server.previewPort, 'GET', `${base}firebase-config.js`)).status));
    assert.ok([403, 404].includes((await request(server.previewPort, 'GET', `${base}service-account.json`)).status));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(home, 'projects', 'demo', '.publish-manifest.json'), 'utf-8'),
    );
    const skipped = manifest.skipped.map((item) => item.path);
    assert.ok(skipped.includes('config.json'), 'secret content must be filtered');
    assert.ok(!skipped.includes('gameConfig.json'));
    // 文件名敏感的凭据在导入阶段就被排除，不会进入工作副本
    assert.equal(fs.existsSync(path.join(project.srcDir, 'firebase-config.js')), false);
    assert.equal(fs.existsSync(path.join(project.srcDir, 'service-account.json')), false);
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('NEW-05: sensitive files are excluded consistently and never deleted by rollback', async () => {
  const root = makeWorkspace('vplay-n5-');
  const home = path.join(root, 'home');
  const source = makeGame(path.join(root, 'source'));
  write(path.join(source, '.env'), 'OPENAI_API_KEY=sk-dummy-000000000000000000');
  write(path.join(source, 'notes.log'), 'log');
  write(path.join(source, 'secret.pem'), '-----BEGIN RSA PRIVATE KEY-----');

  const registry = createProjectRegistry({ home });
  const imported = registry.importProject({ sourceDir: source, id: 'demo' });
  assert.ok(imported.import.skippedSensitive.includes('.env'));
  assert.ok(imported.import.skippedSensitive.includes('notes.log'));
  assert.ok(imported.import.skippedSensitive.includes('secret.pem'));

  const project = registry.get('demo');
  for (const name of ['.env', 'notes.log', 'secret.pem']) {
    assert.equal(fs.existsSync(path.join(project.srcDir, name)), false, `${name} must not be imported`);
  }

  const snap = registry.snapshot('demo', 'no-secrets');
  const snapDir = path.join(home, 'projects', 'demo', '.snapshots', `${String(snap.seq).padStart(3, '0')}-no-secrets`);
  const copied = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else copied.push(entry.name);
    }
  })(snapDir);
  assert.deepEqual(copied.sort(), ['game.js', 'index.html']);

  // 用户后来放的 .env 不应被回退删除
  write(path.join(project.srcDir, '.env'), 'USER_CONFIG=keep-me');
  const rolled = registry.rollback('demo', 1);
  assert.equal(rolled.verified, true);
  assert.equal(fs.readFileSync(path.join(project.srcDir, '.env'), 'utf-8'), 'USER_CONFIG=keep-me');
});

test('NEW-06: concurrent snapshots do not lose registry entries', async () => {
  const root = makeWorkspace('vplay-n6-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: makeGame(path.join(root, 'source')), id: 'demo' });

  const worker = path.join(FIXTURES, 'snapshot-worker.cjs');
  const run = (count) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, home, 'demo', String(count)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let output = '';
      child.stdout.on('data', (c) => (output += c));
      child.stderr.on('data', (c) => (output += c));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(output))));
    });

  try {
    await Promise.all([run(5), run(5)]);
    const state = JSON.parse(
      fs.readFileSync(path.join(home, 'projects', 'demo', 'snapshots.json'), 'utf-8'),
    );
    const dirs = fs
      .readdirSync(path.join(home, 'projects', 'demo', '.snapshots'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    // initial + 10 并发快照
    assert.equal(state.snapshots.length, 11, `registry has ${state.snapshots.length}`);
    assert.equal(dirs.length, 11, `directories: ${dirs.length}`);
    const seqs = state.snapshots.map((item) => Number(item.seq));
    assert.equal(new Set(seqs).size, seqs.length, 'seq must be unique');
  } finally {
    removeWorkspace(root);
  }
});

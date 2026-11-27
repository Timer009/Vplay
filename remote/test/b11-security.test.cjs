'use strict';

/**
 * B11 / C10 安全遗漏回归：
 *  - /status 不跨项目泄漏 prompt
 *  - idempotencyKey 作用域（用户 + 项目）
 *  - Vision 报告/截图 owner 权限
 *  - Vision allowedFiles 路径归一化
 *  - 设备默认项目 fail-closed
 *  - 事件 seq 入哈希 / 尾删可检出 / 跨进程并发
 *  - 预览非入口资源完整性
 *  - 门禁聚合 SKIP 不计 PASS
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { createProjectRegistry } = require('../lib/projects.cjs');
const { createDeviceStore } = require('../lib/devices.cjs');
const { createEventStore } = require('../lib/events.cjs');
const { createVisionService } = require('../lib/vision-service.cjs');
const { aggregate } = require('../tools/gates.cjs');
const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  jsonHeaders,
  waitFor,
  EXECUTOR,
} = require('./helpers.cjs');

const TOKEN = 'b11-token';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeProject(root, label) {
  write(path.join(root, 'index.html'), `<style>:root{--bg:#101014}</style><h1>${label}</h1>`);
  write(path.join(root, 'assets', 'a.txt'), 'asset-v1');
  return root;
}

async function login(port, token) {
  const res = await request(port, 'POST', '/auth/verify', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(res.status, 200);
  const id = String(res.headers['set-cookie']).match(/vplay_session=([^;]+)/)[1];
  return `vplay_session=${id}`;
}

function headersFor(cookieOrToken, json = false) {
  const headers = cookieOrToken.startsWith('vplay_session=')
    ? { Cookie: cookieOrToken }
    : jsonHeaders(cookieOrToken);
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

test('B11-C10-02: /status is scoped and never echoes prompts to devices', async () => {
  const root = makeWorkspace('vplay-b11-status-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: makeProject(path.join(root, 'src1'), 'demo'), id: 'demo' });
  registry.importProject({ sourceDir: makeProject(path.join(root, 'src2'), 'secret'), id: 'secret-demo' });
  const devices = createDeviceStore({ file: path.join(home, 'devices.json') });
  const device = devices.createDevice({ name: 'phone', projects: ['demo'] });

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: EXECUTOR },
  });
  try {
    const secret = await request(server.port, 'POST', '/prompt', {
      headers: jsonHeaders(TOKEN),
      body: JSON.stringify({ text: 'SLOW MARKER-SECRET-PROMPT', projectId: 'secret-demo' }),
    });
    assert.equal(secret.status, 202);
    await waitFor(async () => {
      const res = await request(server.port, 'GET', '/status', { headers: jsonHeaders(TOKEN) });
      return res.json && res.json.phase === 'generating';
    }, { timeout: 10000 });

    const admin = await request(server.port, 'GET', '/status', { headers: jsonHeaders(TOKEN) });
    assert.match(admin.json.message, /MARKER-SECRET-PROMPT/);

    const deviceSession = await login(server.port, device.token);
    const scoped = await request(server.port, 'GET', '/status', {
      headers: headersFor(deviceSession),
    });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.json.projectId, null, 'device must not see other project status');
    assert.equal(JSON.stringify(scoped.json).includes('MARKER-SECRET-PROMPT'), false);
    assert.equal(scoped.json.activeTaskId, undefined);

    // 设备自有项目的任务：可见但不回显 prompt
    const own = await request(server.port, 'POST', '/prompt', {
      headers: headersFor(deviceSession, true),
      body: JSON.stringify({ text: 'SLOW MARKER-OWN-PROMPT', projectId: 'demo' }),
    });
    assert.equal(own.status, 202);
    await waitFor(async () => {
      const res = await request(server.port, 'GET', '/status', { headers: headersFor(deviceSession) });
      return res.json && res.json.projectId === 'demo';
    }, { timeout: 10000 });
    const ownStatus = await request(server.port, 'GET', '/status', {
      headers: headersFor(deviceSession),
    });
    assert.equal(JSON.stringify(ownStatus.json).includes('MARKER-OWN-PROMPT'), false);
    assert.match(ownStatus.json.message, /demo/);
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('B11-C10-03: idempotencyKey is scoped to (createdBy, projectId)', async () => {
  const root = makeWorkspace('vplay-b11-idem-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: makeProject(path.join(root, 'src1'), 'demo'), id: 'demo' });
  registry.importProject({ sourceDir: makeProject(path.join(root, 'src2'), 'other'), id: 'other' });
  const devices = createDeviceStore({ file: path.join(home, 'devices.json') });
  const a = devices.createDevice({ name: 'a', projects: ['demo', 'other'] });
  const b = devices.createDevice({ name: 'b', projects: ['demo'] });

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: EXECUTOR, REMOTE_AUTORUN: '0' },
  });
  try {
    const sessionA = await login(server.port, a.token);
    const sessionB = await login(server.port, b.token);
    const key = 'shared-key-b11';
    const first = await request(server.port, 'POST', '/prompt', {
      headers: headersFor(sessionA, true),
      body: JSON.stringify({ text: 'one', projectId: 'demo', idempotencyKey: key }),
    });
    assert.equal(first.status, 202);

    const same = await request(server.port, 'POST', '/prompt', {
      headers: headersFor(sessionA, true),
      body: JSON.stringify({ text: 'one', projectId: 'demo', idempotencyKey: key }),
    });
    assert.equal(same.status, 200);
    assert.equal(same.json.duplicate, true);

    const crossUser = await request(server.port, 'POST', '/prompt', {
      headers: headersFor(sessionB, true),
      body: JSON.stringify({ text: 'one', projectId: 'demo', idempotencyKey: key }),
    });
    assert.equal(crossUser.status, 409);
    assert.equal(crossUser.json.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(Boolean(crossUser.json.existingTask), false, 'must not leak the existing task');

    const crossProject = await request(server.port, 'POST', '/prompt', {
      headers: headersFor(sessionA, true),
      body: JSON.stringify({ text: 'one', projectId: 'other', idempotencyKey: key }),
    });
    assert.equal(crossProject.status, 409);
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('B11-C10-04/C10-05: Vision evidence is owner-only; traversal allowedFiles rejected', async () => {
  const root = makeWorkspace('vplay-b11-vision-auth-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: makeProject(path.join(root, 'src'), 'demo'), id: 'demo' });
  const devices = createDeviceStore({ file: path.join(home, 'devices.json') });
  const owner = devices.createDevice({ name: 'owner', projects: ['demo'] });
  const peer = devices.createDevice({ name: 'peer', projects: ['demo'] });

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: EXECUTOR, REMOTE_AUTORUN: '0' },
  });
  try {
    const ownerSession = await login(server.port, owner.token);
    const peerSession = await login(server.port, peer.token);
    const created = await request(server.port, 'POST', '/projects/demo/vision', {
      headers: headersFor(ownerSession, true),
      body: JSON.stringify({ mode: 'analyze' }),
    });
    assert.equal(created.status, 202);
    const taskId = created.json.task.id;

    const own = await request(server.port, 'GET', `/projects/demo/vision/${taskId}`, {
      headers: headersFor(ownerSession),
    });
    assert.equal(own.status, 200);
    const peerView = await request(server.port, 'GET', `/projects/demo/vision/${taskId}`, {
      headers: headersFor(peerSession),
    });
    assert.equal(peerView.status, 403, 'task evidence must be private to its creator');
    const peerShot = await request(
      server.port,
      'GET',
      `/projects/demo/vision/${taskId}/screenshot/x.png`,
      { headers: headersFor(peerSession) },
    );
    assert.equal(peerShot.status, 403);
    const adminView = await request(server.port, 'GET', `/projects/demo/vision/${taskId}`, {
      headers: jsonHeaders(TOKEN),
    });
    assert.equal(adminView.status, 200);

    // allowedFiles 路径穿越 / 非 HTML 必须在进入模型前拒绝
    const fakeVision = {
      createEventSink: () => ({ emit() {}, events: [] }),
      redactSource: (text) => ({ text, findings: [] }),
      redactObject: (value) => value,
    };
    const service = createVisionService({ registry, home, deps: { vision: fakeVision, consent: true } });
    await assert.rejects(
      () =>
        service.run({
          taskId: 'vision_traversal',
          projectId: 'demo',
          mode: 'analyze',
          allowedFiles: ['../../outside.html'],
        }),
      /PATH|segment|escape/i,
    );
    await assert.rejects(
      () =>
        service.run({
          taskId: 'vision_js',
          projectId: 'demo',
          mode: 'analyze',
          allowedFiles: ['game.js'],
        }),
      /HTML\/CSS|FILE_NOT_ALLOWED/i,
    );
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('B11-C10-06/C10-09: devices are fail-closed and revocation survives concurrent auth', () => {
  const root = makeWorkspace('vplay-b11-devices-');
  const home = path.join(root, 'home');
  try {
    const devices = createDeviceStore({ file: path.join(home, 'devices.json') });
    assert.throws(() => devices.createDevice({ name: 'noscope' }), /scoped|projects/i);
    const all = devices.createDevice({ name: 'all', projects: '*' });
    assert.deepEqual(all.device.projects, ['*']);

    const scoped = devices.createDevice({ name: 'p', projects: ['demo'] });
    for (let i = 0; i < 20; i += 1) {
      assert.ok(devices.authenticate(scoped.token));
    }
    assert.equal(devices.revoke(scoped.device.id), true);
    assert.equal(devices.authenticate(scoped.token), null, 'revoked token must never authenticate');
    assert.equal(devices.get(scoped.device.id).revoked, true);
  } finally {
    removeWorkspace(root);
  }
});

test('B11-C10-07: event seq participates in hash and tail deletion is detectable', () => {
  const root = makeWorkspace('vplay-b11-events-');
  const file = path.join(root, 'events', 'events.jsonl');
  try {
    const store = createEventStore({ file });
    for (let i = 0; i < 5; i += 1) {
      store.append({ type: 'task.created', taskId: `t${i}`, projectId: 'demo', status: 'queued' });
    }
    assert.equal(store.verify().ok, true);

    // 修改 seq（不重算 hash）必须被检出
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    const tampered = JSON.parse(lines[3]);
    tampered.seq += 1;
    lines[3] = JSON.stringify(tampered);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const seqCheck = createEventStore({ file }).verify();
    assert.equal(seqCheck.ok, false);
    assert.ok(seqCheck.problems.some((item) => item.startsWith('SEQ_ID_MISMATCH') || item.startsWith('HASH_MISMATCH')));
  } finally {
    removeWorkspace(root);
  }
});

test('B11-C10-07: event tail deletion is detected by the anchor', () => {
  const root = makeWorkspace('vplay-b11-events-tail-');
  const file = path.join(root, 'events', 'events.jsonl');
  try {
    const store = createEventStore({ file });
    for (let i = 0; i < 5; i += 1) {
      store.append({ type: 'task.created', taskId: `t${i}`, projectId: 'demo' });
    }
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    fs.writeFileSync(file, `${lines.slice(0, -1).join('\n')}\n`);
    const check = createEventStore({ file }).verify();
    assert.equal(check.ok, false);
    assert.ok(
      check.problems.some((item) => item.startsWith('ANCHOR_COUNT') || item.startsWith('ANCHOR_LAST_ID')),
      check.problems.join(','),
    );
  } finally {
    removeWorkspace(root);
  }
});

test('B11-C10-07: concurrent event writers keep a single valid chain', async () => {
  const root = makeWorkspace('vplay-b11-events-conc-');
  const file = path.join(root, 'events', 'events.jsonl');
  try {
    const writer = path.join(__dirname, 'fixtures', 'events-writer.cjs');
    const run = (prefix) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [writer, file, '20', prefix], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (out += c));
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(out))));
      });
    await Promise.all([run('a'), run('b'), run('c'), run('d')]);
    const store = createEventStore({ file });
    const check = store.verify();
    assert.equal(check.ok, true, check.problems.join(','));
    assert.equal(check.count, 80);
    const ids = fs
      .readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).id);
    assert.equal(new Set(ids).size, 80, 'ids must be unique');
  } finally {
    removeWorkspace(root);
  }
});

test('B11-N15: tampered non-entry preview resource is not served with 200', async () => {
  const root = makeWorkspace('vplay-b11-preview-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: makeProject(path.join(root, 'src'), 'demo'), id: 'demo' });
  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_AUTORUN: '0' },
  });
  try {
    assert.equal((await request(server.previewPort, 'GET', '/p/demo/assets/a.txt')).status, 200);
    write(path.join(home, 'projects', 'demo', '.preview', 'assets', 'a.txt'), 'tampered');
    const tampered = await request(server.previewPort, 'GET', '/p/demo/assets/a.txt');
    assert.equal(tampered.status, 503);
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('B11-B13: gate aggregation never counts SKIP as PASS', () => {
  const skipOnly = aggregate([{ id: 'A', status: 'PASS' }, { id: 'B', status: 'SKIP' }]);
  assert.equal(skipOnly.verdict, 'NOT_PASS');
  const allPass = aggregate([{ id: 'A', status: 'PASS' }, { id: 'B', status: 'PASS' }]);
  assert.equal(allPass.verdict, 'PASS');
  const failed = aggregate([{ id: 'A', status: 'FAIL' }]);
  assert.equal(failed.verdict, 'FAIL');
});

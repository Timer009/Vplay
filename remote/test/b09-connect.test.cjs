'use strict';

/**
 * B09 / C08 契约回归：SSE（X-01..X-05）、设备 ACL、证据链、Vision 宿主接线。
 * 全部离线：假执行器、假 Vision 模块、临时目录；无真实模型/浏览器。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { createProjectRegistry } = require('../lib/projects.cjs');
const { createDeviceStore } = require('../lib/devices.cjs');
const { createEventStore } = require('../lib/events.cjs');
const { createVisionService } = require('../lib/vision-service.cjs');
const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  jsonHeaders,
  waitFor,
  EXECUTOR,
} = require('./helpers.cjs');

const TOKEN = 'b09-token';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeStaticProject(root) {
  write(path.join(root, 'index.html'), '<style>:root{--bg:#101014}</style><h1>b09</h1>');
  write(path.join(root, 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return root;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 读取 SSE 流：返回 { events, close, waitForType } */
function openSse(port, cookieOrToken, lastEventId = 0) {
  const headers = cookieOrToken
    ? cookieOrToken.startsWith('vplay_session=')
      ? { Cookie: cookieOrToken }
      : { Authorization: `Bearer ${cookieOrToken}` }
    : {};
  if (lastEventId) headers['Last-Event-ID'] = String(lastEventId);
  const events = [];
  let buffer = '';
  let req;
  const listeners = new Set();
  const connected = new Promise((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, path: '/events', headers }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE status ${res.statusCode}`));
        return;
      }
      resolve();
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let id = null;
          let data = null;
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4).trim();
            if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (data) {
            try {
              const parsed = JSON.parse(data);
              parsed._sseId = id;
              events.push(parsed);
              for (const listener of listeners) listener(parsed);
            } catch {
              // 忽略非 JSON
            }
          }
        }
      });
    });
    req.on('error', reject);
  });
  return {
    events,
    connected,
    waitFor: (predicate, timeout = 15000) =>
      new Promise((resolve, reject) => {
        const found = events.find(predicate);
        if (found) return resolve(found);
        const handler = (event) => {
          if (predicate(event)) {
            listeners.delete(handler);
            clearTimeout(timer);
            resolve(event);
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(handler);
          reject(new Error('timed out waiting for SSE event'));
        }, timeout);
        listeners.add(handler);
      }),
    close: () => {
      try {
        req.destroy();
      } catch {
        // 忽略
      }
    },
  };
}

async function login(port, token) {
  const res = await request(port, 'POST', '/auth/verify', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(res.status, 200);
  return String(res.headers['set-cookie'] || '').split(';')[0];
}

async function submit(port, tokenOrCookie, payload) {
  const headers = tokenOrCookie.startsWith('vplay_session=')
    ? { Cookie: tokenOrCookie, 'Content-Type': 'application/json' }
    : jsonHeaders(tokenOrCookie);
  return request(port, 'POST', '/prompt', { headers, body: JSON.stringify(payload) });
}

async function waitTask(port, tokenOrCookie, taskId) {
  const headers = tokenOrCookie.startsWith('vplay_session=')
    ? { Cookie: tokenOrCookie }
    : jsonHeaders(tokenOrCookie);
  return waitFor(async () => {
    const res = await request(port, 'GET', `/tasks/${taskId}`, { headers });
    const status = res.json && res.json.task && res.json.task.status;
    return ['succeeded', 'failed', 'interrupted'].includes(status) ? res.json.task : null;
  }, { timeout: 20000 });
}

test('X-01..X-05: SSE events, replay, cross-device visibility, idempotency and preview consistency', async () => {
  const root = makeWorkspace('vplay-b09-sse-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  const imported = registry.importProject({
    sourceDir: makeStaticProject(path.join(root, 'src')),
    id: 'demo',
  });
  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: EXECUTOR },
  });
  const stream = openSse(server.port, TOKEN);
  try {
    await stream.connected;

    // X-01：先连流再提交
    const created = await submit(server.port, TOKEN, { text: 'BACKGROUND SSE task', projectId: 'demo' });
    assert.equal(created.status, 202);
    const taskId = created.json.task.id;
    const createdEvent = await stream.waitFor((event) => event.taskId === taskId && event.type === 'task.created');
    assert.ok(createdEvent.id, 'event must carry id');
    const finished = await stream.waitFor(
      (event) => event.taskId === taskId && ['task.succeeded', 'task.failed'].includes(event.type),
    );
    assert.equal(finished.type, 'task.succeeded');

    // X-05：任务前后入口哈希与预览一致
    const entry = imported.project.entry || 'index.html';
    assert.equal(
      sha256(path.join(imported.project.srcDir, entry)),
      sha256(path.join(home, 'projects', 'demo', '.preview', entry)),
    );

    // X-02：任务终态后从 0 重连，必须补发
    stream.close();
    const replay = openSse(server.port, TOKEN, 0);
    await replay.connected;
    const replayed = await replay.waitFor((event) => event.taskId === taskId && event.type === 'task.succeeded');
    assert.ok(replayed.id);
    replay.close();

    // X-03：设备/另一会话在事件流中能看到任务元数据（不含 prompt 正文）
    const sessionB = await login(server.port, TOKEN);
    const streamB = openSse(server.port, sessionB);
    await streamB.connected;
    const second = await submit(server.port, sessionB, { text: 'BACKGROUND from session B', projectId: 'demo' });
    assert.equal(second.status, 202);
    const seen = await streamB.waitFor((event) => event.taskId === second.json.task.id && event.type === 'task.created');
    assert.equal(seen.projectId, 'demo');
    assert.equal(JSON.stringify(seen).includes('BACKGROUND from session B'), false, 'events must not contain prompt text');
    streamB.close();

    // X-04：跨会话同 idempotencyKey 去重
    const key = 'b09-idem-key';
    const one = await submit(server.port, TOKEN, { text: 'idem one', projectId: 'demo', idempotencyKey: key });
    const two = await submit(server.port, sessionB, { text: 'idem one', projectId: 'demo', idempotencyKey: key });
    assert.equal(two.status, 200);
    assert.equal(two.json.duplicate, true);
    assert.equal(two.json.task.id, one.json.task.id);
  } finally {
    stream.close();
    await server.stop();
    removeWorkspace(root);
  }
});

test('C07-P1-04: device tokens are project-scoped and only see their own tasks', async () => {
  const root = makeWorkspace('vplay-b09-device-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: makeStaticProject(path.join(root, 'src1')), id: 'demo' });
  registry.importProject({ sourceDir: makeStaticProject(path.join(root, 'src2')), id: 'secret-demo' });
  const devices = createDeviceStore({ file: path.join(home, 'devices.json') });
  const created = devices.createDevice({ name: 'iPhone', projects: ['demo'] });

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: EXECUTOR },
  });
  try {
    const adminTask = await submit(server.port, TOKEN, { text: 'BACKGROUND admin task', projectId: 'demo' });
    await waitTask(server.port, TOKEN, adminTask.json.task.id);
    const hiddenTask = await submit(server.port, TOKEN, { text: 'BACKGROUND secret task', projectId: 'secret-demo' });
    await waitTask(server.port, TOKEN, hiddenTask.json.task.id);

    const deviceCookie = await login(server.port, created.token);
    const projects = await request(server.port, 'GET', '/projects', { headers: { Cookie: deviceCookie } });
    assert.deepEqual(projects.json.projects.map((item) => item.id), ['demo']);

    const forbidden = await request(server.port, 'POST', '/prompt', {
      headers: { Cookie: deviceCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'should fail', projectId: 'secret-demo' }),
    });
    assert.equal(forbidden.status, 403);

    // B10 / C-1：授权设备可查看共同工程（demo）的任务详情/日志，但看不到未授权工程
    const list = await request(server.port, 'GET', '/tasks', { headers: { Cookie: deviceCookie } });
    assert.deepEqual(
      list.json.tasks.map((item) => item.projectId),
      ['demo'],
      'device must only see tasks in authorized projects',
    );
    const visible = await request(server.port, 'GET', `/tasks/${adminTask.json.task.id}`, {
      headers: { Cookie: deviceCookie },
    });
    assert.equal(visible.status, 200, 'authorized device may inspect shared-project task');
    const log = await request(server.port, 'GET', `/tasks/${adminTask.json.task.id}/log`, {
      headers: { Cookie: deviceCookie },
    });
    assert.equal(log.status, 200);
    const hidden = await request(server.port, 'GET', `/tasks/${hiddenTask.json.task.id}`, {
      headers: { Cookie: deviceCookie },
    });
    assert.equal(hidden.status, 403, 'task metadata in unauthorized project must not leak');
    const artifact = await request(server.port, 'GET', '/artifact?projectId=secret-demo', {
      headers: { Cookie: deviceCookie },
    });
    assert.equal(artifact.status, 403);

    const own = await submit(server.port, deviceCookie, { text: 'BACKGROUND device task', projectId: 'demo' });
    assert.equal(own.status, 202);
    await waitTask(server.port, deviceCookie, own.json.task.id);
    const list2 = await request(server.port, 'GET', '/tasks', { headers: { Cookie: deviceCookie } });
    assert.ok(list2.json.tasks.some((item) => item.id === own.json.task.id));
    assert.equal(list2.json.tasks.some((item) => item.id === hiddenTask.json.task.id), false);
    const ownDetail = list2.json.tasks.find((item) => item.id === own.json.task.id);
    assert.equal(ownDetail.createdBy, created.device.id);

    // 事件流仍可看到元数据（X-03），但不含 prompt
    const stream = openSse(server.port, deviceCookie);
    await stream.connected;
    const newAdmin = await submit(server.port, TOKEN, { text: 'BACKGROUND admin two', projectId: 'demo' });
    const seen = await stream.waitFor((event) => event.taskId === newAdmin.json.task.id && event.type === 'task.created');
    assert.equal(JSON.stringify(seen).includes('BACKGROUND admin two'), false);
    stream.close();
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('P1-11 / C08 §6: task evidence is written outside the project with HMAC anchor', async () => {
  const root = makeWorkspace('vplay-b09-evidence-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  const imported = registry.importProject({
    sourceDir: makeStaticProject(path.join(root, 'src')),
    id: 'demo',
  });
  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { EVIDENCE_HMAC_KEY: 'b09-hmac-key', REMOTE_EXECUTOR_CMD: EXECUTOR },
  });
  try {
    const created = await submit(server.port, TOKEN, { text: 'BACKGROUND evidence task', projectId: 'demo' });
    const task = await waitTask(server.port, TOKEN, created.json.task.id);
    assert.ok(task.result.artifactId);
    assert.ok(task.result.versionId, 'versionId must be recorded');

    const evidenceDir = path.join(home, 'evidence', 'demo', task.id);
    for (const name of ['meta.json', 'events.jsonl', 'task.log', 'report.json', 'anchor.json']) {
      assert.ok(fs.existsSync(path.join(evidenceDir, name)), `${name} must exist`);
    }
    assert.equal(evidenceDir.startsWith(imported.project.srcDir), false, 'evidence must live outside project');
    const anchor = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'anchor.json'), 'utf-8'));
    assert.equal(anchor.artifactId, task.result.artifactId);
    assert.equal(
      anchor.hmac,
      crypto.createHmac('sha256', 'b09-hmac-key').update(anchor.artifactId).digest('hex'),
    );
    const events = fs.readFileSync(path.join(evidenceDir, 'events.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse);
    assert.ok(events.length >= 2);
    for (let i = 1; i < events.length; i += 1) {
      assert.equal(events[i].prevHash, events[i - 1].hash, 'event hash chain must link');
    }
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

function makeFakeVision() {
  return {
    loadConfig: () => ({}),
    createModelGateway: () => ({ summary: () => ({}) }),
    createBrowserRunner: () => ({ runCapture: async () => ({ ok: true, screenshots: [], viewports: [] }) }),
    createSpacerAdapter: () => ({ id: 'fake', viewports: [], ready: async () => {}, assert: async () => [] }),
    createEventSink: ({ onEvent }) => {
      const events = [];
      return {
        events,
        emit: (type, payload) => {
          events.push({ type, payload });
          if (onEvent) onEvent({ type, payload });
        },
      };
    },
    redactSource: (source) => ({ text: source, findings: [], truncated: false }),
    runVisionTask: async ({ host, mode: runMode }) => {
      if (runMode === 'repair') {
        const snapshot = await host.snapshot('pre-vision-fake');
        await host.applyFiles([{ file: 'index.html', content: '<style>:root{--bg:#222222}</style><h1>fixed</h1>' }]);
        const diff = await host.diff(snapshot.seq);
        return {
          ok: true,
          status: 'repaired',
          validation: { ok: true },
          comparison: {
            ok: true,
            beforeOk: false,
            afterOk: true,
            resolvedCriticalFailures: [{ id: 'hud-visible' }],
            newCriticalFailures: [],
            screenshotsChanged: true,
          },
          diff,
        };
      }
      return { ok: true, status: 'analyzed', before: { ok: true, screenshots: [] } };
    },
  };
}

test('C08 D/restart: interrupted task is marked and emits task.interrupted after restart', async () => {
  const root = makeWorkspace('vplay-b09-restart-');
  const home = path.join(root, 'home');
  createProjectRegistry({ home }).importProject({
    sourceDir: makeStaticProject(path.join(root, 'src')),
    id: 'demo',
  });
  const first = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: EXECUTOR },
  });
  let taskId = null;
  try {
    const created = await submit(first.port, TOKEN, { text: 'SLOW background restart', projectId: 'demo' });
    taskId = created.json.task.id;
    await waitFor(async () => {
      const res = await request(first.port, 'GET', `/tasks/${taskId}`, { headers: jsonHeaders(TOKEN) });
      return res.json && res.json.task && res.json.task.status === 'running';
    }, { timeout: 10000 });
  } finally {
    await first.stop();
  }
  await new Promise((resolve) => setTimeout(resolve, 2200));

  const second = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: EXECUTOR },
  });
  try {
    const detail = await request(second.port, 'GET', `/tasks/${taskId}`, { headers: jsonHeaders(TOKEN) });
    assert.equal(detail.json.task.status, 'interrupted');
    const replay = openSse(second.port, TOKEN, 0);
    await replay.connected;
    const event = await replay.waitFor((item) => item.taskId === taskId && item.type === 'task.interrupted');
    assert.ok(event.id);
    replay.close();
  } finally {
    await second.stop();
    removeWorkspace(root);
  }
});

test('Vision 0.2.0 vendored package is importable without npm registry', async () => {
  const { pathToFileURL } = require('url');
  const entry = path.join(__dirname, '..', '..', 'vendor', 'vision', 'src', 'index.mjs');
  assert.ok(fs.existsSync(entry), 'vendored vision entry must exist');
  const mod = await import(pathToFileURL(entry).href);
  assert.equal(typeof mod.runVisionTask, 'function');
  assert.equal(typeof mod.validatePatchPlan, 'function');
  assert.ok(Object.keys(mod).length >= 40, `exports: ${Object.keys(mod).length}`);
});

test('Sprint03B / P0-05: vision host wiring applies safe patches atomically and rejects unsafe ones', async () => {
  const root = makeWorkspace('vplay-b09-vision-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  const imported = registry.importProject({
    sourceDir: makeStaticProject(path.join(root, 'src')),
    id: 'demo',
  });
  const events = createEventStore({ file: path.join(home, 'events', 'events.jsonl') });
  const service = createVisionService({
    registry,
    home,
    eventStore: events,
    deps: { vision: makeFakeVision(), consent: true, previewUrl: 'http://127.0.0.1:1/p/demo/' },
  });

  const output = await service.run({ taskId: 'vision_ok', projectId: 'demo', mode: 'repair', skipLock: false });
  assert.equal(output.result.ok, true);
  assert.match(fs.readFileSync(path.join(imported.project.srcDir, 'index.html'), 'utf-8'), /fixed/);
  assert.equal(registry.verifyPreview('demo').ok, true);
  assert.ok(fs.existsSync(output.reportFile));
  assert.equal(output.reportFile.startsWith(imported.project.srcDir), false);
  assert.ok(events.listForTask('vision_ok').some((event) => event.type === 'vision.completed'));

  const unsafe = makeFakeVision();
  unsafe.runVisionTask = async ({ host }) => {
    await host.snapshot('pre-vision-unsafe');
    await host.applyFiles([{ file: 'index.html', content: '<script>fetch("https://evil.example")</script>' }]);
    return { ok: true };
  };
  const service2 = createVisionService({
    registry,
    home,
    eventStore: events,
    deps: { vision: unsafe, consent: true, previewUrl: 'http://127.0.0.1:1/p/demo/' },
  });
  const before = fs.readFileSync(path.join(imported.project.srcDir, 'index.html'), 'utf-8');
  await assert.rejects(
    () => service2.run({ taskId: 'vision_bad', projectId: 'demo', mode: 'repair', skipLock: false }),
    /unsafe content/i,
  );
  assert.equal(fs.readFileSync(path.join(imported.project.srcDir, 'index.html'), 'utf-8'), before);

  removeWorkspace(root);
});

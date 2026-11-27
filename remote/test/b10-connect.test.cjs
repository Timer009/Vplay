'use strict';

/**
 * B10 / Sprint03C Connect 协同回归：
 *  - 同一用户授权设备可查看共同工程任务；未授权设备不得获得元数据
 *  - SSE 事件按项目授权过滤
 *  - 设备吊销立即影响 Session / SSE / 预览
 *  - Serve/代理模式拒绝 test seam；子进程凭据最小化
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { createProjectRegistry } = require('../lib/projects.cjs');
const { createDeviceStore } = require('../lib/devices.cjs');
const { buildChildEnv } = require('../lib/worker.cjs');
const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  jsonHeaders,
  waitFor,
  EXECUTOR,
} = require('./helpers.cjs');

const TOKEN = 'b10-token';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeProject(root, label) {
  write(path.join(root, 'index.html'), `<h1>${label}</h1>`);
  return root;
}

function openSse(port, cookie) {
  const events = [];
  let buffer = '';
  let req;
  const connected = new Promise((resolve, reject) => {
    req = http.get(
      { host: '127.0.0.1', port, path: '/events', headers: { Cookie: cookie } },
      (res) => {
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
            const line = block.split('\n').find((item) => item.startsWith('data: '));
            if (!line) continue;
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              // 忽略
            }
          }
        });
      },
    );
    req.on('error', reject);
  });
  return {
    events,
    connected,
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
  const cookies = [].concat(res.headers['set-cookie'] || []).map(String);
  return {
    session: cookies.find((item) => item.startsWith('vplay_session=')).split(';')[0],
    preview: (cookies.find((item) => item.startsWith('vplay_preview=')) || '').split(';')[0],
  };
}

async function submit(port, cookieOrToken, payload) {
  const headers = cookieOrToken.startsWith('vplay_session=')
    ? { Cookie: cookieOrToken, 'Content-Type': 'application/json' }
    : jsonHeaders(cookieOrToken);
  return request(port, 'POST', '/prompt', { headers, body: JSON.stringify(payload) });
}

test('B10-C1/C2: SSE and task metadata are filtered by project authorization', async () => {
  const root = makeWorkspace('vplay-b10-sse-filter-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: makeProject(path.join(root, 'src1'), 'demo'), id: 'demo' });
  registry.importProject({ sourceDir: makeProject(path.join(root, 'src2'), 'secret'), id: 'secret-demo' });
  const devices = createDeviceStore({ file: path.join(home, 'devices.json') });
  const created = devices.createDevice({ name: 'phone', projects: ['demo'] });

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: EXECUTOR, REMOTE_AUTORUN: '0' },
  });
  const stream = openSse(server.port, await login(server.port, created.token).then((c) => c.session));
  try {
    await stream.connected;
    const secretTask = await submit(server.port, TOKEN, { text: 'BACKGROUND secret', projectId: 'secret-demo' });
    const demoTask = await submit(server.port, TOKEN, { text: 'BACKGROUND demo', projectId: 'demo' });
    await waitFor(() => stream.events.some((event) => event.taskId === demoTask.json.task.id), { timeout: 8000 });
    assert.equal(
      stream.events.some((event) => event.taskId === secretTask.json.task.id),
      false,
      'unauthorized project events must not reach the device',
    );
    const demoEvents = stream.events.filter((event) => event.taskId === demoTask.json.task.id);
    assert.ok(demoEvents.every((event) => event.projectId === 'demo'));
  } finally {
    stream.close();
    await server.stop();
    removeWorkspace(root);
  }
});

test('B10-C3: device revocation immediately cuts session, SSE and preview', async () => {
  const root = makeWorkspace('vplay-b10-revoke-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: makeProject(path.join(root, 'src'), 'demo'), id: 'demo' });
  registry.importProject({ sourceDir: makeProject(path.join(root, 'src2'), 'secret'), id: 'secret-demo' });
  const devices = createDeviceStore({ file: path.join(home, 'devices.json') });
  const created = devices.createDevice({ name: 'phone', projects: ['demo'] });

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: {
      REMOTE_EXECUTOR_CMD: EXECUTOR,
      REMOTE_AUTORUN: '0',
      PREVIEW_ACCESS_KEY: 'b10-preview-key',
    },
  });
  const session = await login(server.port, created.token);
  const stream = openSse(server.port, session.session);
  try {
    await stream.connected;
    // 授权项目预览 200；未授权项目预览 401
    assert.equal(
      (await request(server.previewPort, 'GET', '/p/demo/', { headers: { Cookie: session.preview } })).status,
      200,
    );
    assert.equal(
      (await request(server.previewPort, 'GET', '/p/secret-demo/', { headers: { Cookie: session.preview } })).status,
      401,
    );

    // 吊销设备（CLI/管理员操作写 devices.json）
    assert.equal(devices.revoke(created.device.id), true);

    const detail = await request(server.port, 'GET', '/tasks', { headers: { Cookie: session.session } });
    assert.equal(detail.status, 401, 'revoked device session must fail immediately');
    const preview = await request(server.previewPort, 'GET', '/p/demo/', {
      headers: { Cookie: session.preview },
    });
    assert.equal(preview.status, 401, 'revoked device preview ticket must fail immediately');

    // 新事件不应再送达已吊销设备的 SSE
    const before = stream.events.length;
    await submit(server.port, TOKEN, { text: 'BACKGROUND after revoke', projectId: 'demo' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(stream.events.length, before, 'revoked SSE must not receive further events');
  } finally {
    stream.close();
    await server.stop();
    removeWorkspace(root);
  }
});

function rejectsSeam(env) {
  return new Promise((resolve) => {
    const serverPath = path.join(__dirname, '..', 'server.cjs');
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, REMOTE_HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, out });
    }, 5000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

test('B10-C5/B-07: Serve/proxy mode refuses the test seam even on loopback', async () => {
  const publicHome = makeWorkspace('vplay-b10-seam-');
  const proxyHome = makeWorkspace('vplay-b10-seam2-');
  try {
    const publicMode = await rejectsSeam({
      VPLAY_PUBLIC_MODE: '1',
      REMOTE_ALLOW_TEST_SEAM: '1',
      PREVIEW_ACCESS_KEY: '0123456789abcdef',
      EVIDENCE_HMAC_KEY: 'fedcba9876543210',
      REMOTE_ALLOWED_HOSTS: 'timer009.tail199672.ts.net',
      VPLAY_HOME: publicHome,
    });
    assert.equal(publicMode.code, 1);
    assert.match(publicMode.out, /test seam/i);

    const proxyMode = await rejectsSeam({
      REMOTE_TRUST_PROXY: '1',
      REMOTE_ALLOW_TEST_SEAM: '1',
      PREVIEW_ACCESS_KEY: '0123456789abcdef',
      EVIDENCE_HMAC_KEY: 'fedcba9876543210',
      REMOTE_ALLOWED_HOSTS: 'timer009.tail199672.ts.net',
      VPLAY_HOME: proxyHome,
    });
    assert.equal(proxyMode.code, 1);
    assert.match(proxyMode.out, /test seam/i);
  } finally {
    removeWorkspace(publicHome);
    removeWorkspace(proxyHome);
  }
});

test('B10-C5: child process env is an explicit allowlist (no NODE_OPTIONS/HMAC/VPLAY)', () => {
  const env = buildChildEnv('task_x', {
    PATH: 'C:\\bin',
    SystemRoot: 'C:\\Windows',
    NODE_OPTIONS: '--require evil.js',
    OPENAI_API_KEY: 'sk-test',
    OPENAI_UNRELATED_SECRET: 'leak',
    DASHSCOPE_API_KEY: 'ds-test',
    EVIDENCE_HMAC_KEY: 'hmac-secret',
    VPLAY_HOME: 'C:\\home',
    REMOTE_TOKEN: 'token',
    GEMINI_API_KEY: 'gm-test',
  });
  assert.equal(env.OPENGAME_REMOTE_TASK_ID, 'task_x');
  assert.equal(env.PATH, 'C:\\bin');
  assert.equal(env.OPENAI_API_KEY, 'sk-test');
  assert.equal(env.DASHSCOPE_API_KEY, 'ds-test');
  assert.equal(env.GEMINI_API_KEY, 'gm-test');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.OPENAI_UNRELATED_SECRET, undefined);
  assert.equal(env.EVIDENCE_HMAC_KEY, undefined);
  assert.equal(env.VPLAY_HOME, undefined);
  assert.equal(env.REMOTE_TOKEN, undefined);
});

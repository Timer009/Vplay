'use strict';

/**
 * Sprint 02 安全回归套件（对应 Qoder 审计 P0/P1 条目）。
 * 全部使用虚拟凭据与临时工作区，不访问外部系统。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  jsonHeaders,
  postPrompt,
  waitFor,
} = require('./helpers.cjs');

const TOKEN = 'sec-token-abc123';
const FAKE_KEY = 'sk-dummy-e2e-key-1234';
const FIXTURES = path.join(__dirname, 'fixtures');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

function seedGame(workspace) {
  write(
    path.join(workspace, 'index.html'),
    '<style>:root{--bg: #101014}</style><h1>Game</h1>',
  );
}

async function waitTerminal(port, token, id, timeout = 20000) {
  return waitFor(
    async () => {
      const res = await request(port, 'GET', `/tasks/${id}`, {
        headers: jsonHeaders(token),
      });
      if (res.status !== 200) return null;
      const status = res.json.task.status;
      return ['succeeded', 'failed'].includes(status) ? res.json.task : null;
    },
    { timeout, interval: 150 },
  );
}

test('P0-4: worker inherits a minimal env and logs are redacted', async () => {
  const workspace = makeWorkspace('vplay-sec-env-');
  seedGame(workspace);
  const server = await startServer({
    workspace,
    token: TOKEN,
    env: {
      REMOTE_EXECUTOR_CMD: path.join(FIXTURES, 'env-dump.cjs'),
      OPENAI_API_KEY: FAKE_KEY,
      VPLAY_HOME: 'C:\\should-not-leak',
    },
  });
  try {
    const created = await postPrompt(server.port, TOKEN, { text: 'dump env' });
    const task = await waitTerminal(server.port, TOKEN, created.json.task.id);
    assert.equal(task.status, 'succeeded');

    const dump = JSON.parse(fs.readFileSync(path.join(workspace, 'env-dump.json'), 'utf-8'));
    assert.equal(dump.hasRemoteToken, false, 'REMOTE_TOKEN must not reach the CLI');
    assert.equal(dump.hasRemoteTokenFile, false);
    assert.equal(dump.hasRemoteExecutor, false);
    assert.equal(dump.hasVplayHome, false);
    assert.equal(dump.hasTaskId, true, 'task id should be passed through');

    const log = await request(server.port, 'GET', `/tasks/${task.id}/log`, {
      headers: jsonHeaders(TOKEN),
    });
    assert.equal(log.status, 200);
    assert.equal(log.text.includes(TOKEN), false, 'token must never appear in logs');
    assert.equal(log.text.includes(FAKE_KEY), false, 'api key must be redacted');
    assert.match(log.text, /OPENAI_API_KEY=\*\*\*/);
  } finally {
    await server.stop();
    removeWorkspace(workspace);
  }
});

test('P1-4: exit 0 without file changes is not reported as verified success', async () => {
  const workspace = makeWorkspace('vplay-sec-noop-');
  seedGame(workspace);
  const server = await startServer({
    workspace,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: path.join(FIXTURES, 'noop.cjs') },
  });
  try {
    const created = await postPrompt(server.port, TOKEN, { text: 'do nothing' });
    const task = await waitTerminal(server.port, TOKEN, created.json.task.id);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.result.noChanges, true);
    assert.equal(task.result.outcome, 'no_changes');
    assert.equal(task.result.verified, false);
    assert.deepEqual(task.result.changedFiles, { added: 0, removed: 0, modified: 0 });
  } finally {
    await server.stop();
    removeWorkspace(workspace);
  }
});

test('P1-4: stale post-verify results are rejected', async () => {
  const workspace = makeWorkspace('vplay-sec-stale-');
  seedGame(workspace);
  const staleFile = path.join(workspace, '.opengame', 'post-verify.json');
  write(
    staleFile,
    JSON.stringify({
      taskId: 'task_from_last_week',
      checkedImports: 0,
      checkedAssets: 0,
      fixedCount: 0,
      issues: [],
    }),
  );
  const old = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  fs.utimesSync(staleFile, old, old);

  const server = await startServer({
    workspace,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: path.join(FIXTURES, 'noop.cjs') },
  });
  try {
    const created = await postPrompt(server.port, TOKEN, { text: 'noop again' });
    const task = await waitTerminal(server.port, TOKEN, created.json.task.id);
    assert.equal(task.result.verification.postVerifyStale, true);
    assert.equal(task.result.postVerify, null);
    assert.equal(task.result.verified, false);
  } finally {
    await server.stop();
    removeWorkspace(workspace);
  }
});

test('P1-2: session cookie is random, revocable and not the master token', async () => {
  const workspace = makeWorkspace('vplay-sec-session-');
  seedGame(workspace);
  const server = await startServer({ workspace, token: TOKEN });
  try {
    const first = await request(server.port, 'POST', '/auth/verify', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    assert.equal(first.status, 200);
    const cookieA = String([].concat(first.headers['set-cookie'])[0] || '');
    assert.match(cookieA, /HttpOnly/);
    assert.match(cookieA, /SameSite=Strict/);
    assert.equal(cookieA.includes(encodeURIComponent(TOKEN)), false);
    assert.equal(/%2B|%2F/.test(cookieA), false, 'session id must be url-safe');

    const second = await request(server.port, 'POST', '/auth/verify', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookieB = String([].concat(second.headers['set-cookie'])[0] || '');
    assert.notEqual(cookieA.split(';')[0], cookieB.split(';')[0], 'sessions must be unique');

    const jar = cookieA.split(';')[0];
    const status = await request(server.port, 'GET', '/status', {
      headers: { Cookie: jar },
    });
    assert.equal(status.status, 200);

    const logout = await request(server.port, 'POST', '/auth/logout', {
      headers: { Cookie: jar, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(logout.status, 200);

    const after = await request(server.port, 'GET', '/status', {
      headers: { Cookie: jar },
    });
    assert.equal(after.status, 401, 'session must be revoked server-side');
  } finally {
    await server.stop();
    removeWorkspace(workspace);
  }
});

test('P1-1: login brute force is throttled without consuming the task bucket', async () => {
  const workspace = makeWorkspace('vplay-sec-rate-');
  seedGame(workspace);
  const server = await startServer({
    workspace,
    token: TOKEN,
    env: { REMOTE_LOGIN_RATE_LIMIT: '5' },
  });
  try {
    const codes = [];
    for (let i = 0; i < 9; i += 1) {
      const res = await request(server.port, 'POST', '/auth/verify', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: `wrong-${i}` }),
      });
      codes.push(res.status);
    }
    assert.ok(codes.includes(429), `expected a 429, got ${JSON.stringify(codes)}`);

    const prompt = await postPrompt(server.port, TOKEN, { text: 'legit after brute force' });
    assert.equal(prompt.status, 202, 'task bucket must be independent from login bucket');
  } finally {
    await server.stop();
    removeWorkspace(workspace);
  }
});

test('P1-3: spoofed Host is rejected and /health leaks nothing', async () => {
  const workspace = makeWorkspace('vplay-sec-host-');
  seedGame(workspace);
  const server = await startServer({ workspace, token: TOKEN });
  try {
    const spoofed = await request(server.port, 'GET', '/health', {
      headers: { Host: 'attacker.example' },
    });
    assert.equal(spoofed.status, 400);
    assert.equal(spoofed.text.includes(workspace), false);

    const normal = await request(server.port, 'GET', '/health');
    assert.equal(normal.status, 200);
    assert.deepEqual(Object.keys(normal.json).sort(), [
      'ok',
      'remoteEnabled',
      'service',
      'version',
    ]);
    assert.equal(normal.text.includes(workspace), false);
    assert.equal(normal.text.includes('workspace'), false);
  } finally {
    await server.stop();
    removeWorkspace(workspace);
  }
});

test('P0-1/P0-2: preview only serves whitelisted files from the isolated dir', async () => {
  const workspace = makeWorkspace('vplay-sec-static-');
  const sibling = makeWorkspace('vplay-sec-sibling-');
  write(path.join(workspace, 'index.html'), '<h1>ok</h1>');
  write(path.join(workspace, 'notes.txt'), 'notes');
  write(path.join(workspace, 'secret.pem'), 'PRIVATE-KEY');
  write(path.join(workspace, '.env'), 'OPENAI_API_KEY=sk-leak');
  write(path.join(sibling, 'secret.txt'), 'SIBLING_ESCAPE_OK');

  const server = await startServer({ workspace, token: TOKEN, env: { REMOTE_AUTORUN: '0' } });
  try {
    assert.equal((await request(server.previewPort, 'GET', '/legacy/index.html')).status, 200);
    assert.equal((await request(server.previewPort, 'GET', '/legacy/notes.txt')).status, 200);
    assert.equal((await request(server.previewPort, 'GET', '/legacy/secret.pem')).status, 404);
    assert.equal((await request(server.previewPort, 'GET', '/legacy/.env')).status, 403);

    for (const url of [
      '/legacy/..%2f..%2fsecret.txt',
      '/legacy/..%2f' + path.basename(sibling) + '%2fsecret.txt',
      '/legacy/%2e%2e%2f%2e%2e%2fsecret.txt',
    ]) {
      const res = await request(server.previewPort, 'GET', url);
      assert.notEqual(res.status, 200, url);
      assert.doesNotMatch(res.text, /SIBLING_ESCAPE_OK/);
    }
  } finally {
    await server.stop();
    removeWorkspace(workspace);
    removeWorkspace(sibling);
  }
});

test('P1-6: a second server on the same workspace refuses to start', async () => {
  const workspace = makeWorkspace('vplay-sec-lock-');
  seedGame(workspace);
  const first = await startServer({ workspace, token: TOKEN, env: { REMOTE_AUTORUN: '0' } });
  try {
    const port2 = first.port + 1000;
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'server.cjs'), '--port', String(port2)],
      {
        cwd: path.join(__dirname, '..', '..'),
        env: {
          ...process.env,
          REMOTE_PORT: String(port2),
          PREVIEW_PORT: String(port2 + 1),
          REMOTE_HOST: '127.0.0.1',
          OPENGAME_WORKSPACE: workspace,
          REMOTE_TOKEN: TOKEN,
          REMOTE_ALLOW_TEST_SEAM: '1',
          // B22：完整开发模式需显式开启；否则默认受限会在锁检查前退出。
          VPLAY_RESTRICTED_DEPLOYMENT: '0',
          VPLAY_APPROVAL_HMAC_KEY: 'vplay-test-approval-key-0123456789abcdef',
          VPLAY_MODEL_PROXY_URL: 'http://127.0.0.1:18900/v1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));

    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve('timeout');
      }, 10000);
      child.on('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    assert.equal(code, 1, output);
    assert.match(output, /already using this workspace/);
  } finally {
    await first.stop();
    removeWorkspace(workspace);
  }
});

test('P2-2: artifact responses contain no absolute workspace paths', async () => {
  const workspace = makeWorkspace('vplay-sec-paths-');
  seedGame(workspace);
  const server = await startServer({ workspace, token: TOKEN, env: { REMOTE_AUTORUN: '0' } });
  try {
    const artifact = await request(server.port, 'GET', '/artifact', {
      headers: jsonHeaders(TOKEN),
    });
    assert.equal(artifact.status, 200);
    assert.equal(artifact.json.previewPath, '/legacy/');
    assert.equal(Object.prototype.hasOwnProperty.call(artifact.json, 'workspace'), false);
    assert.equal(artifact.text.includes(workspace), false);
  } finally {
    await server.stop();
    removeWorkspace(workspace);
  }
});

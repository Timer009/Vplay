'use strict';

/**
 * C07 定向回归（Sprint03A 安全基础）。
 * 全部使用临时目录、虚拟工程与一次性 token；不调用真实模型。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createProjectRegistry } = require('../lib/projects.cjs');
const { resolveApprovalMode } = require('../lib/worker.cjs');
const {
  scanPatchContent,
  validatePatchFiles,
  applyPatchAtomically,
  isAllowedBrowserUrl,
} = require('../lib/vision-policy.cjs');
const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  jsonHeaders,
  waitFor,
} = require('./helpers.cjs');

const TOKEN = 'c07-token';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeStaticProject(root) {
  write(path.join(root, 'index.html'), '<style>:root{--bg:#101014}</style><h1>c07</h1>');
  write(path.join(root, 'assets', 'token.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
  return root;
}

function makeViteProject(root) {
  write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'vite-demo', scripts: { build: 'node build.cjs' } }, null, 2),
  );
  write(path.join(root, 'vite.config.js'), 'module.exports = {};\n');
  write(path.join(root, 'index.html'), '<div id="app"></div>');
  write(path.join(root, 'content.txt'), 'ORIGINAL');
  write(
    path.join(root, 'build.cjs'),
    [
      "const fs=require('fs');const path=require('path');",
      "const body=fs.readFileSync(path.join(__dirname,'content.txt'),'utf8');",
      "fs.mkdirSync(path.join(__dirname,'dist'),{recursive:true});",
      "fs.writeFileSync(path.join(__dirname,'dist','index.html'),'<h1>'+body+'</h1>');",
    ].join('\n'),
  );
  return root;
}

test('C07-P0-01: yolo requires public=false + env opt-in + per-task flag', () => {
  assert.equal(resolveApprovalMode({ publicMode: true, allowYolo: true, task: { allowYolo: true } }), 'auto-edit');
  assert.equal(resolveApprovalMode({ publicMode: false, allowYolo: false, task: { allowYolo: true } }), 'auto-edit');
  assert.equal(resolveApprovalMode({ publicMode: false, allowYolo: true, task: {} }), 'auto-edit');
  assert.equal(resolveApprovalMode({ publicMode: false, allowYolo: true, task: { allowYolo: true } }), 'yolo');
});

test('C07-P0-03: project lock is atomic, owner-scoped and crash-recoverable', () => {
  const root = makeWorkspace('vplay-c07-lock-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    registry.importProject({ sourceDir: makeStaticProject(path.join(root, 'src')), id: 'demo' });

    const first = registry.acquireLock('demo', { taskId: 'task_1' });
    assert.ok(first.token);
    assert.throws(() => registry.acquireLock('demo', { taskId: 'task_2' }), /占用/);
    assert.equal(registry.releaseLock('demo', 'wrong-token'), false, 'must not release others lock');
    assert.equal(registry.readLock('demo').token, first.token);
    assert.equal(registry.touchLock('demo', 'wrong-token'), false);
    assert.equal(registry.touchLock('demo', first.token), true);
    assert.equal(registry.releaseLock('demo', first.token), true);
    assert.equal(registry.readLock('demo'), null);

    // 死进程残留锁：下一次 acquire 必须自动回收
    const lockFile = path.join(home, 'runtime', 'locks', 'demo.lock');
    write(
      lockFile,
      JSON.stringify({ id: 'demo', pid: 999999, taskId: 'dead', token: 'dead-token', at: new Date().toISOString() }),
    );
    const reclaimed = registry.acquireLock('demo', { taskId: 'task_3' });
    assert.notEqual(reclaimed.token, 'dead-token');
    assert.equal(registry.releaseLock('demo', reclaimed.token), true);

    // 超过硬 TTL 的活进程锁同样允许回收
    write(
      lockFile,
      JSON.stringify({
        id: 'demo',
        pid: process.pid,
        taskId: 'stale',
        token: 'stale-token',
        at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        heartbeatAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      }),
    );
    const fresh = registry.acquireLock('demo', { taskId: 'task_4' });
    assert.equal(registry.releaseLock('demo', fresh.token), true);
  } finally {
    removeWorkspace(root);
  }
});

test('C07-P0-04: Vite rollback rebuilds dist and verifies full preview manifest', async () => {
  const root = makeWorkspace('vplay-c07-vite-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    const imported = registry.importProject({
      sourceDir: makeViteProject(path.join(root, 'src')),
      id: 'vite-demo',
    });
    const record = imported.project;
    assert.equal(record.kind, 'vite');

    const built = registry.buildProject(registry.get('vite-demo'));
    assert.equal(built.ok, true, built.stderr);
    assert.ok(registry.buildPreview('vite-demo'));
    assert.equal(registry.verifyPreview('vite-demo').ok, true);

    write(path.join(record.srcDir, 'content.txt'), 'MODIFIED');
    assert.equal(registry.buildProject(registry.get('vite-demo')).ok, true);
    assert.ok(registry.buildPreview('vite-demo'));
    assert.match(fs.readFileSync(path.join(record.srcDir, 'dist', 'index.html'), 'utf8'), /MODIFIED/);

    const rolled = await registry.rollback('vite-demo', 1);
    assert.equal(rolled.verified, true);
    assert.equal(rolled.previewReady, true);
    assert.ok(rolled.build && rolled.build.ok, 'rollback must rebuild vite output');
    assert.match(
      fs.readFileSync(path.join(record.srcDir, 'dist', 'index.html'), 'utf8'),
      /ORIGINAL/,
      'dist must be rebuilt from restored source',
    );
    assert.equal(registry.verifyPreview('vite-demo').ok, true);
  } finally {
    removeWorkspace(root);
  }
});

test('C07-P1-06/ORD-11: full manifest detects stale preview and previewRoot never builds on read', () => {
  const root = makeWorkspace('vplay-c07-preview-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    const imported = registry.importProject({
      sourceDir: makeStaticProject(path.join(root, 'src')),
      id: 'demo',
    });
    const src = imported.project.srcDir;
    assert.ok(registry.previewRoot('demo'), 'import should prewarm preview');
    assert.equal(registry.verifyPreview('demo').ok, true);

    write(path.join(src, 'index.html'), '<h1>changed without rebuild</h1>');
    assert.equal(registry.verifyPreview('demo').ok, false, 'stale preview must be detected');
    assert.ok(registry.buildPreview('demo'));
    assert.equal(registry.verifyPreview('demo').ok, true);

    fs.rmSync(path.join(home, 'projects', 'demo', '.preview'), { recursive: true, force: true });
    assert.equal(registry.previewRoot('demo'), null, 'GET must not trigger build');
  } finally {
    removeWorkspace(root);
  }
});

test('C07-P0-05/P1-05/P1-11: patch policy rejects bypasses, links and non-atomic paths', () => {
  const root = makeWorkspace('vplay-c07-policy-');
  try {
    const project = makeStaticProject(path.join(root, 'project'));
    const allowed = ['index.html'];

    for (const snippet of [
      '<script>fetch("https://evil.example")</script>',
      '<script src="//evil.example/x.js"></script>',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      '<iframe src="https://evil.example"></iframe>',
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">x</a>',
      '<script>eval("1")</script>',
      '<script>import("https://evil.example/m.js")</script>',
    ]) {
      const scan = scanPatchContent(snippet);
      assert.equal(scan.ok, false, `must reject: ${snippet}`);
    }
    assert.equal(scanPatchContent('<style>:root{--bg:#222}</style>').ok, true);

    assert.throws(
      () => validatePatchFiles(project, [{ file: '../escape.js', content: 'x' }], ['../escape.js']),
      /PATH|escape|segment/i,
    );
    assert.throws(
      () => validatePatchFiles(project, [{ file: 'index.html', content: '<iframe></iframe>' }], allowed),
      /unsafe content/i,
    );

    const outside = path.join(root, 'outside.txt');
    write(outside, 'outside');
    const link = path.join(project, 'assets-link');
    fs.symlinkSync(path.dirname(outside), link, 'junction');
    assert.throws(
      () => validatePatchFiles(project, [{ file: 'assets-link/evil.txt', content: 'x' }], ['assets-link/evil.txt']),
      /symlink/i,
    );

    const journal = path.join(project, '.opengame', 'vision-apply.json');
    const result = applyPatchAtomically({
      root: project,
      files: [{ file: 'index.html', content: '<h1>ok</h1>' }],
      allowedFiles: allowed,
      journalFile: journal,
    });
    assert.equal(result[0].file, 'index.html');
    assert.equal(fs.readFileSync(path.join(project, 'index.html'), 'utf8'), '<h1>ok</h1>');
    assert.equal(fs.existsSync(journal), false, 'journal must be removed on success');

    assert.throws(
      () => applyPatchAtomically({
        root: project,
        files: [{ file: 'index.html', content: '<script>fetch("https://evil.example")</script>' }],
        allowedFiles: allowed,
      }),
      /unsafe content/i,
    );
    assert.equal(fs.readFileSync(path.join(project, 'index.html'), 'utf8'), '<h1>ok</h1>', 'rejected patch must not write');

    assert.equal(isAllowedBrowserUrl('http://127.0.0.1:8788/p/demo/', 'http://127.0.0.1:8788'), true);
    assert.equal(isAllowedBrowserUrl('http://127.0.0.1:8788.evil.example/', 'http://127.0.0.1:8788'), false);
    assert.equal(isAllowedBrowserUrl('https://evil.example/', 'http://127.0.0.1:8788'), false);
    assert.equal(isAllowedBrowserUrl('file:///C:/Windows/win.ini', 'http://127.0.0.1:8788'), false);
    assert.equal(isAllowedBrowserUrl('data:text/html,x', 'http://127.0.0.1:8788'), false);
  } finally {
    removeWorkspace(root);
  }
});

test('C07-P0-05: preview responses carry a script-level CSP', async () => {
  const root = makeWorkspace('vplay-c07-csp-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: makeStaticProject(path.join(root, 'src')), id: 'demo' });
  const server = await startServer({ workspace: path.join(root, 'workspace'), home, token: TOKEN, env: { REMOTE_AUTORUN: '0' } });
  try {
    const res = await request(server.previewPort, 'GET', '/p/demo/');
    assert.equal(res.status, 200);
    const csp = String(res.headers['content-security-policy'] || '');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self' 'unsafe-inline'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('C07-P1-03: failed task never replaces the last known good preview', async () => {
  const root = makeWorkspace('vplay-c07-nopublish-');
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: makeStaticProject(path.join(root, 'src')), id: 'demo' });
  const entry = path.join(home, 'projects', 'demo', '.preview', 'index.html');
  const before = fs.readFileSync(entry, 'utf8');

  const failing = path.join(root, 'fail-executor.cjs');
  write(failing, 'process.stdout.write("fail\\n"); process.exit(1);\n');

  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: failing },
  });
  try {
    const created = await request(server.port, 'POST', '/prompt', {
      headers: jsonHeaders(TOKEN),
      body: JSON.stringify({ text: 'failing task', projectId: 'demo' }),
    });
    assert.ok([200, 202].includes(created.status));
    const id = created.json.task.id;
    await waitFor(async () => {
      const res = await request(server.port, 'GET', `/tasks/${id}`, { headers: jsonHeaders(TOKEN) });
      return ['failed', 'interrupted', 'succeeded'].includes(res.json && res.json.task && res.json.task.status);
    });
    const detail = await request(server.port, 'GET', `/tasks/${id}`, { headers: jsonHeaders(TOKEN) });
    assert.equal(detail.json.task.status, 'failed');
    assert.equal(fs.readFileSync(entry, 'utf8'), before, 'failed task must keep the previous preview');
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('C07-P1-01/P1-02: optional preview auth and cross-site GET blocking', async () => {
  const crypto = require('crypto');
  const root = makeWorkspace('vplay-c07-preview-auth-');
  const home = path.join(root, 'home');
  createProjectRegistry({ home }).importProject({
    sourceDir: makeStaticProject(path.join(root, 'src')),
    id: 'demo',
  });
  const server = await startServer({
    workspace: path.join(root, 'workspace'),
    home,
    token: TOKEN,
    env: { REMOTE_AUTORUN: '0', PREVIEW_ACCESS_KEY: 'preview-key-123' },
  });
  try {
    const anon = await request(server.previewPort, 'GET', '/p/demo/');
    assert.equal(anon.status, 401);

    const login = await request(server.port, 'POST', '/auth/verify', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    const setCookies = [].concat(login.headers['set-cookie'] || []).map(String);
    const previewCookie = setCookies.find((item) => item.startsWith('vplay_preview='));
    assert.ok(previewCookie, 'login must issue preview cookie');
    const previewValue = previewCookie.split(';')[0].split('=')[1];
    assert.notEqual(
      previewValue,
      crypto.createHash('sha256').update('preview-key-123').digest('hex'),
      'B10: preview cookie must be an opaque ticket, not a static key hash',
    );

    const authed = await request(server.previewPort, 'GET', '/p/demo/', {
      headers: { Cookie: `vplay_preview=${previewValue}` },
    });
    assert.equal(authed.status, 200);

    // B10 / C09 B-09：登出后票据立即吊销（即使客户端仍持有旧 cookie）
    const logout = await request(server.port, 'POST', '/auth/logout', {
      headers: { Cookie: `vplay_session=${String(login.headers['set-cookie']).match(/vplay_session=([^;]+)/)[1]}` },
    });
    assert.equal(logout.status, 200);
    const stale = await request(server.previewPort, 'GET', '/p/demo/', {
      headers: { Cookie: `vplay_preview=${previewValue}` },
    });
    assert.equal(stale.status, 401, 'revoked preview ticket must be rejected');

    const crossSite = await request(server.port, 'GET', '/projects', {
      headers: { ...jsonHeaders(TOKEN), 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);
    const sameSite = await request(server.port, 'GET', '/projects', {
      headers: { ...jsonHeaders(TOKEN), 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(sameSite.status, 200);
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

test('C07-P0-02: test seam refuses non-loopback binding', async () => {
  const { spawn } = require('child_process');
  const serverPath = path.join(__dirname, '..', 'server.cjs');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      REMOTE_HOST: '0.0.0.0',
      REMOTE_PORT: '0',
      PREVIEW_PORT: '0',
      REMOTE_TOKEN: 'guard-token',
      REMOTE_ALLOW_TEST_SEAM: '1',
      REMOTE_AUTORUN: '0',
      VPLAY_HOME: makeWorkspace('vplay-c07-guard-'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 1, output);
  assert.match(output, /refuse to start/i);
});

test('C07-P1-09: sessions are bound to token fingerprint and can be revoked', async () => {
  const root = makeWorkspace('vplay-c07-session-');
  const home = path.join(root, 'home');
  createProjectRegistry({ home }).importProject({
    sourceDir: makeStaticProject(path.join(root, 'src')),
    id: 'demo',
  });
  const server = await startServer({ workspace: path.join(root, 'workspace'), home, token: TOKEN, env: { REMOTE_AUTORUN: '0' } });
  try {
    const login = await request(server.port, 'POST', '/auth/verify', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
    assert.ok(cookie.startsWith('vplay_session='));

    const withSession = await request(server.port, 'GET', '/projects', { headers: { Cookie: cookie } });
    assert.equal(withSession.status, 200);

    // Session 不能调用 revoke-all（必须主 token）
    const denied = await request(server.port, 'POST', '/auth/revoke-all', {
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 403);

    const revoked = await request(server.port, 'POST', '/auth/revoke-all', {
      headers: jsonHeaders(TOKEN),
      body: '{}',
    });
    assert.equal(revoked.status, 200);
    assert.ok(revoked.json.revoked >= 1);

    const after = await request(server.port, 'GET', '/projects', { headers: { Cookie: cookie } });
    assert.equal(after.status, 401);

    // 通过 Session 申请 yolo 必须被拒绝
    const login2 = await request(server.port, 'POST', '/auth/verify', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie2 = String(login2.headers['set-cookie'] || '').split(';')[0];
    const yolo = await request(server.port, 'POST', '/prompt', {
      headers: { Cookie: cookie2, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'yolo?', projectId: 'demo', allowYolo: true }),
    });
    assert.equal(yolo.status, 403);
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

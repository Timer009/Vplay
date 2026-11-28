'use strict';

/**
 * B21：受限部署强制策略与集成接口（Windows 定点正负测试）。
 *
 * 覆盖：
 *  - 部署级策略解析 fail-closed；
 *  - 受限 CLI 参数补 MCP/扩展关闭；
 *  - spawn 前策略（非 restricted / 未审批 / Vision 范围漂移）；
 *  - /prompt 与 Vision 入口缺省/显式 false 都不能降级；
 *  - 审批前零 spawn、设备/匿名不能自批、rejected 终态；
 *  - prepare-lab --all-tracked 完整清单 + 双哈希保真。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTaskStore } = require('../lib/tasks.cjs');
const { createWorker } = require('../lib/worker.cjs');
const { createApprovalProof } = require('../lib/approval.cjs');
const {
  parseRestrictedDeployment,
  evaluateSpawnPolicy,
  restrictedCliArgs,
} = require('../lib/linux-config.cjs');
const { prepareLab } = require('../tools/prepare-lab.cjs');
const { createProjectRegistry } = require('../lib/projects.cjs');
const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  waitFor,
  readStarts,
  EXECUTOR,
} = require('./helpers.cjs');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeStore(root) {
  return createTaskStore({
    runtimeDir: path.join(root, '.opengame'),
    workspaceDir: root,
  });
}

function restrictedTask(store, text, extra = {}) {
  const task = store.create({ text, restricted: true, ...extra }).task;
  assert.equal(task.status, 'awaiting_approval');
  return task;
}

test('B21-policy: restricted deployment parsing is fail-closed on unknown values', () => {
  // B22：未设置/空值默认进入受限部署；只有显式 off 值才开启完整开发模式。
  assert.equal(parseRestrictedDeployment(undefined), true);
  assert.equal(parseRestrictedDeployment(''), true);
  for (const off of ['0', 'false', 'FALSE', 'off', 'no', 'full', 'dev']) {
    assert.equal(parseRestrictedDeployment(off), false, off);
  }
  for (const on of ['1', 'true', 'yes', 'on', '2', 'restricted', 'typo']) {
    assert.equal(parseRestrictedDeployment(on), true, on);
  }
});

test('B21-policy: restricted CLI args also disable MCP servers and extensions', () => {
  const args = restrictedCliArgs();
  assert.ok(args.includes('--allowed-mcp-server-names='));
  assert.ok(args.includes('--extensions=none'));
});

test('B21-policy: spawn policy rejects bypass paths', () => {
  assert.equal(
    evaluateSpawnPolicy({ id: 't', status: 'queued', restricted: false }, { restrictedDeployment: true }).code,
    'RESTRICTED_DEPLOYMENT_REQUIRED',
  );
  assert.equal(
    evaluateSpawnPolicy({ id: 't', status: 'queued', restricted: true, approval: { state: 'pending' } }).code,
    'APPROVAL_REQUIRED',
  );
  assert.equal(
    evaluateSpawnPolicy({ id: 't', status: 'queued', restricted: false }).ok,
    true,
  );

  const vision = {
    id: 'v',
    status: 'queued',
    kind: 'vision',
    restricted: true,
    allowedFiles: ['index.html'],
    approval: { state: 'approved', scope: { allowedFiles: ['game.js'] } },
  };
  assert.equal(evaluateSpawnPolicy(vision).code, 'VISION_SCOPE_MISMATCH');
  vision.approval.scope.allowedFiles = ['index.html'];
  assert.equal(evaluateSpawnPolicy(vision).ok, true);
});

test('B21 API: restricted deployment forces approval for /prompt regardless of payload', async () => {
  const root = makeWorkspace('vplay-b21-api-');
  const token = 'b21-admin-token-0123456789';
  let server;
  try {
    server = await startServer({
      workspace: root,
      token,
      autorun: false,
      env: { VPLAY_RESTRICTED_DEPLOYMENT: '1', REMOTE_EXECUTOR_CMD: EXECUTOR },
    });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const status = await request(server.port, 'GET', '/status', { headers });
    assert.equal(status.json.restrictedDeployment, true);
    const health = await request(server.port, 'GET', '/health');
    assert.equal(health.json.restrictedDeployment, undefined, 'public /health stays minimal');

    const omitted = await request(server.port, 'POST', '/prompt', {
      headers,
      body: JSON.stringify({ text: 'omitted restricted flag' }),
    });
    assert.equal(omitted.status, 202);
    assert.equal(omitted.json.task.restricted, true);
    assert.equal(omitted.json.task.status, 'awaiting_approval');

    const explicitFalse = await request(server.port, 'POST', '/prompt', {
      headers,
      body: JSON.stringify({ text: 'explicit false flag', restricted: false }),
    });
    assert.equal(explicitFalse.status, 202);
    assert.equal(explicitFalse.json.task.restricted, true);
    assert.equal(explicitFalse.json.task.status, 'awaiting_approval');

    assert.equal(fs.existsSync(path.join(root, 'executions.jsonl')), false, 'approval must precede spawn');

    const id = omitted.json.task.id;
    const anonymous = await request(server.port, 'POST', `/tasks/${id}/approve`);
    assert.equal(anonymous.status, 401);
    const approved = await request(server.port, 'POST', `/tasks/${id}/approve`, { headers });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.task.status, 'queued');
    const again = await request(server.port, 'POST', `/tasks/${id}/approve`, { headers });
    assert.equal(again.status, 409);

    const rejected = await request(
      server.port,
      'POST',
      `/tasks/${explicitFalse.json.task.id}/reject`,
      { headers },
    );
    assert.equal(rejected.status, 200);
    assert.equal(rejected.json.task.status, 'rejected');
    const revive = await request(
      server.port,
      'POST',
      `/tasks/${explicitFalse.json.task.id}/approve`,
      { headers },
    );
    assert.equal(revive.status, 409, 'rejected tasks must not be re-queued');
    assert.equal(fs.existsSync(path.join(root, 'executions.jsonl')), false, 'no spawn before approve/run');
  } finally {
    if (server) await server.stop();
    removeWorkspace(root);
  }
});

test('B21 API: restricted deployment forces approval and explicit scope for Vision writes', async () => {
  const root = makeWorkspace('vplay-b21-vision-');
  const home = path.join(root, 'home');
  const token = 'b21-vision-token-0123456789';
  const registry = createProjectRegistry({ home });
  const src = path.join(root, 'src');
  write(path.join(src, 'index.html'), '<!doctype html><html><body>demo</body></html>\n');
  registry.importProject({ sourceDir: src, id: 'demo' });
  let server;
  try {
    server = await startServer({
      workspace: path.join(root, 'workspace'),
      home,
      token,
      autorun: false,
      env: { VPLAY_RESTRICTED_DEPLOYMENT: '1' },
    });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const created = await request(server.port, 'POST', '/projects/demo/vision', {
      headers,
      body: JSON.stringify({ mode: 'repair' }),
    });
    assert.equal(created.status, 202);
    assert.equal(created.json.task.kind, 'vision');
    assert.equal(created.json.task.restricted, true);
    assert.equal(created.json.task.status, 'awaiting_approval');
    assert.deepEqual(created.json.task.allowedFiles, ['index.html'], 'scope must be non-empty');

    const badScope = await request(server.port, 'POST', '/projects/demo/vision', {
      headers,
      body: JSON.stringify({ mode: 'repair', allowedFiles: ['game.js'] }),
    });
    assert.equal(badScope.status, 400, 'JS scope must be rejected, not silently replaced');

    const approved = await request(
      server.port,
      'POST',
      `/tasks/${created.json.task.id}/approve`,
      { headers },
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.json.task.status, 'queued');
    assert.deepEqual(approved.json.task.approval.scope.allowedFiles, ['index.html']);
    assert.equal(approved.json.task.approval.scope.visionMode, 'repair');
    assert.equal(fs.existsSync(path.join(root, 'workspace', 'executions.jsonl')), false);
  } finally {
    if (server) await server.stop();
    removeWorkspace(root);
  }
});

test('B21 worker: fails closed for legacy non-restricted and unapproved restricted tasks', async () => {
  const root = makeWorkspace('vplay-b21-worker-');
  const store = makeStore(root);
  const legacy = store.create({ text: 'legacy unrestricted task' }).task;
  assert.equal(legacy.status, 'queued');
  const tampered = restrictedTask(store, 'restricted but never approved');
  // 模拟被篡改的 tasks.json：绕过审批直接置为 queued。
  store.transition(tampered.id, 'queued');

  const worker = createWorker({
    store,
    workspaceDir: root,
    runtimeDir: path.join(root, '.opengame'),
    cliPath: path.join(root, 'dist', 'cli.js'),
    executorScript: EXECUTOR,
    restrictedDeployment: true,
    logger: () => {},
  });
  try {
    worker.start();
    await waitFor(() => {
      const a = store.get(legacy.id);
      const b = store.get(tampered.id);
      return a.status === 'failed' && b.status === 'failed';
    });
    assert.equal(store.get(legacy.id).error.code, 'RESTRICTED_DEPLOYMENT_REQUIRED');
    assert.equal(store.get(tampered.id).error.code, 'APPROVAL_REQUIRED');
    assert.equal(readStarts(root).length, 0, 'blocked tasks must never spawn');
  } finally {
    worker.stop();
    removeWorkspace(root);
  }
});

test('B21 worker: approved restricted task spawns exactly once', async () => {
  const root = makeWorkspace('vplay-b21-worker-ok-');
  write(path.join(root, 'index.html'), '<!doctype html><html><body>legacy</body></html>\n');
  const store = makeStore(root);
  const task = restrictedTask(store, 'approved restricted task');
  const approvalKey = 'vplay-test-approval-key-0123456789abcdef';
  const proof = createApprovalProof({
    task,
    key: approvalKey,
    ttlMs: 10 * 60 * 1000,
    maxRuns: 1,
    model: 'qwen3-coder-plus',
    baseVersionId: null,
  }).proof;
  store.transition(task.id, 'queued', {
    approval: {
      state: 'approved',
      approvedAt: new Date().toISOString(),
      approvedBy: 'admin',
      rejectedAt: null,
      scope: { projectId: 'default', kind: 'prompt', visionMode: null, allowedFiles: null },
      proof,
    },
  });

  const worker = createWorker({
    store,
    workspaceDir: root,
    runtimeDir: path.join(root, '.opengame'),
    cliPath: path.join(root, 'dist', 'cli.js'),
    executorScript: EXECUTOR,
    restrictedDeployment: true,
    approvalKey,
    approvalModel: 'qwen3-coder-plus',
    restrictedProxy: { url: 'http://127.0.0.1:18900/v1', token: 'b21-proxy' },
    logger: () => {},
  });
  try {
    worker.start();
    await waitFor(() => store.get(task.id).status === 'succeeded');
    assert.equal(store.get(task.id).restricted, true);
    assert.equal(readStarts(root).length, 1);
  } finally {
    worker.stop();
    removeWorkspace(root);
  }
});

test('B21 prepare-lab: --all-tracked copies every tracked file with per-file double hashes', () => {
  const root = makeWorkspace('vplay-b21-lab-');
  try {
    const source = path.join(root, 'spacer-official');
    write(path.join(source, 'vector-lander', 'index.html'), '<h1>spacer</h1>\n');
    write(path.join(source, 'js', 'game.js'), 'console.log("game");\n');
    write(path.join(source, 'styles', 'main.css'), 'body { margin: 0; }\n');
    write(path.join(source, 'assets', 'tile.bin'), Buffer.from([0, 1, 2, 3, 255]));
    const git = (args) => spawnSync('git', [
      '-c', 'user.name=b21',
      '-c', 'user.email=b21@example.invalid',
      ...args,
    ], { cwd: source, encoding: 'utf8' });
    assert.equal(git(['init', '-q']).status, 0);
    assert.equal(git(['add', '.']).status, 0);
    assert.equal(git(['commit', '-q', '-m', 'fixture']).status, 0);
    const tracked = git(['ls-files', '-z']).stdout.split('\0').filter(Boolean).sort();

    const labRoot = path.join(root, 'lab', 'spacer');
    const { manifest } = prepareLab({
      sourceDir: source,
      labRoot,
      allTracked: true,
      projectId: 'spacer-lab',
    });
    assert.equal(manifest.mode, 'all-tracked');
    assert.equal(manifest.copied.fileCount, tracked.length);
    assert.deepEqual([...manifest.copied.files].sort(), tracked);
    assert.equal(manifest.fidelity.verified, true);

    for (const file of manifest.files) {
      assert.equal(file.copiedSha256, file.blobSha256, file.path);
      assert.match(file.blobSha256, /^[0-9a-f]{64}$/);
      assert.equal(
        fs.readFileSync(path.join(labRoot, ...file.path.split('/'))).length,
        file.blobBytes,
      );
      if (file.path !== 'assets/tile.bin') {
        assert.match(file.worktreeSha256 || '', /^[0-9a-f]{64}$/, `${file.path} worktree hash`);
      }
    }

    const onDisk = [];
    const walk = (dir, base) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, base);
        else onDisk.push(path.relative(base, full).split(path.sep).join('/'));
      }
    };
    walk(labRoot, labRoot);
    assert.deepEqual(
      onDisk.filter((name) => name !== 'manifest.json').sort(),
      tracked,
      'lab copy must not add or drop files',
    );

    assert.throws(
      () => prepareLab({ sourceDir: source, labRoot: path.join(source, 'inside'), allTracked: true }),
      /must not be inside sourceDir/,
    );
    assert.throws(
      () => prepareLab({ sourceDir: path.join(labRoot, 'x'), labRoot, allTracked: true }),
      /not empty|inside labRoot/,
    );
  } finally {
    removeWorkspace(root);
  }
});

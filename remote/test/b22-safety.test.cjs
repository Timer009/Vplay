'use strict';

/**
 * B22 / C19 B21-1..13 定点正负测试（Windows）。
 *
 * 覆盖：默认 fail-closed、审批防伪与绑定、重放/篡改、logPath 越界、
 * 受限 spawn 预检（.qwen / 代理 / 隔离 HOME）、继续会话与 yolo 禁止、
 * prepare-lab 父目录链接、证据封存。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { createTaskStore } = require('../lib/tasks.cjs');
const { createWorker, buildChildEnv, resolveApprovalMode, resolveContinue } = require('../lib/worker.cjs');
const {
  createApprovalProof,
  buildApprovalPayload,
  signApprovalPayload,
  verifyApprovalProof,
} = require('../lib/approval.cjs');
const { prepareLab } = require('../tools/prepare-lab.cjs');
const { sealEvidence, verifySeal } = require('../lib/evidence-seal.cjs');
const {
  REPO_ROOT,
  EXECUTOR,
  makeWorkspace,
  removeWorkspace,
  waitFor,
  readStarts,
} = require('./helpers.cjs');

const KEY = 'vplay-test-approval-key-0123456789abcdef';
const MODEL = 'qwen3-coder-plus';
const PROXY = { url: 'http://127.0.0.1:18900/v1', token: 'b22-proxy-token' };

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

function approvedTask(store, text, extra = {}) {
  const task = store.create({ text, restricted: true, ...extra }).task;
  const proof = createApprovalProof({
    task,
    key: KEY,
    ttlMs: 10 * 60 * 1000,
    maxRuns: 1,
    model: MODEL,
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
  return store.get(task.id);
}

function workerFor(root, store, extra = {}) {
  return createWorker({
    store,
    workspaceDir: root,
    runtimeDir: path.join(root, '.opengame'),
    cliPath: path.join(root, 'dist', 'cli.js'),
    executorScript: EXECUTOR,
    restrictedDeployment: true,
    approvalKey: KEY,
    approvalModel: MODEL,
    restrictedProxy: PROXY,
    logger: () => {},
    ...extra,
  });
}

test('B22-A1: restricted deployment is the default; missing dependencies refuse startup', async () => {
  const root = makeWorkspace('vplay-b22-start-');
  try {
    const env = { ...process.env };
    delete env.VPLAY_APPROVAL_HMAC_KEY;
    delete env.APPROVAL_HMAC_KEY;
    delete env.VPLAY_MODEL_PROXY_URL;
    env.VPLAY_RESTRICTED_DEPLOYMENT = '';
    env.REMOTE_HOST = '127.0.0.1';
    env.REMOTE_PORT = '0';
    env.OPENGAME_WORKSPACE = root;
    delete env.VPLAY_HOME;
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'remote', 'server.cjs')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 1, out);
    assert.match(out, /VPLAY_APPROVAL_HMAC_KEY/);
    assert.match(out, /VPLAY_MODEL_PROXY_URL/);
  } finally {
    removeWorkspace(root);
  }
});

test('B22-A2: signed approval binds task/content/model/base/expiry/runs', () => {
  const root = makeWorkspace('vplay-b22-proof-');
  try {
    const store = makeStore(root);
    const task = store.create({ text: 'signed restricted task', restricted: true }).task;
    const proof = createApprovalProof({
      task,
      key: KEY,
      ttlMs: 60 * 1000,
      maxRuns: 1,
      model: MODEL,
      baseVersionId: '003-uid',
    }).proof;
    const approval = { state: 'approved', proof };
    const ctx = { task, key: KEY, model: MODEL, baseVersionId: '003-uid' };
    assert.equal(verifyApprovalProof(approval, ctx).ok, true);

    const tamperedText = { ...task, text: 'changed after approval' };
    assert.equal(
      verifyApprovalProof(approval, { ...ctx, task: tamperedText }).reason,
      'APPROVAL_CONTENT_MISMATCH',
    );
    assert.equal(
      verifyApprovalProof(approval, { ...ctx, model: 'other-model' }).reason,
      'APPROVAL_MODEL_MISMATCH',
    );
    assert.equal(
      verifyApprovalProof(approval, { ...ctx, baseVersionId: '004-uid' }).reason,
      'APPROVAL_BASE_MISMATCH',
    );
    assert.equal(
      verifyApprovalProof(approval, { ...ctx, key: `${KEY}-other` }).reason,
      'APPROVAL_KEY_MISMATCH',
    );

    const runsPayload = buildApprovalPayload({
      task,
      ttlMs: 60 * 1000,
      maxRuns: 1,
      model: MODEL,
      baseVersionId: '003-uid',
      runs: 1,
    });
    const exhausted = {
      state: 'approved',
      proof: { alg: 'hmac-sha256', keyId: require('crypto').createHash('sha256').update(KEY).digest('hex').slice(0, 16), payload: runsPayload, signature: signApprovalPayload(runsPayload, KEY) },
    };
    assert.equal(verifyApprovalProof(exhausted, ctx).reason, 'APPROVAL_EXHAUSTED');

    const expired = createApprovalProof({
      task,
      key: KEY,
      ttlMs: -1000,
      maxRuns: 1,
      model: MODEL,
      baseVersionId: '003-uid',
    }).proof;
    assert.equal(
      verifyApprovalProof({ state: 'approved', proof: expired }, ctx).reason,
      'APPROVAL_EXPIRED',
    );
  } finally {
    removeWorkspace(root);
  }
});

test('B22-A2: tampered approval in tasks.json is blocked before spawn', async () => {
  const root = makeWorkspace('vplay-b22-tamper-');
  try {
    write(path.join(root, 'index.html'), '<!doctype html><html></html>\n');
    const store = makeStore(root);
    const task = approvedTask(store, 'tampered after approve');
    // 直接在内存/磁盘上篡改绑定内容
    store.patch(task.id, { text: 'tampered text after approval' });

    const worker = workerFor(root, store);
    try {
      worker.start();
      await waitFor(() => store.get(task.id).status === 'failed');
      assert.equal(store.get(task.id).error.code, 'APPROVAL_CONTENT_MISMATCH');
      assert.equal(readStarts(root).length, 0);
    } finally {
      worker.stop();
    }
  } finally {
    removeWorkspace(root);
  }
});

test('B22-A2: signed approval spawns once and consumes its run budget', async () => {
  const root = makeWorkspace('vplay-b22-run-');
  try {
    write(path.join(root, 'index.html'), '<!doctype html><html></html>\n');
    const store = makeStore(root);
    const task = approvedTask(store, 'approved once');
    const worker = workerFor(root, store);
    try {
      worker.start();
      await waitFor(() => store.get(task.id).status === 'succeeded');
      assert.equal(readStarts(root).length, 1);
      assert.equal(store.get(task.id).approval.proof.payload.runs, 1);
    } finally {
      worker.stop();
    }
  } finally {
    removeWorkspace(root);
  }
});

test('B22-A2: tasks.json logPath tamper cannot escape the runtime log dir', () => {
  const root = makeWorkspace('vplay-b22-logpath-');
  try {
    const runtimeDir = path.join(root, '.opengame');
    const store = makeStore(root);
    const { task } = store.create({ text: 'log path task' });
    const file = path.join(runtimeDir, 'remote', 'tasks.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    parsed.tasks[0].logPath = '../../escaped.log';
    fs.writeFileSync(file, JSON.stringify(parsed));

    const reopened = makeStore(root);
    assert.equal(
      reopened.get(task.id).logPath,
      `.opengame/remote/logs/${task.id}.log`,
      'logPath must be derived server-side',
    );
    reopened.appendLog(task.id, 'hello');
    assert.equal(fs.existsSync(path.join(root, 'escaped.log')), false);
    assert.match(reopened.readLog(task.id), /hello/);

    // 非法状态记录在加载时被丢弃
    parsed.tasks[0].status = 'rooted';
    fs.writeFileSync(file, JSON.stringify(parsed));
    assert.equal(makeStore(root).get(task.id), null);
  } finally {
    removeWorkspace(root);
  }
});

test('B22-A2: restricted spawn refuses workspace .qwen configuration', async () => {
  const root = makeWorkspace('vplay-b22-qwen-');
  try {
    write(path.join(root, 'index.html'), '<!doctype html><html></html>\n');
    write(path.join(root, '.qwen', 'settings.json'), '{"coreTools":["run_shell_command"]}\n');
    const store = makeStore(root);
    const task = approvedTask(store, 'qwen injection attempt');
    const worker = workerFor(root, store);
    try {
      worker.start();
      await waitFor(() => store.get(task.id).status === 'failed');
      assert.equal(store.get(task.id).error.code, 'WORKSPACE_CONFIG_PRESENT');
      assert.equal(readStarts(root).length, 0);
    } finally {
      worker.stop();
    }
  } finally {
    removeWorkspace(root);
  }
});

test('B22-A2: restricted child env holds only proxy credentials and isolated HOME', () => {
  const env = buildChildEnv(
    'task_x',
    {
      PATH: 'C:/bin',
      HOME: 'C:/Users/real',
      OPENAI_API_KEY: 'sk-real-secret',
      OPENAI_BASE_URL: 'https://api.real.example',
      OPENAI_MODEL: 'real-model',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      VPLAY_APPROVAL_HMAC_KEY: KEY,
      APPROVAL_HMAC_KEY: KEY,
    },
    {
      restricted: true,
      proxyUrl: PROXY.url,
      proxyToken: PROXY.token,
      sandboxHome: 'C:/sandbox/home',
      model: MODEL,
    },
  );
  assert.equal(env.OPENAI_API_KEY, PROXY.token);
  assert.equal(env.OPENAI_BASE_URL, PROXY.url);
  assert.equal(env.OPENAI_MODEL, MODEL);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.VPLAY_APPROVAL_HMAC_KEY, undefined);
  assert.equal(env.APPROVAL_HMAC_KEY, undefined);
  assert.equal(env.HOME, 'C:/sandbox/home');
  assert.equal(env.PATH, 'C:/bin');
});

test('B22-A2: restricted tasks never continue, chat-record or auto-edit', () => {
  assert.equal(
    resolveApprovalMode({ publicMode: false, allowYolo: true, task: { allowYolo: true, restricted: true } }),
    'default',
  );
  assert.equal(
    resolveContinue({ restricted: true, project: { id: 'p' }, rounds: [{ at: 'x' }] }),
    false,
  );
  assert.equal(
    resolveContinue({ restricted: false, project: { id: 'p' }, rounds: [{ at: 'x' }] }),
    true,
  );
});

test('B22-A2: prepare-lab rejects symlink/junction parents in single-file mode', () => {
  const root = makeWorkspace('vplay-b22-lab-link-');
  try {
    const source = path.join(root, 'spacer');
    write(path.join(source, 'real', 'index.html'), '<h1>x</h1>\n');
    const link = path.join(source, 'link');
    let linked = true;
    try {
      fs.symlinkSync(path.join(source, 'real'), link, 'junction');
    } catch {
      linked = false;
    }
    if (!linked) return; // 平台不支持 junction 时跳过
    assert.throws(
      () => prepareLab({ sourceDir: source, labRoot: path.join(root, 'lab'), entry: 'link/index.html' }),
      /symlink|junction/,
    );
  } finally {
    removeWorkspace(root);
  }
});

test('B22-A2: evidence sealing writes a verifiable HMAC and detects tamper', () => {
  const root = makeWorkspace('vplay-b22-evidence-');
  try {
    const staging = path.join(root, 'staging');
    const sealed = path.join(root, 'sealed');
    const anchor = path.join(root, 'anchors', 'a.json');
    write(path.join(staging, 'meta.json'), '{"ok":true}\n');
    write(path.join(staging, 'report.json'), '{"verified":true}\n');
    const result = sealEvidence({ stagingDir: staging, sealedDir: sealed, hmacKey: KEY, anchorOut: anchor });
    assert.equal(result.fileCount, 2);
    assert.equal(verifySeal({ sealedDir: sealed, hmacKey: KEY }).ok, true);
    assert.equal(fs.existsSync(anchor), true);
    assert.throws(() => sealEvidence({ stagingDir: staging, sealedDir: path.join(root, 's2'), hmacKey: '' }), /HMAC/);

    fs.writeFileSync(path.join(sealed, 'report.json'), '{"verified":false}\n');
    const check = verifySeal({ sealedDir: sealed, hmacKey: KEY });
    assert.equal(check.ok, false);
    assert.ok(check.reasons.some((reason) => reason.startsWith('FILE_TAMPERED')));
  } finally {
    removeWorkspace(root);
  }
});

test('B22-A2: cli-runner watchdog kills the CLI tree and clears the lease', async () => {
  const root = makeWorkspace('vplay-b22-runner-');
  try {
    const marker = path.join(root, 'child-alive.txt');
    const childCode =
      `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),100);`;
    const fakeParent = spawn(process.execPath, ['-e', 'setTimeout(()=>{},200)'], { stdio: 'ignore' });
    const parentPid = fakeParent.pid;
    await new Promise((resolve) => fakeParent.on('exit', resolve));

    const lease = path.join(root, 'lease.json');
    const runner = spawn(
      process.execPath,
      [
        path.join(REPO_ROOT, 'remote', 'lib', 'cli-runner.cjs'),
        '--lease',
        lease,
        '--parent',
        String(parentPid),
        '--',
        process.execPath,
        '-e',
        childCode,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let out = '';
    runner.stdout.on('data', (chunk) => (out += chunk));
    runner.stderr.on('data', (chunk) => (out += chunk));
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        runner.kill('SIGKILL');
        reject(new Error(`runner did not exit: ${out}`));
      }, 15000);
      runner.on('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    assert.equal(code, 1, out);
    assert.match(out, /parent .* is gone/);
    assert.equal(fs.existsSync(lease), false, 'lease must be removed');

    const size1 = fs.existsSync(marker) ? fs.statSync(marker).size : 0;
    await new Promise((resolve) => setTimeout(resolve, 700));
    const size2 = fs.existsSync(marker) ? fs.statSync(marker).size : 0;
    assert.equal(size2, size1, 'CLI child must be terminated with the runner');
  } finally {
    removeWorkspace(root);
  }
});

test('B22-A2: server approve writes a verifiable signed proof', async () => {
  const root = makeWorkspace('vplay-b22-approve-');
  const { startServer, request } = require('./helpers.cjs');
  const token = 'b22-admin-token-0123456789';
  let server;
  try {
    server = await startServer({
      workspace: root,
      token,
      autorun: false,
      env: { VPLAY_RESTRICTED_DEPLOYMENT: '1' },
    });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const created = await request(server.port, 'POST', '/prompt', {
      headers,
      body: JSON.stringify({ text: 'approve me' }),
    });
    assert.equal(created.status, 202);
    assert.equal(created.json.task.status, 'awaiting_approval');
    const approved = await request(server.port, 'POST', `/tasks/${created.json.task.id}/approve`, { headers });
    assert.equal(approved.status, 200);
    const proof = approved.json.task.approval.proof;
    assert.ok(proof && proof.signature);
    // publicTask 只暴露安全子集，因此这里校验签名本身与关键绑定字段。
    assert.equal(signApprovalPayload(proof.payload, KEY), proof.signature);
    assert.equal(proof.payload.taskId, approved.json.task.id);
    assert.equal(proof.payload.model, 'qwen3-coder-plus');
    assert.equal(proof.payload.maxRuns, 1);
    assert.ok(Date.parse(proof.payload.expiresAt) > Date.now());
  } finally {
    if (server) await server.stop();
    removeWorkspace(root);
  }
});

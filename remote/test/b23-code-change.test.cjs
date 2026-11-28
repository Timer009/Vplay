'use strict';

/**
 * B23 P1：code_change 闭环（内嵌 JS、真实浏览器门禁、失败回滚）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createProjectRegistry } = require('../lib/projects.cjs');
const { createTaskStore } = require('../lib/tasks.cjs');
const { createWorker } = require('../lib/worker.cjs');
const {
  validateChangeSet,
  computeTreeHash,
  renderDiff,
  runFixedChecks,
} = require('../lib/code-change.cjs');
const { createApprovalProof, sha256Hex } = require('../lib/approval.cjs');
const { makeWorkspace, removeWorkspace, waitFor } = require('./helpers.cjs');

const APPROVAL_KEY = 'vplay-test-approval-key-0123456789abcdef';
const MODEL = 'qwen3-coder-plus';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createLab(root) {
  const home = path.join(root, 'home');
  const registry = createProjectRegistry({ home });
  const src = path.join(root, 'dummy-src');
  write(path.join(src, 'index.html'), '<!doctype html><html><body><script src="game.js"></script></body></html>\n');
  write(path.join(src, 'game.js'), 'window.score = 0;\n');
  registry.importProject({ sourceDir: src, id: 'dummy-lab', entry: 'index.html' });
  return { home, registry, project: registry.get('dummy-lab') };
}

function queueChange(store, project, files, baseVersionId = null) {
  const normalized = validateChangeSet({
    projectId: 'dummy-lab',
    files,
    allowlist: ['dummy-lab'],
  });
  const baseHash = computeTreeHash(project.srcDir);
  const diff = renderDiff({ root: project.srcDir, files: normalized });
  const task = store.create({
    text: 'code_change · dummy-lab · b23',
    kind: 'code_change',
    projectId: 'dummy-lab',
    codeChange: {
      projectId: 'dummy-lab',
      baseHash,
      diff,
      diffSha256: sha256Hex(diff),
      summary: 'b23',
      files: normalized.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        bytes: file.bytes,
        content: file.content,
      })),
    },
    restricted: true,
  }).task;
  const proof = createApprovalProof({
    task,
    key: APPROVAL_KEY,
    ttlMs: 10 * 60 * 1000,
    maxRuns: 1,
    model: MODEL,
    baseVersionId,
  }).proof;
  store.transition(task.id, 'queued', {
    approval: {
      state: 'approved',
      approvedAt: new Date().toISOString(),
      approvedBy: 'admin',
      rejectedAt: null,
      scope: { projectId: 'dummy-lab', kind: 'code_change', visionMode: null, allowedFiles: null },
      proof,
    },
  });
  return store.get(task.id);
}

function workerFor(root, store, registry, verifier) {
  return createWorker({
    store,
    projects: registry,
    workspaceDir: path.join(root, 'home'),
    runtimeDir: path.join(root, 'home', '.opengame'),
    cliPath: path.join(root, 'dist', 'cli.js'),
    restrictedDeployment: false,
    approvalKey: APPROVAL_KEY,
    approvalModel: MODEL,
    requireBrowserVerification: true,
    browserVerifier: verifier,
    logger: () => {},
  });
}

function latestBase(registry, projectId = 'dummy-lab') {
  const list = registry.listSnapshots(projectId);
  const last = list[list.length - 1];
  return last ? `${last.seq}-${last.uid}` : null;
}

test('B23-P1: inline HTML JavaScript is syntax-checked without execution', () => {
  const root = makeWorkspace('vplay-b23-p1-inline-');
  try {
    const work = path.join(root, 'work');
    write(path.join(work, 'index.html'), '<html><script>const a = 1;</script></html>\n');
    const valid = validateChangeSet({
      projectId: 'dummy-lab',
      files: [{ path: 'index.html', content: '<html><script>const a = 1;</script></html>\n' }],
      allowlist: ['dummy-lab'],
    });
    const ok = runFixedChecks({ root: work, files: valid });
    assert.equal(ok.ok, true);
    assert.ok(ok.checks.some((check) => check.path.includes('#inline-script-1')));

    const invalid = validateChangeSet({
      projectId: 'dummy-lab',
      files: [{ path: 'index.html', content: '<html><script>function {</script></html>\n' }],
      allowlist: ['dummy-lab'],
    });
    fs.writeFileSync(path.join(work, 'index.html'), invalid[0].content);
    const bad = runFixedChecks({ root: work, files: invalid });
    assert.equal(bad.ok, false);
    assert.ok(bad.checks.some((check) => check.path.includes('#inline-script-1') && !check.ok));
  } finally {
    removeWorkspace(root);
  }
});

test('B23-P1: console exposes approval and diff UI for code changes', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
  assert.match(html, /data-act="approve"/);
  assert.match(html, /data-act="reject"/);
  assert.match(html, /data-act="codechange"/);
  assert.match(html, /class="code-diff"/);
  assert.match(html, /function doApproval\(/);
  assert.match(html, /\/tasks\/' \+ encodeURIComponent\(taskId\) \+ '\/' \+ action/);
});

test('B23-P1: browser verification gates publish and marks verified', async () => {
  const root = makeWorkspace('vplay-b23-p1-browser-');
  try {
    const { registry, project } = createLab(root);
    const store = createTaskStore({
      runtimeDir: path.join(root, 'home', '.opengame'),
      workspaceDir: path.join(root, 'home'),
    });
    const task = queueChange(store, project, [
      { path: 'game.js', content: 'window.score = 42;\n' },
    ], latestBase(registry));
    const calls = [];
    const worker = workerFor(root, store, registry, async (input) => {
      calls.push(input);
      return { ok: true, status: 200, pageErrors: [], consoleErrors: [], sandbox: 'chromiumSandbox:true' };
    });
    try {
      worker.start();
      await waitFor(() => store.get(task.id).status === 'succeeded', { timeout: 20000 });
      const done = store.get(task.id);
      assert.equal(done.result.verified, true);
      assert.equal(done.result.codeChange.browserVerification, 'PASS');
      assert.equal(done.result.codeChange.published, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].projectId, 'dummy-lab');
      assert.equal(fs.readFileSync(path.join(project.srcDir, 'game.js'), 'utf-8'), 'window.score = 42;\n');
    } finally {
      worker.stop();
    }
  } finally {
    removeWorkspace(root);
  }
});

test('B23-P1: failed browser verification rolls back and never publishes', async () => {
  const root = makeWorkspace('vplay-b23-p1-browser-fail-');
  try {
    const { registry, project } = createLab(root);
    const store = createTaskStore({
      runtimeDir: path.join(root, 'home', '.opengame'),
      workspaceDir: path.join(root, 'home'),
    });
    const task = queueChange(store, project, [
      { path: 'game.js', content: 'window.score = 99;\n' },
    ], latestBase(registry));
    const worker = workerFor(root, store, registry, async () => ({
      ok: false,
      reason: 'BROWSER_CHECK_FAILED',
      status: 200,
      pageErrors: ['boom'],
      consoleErrors: [],
    }));
    try {
      worker.start();
      await waitFor(() => store.get(task.id).status === 'failed', { timeout: 20000 });
      const done = store.get(task.id);
      assert.equal(done.error.code, 'CODE_CHANGE_BROWSER_FAILED');
      assert.equal(done.result.codeChange.rolledBack, true);
      assert.equal(done.result.verified, false);
      assert.equal(fs.readFileSync(path.join(project.srcDir, 'game.js'), 'utf-8'), 'window.score = 0;\n');
    } finally {
      worker.stop();
    }
  } finally {
    removeWorkspace(root);
  }
});

test('B23-P1: tampering codeChange hashes invalidates the signed approval', async () => {
  const root = makeWorkspace('vplay-b23-p1-tamper-');
  try {
    const { registry, project } = createLab(root);
    const store = createTaskStore({
      runtimeDir: path.join(root, 'home', '.opengame'),
      workspaceDir: path.join(root, 'home'),
    });
    const task = queueChange(store, project, [
      { path: 'game.js', content: 'window.score = 7;\n' },
    ], latestBase(registry));
    const tampered = {
      ...task.codeChange,
      files: task.codeChange.files.map((file) => ({ ...file, sha256: 'f'.repeat(64) })),
    };
    store.patch(task.id, { codeChange: tampered });
    const worker = workerFor(root, store, registry, async () => ({ ok: true }));
    try {
      worker.start();
      await waitFor(() => store.get(task.id).status === 'failed', { timeout: 15000 });
      assert.equal(store.get(task.id).error.code, 'APPROVAL_CONTENT_MISMATCH');
      assert.equal(fs.readFileSync(path.join(project.srcDir, 'game.js'), 'utf-8'), 'window.score = 0;\n');
    } finally {
      worker.stop();
    }
  } finally {
    removeWorkspace(root);
  }
});

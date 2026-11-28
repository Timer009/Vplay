'use strict';

/**
 * B22-C：受控代码变更通道定点正负测试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createProjectRegistry } = require('../lib/projects.cjs');
const {
  validateChangeSet,
  computeTreeHash,
  renderDiff,
  applyChangeSet,
  rollbackChangeSet,
  runFixedChecks,
  CodeChangeError,
} = require('../lib/code-change.cjs');
const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  waitFor,
} = require('./helpers.cjs');

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

test('B22-C: change-set validation denies paths, types, sizes and unlisted projects', () => {
  const root = makeWorkspace('vplay-b22c-validate-');
  try {
    const { project } = createLab(root);
    assert.throws(
      () => validateChangeSet({ projectId: 'dummy-lab', files: [{ path: '../evil.js', content: 'x' }], allowlist: ['dummy-lab'] }),
      (error) => error instanceof CodeChangeError && error.code === 'CODE_CHANGE_PATH_INVALID',
    );
    assert.throws(
      () => validateChangeSet({ projectId: 'dummy-lab', files: [{ path: '.qwen/settings.json', content: '{}' }], allowlist: ['dummy-lab'] }),
      (error) => error.code === 'CODE_CHANGE_HIDDEN_PATH',
    );
    assert.throws(
      () => validateChangeSet({ projectId: 'dummy-lab', files: [{ path: 'vendor/x.js', content: 'x' }], allowlist: ['dummy-lab'] }),
      (error) => error.code === 'CODE_CHANGE_PATH_DENIED',
    );
    assert.throws(
      () => validateChangeSet({ projectId: 'dummy-lab', files: [{ path: 'package.json', content: '{}' }], allowlist: ['dummy-lab'] }),
      (error) => error.code === 'CODE_CHANGE_TYPE_DENIED',
    );
    assert.throws(
      () => validateChangeSet({ projectId: 'dummy-lab', files: [{ path: 'a.js', content: 'x' }], allowlist: [] }),
      (error) => error.code === 'CODE_CHANGE_PROJECT_DENIED',
    );
    const files = validateChangeSet({
      projectId: 'dummy-lab',
      files: [{ path: 'game.js', content: 'window.score = 1;\n' }],
      allowlist: ['dummy-lab'],
    });
    assert.equal(files.length, 1);
    assert.match(files[0].sha256, /^[0-9a-f]{64}$/);
    assert.ok(project.srcDir);
  } finally {
    removeWorkspace(root);
  }
});

test('B22-C: apply is atomic with rollback and fixed checks', () => {
  const root = makeWorkspace('vplay-b22c-apply-');
  try {
    const work = path.join(root, 'work');
    write(path.join(work, 'game.js'), 'window.score = 0;\n');
    write(path.join(work, 'index.html'), '<script src="game.js"></script>\n');
    const files = validateChangeSet({
      projectId: 'dummy-lab',
      files: [
        { path: 'game.js', content: 'window.score = 2;\n' },
        { path: 'levels.js', content: 'window.level = 1;\n' },
      ],
      allowlist: ['dummy-lab'],
    });
    const diff = renderDiff({ root: work, files });
    assert.match(diff, /--- a\/game\.js/);
    assert.match(diff, /\+window\.score = 2;/);
    assert.match(diff, /\+window\.level = 1;/);

    const base = computeTreeHash(work);
    const journal = path.join(root, 'journal.json');
    applyChangeSet({ root: work, files, journalFile: journal, taskId: 't1' });
    assert.equal(fs.readFileSync(path.join(work, 'game.js'), 'utf-8'), 'window.score = 2;\n');
    assert.equal(fs.readFileSync(path.join(work, 'levels.js'), 'utf-8'), 'window.level = 1;\n');
    assert.notEqual(computeTreeHash(work), base);
    assert.equal(runFixedChecks({ root: work, files }).ok, true);

    rollbackChangeSet({ journalFile: journal, root: work });
    assert.equal(fs.readFileSync(path.join(work, 'game.js'), 'utf-8'), 'window.score = 0;\n');
    assert.equal(fs.existsSync(path.join(work, 'levels.js')), false);
    assert.equal(computeTreeHash(work), base);
  } finally {
    removeWorkspace(root);
  }
});

test('B22-C API: admin creates, approves and executes an isolated-lab change-set', async () => {
  const root = makeWorkspace('vplay-b22c-api-');
  const { home, project } = createLab(root);
  const token = 'b22c-admin-token-0123456789';
  let server;
  try {
    server = await startServer({
      workspace: path.join(root, 'workspace'),
      home,
      token,
      env: { VPLAY_CODE_CHANGE_PROJECTS: 'dummy-lab' },
    });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const created = await request(server.port, 'POST', '/projects/dummy-lab/code-change', {
      headers,
      body: JSON.stringify({
        summary: 'generic dummy feature',
        files: [
          { path: 'game.js', content: 'window.score = 10;\nwindow.lives = 3;\n' },
          { path: 'index.html', content: '<!doctype html><html><body><script src="game.js"></script><p>ok</p></body></html>\n' },
        ],
      }),
    });
    assert.equal(created.status, 202, created.text);
    assert.equal(created.json.task.kind, 'code_change');
    assert.equal(created.json.task.status, 'awaiting_approval');
    assert.equal(created.json.task.restricted, true);
    assert.ok(created.json.task.codeChange.diff.includes('+window.score = 10;'));
    assert.ok(created.json.task.codeChange.files.length === 2);

    const approved = await request(server.port, 'POST', `/tasks/${created.json.task.id}/approve`, { headers });
    assert.equal(approved.status, 200);

    const done = await waitFor(async () => {
      const res = await request(server.port, 'GET', `/tasks/${created.json.task.id}`, { headers });
      const status = res.json.task.status;
      return status === 'succeeded' || status === 'failed' ? res.json.task : null;
    }, { timeout: 20000 });

    assert.equal(done.status, 'succeeded', JSON.stringify(done.error || done.result));
    assert.equal(done.result.codeChange.browserVerification, 'SKIPPED_FULL_DEV');
    assert.equal(done.result.verified, false);
    assert.equal(
      fs.readFileSync(path.join(project.srcDir, 'game.js'), 'utf-8'),
      'window.score = 10;\nwindow.lives = 3;\n',
    );
  } finally {
    if (server) await server.stop();
    removeWorkspace(root);
  }
});

test('B22-C API: baseline change after approval fails closed without writing', async () => {
  const root = makeWorkspace('vplay-b22c-base-');
  const { home, project } = createLab(root);
  const token = 'b22c-admin-token-0123456789';
  let server;
  try {
    server = await startServer({
      workspace: path.join(root, 'workspace'),
      home,
      token,
      env: { VPLAY_CODE_CHANGE_PROJECTS: 'dummy-lab' },
    });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const created = await request(server.port, 'POST', '/projects/dummy-lab/code-change', {
      headers,
      body: JSON.stringify({ files: [{ path: 'game.js', content: 'window.score = 99;\n' }] }),
    });
    assert.equal(created.status, 202);

    // 审批前外部改动基线
    fs.writeFileSync(path.join(project.srcDir, 'game.js'), 'window.score = 77;\n');
    const approved = await request(server.port, 'POST', `/tasks/${created.json.task.id}/approve`, { headers });
    assert.equal(approved.status, 200);

    const done = await waitFor(async () => {
      const res = await request(server.port, 'GET', `/tasks/${created.json.task.id}`, { headers });
      return res.json.task.status === 'failed' ? res.json.task : null;
    }, { timeout: 20000 });
    assert.equal(done.error.code, 'CODE_CHANGE_BASE_MISMATCH');
    assert.equal(fs.readFileSync(path.join(project.srcDir, 'game.js'), 'utf-8'), 'window.score = 77;\n');
  } finally {
    if (server) await server.stop();
    removeWorkspace(root);
  }
});

test('B22-C API: non-admin cannot create code_change', async () => {
  const root = makeWorkspace('vplay-b22c-auth-');
  const { home } = createLab(root);
  const token = 'b22c-admin-token-0123456789';
  let server;
  try {
    server = await startServer({
      workspace: path.join(root, 'workspace'),
      home,
      token,
      env: { VPLAY_CODE_CHANGE_PROJECTS: 'dummy-lab' },
    });
    const unauthorized = await request(server.port, 'POST', '/projects/dummy-lab/code-change', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'game.js', content: 'x\n' }] }),
    });
    assert.equal(unauthorized.status, 401);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const denied = await request(server.port, 'POST', '/projects/dummy-lab/code-change', {
      headers,
      body: JSON.stringify({ files: [{ path: '../evil.js', content: 'x\n' }] }),
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, 'CODE_CHANGE_PATH_INVALID');
  } finally {
    if (server) await server.stop();
    removeWorkspace(root);
  }
});

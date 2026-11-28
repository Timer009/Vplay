'use strict';

/**
 * B20 / C18 P-1/P-2/P-3 单元测试（Windows 定点）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTaskStore } = require('../lib/tasks.cjs');
const {
  RESTRICTED_CORE_TOOLS,
  RESTRICTED_EXCLUDED_TOOLS,
  restrictedCliArgs,
} = require('../lib/linux-config.cjs');
const { prepareLab } = require('../tools/prepare-lab.cjs');
const { makeWorkspace, removeWorkspace, startServer, request } = require('./helpers.cjs');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('B20-P1: restricted CLI args allow only read tools and exclude dangerous tools', () => {
  const args = restrictedCliArgs();
  assert.deepEqual(args.slice(0, 1), ['--core-tools']);
  const core = args[1].split(',');
  const excluded = args[3].split(',');
  assert.deepEqual(core, [...RESTRICTED_CORE_TOOLS]);
  assert.ok(core.includes('read_file'));
  assert.ok(core.includes('grep_search'));
  for (const forbidden of ['run_shell_command', 'edit', 'write_file', 'web_fetch', 'web_search']) {
    assert.equal(core.includes(forbidden), false, forbidden);
    assert.ok(excluded.includes(forbidden), forbidden);
  }
  assert.equal(RESTRICTED_EXCLUDED_TOOLS.includes('task'), true);
});

test('B20-P2: restricted task stays awaiting_approval until approved; reject is terminal', () => {
  const root = makeWorkspace('vplay-b20-task-');
  try {
    const store = createTaskStore({
      runtimeDir: path.join(root, '.opengame'),
      workspaceDir: root,
    });
    const pending = store.create({ text: 'restricted read-only task', restricted: true }).task;
    assert.equal(pending.status, 'awaiting_approval');
    assert.equal(pending.restricted, true);
    assert.equal(store.nextQueued(), null);
    assert.throws(() => store.transition(pending.id, 'running'));

    const approved = store.transition(pending.id, 'queued');
    assert.equal(approved.status, 'queued');
    assert.equal(store.nextQueued().id, pending.id);

    const rejected = store.create({ text: 'reject me', restricted: true }).task;
    const final = store.transition(rejected.id, 'rejected');
    assert.equal(final.status, 'rejected');
    assert.ok(final.finishedAt);
  } finally {
    removeWorkspace(root);
  }
});

test('B20-P2: normal task (full game mode) still queues immediately', () => {
  const root = makeWorkspace('vplay-b20-normal-');
  try {
    const store = createTaskStore({
      runtimeDir: path.join(root, '.opengame'),
      workspaceDir: root,
    });
    const task = store.create({ text: 'full game task' }).task;
    assert.equal(task.status, 'queued');
    assert.equal(task.restricted, false);
  } finally {
    removeWorkspace(root);
  }
});

test('B20-P2 API: restricted task requires admin approval before it can run', async () => {
  const root = makeWorkspace('vplay-b20-api-');
  const token = 'b20-admin-token-0123456789';
  let server;
  try {
    server = await startServer({ workspace: root, token, autorun: false });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const created = await request(server.port, 'POST', '/prompt', {
      headers,
      body: JSON.stringify({ text: 'restricted read-only task', restricted: true }),
    });
    assert.equal(created.status, 202);
    assert.equal(created.json.task.status, 'awaiting_approval');
    const id = created.json.task.id;

    const unauthorized = await request(server.port, 'POST', `/tasks/${id}/approve`);
    assert.equal(unauthorized.status, 401);

    const approved = await request(server.port, 'POST', `/tasks/${id}/approve`, { headers });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.task.status, 'queued');

    const created2 = await request(server.port, 'POST', '/prompt', {
      headers,
      body: JSON.stringify({ text: 'reject this task', restricted: true }),
    });
    const rejected = await request(server.port, 'POST', `/tasks/${created2.json.task.id}/reject`, { headers });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.json.task.status, 'rejected');
  } finally {
    if (server) await server.stop();
    removeWorkspace(root);
  }
});

test('B20-P3: prepare-lab copies official blob, writes manifest and registers independent project', () => {
  const root = makeWorkspace('vplay-b20-lab-');
  try {
    const source = path.join(root, 'spacer-official');
    write(path.join(source, 'vector-lander', 'index.html'), '<h1>spacer</h1>\n');
    const git = (args) => spawnSync('git', [
      '-c', 'user.name=b20',
      '-c', 'user.email=b20@example.invalid',
      ...args,
    ], { cwd: source, encoding: 'utf8' });
    assert.equal(git(['init', '-q']).status, 0);
    assert.equal(git(['add', '.']).status, 0);
    assert.equal(git(['commit', '-q', '-m', 'fixture']).status, 0);

    const home = path.join(root, 'home');
    const labRoot = path.join(root, 'lab', 'spacer');
    const { manifest, project } = prepareLab({
      sourceDir: source,
      labRoot,
      home,
      register: true,
      projectId: 'spacer-lab',
    });
    assert.equal(manifest.entry, 'vector-lander/index.html');
    assert.equal(manifest.source.blobSource, 'git-blob');
    assert.match(manifest.commit, /^[0-9a-f]{40}$/);
    assert.equal(manifest.copied.sha256, manifest.source.blobSha256);
    assert.ok(fs.existsSync(path.join(labRoot, 'manifest.json')));
    assert.equal(project.project.id, 'spacer-lab');

    assert.throws(
      () => prepareLab({ sourceDir: source, labRoot: path.join(source, 'inside') }),
      /must not be inside sourceDir/,
    );
  } finally {
    removeWorkspace(root);
  }
});

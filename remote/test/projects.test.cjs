'use strict';

/**
 * Adopt Mode：导入、检测、快照、差异、回退。
 * 全部在临时目录里进行，不触碰任何真实工程。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createProjectRegistry,
  detectProject,
  digestManifest,
} = require('../lib/projects.cjs');
const { hashTree } = require('../lib/paths.cjs');
const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  jsonHeaders,
  postPrompt,
  waitFor,
  readStarts,
  EXECUTOR,
} = require('./helpers.cjs');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

function makeStaticProject(root) {
  write(path.join(root, 'index.html'), '<h1>game</h1><script src="js/game.js"></script>');
  write(path.join(root, 'js', 'game.js'), 'console.log("v1");');
  write(path.join(root, 'css', 'style.css'), 'body{background:#000}');
  return root;
}

test('detect: static project, subdirectory entry and vite dist', () => {
  const root = makeWorkspace('vplay-detect-');
  try {
    const staticDir = path.join(root, 'static');
    makeStaticProject(staticDir);
    const detected = detectProject(staticDir);
    assert.equal(detected.kind, 'static');
    assert.equal(detected.entry, 'index.html');

    const subDir = path.join(root, 'sub');
    write(path.join(subDir, 'vector-lander', 'index.html'), '<h1>lander</h1>');
    write(path.join(subDir, 'vector-lander', 'game.js'), 'x');
    const subDetected = detectProject(subDir);
    assert.equal(subDetected.kind, 'static');
    assert.equal(subDetected.entry, 'vector-lander/index.html');

    const viteDir = path.join(root, 'vite');
    write(
      path.join(viteDir, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^5.0.0' }, scripts: { build: 'vite build' } }),
    );
    write(path.join(viteDir, 'vite.config.js'), 'export default {}');
    write(path.join(viteDir, 'index.html'), '<div id="app"></div>');
    write(path.join(viteDir, 'dist', 'index.html'), '<div>built</div>');
    const viteDetected = detectProject(viteDir);
    assert.equal(viteDetected.kind, 'vite');
    assert.equal(viteDetected.buildCommand, 'npm run build');
  } finally {
    removeWorkspace(root);
  }
});

test('import: copies the project, keeps the original untouched, creates initial snapshot', () => {
  const root = makeWorkspace('vplay-import-');
  const home = path.join(root, 'home');
  try {
    const source = makeStaticProject(path.join(root, 'original'));
    const beforeDigest = digestManifest(hashTree(source));

    const registry = createProjectRegistry({ home });
    const result = registry.importProject({ sourceDir: source, id: 'demo-game', name: 'Demo' });

    assert.equal(result.import.originalUnchanged, true);
    assert.equal(result.import.hashDigest, beforeDigest);
    assert.equal(digestManifest(hashTree(source)), beforeDigest, 'original must not change');

    const project = registry.get('demo-game');
    assert.equal(project.kind, 'static');
    assert.equal(project.entry, 'index.html');
    assert.ok(fs.existsSync(path.join(project.srcDir, 'index.html')));
    assert.equal(project.snapshots.length, 1);
    assert.equal(project.snapshots[0].seq, 1);
    assert.equal(project.snapshots[0].fileCount, 3);

    // 修改工作副本不影响原始工程
    fs.writeFileSync(path.join(project.srcDir, 'js', 'game.js'), 'console.log("v2");', 'utf-8');
    assert.equal(digestManifest(hashTree(source)), beforeDigest);
  } finally {
    removeWorkspace(root);
  }
});

test('import: rejects duplicate ids and unknown entries', () => {
  const root = makeWorkspace('vplay-import-guard-');
  try {
    const source = makeStaticProject(path.join(root, 'original'));
    const registry = createProjectRegistry({ home: path.join(root, 'home') });
    registry.importProject({ sourceDir: source, id: 'demo' });
    assert.throws(() => registry.importProject({ sourceDir: source, id: 'demo' }), /已存在/);
    assert.throws(() => registry.importProject({ sourceDir: source, id: 'Bad ID' }), /projectId/);

    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    assert.throws(() => registry.importProject({ sourceDir: empty, id: 'empty-one' }), /入口/);
  } finally {
    removeWorkspace(root);
  }
});

test('snapshot + diff: shows added, modified and removed files', () => {
  const root = makeWorkspace('vplay-diff-');
  try {
    const source = makeStaticProject(path.join(root, 'original'));
    const registry = createProjectRegistry({ home: path.join(root, 'home') });
    registry.importProject({ sourceDir: source, id: 'demo' });
    const project = registry.get('demo');

    fs.writeFileSync(path.join(project.srcDir, 'js', 'game.js'), 'console.log("changed");', 'utf-8');
    fs.writeFileSync(path.join(project.srcDir, 'js', 'extra.js'), '// new file\n', 'utf-8');
    fs.rmSync(path.join(project.srcDir, 'css', 'style.css'));

    const result = registry.diff('demo', 1, 'current');
    assert.deepEqual(result.counts, { added: 1, removed: 1, modified: 1 });
    const statuses = Object.fromEntries(result.files.map((f) => [f.path, f.status]));
    assert.equal(statuses['js/extra.js'], 'added');
    assert.equal(statuses['css/style.css'], 'removed');
    assert.equal(statuses['js/game.js'], 'modified');
    assert.match(result.patch, /changed/);
  } finally {
    removeWorkspace(root);
  }
});

test('rollback: restores modified/added/removed files and matches the snapshot hash', async () => {
  const root = makeWorkspace('vplay-rollback-');
  try {
    const source = makeStaticProject(path.join(root, 'original'));
    const registry = createProjectRegistry({ home: path.join(root, 'home') });
    registry.importProject({ sourceDir: source, id: 'demo' });
    const project = registry.get('demo');
    const initialDigest = project.snapshots[0].digest;

    fs.writeFileSync(path.join(project.srcDir, 'js', 'game.js'), 'console.log("modified");', 'utf-8');
    fs.writeFileSync(path.join(project.srcDir, 'added.txt'), 'temporary', 'utf-8');
    fs.rmSync(path.join(project.srcDir, 'css', 'style.css'));

    const rollback = await registry.rollback('demo', 1);
    assert.equal(rollback.verified, true);
    assert.equal(rollback.digest, initialDigest);
    assert.ok(fs.existsSync(path.join(project.srcDir, 'css', 'style.css')));
    assert.equal(fs.existsSync(path.join(project.srcDir, 'added.txt')), false);
    assert.match(fs.readFileSync(path.join(project.srcDir, 'js', 'game.js'), 'utf-8'), /v1/);

    // 回退前已自动备份当前状态
    const snapshots = registry.listSnapshots('demo');
    assert.ok(snapshots.some((s) => s.label.startsWith('pre-rollback')));
  } finally {
    removeWorkspace(root);
  }
});

test('project lock: second acquire fails while the first is held', () => {
  const root = makeWorkspace('vplay-lock-');
  try {
    const registry = createProjectRegistry({ home: path.join(root, 'home') });
    const source = makeStaticProject(path.join(root, 'original'));
    registry.importProject({ sourceDir: source, id: 'demo' });
    const first = registry.acquireLock('demo', { taskId: 'task_1' });
    assert.throws(() => registry.acquireLock('demo', { taskId: 'task_2' }), /占用/);
    // C07-P0-03：owner token 不匹配时不得释放他人锁
    assert.equal(registry.releaseLock('demo', 'wrong-token'), false);
    assert.equal(registry.releaseLock('demo', first.token), true);
    const info = registry.acquireLock('demo', { taskId: 'task_3' });
    assert.equal(info.taskId, 'task_3');
    assert.equal(registry.releaseLock('demo', info.token), true);
  } finally {
    removeWorkspace(root);
  }
});

test('registry home defaults to a user-scoped directory', () => {
  const previous = process.env.VPLAY_HOME;
  delete process.env.VPLAY_HOME;
  try {
    const registry = createProjectRegistry({ home: path.join(os.tmpdir(), 'vplay-home-default') });
    assert.ok(registry.registryFile.endsWith('projects.json'));
    removeWorkspace(path.join(os.tmpdir(), 'vplay-home-default'));
  } finally {
    if (previous !== undefined) process.env.VPLAY_HOME = previous;
  }
});

test('projects mode: task runs inside the imported project, snapshots, diff and rollback work', async () => {
  const root = makeWorkspace('vplay-projects-mode-');
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'unused-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const TOKEN = 'projects-token';

  try {
    const source = path.join(root, 'original');
    write(
      path.join(source, 'index.html'),
      '<style>:root{--bg: #101014}</style><h1>Project Game</h1>',
    );
    write(path.join(source, 'js', 'game.js'), 'console.log("v1");');

    const registry = createProjectRegistry({ home });
    registry.importProject({ sourceDir: source, id: 'demo-game', name: 'Demo Game' });
    const initialDigest = registry.get('demo-game').snapshots[0].digest;

    const server = await startServer({
      workspace,
      home,
      token: TOKEN,
      env: { REMOTE_EXECUTOR_CMD: EXECUTOR },
    });

    try {
      const created = await postPrompt(server.port, TOKEN, {
        projectId: 'demo-game',
        text: 'BACKGROUND change the background',
      });
      assert.equal(created.status, 202, created.text);
      assert.equal(created.json.task.projectId, 'demo-game');

      const task = await waitFor(
        async () => {
          const res = await request(server.port, 'GET', `/tasks/${created.json.task.id}`, {
            headers: jsonHeaders(TOKEN),
          });
          const status = res.json.task.status;
          return ['succeeded', 'failed'].includes(status) ? res.json.task : null;
        },
        { timeout: 20000 },
      );
      assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
      assert.equal(task.projectId, 'demo-game');
      assert.equal(task.snapshotSeq, 2);

      const project = registry.get('demo-game');
      const html = fs.readFileSync(path.join(project.srcDir, 'index.html'), 'utf-8');
      assert.match(html, /--bg: #7c3aed/);
      assert.equal(readStarts(project.srcDir).length, 1);

      // 差异：至少 index.html 被修改
      const diff = await request(
        server.port,
        'GET',
        `/projects/demo-game/diff?from=${task.snapshotSeq}&to=current`,
        { headers: jsonHeaders(TOKEN) },
      );
      assert.equal(diff.status, 200);
      assert.ok(diff.json.files.some((f) => f.path === 'index.html' && f.status === 'modified'));
      assert.match(diff.json.patch, /7c3aed/);

      // 预览地址走独立端口与项目路径
      const artifact = await request(server.port, 'GET', '/artifact?projectId=demo-game', {
        headers: jsonHeaders(TOKEN),
      });
      assert.equal(artifact.json.previewPath, '/p/demo-game/');
      assert.equal(artifact.json.previewPort, server.previewPort);

      // 项目记忆记录了一轮
      const detail = await request(server.port, 'GET', '/projects/demo-game', {
        headers: jsonHeaders(TOKEN),
      });
      assert.equal(detail.json.project.memory.rounds.length, 1);

      // 回退到任务执行前
      const rollback = await request(server.port, 'POST', '/projects/demo-game/rollback', {
        headers: jsonHeaders(TOKEN),
        body: JSON.stringify({ seq: 2 }),
      });
      assert.equal(rollback.status, 200, rollback.text);
      assert.equal(rollback.json.verified, true);
      const afterRollback = fs.readFileSync(path.join(project.srcDir, 'index.html'), 'utf-8');
      assert.doesNotMatch(afterRollback, /7c3aed/);
      assert.equal(digestManifest(hashTree(project.srcDir)), initialDigest);

      // 未知项目 ID 被拒绝
      const unknown = await postPrompt(server.port, TOKEN, {
        projectId: 'no-such-project',
        text: 'anything',
      });
      assert.equal(unknown.status, 404);

      // HTTP 不允许导入
      const importAttempt = await request(server.port, 'POST', '/projects/import', {
        headers: jsonHeaders(TOKEN),
        body: JSON.stringify({ path: 'C:/Windows' }),
      });
      assert.equal(importAttempt.status, 403);
    } finally {
      await server.stop();
    }
  } finally {
    removeWorkspace(root);
  }
});

'use strict';

/**
 * B10 / Sprint03C 收口回归：
 *  - 注册表锁所有权与「活锁不可回收」
 *  - staging 全量校验后原子发布；失败保持旧预览
 *  - Vite「改源码未构建」拒绝发布，构建后才发布
 *  - rollback 持项目锁 + 异步构建
 *  - Vision 宿主增量校验（真实 Spacer 基线不误报、客户端 prevalidated 不生效）
 *  - Vision verify 与 analyze 语义区分
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createProjectRegistry,
  withHomeLock,
} = require('../lib/projects.cjs');
const {
  applyPatchAtomically,
  validatePatchIncremental,
} = require('../lib/vision-policy.cjs');
const { createVisionService } = require('../lib/vision-service.cjs');
const { makeWorkspace, removeWorkspace } = require('./helpers.cjs');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeStaticProject(root, entry = '<h1>v1</h1>') {
  write(path.join(root, 'index.html'), `${entry}\n`);
  write(path.join(root, 'assets', 'a.txt'), 'asset');
  return root;
}

function makeViteProject(root) {
  write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'vite-b10', scripts: { build: 'node build.cjs' } }, null, 2),
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

test('B10-A1: registry lock never steals an empty/just-created lock or a live holder', async () => {
  const root = makeWorkspace('vplay-b10-lock-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    registry.importProject({ sourceDir: makeStaticProject(path.join(root, 'src')), id: 'demo' });
    const lockFile = path.join(home, '.opengame', 'registry.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });

    // 1) 空文件（另一个进程刚 open、尚未写入）：只能等待，不得回收
    fs.writeFileSync(lockFile, '');
    assert.throws(() => withHomeLock(home, () => 'never', { timeoutMs: 250 }), /busy/i);
    assert.ok(fs.existsSync(lockFile), 'empty lock must not be stolen');
    fs.rmSync(lockFile, { force: true });

    // 2) 活进程持锁：超时后必须原样保留
    const liveToken = 'live-token-b10';
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, token: liveToken, at: Date.now() }),
    );
    assert.throws(() => withHomeLock(home, () => 'never', { timeoutMs: 250 }), /busy/i);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf-8')).token, liveToken);
    fs.rmSync(lockFile, { force: true });

    // 3) 死进程残留：必须自动回收且能进入临界区
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 999999, token: 'dead-token', at: Date.now() }),
    );
    const value = withHomeLock(home, () => 'entered', { timeoutMs: 3000 });
    assert.equal(value, 'entered');
    assert.equal(fs.existsSync(lockFile), false, 'own lock must be released');
  } finally {
    removeWorkspace(root);
  }
});

test('B10-A2: failed publish keeps the previous preview (staging validated before switch)', () => {
  const root = makeWorkspace('vplay-b10-publish-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    const imported = registry.importProject({
      sourceDir: makeStaticProject(path.join(root, 'src'), '<h1>stable</h1>'),
      id: 'demo',
    });
    const previewEntry = path.join(home, 'projects', 'demo', '.preview', 'index.html');
    const before = fs.readFileSync(previewEntry, 'utf-8');
    assert.ok(registry.previewRoot('demo'));

    // 人为制造不可发布状态：入口变成目录（staging 校验必须失败）
    const srcEntry = path.join(imported.project.srcDir, 'index.html');
    fs.rmSync(srcEntry);
    fs.mkdirSync(srcEntry);
    write(path.join(srcEntry, 'nested.txt'), 'x');

    assert.equal(registry.buildPreview('demo'), null, 'invalid staging must not publish');
    assert.equal(fs.readFileSync(previewEntry, 'utf-8'), before, 'old preview must stay');
    const stale = JSON.parse(
      fs.readFileSync(path.join(home, 'projects', 'demo', '.preview-stale.json'), 'utf-8'),
    );
    assert.ok(stale.reason);

    // 恢复后重新发布成功
    fs.rmSync(srcEntry, { recursive: true, force: true });
    write(srcEntry, '<h1>fixed</h1>\n');
    assert.ok(registry.buildPreview('demo'));
    assert.equal(registry.verifyPreview('demo').ok, true);
  } finally {
    removeWorkspace(root);
  }
});

test('B10-A2/B-03: Vite source change without rebuild must not publish; rebuild then publish', () => {
  const root = makeWorkspace('vplay-b10-vite-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    const imported = registry.importProject({
      sourceDir: makeViteProject(path.join(root, 'src')),
      id: 'vite-b10',
    });
    const record = registry.get('vite-b10');

    // 未构建：即使 dist 存在也不允许发布
    assert.equal(registry.buildPreview('vite-b10'), null, 'no build stamp => no publish');

    assert.equal(registry.buildProject(record).ok, true);
    assert.ok(registry.buildPreview('vite-b10'));
    const published = fs.readFileSync(
      path.join(home, 'projects', 'vite-b10', '.preview', 'index.html'),
      'utf-8',
    );
    assert.match(published, /ORIGINAL/);

    // 改源码不构建：必须拒绝发布，旧预览保持
    write(path.join(imported.project.srcDir, 'content.txt'), 'MODIFIED');
    assert.equal(registry.buildPreview('vite-b10'), null, 'stale dist must not publish');
    assert.match(
      fs.readFileSync(path.join(home, 'projects', 'vite-b10', '.preview', 'index.html'), 'utf-8'),
      /ORIGINAL/,
    );

    // 构建后才可以发布
    assert.equal(registry.buildProject(registry.get('vite-b10')).ok, true);
    assert.ok(registry.buildPreview('vite-b10'));
    assert.match(
      fs.readFileSync(path.join(home, 'projects', 'vite-b10', '.preview', 'index.html'), 'utf-8'),
      /MODIFIED/,
    );
  } finally {
    removeWorkspace(root);
  }
});

test('B10-A3: rollback requires the project lock, is async, and releases its own lock', async () => {
  const root = makeWorkspace('vplay-b10-rollback-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    registry.importProject({ sourceDir: makeStaticProject(path.join(root, 'src')), id: 'demo' });
    write(path.join(home, 'projects', 'demo', 'src', 'index.html'), '<h1>changed</h1>\n');

    const held = registry.acquireLock('demo', { taskId: 'holder' });
    await assert.rejects(() => registry.rollback('demo', 1), /占用|PROJECT_LOCKED/);
    assert.equal(registry.readLock('demo').token, held.token, 'failed rollback must not drop holder lock');

    // 调用方已持锁（worker/Vision 场景）：传 token 才能执行
    const result = await registry.rollback('demo', 1, { lockToken: held.token });
    assert.equal(result.verified, true);
    assert.equal(registry.readLock('demo').token, held.token);
    registry.releaseLock('demo', held.token);

    // 自行加锁路径：完成后必须释放
    const second = await registry.rollback('demo', 1);
    assert.equal(second.verified, true);
    assert.equal(registry.readLock('demo'), null, 'rollback must release its own lock');
  } finally {
    removeWorkspace(root);
  }
});

test('B10-A1: concurrent snapshots (8x5) never lose entries or produce orphan dirs', async () => {
  const { spawn } = require('child_process');
  const root = makeWorkspace('vplay-b10-conc-');
  const home = path.join(root, 'home');
  try {
    createProjectRegistry({ home }).importProject({
      sourceDir: makeStaticProject(path.join(root, 'src')),
      id: 'demo',
    });
    const worker = path.join(__dirname, 'fixtures', 'snapshot-worker.cjs');
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, home, 'demo', '5'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (out += c));
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(out))));
      });
    await Promise.all(Array.from({ length: 8 }, run));

    const registry = createProjectRegistry({ home });
    const entries = registry.listSnapshots('demo');
    assert.equal(entries.length, 41, `entries: ${entries.length}`);
    const dirs = fs
      .readdirSync(path.join(home, 'projects', 'demo', '.snapshots'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{3,}-/.test(entry.name));
    assert.equal(dirs.length, 41, `dirs: ${dirs.length}`);
    const seqs = entries.map((item) => Number(item.seq));
    assert.equal(new Set(seqs).size, seqs.length, 'duplicate seq');
    for (const item of entries) registry.validateSnapshot('demo', item.seq);
  } finally {
    removeWorkspace(root);
  }
});

test('B10-A4: worker settle is exception-safe — failure still finalizes and releases the lock', async () => {
  const { createWorker } = require('../lib/worker.cjs');
  const { waitFor } = require('./helpers.cjs');
  const root = makeWorkspace('vplay-b10-settle-');
  const runtimeDir = path.join(root, 'runtime');
  try {
    write(path.join(root, 'src', 'index.html'), '<h1>settle</h1>\n');
    const task = { id: 'task_settle', text: 'noop', projectId: 'demo' };
    let queued = task;
    const transitions = [];
    const store = {
      transition(id, status, patch) {
        transitions.push({ id, status, patch });
      },
      appendLog() {},
      get: () => ({ id: task.id, status: 'running' }),
      nextQueued() {
        const next = queued;
        queued = null;
        return next;
      },
      activeTask: () => null,
      readLog: () => '',
      list: () => [task],
    };
    const released = [];
    const fakeProjects = {
      get: () => ({ id: 'demo', srcDir: path.join(root, 'src'), entry: 'index.html', kind: 'static' }),
      acquireLock: () => ({ token: 'settle-token' }),
      releaseLock: (id, token) => released.push(token),
      snapshot: () => ({ seq: 1 }),
      // 模拟 verify() 内部抛出（C09 B-05：不得让进程退出/任务悬挂）
      previewRoot: () => {
        throw new Error('boom-preview');
      },
      memory: () => ({ rounds: [] }),
      appendRound() {},
      listSnapshots: () => [],
      diff: () => {
        throw new Error('boom-diff');
      },
    };
    const worker = createWorker({
      store,
      projects: fakeProjects,
      workspaceDir: path.join(root, 'src'),
      runtimeDir,
      cliPath: path.join(root, 'dist', 'cli.js'),
      executorScript: path.join(__dirname, 'fixtures', 'noop.cjs'),
      timeoutMs: 10000,
      logger: () => {},
    });
    worker.start();
    await waitFor(
      () => transitions.some((item) => item.status === 'failed'),
      { timeout: 10000 },
    );
    worker.stop();
    const failed = transitions.find((item) => item.status === 'failed');
    assert.equal(failed.patch.error.code, 'SETTLE_FAILED');
    assert.deepEqual(released, ['settle-token'], 'lock must be released exactly once');
    assert.equal(worker.isBusy(), false);
  } finally {
    removeWorkspace(root);
  }
});

test('B10-B1: incremental validation ignores unchanged Spacer-style unsafe baseline', () => {
  const root = makeWorkspace('vplay-b10-spacer-');
  try {
    const baseline = [
      '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\'></svg>">',
      '<script>const onChange = () => { window.__hud = 1; };</script>',
      '<h1>v1</h1>',
    ].join('\n');
    write(path.join(root, 'index.html'), `${baseline}\n`);
    const after = baseline.replace('<h1>v1</h1>', '<h1>v2</h1>');

    // 整文件黑名单会误报，但宿主增量校验只扫描新增行 → 放行
    const applied = applyPatchAtomically({
      root,
      files: [{ file: 'index.html', content: `${after}\n` }],
      allowedFiles: ['index.html'],
    });
    assert.equal(applied[0].file, 'index.html');
    assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /<h1>v2<\/h1>/);

    // 新增恶意行必须拒绝；客户端 prevalidated 字段不得生效
    assert.throws(
      () =>
        applyPatchAtomically({
          root,
          files: [
            {
              file: 'index.html',
              content: `${after}\n<script>fetch("https://evil.example")</script>\n`,
              prevalidated: true,
              contentScan: 'prevalidated',
            },
          ],
          allowedFiles: ['index.html'],
        }),
      /unsafe content|delta content rejected/i,
    );

    // 基线摘要不匹配（补丁基于旧内容）必须拒绝
    assert.throws(
      () =>
        validatePatchIncremental(
          root,
          [{ file: 'index.html', content: `${after}\n<!-- x -->`, sha256Before: 'deadbeef' }],
          ['index.html'],
        ),
      /baseline digest mismatch/i,
    );

    // 无实际变化必须拒绝
    assert.throws(
      () =>
        validatePatchIncremental(
          root,
          [{ file: 'index.html', content: fs.readFileSync(path.join(root, 'index.html'), 'utf8') }],
          ['index.html'],
        ),
      /no change/i,
    );
  } finally {
    removeWorkspace(root);
  }
});

test('B10-B: Vision verify mode is functional re-verification, not analyze', async () => {
  const root = makeWorkspace('vplay-b10-verify-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    registry.importProject({ sourceDir: makeStaticProject(path.join(root, 'src')), id: 'demo' });
    const calls = { capture: 0, analyze: 0 };
    const fakeVision = {
      createEventSink: () => ({ emit() {}, events: [] }),
      createBrowserRunner: () => ({
        runCapture: async () => {
          calls.capture += 1;
          return {
            ok: true,
            browserVersion: 'fake',
            viewports: [
              {
                viewport: 'desktop',
                ok: true,
                assertions: [{ id: 'hud-visible', ok: true, critical: true }],
                diagnostics: { pageErrors: [] },
              },
            ],
            screenshots: [],
          };
        },
      }),
      createSpacerAdapter: () => ({ id: 'fake', viewports: [], ready: async () => {}, assert: async () => [] }),
      createModelGateway: () => {
        calls.analyze += 1;
        return { summary: () => ({}) };
      },
      redactObject: (value) => value,
      runVisionTask: async () => {
        calls.analyze += 1;
        return { ok: true, status: 'analyzed' };
      },
    };
    const service = createVisionService({ registry, home, deps: { vision: fakeVision } });
    const output = await service.run({ taskId: 'verify_1', projectId: 'demo', mode: 'verify' });
    assert.equal(calls.capture, 1);
    assert.equal(calls.analyze, 0, 'verify must not call the model');
    assert.equal(output.result.ok, true);
    assert.equal(output.result.status, 'verify_passed');
    assert.equal(output.result.repairVerified, false);
    assert.ok(fs.existsSync(output.reportFile));
    assert.equal(registry.readLock('demo'), null, 'vision run must not leak locks');
  } finally {
    removeWorkspace(root);
  }
});

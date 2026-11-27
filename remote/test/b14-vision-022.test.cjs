'use strict';

/**
 * B14 定向测试：
 *  - vendored Vision 0.2.2 身份、strict-repair 真实语义、defect/missing/newFailures
 *  - 宿主 delta 与 0.2.2 结构规则一致（ESM/CJS parity）
 *  - C13-P1-01 锁 released 标记活锁（S24 < 2s）
 *  - C13-P1-02/03/04 证据链 anchor 收养/降级/缺失签名/无 key
 *  - trusted-lab L-1/L-2 cleanup 精确白名单、marker、路径规范化、重解析点拒绝
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const { createProjectRegistry } = require('../lib/projects.cjs');
const { createEventStore } = require('../lib/events.cjs');
const { createDeltaPolicy } = require('../lib/vision-policy-delta.cjs');
const { structuralFindings, normalizeStructural } = require('../lib/vision-structure.cjs');
const visionPolicy = require('../lib/vision-policy.cjs');
const { makeWorkspace, removeWorkspace } = require('./helpers.cjs');

const VENDOR = path.join(__dirname, '..', '..', 'vendor', 'vision');
const LAB_SCRIPT = path.join(__dirname, '..', 'tools', 'trusted-lab', 'cleanup-lab.ps1');
const LAB_BASE = 'G:\\AI_GAME\\VPLAY-B14-WORK\\lab-tests';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('B14-vendor: Vision 0.2.2 identity and exports', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(VENDOR, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.2.2');
  const mod = await import(pathToFileURL(path.join(VENDOR, 'src', 'index.mjs')).href);
  assert.ok(Object.keys(mod).length >= 66, `exports=${Object.keys(mod).length}`);
  for (const name of ['compareVerification', 'defectKeyOf', 'validatePatchPlan', 'validateStructureDelta', 'installNetworkGuard', 'runVisionTask']) {
    assert.equal(typeof mod[name], 'function', name);
  }
  const guardMod = await import(pathToFileURL(path.join(VENDOR, 'src', 'browser', 'guard.mjs')).href);
  const guard = await guardMod.installNetworkGuard({
    context: { addInitScript: async () => {}, route: async () => {}, on: () => {} },
    previewUrl: 'http://127.0.0.1:8788/p/demo/',
  });
  assert.equal(typeof guard.enableRedirectGuard, 'function');
});

const PLAN = {
  diagnosis: 'safe class',
  patches: [{ file: 'index.html', old_string: '<div id="hud">HUD</div>', new_string: '<div id="hud" class="v">HUD</div>', reason: 'x' }],
  verification: ['hud'],
};

function capture({ ok, assertions, sha }) {
  return {
    ok,
    browserVersion: 'fake',
    durationMs: 1,
    screenshots: [{ viewport: 'pc', path: `/tmp/${sha}.png`, sha256: sha, bytes: 1 }],
    viewports: [{
      viewport: 'pc',
      ok,
      sha256: sha,
      assertions: assertions.map(([id, value, critical = true]) => ({ id, ok: value, critical, detail: {} })),
      diagnostics: { pageErrors: [], console: [], requestFailures: [] },
    }],
  };
}

function fakeGateway() {
  return {
    async analyzeScreenshots() {
      return {
        report: {
          summary: 'fixture',
          defects: [{
            id: 'model-id-varies',
            defect_type: 'ui_occlusion',
            location: { screen: 'pc', description: 'hud', region: null },
            severity: 'major',
            evidence: { screenshots: ['before.png'], observation: 'x' },
            confidence: 0.9,
            recommendation: 'x',
            verification: 'x',
          }],
          limitations: [],
        },
        meta: { model: 'fake', usage: {}, latencyMs: 1, requestId: 'r1' },
      };
    },
    async proposePatchPlan() {
      return { plan: PLAN, meta: { model: 'fake', usage: {}, latencyMs: 1, requestId: 'r2' } };
    },
    summary() { return {}; },
  };
}

async function runRealStrict({ before, after, defectAssertionIds = ['hud'], defectKey = 'V-001' }) {
  const vision = await import(pathToFileURL(path.join(VENDOR, 'src', 'index.mjs')).href);
  const root = makeWorkspace('vplay-b14-strict-');
  const calls = { rollback: 0, apply: 0, snapshot: 0 };
  try {
    write(path.join(root, 'index.html'), '<div id="hud">HUD</div>');
    const result = await vision.runVisionTask({
      taskId: 'b14_strict',
      projectId: 'demo',
      root,
      previewUrl: 'http://127.0.0.1:1/p/demo/',
      adapter: { id: 'fake', viewports: [{ name: 'pc' }] },
      browserRunner: { async runCapture({ scenario }) { return scenario === 'before' ? before : after; } },
      gateway: fakeGateway(),
      host: {
        async snapshot() { calls.snapshot += 1; return { seq: 7 }; },
        async applyFiles() { calls.apply += 1; },
        async diff() { return { counts: { added: 0, modified: 1, removed: 0 }, files: [{ file: 'index.html' }] }; },
        async rollback() { calls.rollback += 1; return { verified: true, previewReady: true }; },
      },
      mode: 'repair',
      allowedFiles: ['index.html'],
      maxRepairRounds: 1,
      verificationPolicy: 'strict-repair',
      defectAssertionIds,
      defectKey,
      sourceProvider: async () => '<div id="hud">HUD</div>',
      outDir: path.join(root, 'out'),
    });
    return { result, calls };
  } finally {
    removeWorkspace(root);
  }
}

const beforeFail = capture({ ok: false, assertions: [['hud', false]], sha: 'a'.repeat(64) });
const beforePass = capture({ ok: true, assertions: [['hud', true]], sha: 'a'.repeat(64) });
const afterPass = capture({ ok: true, assertions: [['hud', true]], sha: 'b'.repeat(64) });
const afterWithNewCritical = capture({
  ok: false,
  assertions: [['hud', true], ['new-bug', false]],
  sha: 'b'.repeat(64),
});
afterWithNewCritical.ok = false;

test('B14-strict: 0.2.2 repair_verified only for the same defect assertion before=false/after=true', async () => {
  const fixed = await runRealStrict({ before: beforeFail, after: afterPass });
  assert.equal(fixed.result.ok, true);
  assert.equal(fixed.result.status, 'repair_verified');
  assert.equal(fixed.result.strictVerification.ok, true);
  assert.equal(fixed.result.comparison.defect.ok, true);
  assert.equal(fixed.result.comparison.missingAssertions.length, 0);
  assert.equal(fixed.result.defect.defectKey, 'V-001');
  assert.equal(fixed.calls.rollback, 0);

  const noIds = await runRealStrict({ before: beforeFail, after: afterPass, defectAssertionIds: [] });
  assert.equal(noIds.result.ok, false);
  assert.equal(noIds.result.status, 'repair_unconfirmed');
  assert.equal(noIds.result.strictVerification.reason, 'no-defect-assertions');
  assert.equal(noIds.calls.rollback, 1);

  const notBefore = await runRealStrict({ before: beforePass, after: afterPass });
  assert.equal(notBefore.result.ok, false);
  assert.equal(notBefore.result.status, 'repair_unconfirmed');
  assert.equal(notBefore.result.comparison.defect.reason, 'defect-not-reproduced-before');

  const deleted = await runRealStrict({
    before: beforeFail,
    after: capture({ ok: true, assertions: [['other', true]], sha: 'b'.repeat(64) }),
  });
  assert.equal(deleted.result.ok, false);
  assert.equal(deleted.result.status, 'repair_unconfirmed');
  assert.ok(deleted.result.comparison.missingAssertions.length >= 1);
  assert.equal(deleted.result.strictVerification.reason, 'defect-assertion-missing');
  assert.equal(deleted.calls.rollback, 1);
});

test('B14-strict: after-only new critical failure cannot be repair_verified', async () => {
  const addedCritical = await runRealStrict({ before: beforeFail, after: afterWithNewCritical });
  assert.equal(addedCritical.result.ok, false);
  assert.ok(['repair_unconfirmed', 'repair_failed'].includes(addedCritical.result.status));
  assert.equal(addedCritical.calls.rollback, 1);
  const comparison = addedCritical.result.comparison || addedCritical.result.last?.comparison;
  assert.ok(comparison.newCriticalFailures.some((item) => item.id === 'new-bug'));
});

test('B14-delta: host rules match Vision 0.2.2 structure findings (ESM/CJS parity)', async () => {
  const esm = await import(pathToFileURL(path.join(VENDOR, 'src', 'patch', 'structure.mjs')).href);
  const corpus = [
    '<scr\nipt>alert(1)</scr\nipt>',
    '<a href="java\nscript:alert(1)">x</a>',
    '<!-- note --><div>x</div>',
    '<style>.a{color:red}</style><div>x</div>',
    '<h1 id="t">T</h1>',
    '<img src="//evil.example/x.png">',
    '<div>http://example.com</div>',
  ];
  for (const text of corpus) {
    const cjs = structuralFindings(text).slice().sort();
    const esmFindings = esm.structuralFindings(text).slice().sort();
    assert.deepEqual(cjs, esmFindings, text);
    assert.equal(normalizeStructural(text), esm.normalizeStructural(text), text);
  }
});

test('B14-delta: legal patch near baseline script passes, cross-line/structural breakage rejected', () => {
  const policy = createDeltaPolicy({ policy: visionPolicy });
  const root = makeWorkspace('vplay-b14-delta-');
  try {
    const before = '<script src="/app.js"></script><h1 id="t">T</h1>\n';
    write(path.join(root, 'index.html'), before);
    const after = before.replace('<h1 id="t">', '<h1 id="t" class="vision-safe">');
    const applied = policy.applyDelta({
      root,
      files: [{ file: 'index.html', content: after, sha256Before: sha256(before), sha256After: sha256(after) }],
      operations: [{
        file: 'index.html',
        start: before.indexOf('<h1 id="t">'),
        end: before.indexOf('<h1 id="t">') + '<h1 id="t">'.length,
        oldString: '<h1 id="t">',
        newString: '<h1 id="t" class="vision-safe">',
      }],
      allowedFiles: ['index.html'],
    });
    assert.equal(applied.files[0].file, 'index.html');

    const cross = before.replace('<h1 id="t">T</h1>', '<scr\nipt>alert(1)</scr\nipt>');
    assert.throws(
      () => policy.applyDelta({
        root,
        files: [{ file: 'index.html', content: cross, sha256Before: sha256(after), sha256After: sha256(cross) }],
        operations: [{
          file: 'index.html',
          start: after.indexOf('<h1 id="t" class="vision-safe">T</h1>'),
          end: after.indexOf('<h1 id="t" class="vision-safe">T</h1>') + '<h1 id="t" class="vision-safe">T</h1>'.length,
          oldString: '<h1 id="t" class="vision-safe">T</h1>',
          newString: '<scr\nipt>alert(1)</scr\nipt>',
        }],
        allowedFiles: ['index.html'],
      }),
      (error) => error.code === 'DELTA_CONTENT_REJECTED',
    );

    // 未闭合注释（替换操作，非零长度）→ 拒绝
    const current = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const anchorText = '<h1 id="t" class="vision-safe">T</h1>';
    const broken = current.replace(anchorText, `<!-- note ${anchorText}`);
    assert.throws(
      () => policy.applyDelta({
        root,
        files: [{ file: 'index.html', content: broken, sha256Before: sha256(current), sha256After: sha256(broken) }],
        operations: [{
          file: 'index.html',
          start: current.indexOf(anchorText),
          end: current.indexOf(anchorText) + anchorText.length,
          oldString: anchorText,
          newString: `<!-- note ${anchorText}`,
        }],
        allowedFiles: ['index.html'],
      }),
      (error) => error.code === 'DELTA_CONTENT_REJECTED',
    );
  } finally {
    removeWorkspace(root);
  }
});

test('B14-lock: released marker (pid=0) is reclaimed under 2s (C13-P1-01 / S24)', () => {
  const root = makeWorkspace('vplay-b14-lock-');
  const home = path.join(root, 'home');
  try {
    const registry = createProjectRegistry({ home });
    write(path.join(root, 'src', 'index.html'), '<h1>v1</h1>');
    registry.importProject({ sourceDir: path.join(root, 'src'), id: 'demo' });
    const lockFile = path.join(home, '.opengame', 'registry.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 0, token: 'released', at: Date.now() }), 'utf8');
    const started = Date.now();
    registry.snapshot('demo', 'after-released-marker');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `elapsed=${elapsed}ms`);
  } finally {
    removeWorkspace(root);
  }
});

function makeChain(dir, key) {
  const file = path.join(dir, 'events', 'events.jsonl');
  const store = createEventStore({ file, hmacKey: key });
  for (let i = 1; i <= 3; i += 1) store.append({ type: 'task.event', taskId: `t${i}`, status: `s${i}` });
  return { file, store, anchor: path.join(dir, 'events', 'events.anchor.json') };
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
}

test('B14-events: tail deletion and anchor deletion cannot be adopted silently (C13-P1-02)', () => {
  const key = 'b14-hmac-key-0123456789';
  const root = makeWorkspace('vplay-b14-anchor-');
  try {
    const a = makeChain(path.join(root, 'a'), key);
    assert.equal(a.store.verify().ok, true);
    fs.writeFileSync(a.file, `${readLines(a.file).slice(0, 2).join('\n')}\n`);
    const afterTail = createEventStore({ file: a.file, hmacKey: key }).verify();
    assert.equal(afterTail.ok, false);
    assert.ok(afterTail.problems.includes('ANCHOR_COUNT_MISMATCH'));

    const b = makeChain(path.join(root, 'b'), key);
    fs.rmSync(b.anchor, { force: true });
    fs.writeFileSync(b.file, `${readLines(b.file).slice(0, 2).join('\n')}\n`);
    const reopened = createEventStore({ file: b.file, hmacKey: key });
    const missing = reopened.verify();
    assert.equal(missing.ok, false);
    assert.ok(missing.problems.includes('ANCHOR_MISSING'));
    assert.equal(fs.existsSync(b.anchor), false, 'must not auto-create anchor with a key');
    assert.equal(reopened.append({ type: 'task.event', status: 'x' }), null);

    // 无 key + 显式 opt-in 才允许收养，并永久报告 ANCHOR_ADOPTED
    const c = makeChain(path.join(root, 'c'), null);
    fs.rmSync(c.anchor, { force: true });
    const noOpt = createEventStore({ file: c.file }).verify();
    assert.ok(noOpt.problems.includes('ANCHOR_MISSING'));
    process.env.VPLAY_ALLOW_ANCHOR_ADOPT = '1';
    let adopted;
    try {
      adopted = createEventStore({ file: c.file });
    } finally {
      delete process.env.VPLAY_ALLOW_ANCHOR_ADOPT;
    }
    const adoptedVerify = adopted.verify();
    assert.equal(adoptedVerify.ok, false);
    assert.ok(adoptedVerify.problems.includes('ANCHOR_ADOPTED'));
  } finally {
    removeWorkspace(root);
  }
});

test('B14-events: anchor downgrade, missing signature and no-key verification fail closed (C13-P1-03/04)', () => {
  const key = 'b14-hmac-key-0123456789';
  const root = makeWorkspace('vplay-b14-evidence-');
  try {
    const a = makeChain(path.join(root, 'a'), key);
    const anchor = JSON.parse(fs.readFileSync(a.anchor, 'utf8'));
    const lines = readLines(a.file);
    fs.writeFileSync(a.file, `${lines.slice(0, 2).join('\n')}\n`);
    const second = JSON.parse(lines[1]);
    fs.writeFileSync(a.anchor, JSON.stringify({
      ...anchor,
      count: 2,
      lastId: String(second.id),
      head: second.hash,
      alg: 'sha256',
      hmac: undefined,
    }, null, 2));
    const downgraded = createEventStore({ file: a.file, hmacKey: key }).verify();
    assert.equal(downgraded.ok, false);
    assert.ok(downgraded.problems.includes('ANCHOR_ALG_DOWNGRADE'));

    const b = makeChain(path.join(root, 'b'), key);
    const bLines = readLines(b.file);
    const firstRecord = JSON.parse(bLines[0]);
    delete firstRecord.hmac;
    bLines[0] = JSON.stringify(firstRecord);
    fs.writeFileSync(b.file, `${bLines.join('\n')}\n`);
    const missingSig = createEventStore({ file: b.file, hmacKey: key }).verify();
    assert.equal(missingSig.ok, false);
    assert.ok(missingSig.problems.some((item) => item.startsWith('RECORD_HMAC_MISSING')));

    const c = makeChain(path.join(root, 'c'), key);
    const noKey = createEventStore({ file: c.file }).verify();
    assert.equal(noKey.ok, false);
    assert.ok(noKey.problems.includes('HMAC_KEY_REQUIRED'));
    assert.ok(noKey.problems.includes('HMAC_KEY_MISSING'));

    const wrongKey = createEventStore({ file: c.file, hmacKey: 'wrong-key-0123456789' }).verify();
    assert.equal(wrongKey.ok, false);
  } finally {
    removeWorkspace(root);
  }
});

function runCleanup({ config, labRoot, approve = false }) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', LAB_SCRIPT,
    '-Config', config,
    '-LabRoot', labRoot,
  ];
  if (approve) args.push('-Approve');
  return spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 30000 });
}

test('B14-lab: cleanup requires exact configured labRoot and marker; reparse points rejected (C13 L-1/L-2)', () => {
  if (!fs.existsSync(LAB_SCRIPT)) {
    test.skip?.('cleanup-lab.ps1 missing');
    return;
  }
  fs.mkdirSync(LAB_BASE, { recursive: true });
  const base = fs.mkdtempSync(path.join(LAB_BASE, 'case-'));
  const lab = path.join(base, 'lab');
  const other = path.join(base, 'other');
  const config = path.join(base, 'lab-config.json');
  try {
    fs.mkdirSync(lab, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(lab, 'marker.txt'), 'x');
    fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, labRoot: lab, publicMode: false }));

    // 未配置 labRoot → 拒绝
    const mismatch = runCleanup({ config, labRoot: other });
    assert.notEqual(mismatch.status, 0);
    assert.match(`${mismatch.stdout}${mismatch.stderr}`, /must exactly equal configured labRoot/i);

    // 缺 marker → 拒绝
    const noMarker = runCleanup({ config, labRoot: lab });
    assert.notEqual(noMarker.status, 0);
    assert.match(`${noMarker.stdout}${noMarker.stderr}`, /marker missing/i);

    // marker 正确 → DryRun 不删除
    fs.writeFileSync(path.join(lab, '.vplay-lab-marker'), JSON.stringify({
      schemaVersion: 1,
      labRoot: lab,
    }));
    const dry = runCleanup({ config, labRoot: lab });
    assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`);
    assert.ok(fs.existsSync(lab));

    // 重解析点（junction）→ 拒绝
    const junction = path.join(lab, 'link-out');
    const made = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `New-Item -ItemType Junction -Path '${junction}' -Target '${other}' | Out-Null`,
    ], { encoding: 'utf8', timeout: 30000 });
    if (made.status === 0) {
      const reparse = runCleanup({ config, labRoot: lab });
      assert.notEqual(reparse.status, 0);
      assert.match(`${reparse.stdout}${reparse.stderr}`, /reparse point/i);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

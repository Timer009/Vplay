'use strict';

/**
 * B10 / D 独立证据：
 *  - 产品证据包：HMAC + 全量 manifest + 事件链的离线校验与负对照
 *  - Qoder `verify-run.cjs` 契约适配：合成包 PASS，篡改/降级 FAIL
 *
 * 说明：Qoder 部分验证的是「契约适配器」，不是产品真实验收包；
 * 真实包仍需 Qoder 端到端执行（本轮未宣称通过）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createEventStore } = require('../lib/events.cjs');
const { createEvidenceStore } = require('../lib/evidence.cjs');
const { verifyWithQoder, resolveVerifyRun } = require('../lib/qoder-evidence.cjs');
const { makeWorkspace, removeWorkspace } = require('./helpers.cjs');

const HMAC_KEY = 'b10-evidence-key';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function canonical(record) {
  return stableStringify({
    seq: record.seq,
    at: record.at,
    runId: record.runId,
    taskId: record.taskId,
    type: record.type,
    actor: record.actor,
    payload: record.payload,
    prevHash: record.prevHash,
  });
}

test('B10-D: product evidence verifies, then detects tamper/downgrade/extra files', () => {
  const root = makeWorkspace('vplay-b10-evidence-');
  try {
    const home = path.join(root, 'home');
    const events = createEventStore({ file: path.join(home, 'events', 'events.jsonl'), hmacKey: HMAC_KEY });
    events.append({ type: 'task.created', taskId: 'task_ev', projectId: 'demo', status: 'queued' });
    events.append({ type: 'task.running', taskId: 'task_ev', projectId: 'demo', status: 'running' });
    events.append({ type: 'task.succeeded', taskId: 'task_ev', projectId: 'demo', status: 'succeeded' });

    const store = createEvidenceStore({ home, root: path.join(home, 'evidence'), hmacKey: HMAC_KEY });
    const written = store.writeTaskEvidence({
      task: { id: 'task_ev', projectId: 'demo', status: 'succeeded', createdBy: 'admin' },
      result: { verified: true, outcome: 'verified', changedFiles: { modified: 1 } },
      versionId: '003-abc',
      events: events.listForTask('task_ev'),
      logText: 'done\n',
    });

    const good = store.verifyEvidence(written.dir, { hmacKey: HMAC_KEY, requireHmac: true });
    assert.equal(good.ok, true, good.reasons.join(','));
    const anchor = JSON.parse(fs.readFileSync(path.join(written.dir, 'anchor.json'), 'utf-8'));
    assert.equal(anchor.alg, 'hmac-sha256');
    assert.equal(anchor.keyFingerprint, sha256(HMAC_KEY).slice(0, 16));

    // 负对照 1：报告被篡改
    const reportFile = path.join(written.dir, 'report.json');
    const originalReport = fs.readFileSync(reportFile, 'utf-8');
    fs.writeFileSync(reportFile, originalReport.replace('"verified": true', '"verified": false'));
    const tampered = store.verifyEvidence(written.dir, { hmacKey: HMAC_KEY, requireHmac: true });
    assert.equal(tampered.ok, false);
    assert.ok(tampered.reasons.includes('REPORT_TAMPERED'));
    fs.writeFileSync(reportFile, originalReport);

    // 负对照 2：去掉 HMAC 声明（降级为 SHA-256）必须被拒
    const anchorFile = path.join(written.dir, 'anchor.json');
    const originalAnchor = fs.readFileSync(anchorFile, 'utf-8');
    fs.writeFileSync(anchorFile, JSON.stringify({ ...anchor, alg: 'sha256', hmac: null }, null, 2));
    const downgraded = store.verifyEvidence(written.dir, { hmacKey: HMAC_KEY, requireHmac: true });
    assert.equal(downgraded.ok, false);
    assert.ok(downgraded.reasons.includes('HMAC_REQUIRED'));
    fs.writeFileSync(anchorFile, originalAnchor);

    // 负对照 3：错误密钥
    const wrongKey = store.verifyEvidence(written.dir, { hmacKey: 'wrong-key', requireHmac: true });
    assert.equal(wrongKey.ok, false);
    assert.ok(wrongKey.reasons.includes('HMAC_KEY_WRONG'));

    // 负对照 4：目录内多余文件
    fs.writeFileSync(path.join(written.dir, 'extra.txt'), 'x');
    const extra = store.verifyEvidence(written.dir, { hmacKey: HMAC_KEY, requireHmac: true });
    assert.equal(extra.ok, false);
    assert.ok(extra.reasons.some((reason) => reason.startsWith('FILE_EXTRA')));
  } finally {
    removeWorkspace(root);
  }
});

function appendChain(records, state, entry) {
  state.seq += 1;
  const record = {
    seq: state.seq,
    at: new Date().toISOString(),
    runId: state.runId,
    taskId: state.taskId,
    type: entry.type,
    actor: entry.actor || { pid: process.pid, name: 'node' },
    payload: entry.payload || {},
    prevHash: state.prevHash,
    alg: 'hmac-sha256',
  };
  record.hash = crypto.createHmac('sha256', HMAC_KEY).update(canonical(record)).digest('hex');
  state.prevHash = record.hash;
  records.push(record);
}

async function runRecorder(afterDir, pkgDir) {
  const recorder =
    process.env.QODER_RECORDER ||
    path.join(__dirname, '..', 'tools', 'qoder', 'recorder', 'host-recorder.cjs');
  if (!fs.existsSync(recorder)) return false;
  await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [recorder, `--src=${afterDir}`, `--out=${pkgDir}`, '--interval=1000', '--seconds=3', '--with-procs=0'],
      { stdio: 'ignore', windowsHide: true },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return fs.existsSync(path.join(pkgDir, '03-host-recorder.jsonl'));
}

async function buildSyntheticPackage(pkgDir) {
  fs.mkdirSync(pkgDir, { recursive: true });
  const baselineDir = path.join(pkgDir, '01-baseline', 'src');
  const afterDir = path.join(pkgDir, '08-patch', 'after');
  write(path.join(baselineDir, 'index.html'), '<h1>ORIGINAL</h1>\n');
  write(path.join(afterDir, 'index.html'), '<h1>FIXED</h1>\n');
  write(path.join(pkgDir, '07-screenshots', 'shot-1.png'), Buffer.from('89504e470d0a1a0a-1'));
  write(path.join(pkgDir, '07-screenshots', 'shot-2.png'), Buffer.from('89504e470d0a1a0a-2'));
  write(path.join(pkgDir, '04-tasks.json'), '{"tasks":[]}');
  write(path.join(pkgDir, '05-task.log'), 'log\n');
  write(path.join(pkgDir, '06-vision-artifact.json'), '{"captureId":"b10","executor":"cli"}');
  write(path.join(pkgDir, '08-diff.patch'), '-ORIGINAL\n+FIXED\n');
  write(path.join(pkgDir, '13-report.md'), '# report\n');
  const pid = process.pid;
  write(path.join(pkgDir, '11-anchors', 'usn.csv'), `pid,path\n${pid},index.html\n`);
  write(path.join(pkgDir, '11-anchors', 'phone-video.sha256'), `${sha256('video')}  phone.mp4\n`);
  write(path.join(pkgDir, '11-anchors', 'witness.md'), 'witness\n');

  const baseline = { srcDigest: sha256('ORIGINAL'), entryPath: 'index.html' };
  write(path.join(pkgDir, '01-baseline.json'), JSON.stringify(baseline, null, 2));

  const afterFile = path.join(afterDir, 'index.html');
  const afterSha = sha256(fs.readFileSync(afterFile));
  const shot1 = sha256(fs.readFileSync(path.join(pkgDir, '07-screenshots', 'shot-1.png')));
  const shot2 = sha256(fs.readFileSync(path.join(pkgDir, '07-screenshots', 'shot-2.png')));
  write(
    path.join(pkgDir, '09-preview-manifest.json'),
    JSON.stringify({ entryPath: 'index.html', entrySha256: afterSha, externalResources: [] }, null, 2),
  );
  const atNow = new Date().toISOString();
  write(
    path.join(pkgDir, '10-provider-usage.csv'),
    `requestId,totalTokens,at\nreq-1,120,${atNow}\n`,
  );

  await runRecorder(afterDir, pkgDir);

  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({ rel: path.relative(afterDir, full).split(path.sep).join('/'), sha256: sha256(fs.readFileSync(full)) });
    }
  })(afterDir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const finalDigest = sha256(files.map((file) => `${file.rel}\0${file.sha256}`).join('\n'));

  const records = [];
  const state = { seq: 0, prevHash: '', runId: 'run-b10', taskId: 'task-b10' };
  appendChain(records, state, { type: 'RUN_START', payload: { testSeam: false, executor: 'cli' } });
  appendChain(records, state, { type: 'BUILD_STARTED', payload: { pid } });
  appendChain(records, state, { type: 'BASELINE', payload: { srcDigest: baseline.srcDigest } });
  appendChain(records, state, { type: 'LOCK_ACQUIRED', payload: { projectId: 'demo' } });
  appendChain(records, state, {
    type: 'MODEL_REQUEST',
    payload: { requestId: 'req-1', at: atNow, usage: { totalTokens: 120 } },
  });
  appendChain(records, state, {
    type: 'FILES_APPLIED',
    payload: {
      patches: [{ file: 'index.html', old_string: 'ORIGINAL', new_string: 'FIXED' }],
      files: [{ path: 'index.html', afterSha256: afterSha }],
    },
  });
  appendChain(records, state, { type: 'CAPTURE', payload: { sha256: shot1 } });
  appendChain(records, state, { type: 'CAPTURE', payload: { sha256: shot2 } });
  appendChain(records, state, { type: 'PREVIEW_PUBLISHED', payload: { entrySha256: afterSha } });
  appendChain(records, state, { type: 'TASK_FINISHED', payload: { finalSrcDigest: finalDigest } });
  appendChain(records, state, { type: 'LOCK_RELEASED', payload: { projectId: 'demo' } });
  write(
    path.join(pkgDir, '02-server-chain.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );

  const manifestFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(pkgDir, full).split(path.sep).join('/');
        if (rel !== '00-manifest.json') manifestFiles.push({ path: rel, sha256: sha256(fs.readFileSync(full)) });
      }
    }
  })(pkgDir);
  write(path.join(pkgDir, '00-manifest.json'), JSON.stringify({ files: manifestFiles }, null, 2));
  return pkgDir;
}

test('B10-D/Qoder: contract adapter passes a synthetic package and fails negative controls', async (t) => {
  if (!fs.existsSync(resolveVerifyRun())) {
    t.skip(`Qoder verify-run not available at ${resolveVerifyRun()}`);
    return;
  }
  const root = makeWorkspace('vplay-b10-qoder-');
  try {
    const pkg = path.join(root, 'pkg');
    await buildSyntheticPackage(pkg);
    const pass = verifyWithQoder(pkg, { hmacKey: HMAC_KEY, requireHmac: true });
    assert.equal(pass.verdict, 'PASS', `${pass.codes.join(',')}`);
    assert.ok(pass.result.steps.every((step) => step.status === 'PASS'), JSON.stringify(pass.result.steps.filter((s) => s.status !== 'PASS')));

    // 负对照 A：篡改最终产物 → 重放/摘要失败
    fs.appendFileSync(path.join(pkg, '08-patch', 'after', 'index.html'), '<!-- tampered -->\n');
    const tampered = verifyWithQoder(pkg, { hmacKey: HMAC_KEY, requireHmac: true });
    assert.equal(tampered.verdict, 'FAIL');

    // 还原后，负对照 B：链降级为无 alg → 适配器拒绝（HMAC_REQUIRED）
    const chainFile = path.join(pkg, '02-server-chain.jsonl');
    const chain = fs
      .readFileSync(chainFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    fs.writeFileSync(
      chainFile,
      `${chain.map((record) => JSON.stringify({ ...record, alg: undefined })).join('\n')}\n`,
    );
    const downgraded = verifyWithQoder(pkg, { hmacKey: HMAC_KEY, requireHmac: true });
    assert.equal(downgraded.verdict, 'FAIL');
    assert.ok(downgraded.codes.includes('HMAC_REQUIRED'));
  } finally {
    removeWorkspace(root);
  }
});

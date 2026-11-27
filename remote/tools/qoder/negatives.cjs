'use strict';

/**
 * C07 §6.6 的 8 项负对照。
 * 每个用例构造一个“只含单一缺陷”的合成证据包，交给 verify-run 校验；
 * 8/8 被检出（verdict=FAIL 且命中预期 code）才算工具可信。
 *
 * 用法：node evidence/negatives.cjs [--json] [--keep]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyRun, hashRecord, sha256 } = require('./verify-run.cjs');

// B11：负对照产物写到系统临时目录，避免污染仓库（原实现写到 evidence/..）。
const ROOT = path.join(os.tmpdir(), 'vplay-qoder-negatives');
const OUT = path.join(ROOT, 'sandbox', 'negatives');

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out.sort();
}

function digestOf(dir) {
  const files = walk(dir)
    .map((file) => ({ rel: path.relative(dir, file).split(path.sep).join('/'), sha256: sha256(fs.readFileSync(file)) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return sha256(files.map((file) => `${file.rel}\0${file.sha256}`).join('\n'));
}

const T = Date.parse('2026-11-27T10:00:00.000Z');

function at(offsetMs) {
  return new Date(T + offsetMs).toISOString();
}

function buildRun(dir, options = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '01-baseline', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '08-patch', 'after'), { recursive: true });
  fs.mkdirSync(path.join(dir, '07-screenshots'), { recursive: true });
  fs.mkdirSync(path.join(dir, '11-anchors'), { recursive: true });

  const before = '<html><body><p>OLD</p></body></html>';
  const after = options.noChange ? before : '<html><body><p>NEW</p></body></html>';
  fs.writeFileSync(path.join(dir, '01-baseline', 'src', 'index.html'), before);
  fs.writeFileSync(path.join(dir, '08-patch', 'after', 'index.html'), after);
  fs.writeFileSync(path.join(dir, '08-diff.patch'), '--- a/index.html\n+++ b/index.html\n-<p>OLD</p>\n+<p>NEW</p>\n');
  fs.writeFileSync(path.join(dir, '05-task.log'), 'c08 synthetic log\n');
  fs.writeFileSync(path.join(dir, '13-report.md'), '# synthetic run\n');
  fs.writeFileSync(path.join(dir, '04-tasks.json'), JSON.stringify([{ id: 'task-c08' }], null, 2));
  fs.writeFileSync(path.join(dir, '06-vision-artifact.json'), JSON.stringify({ taskId: 'task-c08', events: [] }, null, 2));

  const shotA = Buffer.from('PNG-A-0001');
  fs.writeFileSync(path.join(dir, '07-screenshots', 'r1-before.png'), shotA);
  fs.writeFileSync(path.join(dir, '07-screenshots', 'r1-after.png'), options.duplicateShot ? shotA : Buffer.from('PNG-B-0002'));

  const baselineDigest = digestOf(path.join(dir, '01-baseline', 'src'));
  const afterDigest = digestOf(path.join(dir, '08-patch', 'after'));
  const shotBefore = sha256(fs.readFileSync(path.join(dir, '07-screenshots', 'r1-before.png')));
  const shotAfter = sha256(fs.readFileSync(path.join(dir, '07-screenshots', 'r1-after.png')));

  const records = [];
  const push = (type, payload, actor = { kind: 'vplay', pid: 4242 }) => {
    const prev = records[records.length - 1];
    const record = {
      seq: records.length + 1,
      at: at(records.length * 1000),
      runId: 'run-c08',
      taskId: 'task-c08',
      type,
      actor,
      payload,
      prevHash: prev ? prev.hash : '',
    };
    record.hash = hashRecord(record, '');
    records.push(record);
  };

  push('RUN_START', {
    commit: 'fcfd880',
    testSeam: options.testSeam ? true : false,
    executor: options.mockExecutor ? 'mock-executor.cjs' : 'cli',
    node: process.version,
  });
  push('LOCK_ACQUIRED', { owner: 'c08' });
  push('BASELINE', { srcDigest: baselineDigest, gitHead: 'fcfd880' });
  push('MODEL_REQUEST', { requestId: 'req-c08-1', model: 'qwen4-max', usage: { totalTokens: 100 }, at: at(0) });
  push('FILES_APPLIED', {
    files: [{ path: 'index.html', afterSha256: sha256(Buffer.from(after)) }],
    patches: [{ file: 'index.html', old_string: '<p>OLD</p>', new_string: options.noChange ? '<p>OLD</p>' : '<p>NEW</p>' }],
  });
  push('BUILD_STARTED', { command: 'npm run build', pid: options.buildPidMismatch ? 9999 : 4343 });
  push('PREVIEW_PUBLISHED', { entrySha256: sha256(Buffer.from(after)) });
  push('CAPTURE', { phase: 'before', sha256: shotBefore, at: at(3000) });
  push('CAPTURE', { phase: 'after', sha256: shotAfter, at: at(4000) });
  push('LOCK_RELEASED', { owner: 'c08' });
  if (options.rollbackLiar) {
    push('ROLLBACK', { verified: true, previewReady: true, targetDigest: baselineDigest, entrySha256: sha256(Buffer.from('STALE')) });
  }
  push('TASK_FINISHED', { status: 'succeeded', finalSrcDigest: options.noChange ? baselineDigest : afterDigest });

  if (options.tampered) {
    records[4].payload = { files: [], patches: [], note: 'tampered' };
  }

  fs.writeFileSync(path.join(dir, '02-server-chain.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const recorderSamples = [];
  for (let i = -2; i <= 12; i += 1) {
    recorderSamples.push({ seq: i + 3, at: at(i * 1000), digest: baselineDigest, note: 'sample' });
  }
  fs.writeFileSync(path.join(dir, '03-host-recorder.jsonl'), `${recorderSamples.map((sample) => JSON.stringify(sample)).join('\n')}\n`);

  const usnRows = [
    'at,pid,action,path',
    `${at(2000)},4242,write,projects/c08/src/index.html`,
    `${at(5000)},4343,write,projects/c08/dist/index.html`,
  ];
  if (options.extraUsnPid) usnRows.push(`${at(6000)},${options.extraUsnPid},write,projects/c08/src/index.html`);
  fs.writeFileSync(path.join(dir, '11-anchors', 'usn.csv'), `${usnRows.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, '11-anchors', 'phone-video.sha256'), `${sha256('phone-video')}  phone.mp4\n`);
  fs.writeFileSync(path.join(dir, '11-anchors', 'witness.md'), 'witness: C08 synthetic\n');

  fs.writeFileSync(
    path.join(dir, '10-provider-usage.csv'),
    `requestId,model,totalTokens,at\nreq-c08-1,qwen4-max,100,${at(0)}\n`,
  );

  const previewManifest = {
    entryPath: 'index.html',
    entrySha256: options.rollbackLiar ? sha256(Buffer.from('STALE')) : sha256(Buffer.from(after)),
    files: [{ path: 'index.html', sha256: sha256(Buffer.from(after)) }],
    externalResources: options.externalResource ? ['https://evil.example/x.js'] : [],
  };
  fs.writeFileSync(path.join(dir, '09-preview-manifest.json'), JSON.stringify(previewManifest, null, 2));

  const manifest = {
    runId: 'run-c08',
    commit: 'fcfd880',
    createdAt: at(0),
    files: [],
  };
  const names = [
    '01-baseline.json',
    '02-server-chain.jsonl',
    '03-host-recorder.jsonl',
    '04-tasks.json',
    '05-task.log',
    '06-vision-artifact.json',
    '08-diff.patch',
    '09-preview-manifest.json',
    '10-provider-usage.csv',
    '11-anchors/usn.csv',
    '11-anchors/phone-video.sha256',
    '11-anchors/witness.md',
    '13-report.md',
    '07-screenshots/r1-before.png',
    '07-screenshots/r1-after.png',
    '08-patch/after/index.html',
    '01-baseline/src/index.html',
  ];
  fs.writeFileSync(
    path.join(dir, '01-baseline.json'),
    JSON.stringify({ gitHead: 'fcfd880', srcDigest: baselineDigest, files: [] }, null, 2),
  );
  manifest.files = names
    .filter((name) => fs.existsSync(path.join(dir, name)))
    .map((name) => ({ path: name, sha256: sha256(fs.readFileSync(path.join(dir, name))) }));
  fs.writeFileSync(path.join(dir, '00-manifest.json'), JSON.stringify(manifest, null, 2));

  return { before: baselineDigest, after: afterDigest };
}

const CASES = [
  { id: 'NC-1', name: '锁空闲期外部写入', options: { extraUsnPid: 7001 }, expect: ['PID_UNEXPECTED'] },
  { id: 'NC-2', name: '预埋修复 + no-op 任务', options: { noChange: true }, expect: ['NO_CHANGES'] },
  { id: 'NC-3', name: '复用旧截图', options: { duplicateShot: true }, expect: ['SCREENSHOT_DUPLICATE'] },
  { id: 'NC-4', name: '篡改链中间一行', options: { tampered: true }, expect: ['CHAIN_BROKEN'] },
  { id: 'NC-5', name: 'mock executor 冒充 CLI', options: { testSeam: true, mockExecutor: true }, expect: ['TEST_SEAM'] },
  { id: 'NC-6', name: '外部进程构建/截图', options: { buildPidMismatch: true }, expect: ['PID_UNEXPECTED'] },
  { id: 'NC-7', name: '预览外链资源', options: { externalResource: true }, expect: ['EXTERNAL_RESOURCE'] },
  { id: 'NC-8', name: '回退谎报 verified', options: { rollbackLiar: true }, expect: ['ROLLBACK_INCONSISTENT'] },
];

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  // 基线（无缺陷）必须判 PASS，否则负对照没有意义
  const goodDir = path.join(OUT, 'baseline-good');
  buildRun(goodDir, {});
  const good = verifyRun(goodDir, {});
  results.push({ id: 'baseline', name: '无缺陷基线', verdict: good.verdict, ok: good.verdict === 'PASS', failed: good.failed });

  for (const testCase of CASES) {
    const dir = path.join(OUT, testCase.id);
    buildRun(dir, testCase.options);
    const result = verifyRun(dir, {});
    const hit = result.failed.some((code) => testCase.expect.includes(code));
    results.push({
      id: testCase.id,
      name: testCase.name,
      verdict: result.verdict,
      detected: hit,
      failed: result.failed,
      expected: testCase.expect,
      ok: result.verdict === 'FAIL' && hit,
    });
  }

  const detected = results.filter((item) => item.id !== 'baseline' && item.ok).length;
  const summary = { at: new Date().toISOString(), total: CASES.length, detected, baselineOk: results[0].ok, results };
  if (process.argv.includes('--keep') === false) {
    // 保留合成包供人工查看；如需清理用 --clean
  }
  if (process.argv.includes('--clean')) fs.rmSync(OUT, { recursive: true, force: true });
  if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`baseline: ${results[0].verdict}`);
    for (const item of results.slice(1)) {
      console.log(`${item.id} ${item.detected ? 'DETECTED' : 'MISSED'}  ${item.name}  failed=[${item.failed.join(',')}]`);
    }
    console.log(`detected ${detected}/${CASES.length}`);
  }
  process.exit(detected === CASES.length && results[0].ok ? 0 : 1);
}

module.exports = { buildRun, CASES };

if (require.main === module) main();

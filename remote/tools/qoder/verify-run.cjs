'use strict';

/**
 * 证据包离线校验器（C07 §6.5 的 12 步实现）。
 * 只读：不修改证据包；12-verify.json 由 CLI 外壳写入。
 *
 * 用法：
 *   node evidence/verify-run.cjs <evidenceDir> [--hmac-key-file=<path>] [--json]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REQUIRED = [
  '00-manifest.json',
  '01-baseline.json',
  '02-server-chain.jsonl',
  '03-host-recorder.jsonl',
  '04-tasks.json',
  '05-task.log',
  '06-vision-artifact.json',
  '07-screenshots',
  '08-diff.patch',
  '09-preview-manifest.json',
  '10-provider-usage.csv',
  '11-anchors',
  '13-report.md',
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function canonicalRecord(record) {
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

function hashRecord(record, hmacKey) {
  const data = canonicalRecord(record);
  return hmacKey
    ? crypto.createHmac('sha256', hmacKey).update(data).digest('hex')
    : crypto.createHash('sha256').update(data).digest('hex');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return null;
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (error) {
      out.push({ __parseError: error.message, __raw: trimmed.slice(0, 200) });
    }
  }
  return out;
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out.sort();
}

function relPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split(',').map((cell) => cell.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    header.forEach((key, index) => {
      row[key] = (cells[index] || '').trim();
    });
    return row;
  });
  return { header, rows };
}

function step(number, title, fn) {
  try {
    const result = fn() || {};
    return { step: number, title, status: result.status || 'PASS', code: result.code || null, detail: result.detail || '', extra: result.extra || null };
  } catch (error) {
    return { step: number, title, status: 'FAIL', code: 'STEP_EXCEPTION', detail: String(error && error.message ? error.message : error) };
  }
}

function verifyRun(dir, options = {}) {
  const root = path.resolve(dir);
  const hmacKey = options.hmacKey || '';
  const steps = [];

  const manifest = readJson(path.join(root, '00-manifest.json'), null);
  const baseline = readJson(path.join(root, '01-baseline.json'), null);
  const chain = readJsonl(path.join(root, '02-server-chain.jsonl'));
  const recorder = readJsonl(path.join(root, '03-host-recorder.jsonl'));
  const previewManifest = readJson(path.join(root, '09-preview-manifest.json'), null);
  const artifact = readJson(path.join(root, '06-vision-artifact.json'), null);

  steps.push(
    step(1, 'manifest 完整性与自校验', () => {
      if (!manifest) return { status: 'FAIL', code: 'MANIFEST_MISSING', detail: '00-manifest.json 缺失' };
      const missing = REQUIRED.filter((name) => !fs.existsSync(path.join(root, name)));
      const listed = Array.isArray(manifest.files) ? manifest.files : [];
      const mismatched = [];
      for (const item of listed) {
        const file = path.join(root, item.path);
        if (!fs.existsSync(file)) {
          mismatched.push(`${item.path}: missing`);
          continue;
        }
        const actual = sha256(fs.readFileSync(file));
        if (item.sha256 && actual !== item.sha256) mismatched.push(`${item.path}: ${actual.slice(0, 12)}≠${String(item.sha256).slice(0, 12)}`);
      }
      if (missing.length) return { status: 'FAIL', code: 'EVIDENCE_INCOMPLETE', detail: `缺少 ${missing.length} 项：${missing.join(', ')}`, extra: { missing } };
      if (mismatched.length) return { status: 'FAIL', code: 'MANIFEST_MISMATCH', detail: `哈希不一致 ${mismatched.length} 项`, extra: { mismatched } };
      return { detail: `${REQUIRED.length} 项齐全；${listed.length} 个文件哈希一致`, extra: { manifestSha256: sha256(fs.readFileSync(path.join(root, '00-manifest.json'))) } };
    }),
  );

  steps.push(
    step(2, '哈希链重算', () => {
      if (!chain) return { status: 'FAIL', code: 'CHAIN_MISSING', detail: '02-server-chain.jsonl 缺失' };
      if (!chain.length) return { status: 'FAIL', code: 'CHAIN_EMPTY', detail: '哈希链为空' };
      const usesHmac = chain.some((record) => record && record.alg === 'hmac-sha256');
      if (usesHmac && !hmacKey) {
        return { status: 'INCONCLUSIVE', code: 'HMAC_KEY_MISSING', detail: '链使用 HMAC，但未提供密钥' };
      }
      let broken = null;
      for (const record of chain) {
        if (record.__parseError) {
          broken = { seq: null, reason: `JSON 解析失败：${record.__parseError}` };
          break;
        }
        const expected = hashRecord(record, usesHmac ? hmacKey : '');
        if (expected !== record.hash) {
          broken = { seq: record.seq, reason: `hash 不匹配（期望 ${expected.slice(0, 12)}…）` };
          break;
        }
      }
      if (broken) return { status: 'FAIL', code: 'CHAIN_BROKEN', detail: `seq=${broken.seq} ${broken.reason}`, extra: broken };
      return { detail: `${chain.length} 条记录哈希全部匹配（${usesHmac ? 'HMAC-SHA256' : 'SHA-256'}）` };
    }),
  );

  steps.push(
    step(3, '链结构、seq 与事件配对', () => {
      if (!chain || !chain.length) return { status: 'FAIL', code: 'CHAIN_EMPTY', detail: '无记录' };
      const problems = [];
      let prevHash = '';
      let runId = null;
      chain.forEach((record, index) => {
        if (record.seq !== index + 1) problems.push(`seq 不连续：位置 ${index + 1} 是 ${record.seq}`);
        if (index === 0 && record.prevHash !== '') problems.push('首条 prevHash 非空');
        if (index > 0 && record.prevHash !== prevHash) problems.push(`seq=${record.seq} prevHash 断裂`);
        if (runId && record.runId !== runId) problems.push(`seq=${record.seq} runId 不一致`);
        runId = runId || record.runId;
        prevHash = record.hash;
      });
      const types = new Set(chain.map((record) => record.type));
      if (!types.has('RUN_START')) problems.push('缺少 RUN_START');
      if (!types.has('TASK_FINISHED')) problems.push('缺少 TASK_FINISHED');
      const starts = chain.filter((record) => record.type === 'LOCK_ACQUIRED').length;
      const ends = chain.filter((record) => record.type === 'LOCK_RELEASED').length;
      if (starts !== ends) problems.push(`锁事件不配对 ${starts}/${ends}`);
      if (problems.length) return { status: 'FAIL', code: 'CHAIN_STRUCTURE', detail: problems.slice(0, 5).join(' | '), extra: { problems } };
      return { detail: `${chain.length} 条记录，seq/prevHash/runId 一致；锁事件配对 ${starts}/${ends}` };
    }),
  );

  steps.push(
    step(4, '从基线重放到最终摘要', () => {
      const afterDir = path.join(root, '08-patch', 'after');
      const finished = chain && chain.find((record) => record.type === 'TASK_FINISHED');
      if (!finished) return { status: 'FAIL', code: 'CHAIN_STRUCTURE', detail: '缺少 TASK_FINISHED' };
      if (previewManifest && Array.isArray(previewManifest.externalResources) && previewManifest.externalResources.length) {
        return {
          status: 'FAIL',
          code: 'EXTERNAL_RESOURCE',
          detail: `预览包含外部资源：${previewManifest.externalResources.slice(0, 3).join(', ')}`,
        };
      }
      const rollbackRecord = (chain || []).find((record) => record.type === 'ROLLBACK');
      if (rollbackRecord && rollbackRecord.payload && rollbackRecord.payload.verified === true) {
        const target = rollbackRecord.payload.targetDigest;
        const entrySha = previewManifest && previewManifest.entrySha256;
        if (target && entrySha && target !== entrySha) {
          return {
            status: 'FAIL',
            code: 'ROLLBACK_INCONSISTENT',
            detail: `回退声称 verified=true，但预览入口 ${String(entrySha).slice(0, 12)}… ≠ 目标 ${String(target).slice(0, 12)}…`,
          };
        }
      }
      if (!fs.existsSync(afterDir)) {
        return { status: 'INCONCLUSIVE', code: 'AFTER_CONTENT_MISSING', detail: '缺少 08-patch/after/（无法重放最终内容）' };
      }
      const files = walkFiles(afterDir).map((file) => ({ rel: relPath(afterDir, file), sha256: sha256(fs.readFileSync(file)) }));
      files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
      const digest = sha256(files.map((file) => `${file.rel}\0${file.sha256}`).join('\n'));
      const applied = (chain || []).filter((record) => record.type === 'FILES_APPLIED');
      const mismatched = [];
      for (const record of applied) {
        const entries = Array.isArray(record.payload && record.payload.files) ? record.payload.files : [];
        for (const entry of entries) {
          const target = files.find((file) => file.rel === entry.path);
          if (!target) mismatched.push(`${entry.path} 缺少 after 内容`);
          else if (entry.afterSha256 && target.sha256 !== entry.afterSha256) mismatched.push(`${entry.path} after 哈希不一致`);
        }
      }
      const expectedDigest = finished.payload && finished.payload.finalSrcDigest;
      if (previewManifest && previewManifest.entrySha256) {
        const entry = files.find((file) => file.rel === (previewManifest.entryPath || 'index.html'));
        if (entry && entry.sha256 !== previewManifest.entrySha256) mismatched.push('预览入口与 after 内容不一致');
      }
      if (mismatched.length) return { status: 'FAIL', code: 'REPLAY_MISMATCH', detail: mismatched.slice(0, 5).join(' | '), extra: { mismatched } };
      if (expectedDigest && expectedDigest !== digest) {
        return { status: 'FAIL', code: 'FINAL_DIGEST_MISMATCH', detail: `最终摘要 ${digest.slice(0, 12)} ≠ 记录 ${String(expectedDigest).slice(0, 12)}` };
      }
      const baselineDigest = baseline && baseline.srcDigest;
      if (baselineDigest && baselineDigest === digest) {
        return { status: 'FAIL', code: 'NO_CHANGES', detail: '基线摘要等于最终摘要（no-op 不能算成功）' };
      }
      return { detail: `${files.length} 个文件重放后摘要 ${digest.slice(0, 12)}…；与记录一致` };
    }),
  );

  steps.push(
    step(5, '截图哈希与重复检测', () => {
      const shotDir = path.join(root, '07-screenshots');
      if (!fs.existsSync(shotDir)) return { status: 'FAIL', code: 'SCREENSHOTS_MISSING', detail: '缺少 07-screenshots' };
      const files = walkFiles(shotDir);
      if (!files.length) return { status: 'FAIL', code: 'SCREENSHOTS_MISSING', detail: '截图目录为空' };
      const captures = (chain || []).filter((record) => record.type === 'CAPTURE').map((record) => record.payload || {});
      const recorded = new Set(captures.map((payload) => payload.sha256).filter(Boolean));
      const problems = [];
      const seen = new Map();
      for (const file of files) {
        const digest = sha256(fs.readFileSync(file));
        const rel = relPath(root, file);
        if (seen.has(digest)) problems.push(`重复截图：${rel} 与 ${seen.get(digest)}`);
        seen.set(digest, rel);
        if (recorded.size && !recorded.has(digest)) problems.push(`截图 ${rel} 不在链中`);
      }
      if (problems.length) return { status: 'FAIL', code: 'SCREENSHOT_DUPLICATE', detail: problems.slice(0, 5).join(' | '), extra: { problems } };
      return { detail: `${files.length} 张截图哈希唯一且与链中 CAPTURE 一致` };
    }),
  );

  steps.push(
    step(6, '宿主记录器时间线一致性', () => {
      if (!recorder || !recorder.length) return { status: 'FAIL', code: 'RECORDER_MISSING', detail: '03-host-recorder.jsonl 缺失或为空' };
      const samples = recorder.map((record) => Date.parse(record.at)).filter((value) => Number.isFinite(value));
      if (!samples.length) return { status: 'FAIL', code: 'RECORDER_INVALID', detail: '记录器条目缺少有效 at' };
      const anchors = (chain || []).filter((record) => ['BASELINE', 'FILES_APPLIED', 'PREVIEW_PUBLISHED'].includes(record.type));
      const gaps = [];
      for (const record of anchors) {
        const at = Date.parse(record.at);
        const nearest = samples.reduce((best, value) => (Math.abs(value - at) < Math.abs(best - at) ? value : best), samples[0]);
        if (Math.abs(nearest - at) > 3000) gaps.push(`${record.type}@${record.at} 最近采样差 ${Math.abs(nearest - at)}ms`);
      }
      if (gaps.length) return { status: 'FAIL', code: 'RECORDER_GAP', detail: gaps.slice(0, 3).join(' | '), extra: { gaps } };
      return { detail: `${recorder.length} 个采样，锚点均在 3s 容差内` };
    }),
  );

  steps.push(
    step(7, 'USN 写入与进程归因', () => {
      const usnFile = path.join(root, '11-anchors', 'usn.csv');
      if (!fs.existsSync(usnFile)) return { status: 'INCONCLUSIVE', code: 'USN_MISSING', detail: '缺少 11-anchors/usn.csv' };
      const { rows } = parseCsv(fs.readFileSync(usnFile, 'utf8'));
      if (!rows.length) return { status: 'INCONCLUSIVE', code: 'USN_EMPTY', detail: 'USN 为空' };
      const expected = new Set();
      for (const record of chain || []) {
        if (record.actor && record.actor.pid) expected.add(String(record.actor.pid));
        if (record.type === 'BUILD_STARTED' && record.payload && record.payload.pid) expected.add(String(record.payload.pid));
      }
      const unexpected = rows.filter((row) => row.pid && !expected.has(String(row.pid)));
      if (unexpected.length) {
        return {
          status: 'FAIL',
          code: 'PID_UNEXPECTED',
          detail: `${unexpected.length} 条写入来自非预期 PID（例：${unexpected[0].pid} ${unexpected[0].path || ''}）`,
          extra: { unexpected: unexpected.slice(0, 10) },
        };
      }
      return { detail: `${rows.length} 条 USN 记录 PID 均在预期集合（${[...expected].join(',')}）` };
    }),
  );

  steps.push(
    step(8, 'Provider requestId 与 usage 匹配', () => {
      const csvFile = path.join(root, '10-provider-usage.csv');
      if (!fs.existsSync(csvFile)) return { status: 'INCONCLUSIVE', code: 'PROVIDER_CSV_MISSING', detail: '缺少 10-provider-usage.csv' };
      const { rows } = parseCsv(fs.readFileSync(csvFile, 'utf8'));
      const requests = (chain || []).filter((record) => record.type === 'MODEL_REQUEST');
      if (!requests.length) return { status: 'FAIL', code: 'NO_MODEL_REQUEST', detail: '链中没有 MODEL_REQUEST' };
      const byId = new Map(rows.map((row) => [String(row.requestId || row.request_id || ''), row]));
      const problems = [];
      let chainTokens = 0;
      let csvTokens = 0;
      for (const record of requests) {
        const payload = record.payload || {};
        const id = String(payload.requestId || '');
        const row = byId.get(id);
        if (!id) problems.push('MODEL_REQUEST 缺少 requestId');
        else if (!row) problems.push(`requestId ${id} 不在 Provider 导出中`);
        if (payload.usage && Number.isFinite(Number(payload.usage.totalTokens))) chainTokens += Number(payload.usage.totalTokens);
        if (row && Number.isFinite(Number(row.totalTokens || row.total_tokens))) csvTokens += Number(row.totalTokens || row.total_tokens);
        if (row && payload.at && row.at) {
          const diff = Math.abs(Date.parse(payload.at) - Date.parse(row.at));
          if (Number.isFinite(diff) && diff > 300000) problems.push(`requestId ${id} 时间差 ${Math.round(diff / 1000)}s`);
        }
      }
      if (problems.length) return { status: 'FAIL', code: 'PROVIDER_MISMATCH', detail: problems.slice(0, 5).join(' | '), extra: { problems } };
      if (chainTokens && csvTokens) {
        const error = Math.abs(chainTokens - csvTokens) / Math.max(chainTokens, csvTokens);
        if (error > 0.05) return { status: 'FAIL', code: 'USAGE_MISMATCH', detail: `token 误差 ${(error * 100).toFixed(1)}% > 5%` };
      }
      return { detail: `${requests.length} 个请求全部匹配 Provider 导出；usage 误差 ≤5%` };
    }),
  );

  steps.push(
    step(9, '自主性与测试后门断言', () => {
      const start = (chain || []).find((record) => record.type === 'RUN_START');
      if (!start) return { status: 'FAIL', code: 'CHAIN_STRUCTURE', detail: '缺少 RUN_START' };
      const payload = start.payload || {};
      const problems = [];
      if (payload.testSeam !== false) problems.push('testSeam 未显式记录为 false');
      if (!/^(cli|vplay-cli)$/i.test(String(payload.executor || ''))) problems.push(`executor=${payload.executor} 非 CLI`);
      if (payload.mockExecutor) problems.push('存在 mockExecutor 标记');
      const artifactText = artifact ? JSON.stringify(artifact) : '';
      if (/mock-executor|REMOTE_ALLOW_TEST_SEAM|REMOTE_EXECUTOR_CMD/.test(artifactText)) problems.push('artifact 含后门标记');
      if (problems.length) return { status: 'FAIL', code: 'TEST_SEAM', detail: problems.join(' | '), extra: { problems } };
      return { detail: `testSeam=false；executor=${payload.executor}` };
    }),
  );

  steps.push(
    step(10, '补丁与 diff 对应', () => {
      const patches = (chain || []).filter((record) => ['PATCH_APPLIED', 'FILES_APPLIED'].includes(record.type));
      if (!patches.length) return { status: 'FAIL', code: 'NO_PATCH', detail: '链中没有补丁写入记录' };
      const baselineDir = path.join(root, '01-baseline', 'src');
      const afterDir = path.join(root, '08-patch', 'after');
      const operations = [];
      for (const record of patches) {
        const payload = record.payload || {};
        for (const patch of Array.isArray(payload.patches) ? payload.patches : []) operations.push(patch);
      }
      if (!operations.length) return { status: 'INCONCLUSIVE', code: 'PATCH_DETAIL_MISSING', detail: '链中未记录 old/new 文本，无法做 hunk 对应' };
      if (!fs.existsSync(baselineDir) || !fs.existsSync(afterDir)) {
        return { status: 'INCONCLUSIVE', code: 'CONTENT_MISSING', detail: '缺少 01-baseline/src 或 08-patch/after' };
      }
      const problems = [];
      for (const patch of operations) {
        const beforeFile = path.join(baselineDir, patch.file || '');
        const afterFile = path.join(afterDir, patch.file || '');
        const before = fs.existsSync(beforeFile) ? fs.readFileSync(beforeFile, 'utf8') : '';
        const after = fs.existsSync(afterFile) ? fs.readFileSync(afterFile, 'utf8') : '';
        if (patch.old_string && !before.includes(patch.old_string)) problems.push(`${patch.file} old_string 不在基线中`);
        if (patch.new_string && !after.includes(patch.new_string)) problems.push(`${patch.file} new_string 不在结果中`);
      }
      if (problems.length) return { status: 'FAIL', code: 'PATCH_DIFF_MISMATCH', detail: problems.slice(0, 5).join(' | '), extra: { problems } };
      return { detail: `${operations.length} 个补丁的 old/new 均可定位` };
    }),
  );

  steps.push(step(11, '输出判定摘要', () => ({ detail: '由 CLI 写入 12-verify.json' })));
  steps.push(step(12, '总判定', () => ({ detail: '见 verdict' })));

  const failed = steps.filter((item) => item.status === 'FAIL');
  const inconclusive = steps.filter((item) => ['INCONCLUSIVE', 'BLOCKED'].includes(item.status));
  const verdict = failed.length ? 'FAIL' : inconclusive.length ? 'INCONCLUSIVE' : 'PASS';
  return { root, verdict, at: new Date().toISOString(), steps, failed: failed.map((item) => item.code), inconclusive: inconclusive.map((item) => item.code) };
}

module.exports = { verifyRun, REQUIRED, stableStringify, hashRecord, parseCsv, sha256 };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = args.find((arg) => !arg.startsWith('--'));
  if (!dir) {
    console.error('usage: node evidence/verify-run.cjs <evidenceDir> [--hmac-key-file=path] [--json]');
    process.exit(64);
  }
  let hmacKey = '';
  const keyArg = args.find((arg) => arg.startsWith('--hmac-key-file='));
  if (keyArg) {
    try {
      hmacKey = fs.readFileSync(keyArg.split('=')[1], 'utf8').trim();
    } catch {
      hmacKey = '';
    }
  }
  const result = verifyRun(dir, { hmacKey });
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`verdict: ${result.verdict}`);
    for (const item of result.steps) {
      console.log(`${String(item.step).padStart(2)}. ${item.status.padEnd(12)} ${item.title} — ${item.detail}`);
    }
  }
  process.exit(result.verdict === 'PASS' ? 0 : result.verdict === 'INCONCLUSIVE' ? 2 : 1);
}

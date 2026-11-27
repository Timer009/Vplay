'use strict';

/**
 * B11 可移植门禁聚合器。
 *
 * 修正 C10/B-13「SKIP 计 PASS」口径：
 *  - 只有全部项都是 PASS 才是 PASS；
 *  - SKIP / NOT_RUN / NOT_IMPLEMENTED / BLOCKED / MANUAL / PARTIAL 一律 NOT_PASS；
 *  - FAIL / ERROR 优先。
 *
 * 用法：
 *   node remote/tools/gates.cjs --input=results.json
 *   echo '[{"id":"A","status":"PASS"},{"id":"B","status":"SKIP"}]' | node remote/tools/gates.cjs
 *
 * 输入：数组，或 { results: [...] } / { checks: [...] }；每项至少 { id, status }。
 */

const fs = require('fs');

const FAIL = new Set(['FAIL', 'ERROR']);

function aggregate(items) {
  const results = (items || []).map((item) => ({
    id: String((item && item.id) || '?'),
    status: String((item && item.status) || 'NOT_RUN').toUpperCase(),
  }));
  const counts = {};
  for (const item of results) counts[item.status] = (counts[item.status] || 0) + 1;
  const failed = results.filter((item) => FAIL.has(item.status));
  const nonPass = results.filter(
    (item) => !FAIL.has(item.status) && item.status !== 'PASS',
  );
  let verdict = 'PASS';
  if (failed.length) verdict = 'FAIL';
  else if (nonPass.length) verdict = 'NOT_PASS';
  return {
    verdict,
    total: results.length,
    passed: results.filter((item) => item.status === 'PASS').length,
    failed: failed.map((item) => item.id),
    notPass: nonPass.map((item) => `${item.id}:${item.status}`),
    counts,
  };
}

function main() {
  const arg = process.argv.slice(2).find((item) => item.startsWith('--input='));
  let raw;
  if (arg) raw = fs.readFileSync(arg.slice('--input='.length), 'utf-8');
  else raw = fs.readFileSync(0, 'utf-8');
  const parsed = JSON.parse(raw || '[]');
  const items = Array.isArray(parsed) ? parsed : parsed.results || parsed.checks || [];
  const summary = aggregate(items);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(summary.verdict === 'PASS' ? 0 : summary.verdict === 'FAIL' ? 1 : 2);
}

module.exports = { aggregate };

if (require.main === module) main();

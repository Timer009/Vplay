'use strict';

/**
 * 孤儿进程收敛：服务崩溃后留下的租约必须被安全清理。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { recoverStaleLeases, isAlive } = require('../lib/leases.cjs');
const { makeWorkspace, removeWorkspace } = require('./helpers.cjs');

function writeLease(dir, name, payload) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  return file;
}

test('leases: stale lease with our runner is killed; unrelated pid is not', async () => {
  const root = makeWorkspace('vplay-leases-');
  const leasesDir = path.join(root, 'leases');
  const taskId = 'task_orphan_check_1234';
  let victim;
  try {
    // 命令行里带 taskId，模拟我们的 runner
    victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)', taskId], {
      stdio: 'ignore',
      windowsHide: true,
    });
    writeLease(leasesDir, `${taskId}.json`, {
      taskId,
      runnerPid: victim.pid,
      childPid: null,
      parentPid: 1,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // 当前进程存活，但命令行不含该 taskId → 不能误杀
    const unrelated = 'task_unrelated_9999';
    writeLease(leasesDir, `${unrelated}.json`, {
      taskId: unrelated,
      runnerPid: process.pid,
      childPid: null,
      parentPid: 1,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const actions = recoverStaleLeases({ leasesDir, maxAgeMs: 0 });
    const byTask = Object.fromEntries(actions.map((a) => [a.taskId, a.action]));
    assert.equal(byTask[taskId], 'killed-runner');
    assert.equal(byTask[unrelated], 'kept-unverified');

    assert.equal(fs.existsSync(path.join(leasesDir, `${taskId}.json`)), false);
    assert.equal(fs.existsSync(path.join(leasesDir, `${unrelated}.json`)), true);

    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(isAlive(victim.pid), false, 'orphan runner should be gone');
  } finally {
    if (victim && isAlive(victim.pid)) victim.kill('SIGKILL');
    removeWorkspace(root);
  }
});

test('leases: fresh leases are left alone', () => {
  const root = makeWorkspace('vplay-leases-fresh-');
  const leasesDir = path.join(root, 'leases');
  try {
    writeLease(leasesDir, 'fresh.json', {
      taskId: 'task_fresh',
      runnerPid: process.pid,
      updatedAt: new Date().toISOString(),
    });
    const actions = recoverStaleLeases({ leasesDir, maxAgeMs: 60_000 });
    assert.equal(actions.length, 0);
    assert.ok(fs.existsSync(path.join(leasesDir, 'fresh.json')));
  } finally {
    removeWorkspace(root);
  }
});

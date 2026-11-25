'use strict';

/**
 * 租约（lease）与孤儿进程收敛。
 *
 * worker 启动任务时会让 cli-runner 写 <runtime>/leases/<taskId>.json。
 * 服务端启动时扫描这些文件：
 *  - 心跳超过 maxAge 且进程仍在 → 校验命令行确实是我们自己的 runner，再杀进程树
 *  - 命令行不匹配 → 只清理租约文件，绝不误杀
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

function processCommandLine(pid) {
  try {
    if (process.platform === 'win32') {
      const script =
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue;` +
        'if ($p) { $p.CommandLine }';
      return execFileSync('powershell', ['-NoProfile', '-Command', script], {
        encoding: 'utf-8',
        timeout: 8000,
        windowsHide: true,
      }).trim();
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).unref();
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recoverStaleLeases(options = {}) {
  const leasesDir = options.leasesDir;
  const maxAgeMs = Number(options.maxAgeMs || 15000);
  const logger = options.logger || (() => {});
  const actions = [];

  if (!leasesDir || !fs.existsSync(leasesDir)) return actions;

  for (const name of fs.readdirSync(leasesDir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(leasesDir, name);
    let lease;
    try {
      lease = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
    } catch {
      fs.rmSync(file, { force: true });
      actions.push({ file: name, action: 'removed-invalid' });
      continue;
    }

    const age = Date.now() - Date.parse(lease.updatedAt || 0);
    if (!Number.isFinite(age) || age < maxAgeMs) continue;

    const runnerPid = Number(lease.runnerPid);
    const childPid = Number(lease.childPid);
    let action = 'removed-stale';

    if (runnerPid && isAlive(runnerPid)) {
      const cmdline = processCommandLine(runnerPid);
      const ours =
        cmdline.includes('cli-runner.cjs') ||
        (lease.taskId && cmdline.includes(lease.taskId));
      if (ours) {
        killTree(runnerPid);
        action = 'killed-runner';
        logger(`[leases] killed orphan runner ${runnerPid} (task ${lease.taskId || '?'})`);
      } else {
        action = 'kept-unverified';
        logger(
          `[leases] pid ${runnerPid} is alive but does not look like our runner; not killing`,
        );
      }
    } else if (childPid && isAlive(childPid)) {
      const cmdline = processCommandLine(childPid);
      if (cmdline.includes('cli.js') || (lease.taskId && cmdline.includes(lease.taskId))) {
        killTree(childPid);
        action = 'killed-child';
        logger(`[leases] killed orphan CLI child ${childPid} (task ${lease.taskId || '?'})`);
      } else {
        action = 'kept-unverified';
      }
    }

    if (action !== 'kept-unverified') {
      fs.rmSync(file, { force: true });
    }
    actions.push({ file: name, taskId: lease.taskId || null, action });
  }

  return actions;
}

module.exports = { recoverStaleLeases, processCommandLine, isAlive, killTree };

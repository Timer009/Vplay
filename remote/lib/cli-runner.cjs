'use strict';

/**
 * CLI 运行器（父进程看门狗 + 租约心跳）。
 *
 * 由 worker 以子进程方式启动：
 *   node cli-runner.cjs --lease <file> --parent <pid> -- <node> <cli.js> <args...>
 *
 * 解决的问题：worker（服务端）被强杀时，直接 spawn 的 CLI 会变成孤儿进程继续
 * 写工作区。这里加一层薄包装：
 *  - 每 2 秒写一次租约心跳（taskId / runnerPid / childPid / updatedAt）
 *  - 每 2 秒探测父进程是否存活，父进程消失就杀掉 CLI 进程树并退出
 *  - 正常退出时删除租约
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killProcessGroup } = require('./linux-config.cjs');

function readFlag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const leaseFile = readFlag(argv, 'lease');
const parentPid = Number(readFlag(argv, 'parent') || process.ppid);
const separator = argv.indexOf('--');
const command = separator >= 0 ? argv.slice(separator + 1) : [];

if (command.length === 0) {
  console.error('[runner] missing command after --');
  process.exit(2);
}

const taskId = readFlag(argv, 'task') || path.basename(String(leaseFile || ''), '.json');

function writeLease(childPid) {
  if (!leaseFile) return;
  try {
    fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
    fs.writeFileSync(
      leaseFile,
      JSON.stringify(
        {
          taskId,
          runnerPid: process.pid,
          childPid: childPid || null,
          parentPid,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf-8',
    );
  } catch {
    // 心跳失败不影响任务执行
  }
}

function clearLease() {
  if (!leaseFile) return;
  try {
    fs.rmSync(leaseFile, { force: true });
  } catch {
    // 忽略
  }
}

function killTree(pid, signal = 'SIGKILL') {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else if (!killProcessGroup(pid, { signal })) {
      process.kill(pid, signal);
    }
  } catch {
    // 进程可能已退出
  }
}

/** 先 SIGTERM 再 SIGKILL，确保孙进程也被进程组信号覆盖。 */
function terminateTree(pid) {
  if (!pid) return;
  killTree(pid, 'SIGTERM');
  const timer = setTimeout(() => killTree(pid, 'SIGKILL'), 2500);
  timer.unref?.();
}

const child = spawn(command[0], command.slice(1), {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
  env: process.env,
  // POSIX：CLI 成为独立进程组组长，runner 与 worker 都能按组清理整棵树。
  detached: process.platform !== 'win32',
});

writeLease(child.pid);

const heartbeat = setInterval(() => writeLease(child.pid), 2000);

let parentGone = false;
const watchdog = setInterval(() => {
  let alive = true;
  try {
    process.kill(parentPid, 0);
  } catch {
    alive = false;
  }
  if (!alive && !parentGone) {
    parentGone = true;
    console.error(`[runner] parent ${parentPid} is gone, terminating child ${child.pid}`);
    terminateTree(child.pid);
    clearInterval(heartbeat);
    clearInterval(watchdog);
    setTimeout(() => {
      clearLease();
      process.exit(1);
    }, 2700).unref?.();
  }
}, 2000);

function shutdown(code) {
  clearInterval(heartbeat);
  clearInterval(watchdog);
  if (child.pid && child.exitCode === null) terminateTree(child.pid);
  clearLease();
  const timer = setTimeout(() => process.exit(code), 2800);
  timer.unref?.();
  // 子进程很快退出时立即结束，避免多余等待。
  if (child.exitCode !== null) process.exit(code);
}

child.on('error', (error) => {
  console.error(`[runner] failed to start CLI: ${error.message}`);
  shutdown(127);
});

child.on('exit', (code, signal) => {
  if (signal) console.error(`[runner] CLI terminated by signal ${signal}`);
  shutdown(typeof code === 'number' ? code : 1);
});

process.on('SIGTERM', () => {
  terminateTree(child.pid);
  shutdown(143);
});
process.on('SIGINT', () => {
  terminateTree(child.pid);
  shutdown(130);
});
process.on('uncaughtException', (error) => {
  console.error(`[runner] uncaught exception: ${error && error.message ? error.message : error}`);
  terminateTree(child.pid);
  shutdown(1);
});
process.on('unhandledRejection', (error) => {
  console.error(`[runner] unhandled rejection: ${error && error.message ? error.message : error}`);
  terminateTree(child.pid);
  shutdown(1);
});

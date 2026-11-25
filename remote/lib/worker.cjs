'use strict';

/**
 * Serial task worker.
 *
 * One task at a time. Each task is executed as a *normal user message* through
 * the OpenGame CLI (`dist/cli.js -p "<text>" --yolo`) in the game workspace.
 * There is deliberately no "[REMOTE INSTRUCTIONS]" text injection anywhere:
 * the model sees an ordinary prompt from the CLI, which is the only way it
 * treats the request as legitimate user intent.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const STATUS_POLL_MS = 1000;

function readRuntimePhase(workspaceDir) {
  try {
    const file = path.join(workspaceDir, '.opengame', 'runtime-status.json');
    const raw = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return typeof parsed.phase === 'string' ? parsed.phase : null;
  } catch {
    return null;
  }
}

function readPostVerifySummary(workspaceDir) {
  try {
    const file = path.join(workspaceDir, '.opengame', 'post-verify.json');
    const raw = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return {
      checkedImports: parsed.checkedImports ?? 0,
      checkedAssets: parsed.checkedAssets ?? 0,
      fixedCount: parsed.fixedCount ?? 0,
      issues: Array.isArray(parsed.issues) ? parsed.issues.length : 0,
    };
  } catch {
    return null;
  }
}

function tail(text, maxLines) {
  const lines = String(text || '').trim().split(/\r?\n/);
  return lines.slice(-maxLines).join('\n').slice(-4000);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Process already gone.
    }
  }
}

function createWorker(options) {
  const store = options.store;
  const workspaceDir = path.resolve(options.workspaceDir);
  const cliPath = options.cliPath;
  const executorScript = options.executorScript || null;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const log = options.logger || ((line) => console.log(line));

  let current = null;
  let loopTimer = null;
  let stopped = false;

  function buildCommand(text) {
    if (executorScript) {
      // Test/debug seam only. Never used in normal operation.
      return [process.execPath, executorScript, text];
    }
    return [process.execPath, cliPath, '-p', text, '--yolo'];
  }

  function finish(taskId, status, patch) {
    try {
      store.transition(taskId, status, patch);
    } catch (error) {
      log(`[remote] failed to persist ${status} for ${taskId}: ${error.message}`);
    }
  }

  function run(task) {
    current = task;
    const command = buildCommand(task.text);

    if (!executorScript && !fs.existsSync(cliPath)) {
      finish(task.id, 'failed', {
        error: {
          code: 'CLI_MISSING',
          message: `OpenGame CLI bundle not found at ${cliPath}. Run "npm run build" and "npm run bundle" first.`,
        },
      });
      current = null;
      return;
    }

    store.appendLog(
      task.id,
      `[remote] ${new Date().toISOString()} start cwd=${workspaceDir}\n` +
        `[remote] command: ${command
          .slice(0, 2)
          .map((part) => path.basename(part))
          .join(' ')} <prompt> --yolo\n`,
    );
    log(`[remote] task ${task.id} started`);

    let child;
    try {
      child = spawn(command[0], command.slice(1), {
        cwd: workspaceDir,
        env: { ...process.env, OPENGAME_REMOTE_TASK_ID: task.id },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      finish(task.id, 'failed', {
        error: { code: 'SPAWN_FAILED', message: error.message },
      });
      current = null;
      return;
    }

    store.transition(task.id, 'running', {
      startedAt: new Date().toISOString(),
      pid: child.pid || null,
    });

    let stderrBuffer = '';
    child.stdout.on('data', (chunk) => store.appendLog(task.id, chunk));
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      store.appendLog(task.id, chunk);
    });

    const poll = setInterval(() => {
      const phase = readRuntimePhase(workspaceDir);
      if (phase === 'verifying' && store.get(task.id)?.status === 'running') {
        try {
          store.transition(task.id, 'verifying');
        } catch {
          // Transition may race with process exit.
        }
      }
    }, STATUS_POLL_MS);

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      store.appendLog(
        task.id,
        `[remote] timeout after ${timeoutMs}ms, killing process tree\n`,
      );
      killTree(child);
    }, timeoutMs);

    let settled = false;
    const settle = (status, patch) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      finish(task.id, status, patch);
      store.appendLog(
        task.id,
        `[remote] ${new Date().toISOString()} finished: ${status}\n`,
      );
      log(`[remote] task ${task.id} ${status}`);
      current = null;
      // Immediately look for the next queued task.
      tick();
    };

    child.on('error', (error) => {
      settle('failed', {
        error: { code: 'SPAWN_FAILED', message: error.message },
      });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        settle('failed', {
          error: {
            code: 'TIMEOUT',
            message: `task exceeded ${timeoutMs}ms and was terminated`,
          },
        });
        return;
      }

      const postVerify = readPostVerifySummary(workspaceDir);
      const indexHtml = path.join(workspaceDir, 'index.html');

      if (code === 0) {
        settle('succeeded', {
          pid: null,
          error: null,
          result: {
            exitCode: 0,
            artifactIndexHtml: fs.existsSync(indexHtml) ? indexHtml : null,
            postVerify,
          },
        });
        return;
      }

      settle('failed', {
        pid: null,
        error: {
          code: 'EXIT_CODE',
          message: `CLI exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
          detail: tail(stderrBuffer, 20),
        },
        result: { exitCode: code, postVerify },
      });
    });
  }

  function tick() {
    if (stopped || current) return;
    const task = store.nextQueued();
    if (task) run(task);
  }

  function start() {
    stopped = false;
    tick();
    if (!loopTimer) loopTimer = setInterval(tick, 500);
  }

  function stop() {
    stopped = true;
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
  }

  return {
    start,
    stop,
    tick,
    isBusy: () => current !== null,
    currentTask: () => (current ? store.get(current.id) : null),
  };
}

module.exports = {
  createWorker,
  DEFAULT_TIMEOUT_MS,
};

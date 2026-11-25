'use strict';

/**
 * 串行任务执行器（Sprint 02）。
 *
 * 每个任务都以「正式用户消息」交给 OpenGame CLI：
 *   node cli-runner.cjs -- ... node dist/cli.js -p "<prompt>" --approval-mode ...
 * 不再有任何 "[REMOTE INSTRUCTIONS]" 文本注入。
 *
 * Sprint 02 增加：
 *  - 项目锁：同一项目同一时间只允许一个任务写入
 *  - 修改前快照（可回退）
 *  - 项目上下文 / 记忆注入（仅当前项目）
 *  - 执行成功 ≠ 验证成功：result.verified 单独标记
 *  - 孤儿进程收敛：子进程包在 cli-runner 里，父进程死亡即自杀
 *  - 公开模式下禁止无约束 --yolo
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const STATUS_POLL_MS = 1000;

function readRuntimePhase(dir) {
  try {
    const file = path.join(dir, '.opengame', 'runtime-status.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
    return typeof parsed.phase === 'string' ? parsed.phase : null;
  } catch {
    return null;
  }
}

function readPostVerify(dir) {
  try {
    const file = path.join(dir, '.opengame', 'post-verify.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
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

function summarize(text, max = 120) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
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
      // 已退出
    }
  }
}

/**
 * 项目上下文前缀。它是「受控调度器」生成的上下文，不是特权文本：
 * 鉴权只在 HTTP 层完成，这里只是让模型知道自己在哪个项目里工作。
 */
function composePrompt({ text, project, memory }) {
  const lines = [];
  lines.push('【Vplay 项目上下文】');
  if (project) {
    lines.push(`项目：${project.name || project.id}（id=${project.id}）`);
    lines.push(`类型：${project.kind} / ${project.framework || 'unknown'}`);
    lines.push(`入口：${project.entry || '(未知)'}`);
    lines.push(`工作区：${project.srcDir}`);
    lines.push('该工作区是当前项目唯一允许修改的位置。');
  } else {
    lines.push('工作区：当前目录。');
  }
  const rounds = (memory && memory.rounds) || [];
  if (rounds.length > 0) {
    lines.push('最近修改：');
    for (const round of rounds.slice(-3)) {
      lines.push(
        `- ${round.at || ''} ${summarize(round.prompt, 80)} → ` +
          `改动 ${round.changedFiles ?? 0} 个文件，${round.verified ? '验证通过' : '未验证'}`,
      );
    }
  }
  lines.push('');
  lines.push('规则：');
  lines.push('1. 只修改上述工作区内的文件；不要读写工作区外的路径（尤其 Vplay 源码和系统目录）。');
  lines.push('2. 保留已有技术栈、目录结构与入口文件，不要套用模板或强制转换成 Phaser。');
  lines.push('3. 大文件先搜索定位、再分段读取，避免整文件重写。');
  lines.push('4. 不要执行 git reset --hard 或 git clean -fd。');
  lines.push('5. 完成后用一两句话说明修改了哪些文件。');
  lines.push('');
  lines.push('【用户指令】');
  lines.push(text);
  return lines.join('\n');
}

function createWorker(options) {
  const store = options.store;
  const projects = options.projects || null;
  const legacyWorkspace = path.resolve(options.workspaceDir);
  const cliPath = options.cliPath;
  const runnerPath = path.resolve(__dirname, 'cli-runner.cjs');
  const leasesDir = path.join(path.resolve(options.runtimeDir), 'leases');
  const executorScript = options.executorScript || null;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const publicMode = Boolean(options.publicMode);
  const allowYolo = options.allowYolo !== false;
  const log = options.logger || ((line) => console.log(line));

  let current = null;
  let loopTimer = null;
  let stopped = false;

  function resolveTarget(task) {
    if (!projects) return { project: null, dir: legacyWorkspace, projectId: 'default' };
    const projectId = task.projectId || 'default';
    const record = projects.get(projectId);
    return { project: record, dir: record.srcDir, projectId };
  }

  function buildPrompt(task, project) {
    const memory = project ? projects.memory(project.id) : null;
    return composePrompt({ text: task.text, project, memory });
  }

  function approvalMode() {
    if (publicMode) return 'auto-edit';
    if (!allowYolo) return 'auto-edit';
    return 'yolo';
  }

  function finish(taskId, status, patch) {
    try {
      store.transition(taskId, status, patch);
    } catch (error) {
      log(`[remote] failed to persist ${status} for ${taskId}: ${error.message}`);
    }
  }

  function spawnExecutor(task, dir) {
    return spawn(process.execPath, [executorScript, task.text], {
      cwd: dir,
      env: { ...process.env, OPENGAME_REMOTE_TASK_ID: task.id },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  function spawnCli(task, dir, prompt, useContinue) {
    fs.mkdirSync(leasesDir, { recursive: true });
    const leaseFile = path.join(leasesDir, `${task.id}.json`);
    const args = [
      runnerPath,
      '--task',
      task.id,
      '--lease',
      leaseFile,
      '--parent',
      String(process.pid),
      '--',
      process.execPath,
      cliPath,
      '-p',
      prompt,
      '--approval-mode',
      approvalMode(),
    ];
    if (useContinue) {
      args.push('--continue', '--chat-recording');
    }
    return spawn(process.execPath, args, {
      cwd: dir,
      env: { ...process.env, OPENGAME_REMOTE_TASK_ID: task.id },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  function verify(project, dir) {
    const postVerify = readPostVerify(dir);
    let entryExists = false;
    let previewReady = false;
    let entryPath = null;

    if (project) {
      entryPath = path.join(project.srcDir, project.entry || 'index.html');
      entryExists = fs.existsSync(entryPath);
      if (project.kind === 'vite') {
        previewReady = fs.existsSync(path.join(project.srcDir, 'dist', 'index.html'));
      } else {
        previewReady = entryExists;
      }
    } else {
      entryPath = path.join(dir, 'index.html');
      entryExists = fs.existsSync(entryPath);
      previewReady = entryExists;
    }

    return {
      entryExists,
      previewReady,
      postVerify,
      verified: entryExists && previewReady && (!postVerify || postVerify.issues === 0),
      entryPath,
    };
  }

  function run(task) {
    current = task;
    let target;
    try {
      target = resolveTarget(task);
    } catch (error) {
      finish(task.id, 'failed', {
        error: { code: error.code || 'PROJECT_NOT_FOUND', message: error.message },
      });
      current = null;
      return;
    }

    const { project, dir, projectId } = target;

    if (publicMode && project && !project.managed) {
      finish(task.id, 'failed', {
        startedAt: new Date().toISOString(),
        error: {
          code: 'POLICY_VIOLATION',
          message: '公开模式只允许对受控（导入）项目执行任务，不能直接写工作区',
        },
      });
      current = null;
      return;
    }

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

    // 项目锁 + 修改前快照
    let snapshotSeq = null;
    if (project) {
      try {
        projects.acquireLock(projectId, { taskId: task.id });
      } catch (error) {
        finish(task.id, 'failed', {
          error: { code: error.code || 'PROJECT_LOCKED', message: error.message },
        });
        current = null;
        return;
      }
      try {
        snapshotSeq = projects.snapshot(projectId, `pre-task-${task.id}`).seq;
      } catch (error) {
        projects.releaseLock(projectId);
        finish(task.id, 'failed', {
          error: { code: 'SNAPSHOT_FAILED', message: error.message },
        });
        current = null;
        return;
      }
    }

    const prompt = buildPrompt(task, project);
    const useContinue =
      Boolean(project) &&
      (projects.memory(projectId).rounds || []).length > 0 &&
      process.env.VPLAY_CONTINUE_SESSION !== '0';

    store.appendLog(
      task.id,
      `[remote] ${new Date().toISOString()} start project=${projectId} cwd=${dir}\n` +
        `[remote] approval=${approvalMode()} continue=${useContinue} snapshot=${snapshotSeq ?? '-'}\n`,
    );
    log(`[remote] task ${task.id} started (project ${projectId})`);

    let child;
    try {
      child = executorScript ? spawnExecutor(task, dir) : spawnCli(task, dir, prompt, useContinue);
    } catch (error) {
      if (project) projects.releaseLock(projectId);
      finish(task.id, 'failed', {
        error: { code: 'SPAWN_FAILED', message: error.message },
      });
      current = null;
      return;
    }

    store.transition(task.id, 'running', {
      startedAt: new Date().toISOString(),
      pid: child.pid || null,
      projectId,
      snapshotSeq,
    });

    let stderrBuffer = '';
    child.stdout.on('data', (chunk) => store.appendLog(task.id, chunk));
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      store.appendLog(task.id, chunk);
    });

    const poll = setInterval(() => {
      const phase = readRuntimePhase(dir);
      if (phase === 'verifying' && store.get(task.id)?.status === 'running') {
        try {
          store.transition(task.id, 'verifying');
        } catch {
          // 与退出竞争，忽略
        }
      }
    }, STATUS_POLL_MS);

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      store.appendLog(task.id, `[remote] timeout after ${timeoutMs}ms, killing process tree\n`);
      killTree(child);
    }, timeoutMs);

    let settled = false;
    const settle = (status, patch) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);

      const verification = verify(project, dir);
      const enriched = { ...patch };
      if (enriched.result) {
        enriched.result = {
          ...enriched.result,
          verified: verification.verified,
          verification,
        };
      } else {
        enriched.result = {
          exitCode: null,
          verified: verification.verified,
          verification,
        };
      }

      if (project) {
        try {
          const diff = snapshotSeq ? projects.diff(projectId, snapshotSeq, 'current') : null;
          if (enriched.result) {
            enriched.result.changedFiles = diff ? diff.counts : null;
            enriched.result.diffSummary = diff
              ? diff.files.slice(0, 20).map((f) => `${f.status}: ${f.path}`)
              : [];
          }
          projects.appendRound(projectId, {
            taskId: task.id,
            prompt: task.text.slice(0, 200),
            changedFiles: diff ? diff.files.length : 0,
            verified: verification ? verification.verified : false,
            status,
          });
        } catch (error) {
          store.appendLog(task.id, `[remote] post-run bookkeeping failed: ${error.message}\n`);
        }
        projects.releaseLock(projectId);
      }

      finish(task.id, status, enriched);
      store.appendLog(task.id, `[remote] ${new Date().toISOString()} finished: ${status}\n`);
      log(`[remote] task ${task.id} ${status}`);
      current = null;
      tick();
    };

    child.on('error', (error) => {
      settle('failed', { error: { code: 'SPAWN_FAILED', message: error.message } });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        settle('failed', {
          error: { code: 'TIMEOUT', message: `task exceeded ${timeoutMs}ms and was terminated` },
        });
        return;
      }

      const verification = verify(project, dir);

      if (code === 0) {
        settle('succeeded', {
          pid: null,
          error: null,
          result: {
            exitCode: 0,
            artifactIndexHtml: verification.entryExists ? verification.entryPath : null,
            postVerify: verification.postVerify,
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
        result: {
          exitCode: code,
          postVerify: verification.postVerify,
          artifactIndexHtml: verification.entryExists ? verification.entryPath : null,
        },
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
  composePrompt,
  DEFAULT_TIMEOUT_MS,
};

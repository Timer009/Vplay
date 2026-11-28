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

const { hashTree, compareManifests } = require('./paths.cjs');
const { spawnDetachedOptions, killProcessGroup } = require('./linux-config.cjs');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const STATUS_POLL_MS = 1000;

/** 允许传给 CLI 子进程的环境变量（P0-4 / C09 B-08：显式名单，默认拒绝）。 */
const ENV_PASSTHROUGH = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'NODE_ENV', 'LANG', 'LC_ALL', 'TZ', 'SHELL', 'TERM',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
]);

/**
 * 模型凭据/端点的显式名单（C09 B-08）：
 * 过去按 OPENAI_/GEMINI_/QWEN_/DASHSCOPE_ 前缀全量透传，宿主环境里任何同前缀变量
 * （包括未来新增的密钥）都会进入 Agent 子进程。这里只放行列出的 key，
 * 并显式剥离 NODE_OPTIONS / NODE_PATH 等可注入执行路径的变量。
 */
const MODEL_ENV_KEYS = new Set([
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI',
  'QWEN_API_KEY', 'QWEN_BASE_URL', 'QWEN_MODEL',
  'DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  'VLM_SWITCH_MODE',
  'OPENGAME_MODEL', 'OPENGAME_PROVIDER', 'OPENGAME_API_KEY', 'OPENGAME_BASE_URL',
  'OPENGAME_REASONING_EFFORT', 'OPENGAME_POST_VERIFY', 'OPENGAME_TEMPLATES_DIR',
  'OPENGAME_DEBUG_PROTOCOL',
]);

/** 只传「模型调用必需 + 系统运行必需」的变量；REMOTE_* / VPLAY_* 一律不传。 */
function buildChildEnv(taskId, source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('REMOTE_') || key.startsWith('VPLAY_') || key.startsWith('EVIDENCE_')) continue;
    const allowed = ENV_PASSTHROUGH.has(key) || MODEL_ENV_KEYS.has(key);
    if (allowed) env[key] = value;
  }
  env.OPENGAME_REMOTE_TASK_ID = taskId;
  return env;
}

/** 测试后门（REMOTE_EXECUTOR_CMD）必须显式开启，避免生产环境任意脚本执行（P2-5）。 */
function resolveExecutorScript(env = process.env) {
  if (env.NODE_ENV === 'test' || env.REMOTE_ALLOW_TEST_SEAM === '1') {
    return env.REMOTE_EXECUTOR_CMD || null;
  }
  return null;
}


/**
 * C07-P0-01：审批模式解析（纯函数，便于测试）。
 * yolo 需要三者同时成立：非 public、环境显式开启、任务显式 allowYolo。
 */
function resolveApprovalMode({ publicMode, allowYolo, task }) {
  if (publicMode) return 'auto-edit';
  if (!allowYolo) return 'auto-edit';
  if (!task || task.allowYolo !== true) return 'auto-edit';
  return 'yolo';
}

function readRuntimePhase(dir) {
  try {
    const file = path.join(dir, '.opengame', 'runtime-status.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
    return typeof parsed.phase === 'string' ? parsed.phase : null;
  } catch {
    return null;
  }
}

function readPostVerify(dir, task, startedAtMs) {
  try {
    const file = path.join(dir, '.opengame', 'post-verify.json');
    const stat = fs.statSync(file);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
    // P1-4：只接受本次任务写入的结果，拒绝陈旧 post-verify
    const taskMatches = !parsed.taskId || parsed.taskId === task.id;
    const fresh = stat.mtimeMs >= (startedAtMs || 0) - 1000;
    if (!taskMatches || !fresh) {
      return { summary: null, stale: true };
    }
    return {
      stale: false,
      summary: {
        checkedImports: parsed.checkedImports ?? 0,
        checkedAssets: parsed.checkedAssets ?? 0,
        fixedCount: parsed.fixedCount ?? 0,
        issues: Array.isArray(parsed.issues) ? parsed.issues.length : 0,
      },
    };
  } catch {
    return { summary: null, stale: false };
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
    } else if (!killProcessGroup(child.pid)) {
      child.kill('SIGKILL');
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
  const allowYolo = options.allowYolo === true;
  const log = options.logger || ((line) => console.log(line));
  const secrets = (options.secrets || []).filter((secret) => typeof secret === 'string' && secret.length >= 6);
  const onFinished = typeof options.onFinished === 'function' ? options.onFinished : null;
  const visionService = options.visionService || null;
  const eventStore = options.eventStore || null;
  const evidenceStore = options.evidenceStore || null;
  const home = options.home || null;

  let current = null;
  let currentChild = null;
  let loopTimer = null;
  let stopped = false;

  /** 回传前脱敏：绝对路径与凭据都不进错误信息（P2-8）。 */
  function scrub(text, dir) {
    let out = String(text || '');
    for (const secret of secrets) out = out.split(secret).join('***');
    out = out.split(path.resolve(dir)).join('<workspace>');
    out = out.split(path.resolve(legacyWorkspace)).join('<workspace>');
    return out;
  }

  function emitEvent(type, task, extra = {}) {
    if (!eventStore) return;
    const projectId = extra.projectId || (task && task.projectId) || 'default';
    const data = extra.data && typeof extra.data === 'object' ? extra.data : null;
    eventStore.append({
      type,
      taskId: extra.taskId || (task && task.id) || null,
      projectId,
      status: extra.status || null,
      data,
    });
  }

  function latestVersionId(projectId) {
    if (!projects) return null;
    try {
      const list = projects.listSnapshots(projectId);
      const last = list[list.length - 1];
      return last ? `${last.seq}-${last.uid}` : null;
    } catch {
      return null;
    }
  }

  function persistEvidence(task, result, status, projectId) {
    if (!evidenceStore) return null;
    try {
      return evidenceStore.writeTaskEvidence({
        task: { ...task, status },
        result,
        versionId: latestVersionId(projectId),
        events: eventStore ? eventStore.listForTask(task.id) : [],
        logText: store.readLog(task.id) || '',
        extra: { home: Boolean(home) },
      });
    } catch (error) {
      log(`[remote] evidence write failed: ${error.message}`);
      return null;
    }
  }

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

  function approvalMode(task) {
    return resolveApprovalMode({ publicMode, allowYolo, task });
  }

  function finish(taskId, status, patch) {
    try {
      store.transition(taskId, status, patch);
    } catch (error) {
      log(`[remote] failed to persist ${status} for ${taskId}: ${error.message}`);
    }
  }

  function spawnExecutor(task, dir) {
    return spawn(process.execPath, [executorScript, task.text], spawnDetachedOptions({
      cwd: dir,
      env: buildChildEnv(task.id),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }));
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
      approvalMode(task),
    ];
    if (useContinue) {
      args.push('--continue', '--chat-recording');
    }
    return spawn(process.execPath, args, spawnDetachedOptions({
      cwd: dir,
      env: buildChildEnv(task.id),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }));
  }

  function verify(project, dir, task, startedAtMs) {
    const post = readPostVerify(dir, task, startedAtMs);
    let entryExists = false;
    let previewReady = false;
    let entryPath = null;

    if (project) {
      entryPath = path.join(project.srcDir, project.entry || 'index.html');
      entryExists = fs.existsSync(entryPath);
      previewReady = projects.previewRoot(project.id) !== null;
    } else {
      entryPath = path.join(dir, 'index.html');
      entryExists = fs.existsSync(entryPath);
      previewReady = entryExists;
    }

    return {
      entryExists,
      previewReady,
      postVerify: post.summary,
      postVerifyStale: post.stale,
      entryPath,
      verified:
        entryExists &&
        previewReady &&
        !post.stale &&
        (!post.summary || post.summary.issues === 0),
    };
  }

  async function runVisionTaskFlow(task, target) {
    const { projectId } = target;
    let lockToken = null;
    try {
      lockToken = projects.acquireLock(projectId, { taskId: task.id }).token;
    } catch (error) {
      finish(task.id, 'failed', {
        error: { code: error.code || 'PROJECT_LOCKED', message: error.message },
      });
      emitEvent('task.failed', task, { status: 'failed', data: { kind: 'vision' } });
      current = null;
      return;
    }

    try {
      store.transition(task.id, 'running', {
        startedAt: new Date().toISOString(),
        pid: null,
        projectId,
      });
      emitEvent('task.running', task, { status: 'running', data: { kind: 'vision' } });
      store.appendLog(task.id, `[vision] start mode=${task.visionMode || 'analyze'}\n`);

      const output = await visionService.run({
        taskId: task.id,
        projectId,
        mode: task.visionMode || 'analyze',
        allowedFiles: task.allowedFiles || undefined,
        skipLock: true,
        lockToken,
        defectId: task.defectId || null,
        defectAssertionIds: task.defectAssertionIds || [],
      });

      // B14：verify 仅是功能复验；repair 只有 Vision `repair_verified` 才算已验证
      const isRepair = (task.visionMode || 'analyze') === 'repair';
      const verified = isRepair && Boolean(
        output.result &&
          output.result.status === 'repair_verified' &&
          output.result.repairVerified === true,
      );
      const status = output.result && output.result.ok ? 'succeeded' : 'failed';
      const result = {
        ok: Boolean(output.result && output.result.ok),
        verified,
        outcome: (output.result && output.result.status) || null,
        vision: {
          status: output.result && output.result.status,
          reportFile: output.reportFile,
          artifactId: output.artifactId,
          mode: task.visionMode || 'analyze',
        },
      };
      const evidence = persistEvidence(task, result, status, projectId);
      result.versionId = evidence ? evidence.versionId : latestVersionId(projectId);
      result.artifactId = evidence ? evidence.artifactId : output.artifactId;
      result.evidenceDir = evidence ? evidence.dir : null;
      result.previewPath = `/p/${projectId}/`;

      if (onFinished) {
        try {
          onFinished({ taskId: task.id, projectId, status, verified });
        } catch (error) {
          log(`[remote] onFinished failed: ${error.message}`);
        }
      }
      finish(task.id, status, { result });
      emitEvent(status === 'succeeded' ? 'task.succeeded' : 'task.failed', task, {
        status,
        data: { verified, kind: 'vision' },
      });
      store.appendLog(task.id, `[vision] finished ${status}\n`);
      log(`[remote] vision task ${task.id} ${status}`);
    } catch (error) {
      const message = scrub(error.message, target.dir);
      const result = {
        ok: false,
        verified: false,
        outcome: 'failed',
        vision: { error: { code: error.code || 'VISION_FAILED', message } },
      };
      const evidence = persistEvidence(task, result, 'failed', projectId);
      result.versionId = evidence ? evidence.versionId : latestVersionId(projectId);
      result.artifactId = evidence ? evidence.artifactId : null;
      result.evidenceDir = evidence ? evidence.dir : null;
      if (onFinished) {
        try {
          onFinished({ taskId: task.id, projectId, status: 'failed', verified: false });
        } catch {
          // 忽略
        }
      }
      finish(task.id, 'failed', {
        error: { code: error.code || 'VISION_FAILED', message },
        result,
      });
      emitEvent('task.failed', task, { status: 'failed', data: { verified: false, kind: 'vision' } });
      store.appendLog(task.id, `[vision] failed: ${message}\n`);
      log(`[remote] vision task ${task.id} failed: ${message}`);
    } finally {
      if (lockToken) projects.releaseLock(projectId, lockToken);
      current = null;
      tick();
    }
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

    // Sprint03B：Vision 任务复用同一队列/状态机/锁，仅执行器不同
    if (task.kind === 'vision') {
      if (!visionService) {
        finish(task.id, 'failed', {
          error: { code: 'VISION_UNAVAILABLE', message: 'vision service is not configured' },
        });
        current = null;
        return;
      }
      runVisionTaskFlow(task, target);
      return;
    }

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
    let lockToken = null;
    if (project) {
      try {
        lockToken = projects.acquireLock(projectId, { taskId: task.id }).token;
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
        projects.releaseLock(projectId, lockToken);
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
    const startedAtMs = Date.now();
    // 单工作区模式没有快照，用前后哈希判断是否真的改了文件（P1-4）
    const beforeManifest = project ? null : hashTree(dir);

    store.appendLog(
      task.id,
      `[remote] ${new Date().toISOString()} start project=${projectId} cwd=${dir}\n` +
        `[remote] approval=${approvalMode(task)} continue=${useContinue} snapshot=${snapshotSeq ?? '-'}\n`,
    );
    log(`[remote] task ${task.id} started (project ${projectId})`);

    let child;
    try {
      child = executorScript ? spawnExecutor(task, dir) : spawnCli(task, dir, prompt, useContinue);
    } catch (error) {
      if (project) projects.releaseLock(projectId, lockToken);
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
    emitEvent('task.running', task, { status: 'running' });
    currentChild = child;

    let stderrBuffer = '';
    child.stdout.on('data', (chunk) => store.appendLog(task.id, chunk));
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      store.appendLog(task.id, chunk);
    });

    let lastBeat = Date.now();
    const poll = setInterval(() => {
      const phase = readRuntimePhase(dir);
      if (phase === 'verifying' && store.get(task.id)?.status === 'running') {
        try {
          store.transition(task.id, 'verifying');
          emitEvent('task.verifying', task, { status: 'verifying' });
        } catch {
          // 与退出竞争，忽略
        }
      }
      if (project && lockToken && Date.now() - lastBeat > 15000) {
        lastBeat = Date.now();
        projects.touchLock(projectId, lockToken);
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

      try {
        const verification = verify(project, dir, task, startedAtMs);
        let changes = null;
        let diff = null;
        try {
          if (project && snapshotSeq) {
            diff = projects.diff(projectId, snapshotSeq, 'current');
            changes = diff.counts;
          } else if (beforeManifest) {
            const compared = compareManifests(beforeManifest, hashTree(dir));
            changes = {
              added: compared.added.length,
              removed: compared.removed.length,
              modified: compared.modified.length,
            };
          }
        } catch (error) {
          store.appendLog(task.id, `[remote] change detection failed: ${error.message}\n`);
        }
        const totalChanges = changes ? changes.added + changes.modified + changes.removed : null;
        const noChanges = totalChanges === 0;
        // B10 / C09 B-02/B-03：先发布新预览并做全量新鲜度校验，成功才算 verified；
        // 发布失败（校验失败/构建产物陈旧）保持旧预览，任务不得标记为 verified。
        let published = true;
        let publishError = null;
        if (
          project &&
          !noChanges &&
          verification.entryExists &&
          !verification.postVerifyStale &&
          (!verification.postVerify || verification.postVerify.issues === 0)
        ) {
          try {
            const root = projects.buildPreview(projectId);
            const check = projects.verifyPreview(projectId);
            if (!root || !check.ok) {
              published = false;
              publishError = check.reason;
            }
          } catch (error) {
            published = false;
            publishError = error.message;
          }
        }
        const verified = verification.verified && !noChanges && published;
        const outcome = noChanges ? 'no_changes' : verified ? 'verified' : 'unverified';

        const enriched = { ...patch };
        const baseResult = enriched.result || { exitCode: null };
        enriched.result = {
          ...baseResult,
          artifactPath: project ? project.entry || 'index.html' : 'index.html',
          postVerify: verification.postVerify,
          verified,
          outcome,
          noChanges,
          changedFiles: changes,
          diffSummary:
            diff && diff.files.length > 0
              ? diff.files.slice(0, 20).map((f) => `${f.status}: ${f.path}`)
              : [],
          verification: {
            entryExists: verification.entryExists,
            previewReady: verification.previewReady,
            postVerifyStale: verification.postVerifyStale,
            published,
            publishError,
          },
        };

        if (project) {
          try {
            projects.appendRound(projectId, {
              taskId: task.id,
              prompt: task.text.slice(0, 200),
              changedFiles: totalChanges ?? 0,
              verified,
              status,
            });
          } catch (error) {
            store.appendLog(task.id, `[remote] post-run bookkeeping failed: ${error.message}\n`);
          }
        }

        // C07-P1-03：只有 functional verified 才允许发布预览；
        // C07 ORD-05：发布期间仍持有项目锁，发布完成后再释放（见 finally）。
        if (onFinished) {
          try {
            onFinished({ taskId: task.id, projectId, status, verified });
          } catch (error) {
            log(`[remote] onFinished failed: ${error.message}`);
          }
        }

        const evidence = persistEvidence(task, enriched.result, status, projectId);
        if (enriched.result) {
          enriched.result.versionId = evidence ? evidence.versionId : latestVersionId(projectId);
          enriched.result.artifactId = evidence ? evidence.artifactId : null;
          enriched.result.evidenceDir = evidence ? evidence.dir : null;
          enriched.result.previewPath = projectId ? `/p/${projectId}/` : '/legacy/';
        }

        finish(task.id, status, enriched);
        emitEvent(status === 'succeeded' ? 'task.succeeded' : 'task.failed', task, {
          status,
          data: { verified, outcome },
        });
        store.appendLog(task.id, `[remote] ${new Date().toISOString()} finished: ${status}\n`);
        log(`[remote] task ${task.id} ${status}`);
      } catch (error) {
        // B-05：verify()/记账/证据任一异常都不能让进程崩溃或让任务悬挂
        const message = scrub(error && error.message ? error.message : String(error), dir);
        try {
          store.appendLog(task.id, `[remote] settle failed: ${message}\n`);
        } catch {
          // 忽略
        }
        try {
          finish(task.id, 'failed', {
            error: { code: 'SETTLE_FAILED', message },
          });
          emitEvent('task.failed', task, { status: 'failed', data: { settleFailed: true } });
        } catch {
          // 忽略
        }
        log(`[remote] task ${task.id} settle failed: ${message}`);
      } finally {
        if (project && lockToken) {
          try {
            projects.releaseLock(projectId, lockToken);
          } catch {
            // 忽略
          }
        }
        currentChild = null;
        current = null;
        tick();
      }
    };

    child.on('error', (error) => {
      settle('failed', {
        error: { code: 'SPAWN_FAILED', message: scrub(error.message, dir) },
      });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        settle('failed', {
          error: { code: 'TIMEOUT', message: `task exceeded ${timeoutMs}ms and was terminated` },
        });
        return;
      }

      if (code === 0) {
        settle('succeeded', { pid: null, error: null, result: { exitCode: 0 } });
        return;
      }

      settle('failed', {
        pid: null,
        error: {
          code: 'EXIT_CODE',
          message: `CLI exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
          detail: scrub(tail(stderrBuffer, 20), dir),
        },
        result: { exitCode: code },
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
    // P1-5：停止时杀掉正在运行的 CLI 进程树，避免留下孤儿
    if (currentChild) {
      killTree(currentChild);
      currentChild = null;
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
  buildChildEnv,
  resolveExecutorScript,
  resolveApprovalMode,
  DEFAULT_TIMEOUT_MS,
};

#!/usr/bin/env node
'use strict';

/**
 * B23 P0：受限执行器 daemon（独立 UID 运行）。
 *
 * 职责：只接收控制面经受限 socket 发来的受限任务，启动 CLI 子进程，回传
 * stdout/stderr/exit；不读写任务状态、不持有审批密钥、不写日志配置。
 *
 * 用法（systemd 或测试）：
 *   node remote/agent/agent-daemon.cjs \
 *     --socket /run/vplay/agent.sock \
 *     --cli /srv/vplay-lab/repo/dist/cli.js \
 *     --allowed-root /srv/vplay-lab
 *
 * 环境变量：
 *   VPLAY_IPC_HMAC_KEY   （≥32 字符，agent 与 control 共享；≠ 审批密钥）
 *   VPLAY_AGENT_VERSION  （可选，回显给控制面）
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const {
  IpcError,
  verifyEnvelope,
  baseEnvelope,
  validateRunRequest,
  encodeFrame,
  createFrameReader,
} = require('../lib/ipc-protocol.cjs');
const { restrictedCliArgs, killProcessGroup } = require('../lib/linux-config.cjs');

function readFlag(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

const argv = process.argv.slice(2);
const socketPath = readFlag(argv, 'socket');
const cliPath = readFlag(argv, 'cli');
const allowedRoot = readFlag(argv, 'allowed-root');
const ipcKey = String(process.env.VPLAY_IPC_HMAC_KEY || '').trim();
const agentVersion = String(process.env.VPLAY_AGENT_VERSION || 'b23-1');
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

if (!socketPath || !cliPath || !allowedRoot) {
  console.error('[agent] --socket, --cli and --allowed-root are required');
  process.exit(2);
}
if (ipcKey.length < 32) {
  console.error('[agent] VPLAY_IPC_HMAC_KEY (>=32 chars) is required');
  process.exit(2);
}
if (!fs.existsSync(cliPath)) {
  console.error(`[agent] CLI not found: ${cliPath}`);
  process.exit(2);
}
const root = path.resolve(allowedRoot);
if (!fs.existsSync(root)) {
  console.error(`[agent] allowed root not found: ${root}`);
  process.exit(2);
}

const isWindowsPipe = process.platform === 'win32' && socketPath.startsWith('\\\\.\\pipe\\');
if (process.platform !== 'win32' && !path.isAbsolute(socketPath)) {
  console.error('[agent] socket path must be absolute on POSIX');
  process.exit(2);
}
if (process.platform === 'win32' && !isWindowsPipe) {
  console.error('[agent] Windows socket must be a named pipe (\\\\.\\pipe\\...)');
  process.exit(2);
}

let activeRun = null;
const usedRunIds = new Set();
const usedTaskRuns = new Map();

function log(line) {
  console.log(`[agent] ${new Date().toISOString()} ${line}`);
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
    // 已退出
  }
}

function send(socket, message) {
  try {
    socket.write(encodeFrame(message));
  } catch {
    // 连接已断
  }
}

function sendError(socket, runId, error) {
  const code = error instanceof IpcError ? error.code : 'AGENT_ERROR';
  send(socket, baseEnvelope('error', ipcKey, {
    runId: runId || null,
    code,
    message: String(error && error.message ? error.message : error).slice(0, 400),
  }));
}

function buildChildEnv(run) {
  const env = { ...run.env };
  if (!env.PATH) env.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  env.OPENGAME_REMOTE_TASK_ID = run.taskId;
  return env;
}

function runTask(socket, request, connection) {
  let run;
  try {
    run = validateRunRequest(request, { allowedRoot: root });
    if (usedRunIds.has(run.runId)) throw new IpcError('runId already used', 'RUN_REPLAYED');
    const previous = usedTaskRuns.get(run.taskId);
    if (previous && previous !== run.runId) {
      throw new IpcError('task already has a run in this agent lifetime', 'TASK_REBOUND');
    }
    if (activeRun) throw new IpcError('agent is busy with another run', 'AGENT_BUSY');
  } catch (error) {
    sendError(socket, request && request.runId, error);
    return;
  }
  usedRunIds.add(run.runId);
  usedTaskRuns.set(run.taskId, run.runId);

  const startedAt = new Date().toISOString();
  const args = [
    cliPath,
    '-p',
    run.prompt,
    '--approval-mode',
    'default',
    ...restrictedCliArgs(),
  ];
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: run.cwd,
      env: buildChildEnv(run),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    sendError(socket, run.runId, new IpcError(`spawn failed: ${error.message}`, 'SPAWN_FAILED'));
    return;
  }

  const state = {
    runId: run.runId,
    taskId: run.taskId,
    child,
    cancelled: false,
    timedOut: false,
    outputBytes: 0,
    finished: false,
    timer: null,
  };
  activeRun = state;
  log(`run ${run.runId} task=${run.taskId} pid=${child.pid || '-'}`);

  send(socket, baseEnvelope('started', ipcKey, {
    runId: run.runId,
    pid: child.pid || null,
    startedAt,
    approvalDigest: run.approvalDigest,
  }));

  const forward = (streamName, chunk) => {
    if (state.finished) return;
    const text = chunk.toString('utf8');
    state.outputBytes += Buffer.byteLength(text, 'utf8');
    if (state.outputBytes > MAX_OUTPUT_BYTES) {
      if (!state.truncated) {
        state.truncated = true;
        send(socket, baseEnvelope('stderr', ipcKey, {
          runId: run.runId,
          data: '\n[agent] output limit reached; further output dropped\n',
        }));
      }
      return;
    }
    send(socket, baseEnvelope(streamName, ipcKey, { runId: run.runId, data: text }));
  };
  child.stdout.on('data', (chunk) => forward('stdout', chunk));
  child.stderr.on('data', (chunk) => forward('stderr', chunk));

  const finish = (exitCode, signal, error) => {
    if (state.finished) return;
    state.finished = true;
    if (state.timer) clearTimeout(state.timer);
    if (activeRun === state) activeRun = null;
    const endedAt = new Date().toISOString();
    if (error) sendError(socket, run.runId, error);
    else {
      send(socket, baseEnvelope('exit', ipcKey, {
        runId: run.runId,
        code: exitCode,
        signal: signal || null,
      }));
    }
    send(socket, baseEnvelope('done', ipcKey, {
      runId: run.runId,
      taskId: run.taskId,
      exitCode,
      signal: signal || null,
      startedAt,
      endedAt,
      spawnPid: child.pid || null,
      cancelled: state.cancelled,
      timedOut: state.timedOut,
    }));
    log(`run ${run.runId} done code=${exitCode} signal=${signal || '-'}`);
  };

  state.timer = setTimeout(() => {
    state.timedOut = true;
    killTree(child.pid, 'SIGTERM');
    const hard = setTimeout(() => killTree(child.pid, 'SIGKILL'), 2000);
    hard.unref?.();
    setTimeout(() => {
      finish(null, 'SIGKILL', new IpcError('run exceeded deadline', 'RUN_TIMEOUT'));
    }, 2600).unref?.();
  }, run.deadlineMs);

  child.on('error', (error) => {
    finish(null, null, new IpcError(`CLI error: ${error.message}`, 'SPAWN_FAILED'));
  });
  child.on('exit', (code, signal) => {
    if (state.timedOut) {
      finish(null, signal, new IpcError('run exceeded deadline', 'RUN_TIMEOUT'));
      return;
    }
    if (state.cancelled) {
      finish(null, signal, new IpcError('run cancelled by control plane', 'RUN_CANCELLED'));
      return;
    }
    finish(typeof code === 'number' ? code : 1, signal, null);
  });

  // 连接断开：控制面消失，必须杀掉 CLI 树。
  connection.once('close', () => {
    if (!state.finished) {
      state.cancelled = true;
      killTree(child.pid, 'SIGTERM');
      setTimeout(() => killTree(child.pid, 'SIGKILL'), 1500).unref?.();
    }
  });
  socket.on('error', () => {
    if (!state.finished) {
      state.cancelled = true;
      killTree(child.pid, 'SIGTERM');
    }
  });
}

function handleCancel(socket, message) {
  if (!activeRun) {
    sendError(socket, message.runId, new IpcError('no active run', 'RUN_NOT_FOUND'));
    return;
  }
  if (message.runId !== activeRun.runId) {
    sendError(socket, message.runId, new IpcError('runId does not match active run', 'RUN_NOT_FOUND'));
    return;
  }
  activeRun.cancelled = true;
  killTree(activeRun.child.pid, 'SIGTERM');
  setTimeout(() => {
    if (activeRun && activeRun.child.pid) killTree(activeRun.child.pid, 'SIGKILL');
  }, 1500).unref?.();
}

function handleConnection(socket) {
  const seenNonces = new Set();
  let authenticated = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      socket.end();
    } catch {
      // 忽略
    }
  };

  const reader = createFrameReader(
    (message) => {
      const check = verifyEnvelope(message, ipcKey, { seenNonces });
      if (!check.ok) {
        sendError(socket, message && message.runId, new IpcError(check.reason, check.reason));
        if (!authenticated) close();
        return;
      }
      seenNonces.add(message.nonce);
      if (!authenticated) {
        if (message.type !== 'hello' || message.role !== 'control') {
          sendError(socket, null, new IpcError('hello required', 'HELLO_REQUIRED'));
          close();
          return;
        }
        authenticated = true;
        send(socket, baseEnvelope('ready', ipcKey, {
          agentVersion,
          pid: process.pid,
          platform: process.platform,
          allowedRoot: root,
          capabilities: ['restricted-cli', 'cancel', 'deadline'],
        }));
        return;
      }
      if (message.type === 'run') {
        runTask(socket, message, socket);
        return;
      }
      if (message.type === 'cancel') {
        handleCancel(socket, message);
        return;
      }
      if (message.type === 'ping') {
        send(socket, baseEnvelope('pong', ipcKey, { at: Date.now() }));
        return;
      }
      sendError(socket, null, new IpcError(`unknown message type: ${message.type}`, 'IPC_TYPE_UNKNOWN'));
    },
    (error) => {
      sendError(socket, null, error);
      if (!authenticated) close();
    },
  );
  socket.on('data', reader);
  socket.on('error', () => {
    // 连接级错误由 runTask 的 close 处理
  });
}

function start() {
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
    try {
      fs.rmSync(socketPath, { force: true });
    } catch (error) {
      console.error(`[agent] failed to remove stale socket: ${error.message}`);
      process.exit(1);
    }
  }
  const server = net.createServer({}, handleConnection);
  server.on('error', (error) => {
    console.error(`[agent] socket error: ${error.message}`);
    process.exit(1);
  });
  server.listen(socketPath, () => {
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(socketPath, 0o660);
      } catch (error) {
        console.error(`[agent] failed to chmod socket: ${error.message}`);
        process.exit(1);
      }
    }
    log(`listening uid=${typeof process.getuid === 'function' ? process.getuid() : 'n/a'} socket=${socketPath}`);
  });

  const shutdown = (signal) => {
    log(`shutting down (${signal})`);
    if (activeRun) {
      killTree(activeRun.child.pid, 'SIGTERM');
      setTimeout(() => killTree(activeRun.child.pid, 'SIGKILL'), 1000).unref?.();
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();

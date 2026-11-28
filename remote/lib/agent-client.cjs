'use strict';

/**
 * B23 P0：控制面 → 执行器 IPC 客户端。
 *
 * 每个任务一条连接：hello（HMAC）→ run（任务绑定）→ 流式 stdout/stderr → done。
 * 控制面保留审批密钥；只把 approvalDigest（proof 的 sha256）交给 agent 审计。
 * 超时/取消都会主动通知 agent；连接断开也会让 agent 杀掉 CLI 树。
 */

const net = require('net');
const {
  IpcError,
  baseEnvelope,
  verifyEnvelope,
  runPayloadHash,
  encodeFrame,
  createFrameReader,
} = require('./ipc-protocol.cjs');

function isWindowsPipePath(value) {
  return process.platform === 'win32' && String(value).startsWith('\\\\.\\pipe\\');
}

class AgentClient {
  constructor(options = {}) {
    this.socketPath = String(options.socketPath || '');
    this.ipcKey = String(options.ipcKey || '');
    this.connectTimeoutMs = Number(options.connectTimeoutMs || 5000);
    this.socket = null;
    this.ready = false;
    this.closed = false;
    this.pending = new Map();
    this.seenNonces = new Set();
  }

  async connect() {
    if (!this.socketPath || !this.ipcKey) {
      throw new IpcError('agent socket and IPC key are required', 'IPC_CONFIG_MISSING');
    }
    if (process.platform === 'win32' && !isWindowsPipePath(this.socketPath)) {
      throw new IpcError('Windows agent socket must be a named pipe', 'IPC_SOCKET_INVALID');
    }
    const socket = net.connect(this.socketPath);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new IpcError('agent connect timeout', 'IPC_CONNECT_TIMEOUT'));
      }, this.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new IpcError(`agent connect failed: ${error.message}`, 'IPC_CONNECT_FAILED'));
      });
    });

    const reader = createFrameReader(
      (message) => this.handleMessage(message),
      (error) => this.failAll(error),
    );
    socket.on('data', reader);
    socket.on('close', () => {
      this.closed = true;
      this.failAll(new IpcError('agent connection closed', 'IPC_CLOSED'));
    });
    socket.on('error', () => {
      // close 会统一处理
    });

    const readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete('__ready__');
        reject(new IpcError('agent hello timeout', 'IPC_HELLO_TIMEOUT'));
      }, this.connectTimeoutMs);
      this.pending.set('__ready__', {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    const hello = baseEnvelope('hello', this.ipcKey, { role: 'control', clientPid: process.pid });
    socket.write(encodeFrame(hello));
    await readyPromise;
    this.ready = true;
    return this;
  }

  handleMessage(message) {
    const check = verifyEnvelope(message, this.ipcKey, { seenNonces: this.seenNonces });
    if (!check.ok) {
      this.failAll(new IpcError(check.reason, check.reason));
      return;
    }
    this.seenNonces.add(message.nonce);
    if (message.type === 'ready') {
      const waiter = this.pending.get('__ready__');
      if (waiter) {
        this.pending.delete('__ready__');
        waiter.resolve(message);
      }
      return;
    }
    const runId = message.runId;
    const waiter = runId ? this.pending.get(runId) : null;
    if (!waiter) return;
    switch (message.type) {
      case 'started':
        if (waiter.onStarted) waiter.onStarted(message);
        return;
      case 'stdout':
        if (waiter.onStdout) waiter.onStdout(String(message.data || ''));
        return;
      case 'stderr':
        if (waiter.onStderr) waiter.onStderr(String(message.data || ''));
        return;
      case 'exit':
        waiter.exit = { code: message.code, signal: message.signal || null };
        return;
      case 'error':
        this.pending.delete(runId);
        waiter.reject(new IpcError(String(message.message || message.code), String(message.code || 'AGENT_ERROR')));
        return;
      case 'done':
        this.pending.delete(runId);
        waiter.resolve({
          runId,
          taskId: message.taskId,
          exitCode: message.exitCode,
          signal: message.signal || null,
          startedAt: message.startedAt,
          endedAt: message.endedAt,
          spawnPid: message.spawnPid,
          cancelled: message.cancelled === true,
          timedOut: message.timedOut === true,
        });
        return;
      default:
        return;
    }
  }

  failAll(error) {
    for (const [key, waiter] of this.pending) {
      this.pending.delete(key);
      waiter.reject(error);
    }
  }

  run(params) {
    if (!this.ready || !this.socket || this.closed) {
      return { promise: Promise.reject(new IpcError('agent is not connected', 'IPC_NOT_CONNECTED')), cancel: () => {} };
    }
    const runId = params.runId;
    const payloadHash = runPayloadHash(params.taskId, runId, params.prompt);
    const message = baseEnvelope('run', this.ipcKey, {
      runId,
      taskId: params.taskId,
      prompt: params.prompt,
      restricted: true,
      cwd: params.cwd,
      deadlineMs: params.deadlineMs,
      env: params.env,
      model: params.model || null,
      approvalDigest: params.approvalDigest || null,
      payloadHash,
    });
    const promise = new Promise((resolve, reject) => {
      const grace = Number(params.deadlineMs || 0) + 15000;
      const timer = setTimeout(() => {
        this.pending.delete(runId);
        reject(new IpcError('agent run timeout', 'IPC_RUN_TIMEOUT'));
        this.cancel(runId);
      }, grace);
      this.pending.set(runId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        onStarted: params.onStarted,
        onStdout: params.onStdout,
        onStderr: params.onStderr,
      });
      try {
        this.socket.write(encodeFrame(message));
      } catch (error) {
        this.pending.delete(runId);
        clearTimeout(timer);
        reject(new IpcError(`agent write failed: ${error.message}`, 'IPC_WRITE_FAILED'));
      }
    });
    promise.then(
      () => this.close(),
      () => this.close(),
    );
    return {
      promise,
      cancel: () => this.cancel(runId),
    };
  }

  cancel(runId) {
    if (!this.socket || this.closed) return;
    try {
      this.socket.write(encodeFrame(baseEnvelope('cancel', this.ipcKey, { runId })));
    } catch {
      // 连接已断
    }
  }

  close() {
    if (!this.socket) return;
    try {
      this.socket.end();
    } catch {
      // 忽略
    }
    this.closed = true;
    this.socket = null;
  }
}

function createAgentClient(options) {
  return new AgentClient(options);
}

/** 健康探测：只做 hello/ready，不触发任务。 */
async function probeAgent({ socketPath, ipcKey, timeoutMs = 3000 }) {
  const client = createAgentClient({ socketPath, ipcKey, connectTimeoutMs: timeoutMs });
  try {
    const ready = await client.connect();
    return { ok: true, agentVersion: ready.agentVersion, platform: ready.platform, capabilities: ready.capabilities };
  } finally {
    client.close();
  }
}

module.exports = { AgentClient, createAgentClient, probeAgent };

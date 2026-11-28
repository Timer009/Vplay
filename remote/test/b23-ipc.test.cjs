'use strict';

/**
 * B23 P0：受限执行器分离 IPC 正负测试（Windows 命名管道 / Linux UDS）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createAgentClient, probeAgent } = require('../lib/agent-client.cjs');
const { createTaskStore } = require('../lib/tasks.cjs');
const { createWorker } = require('../lib/worker.cjs');
const {
  buildApprovalPayload,
  signApprovalPayload,
} = require('../lib/approval.cjs');
const {
  baseEnvelope,
  encodeFrame,
  createFrameReader,
} = require('../lib/ipc-protocol.cjs');
const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  waitFor,
} = require('./helpers.cjs');

const IPC_KEY = 'vplay-test-ipc-key-0123456789abcdef';
const APPROVAL_KEY = 'vplay-test-approval-key-0123456789abcdef';
const STUB = path.join(__dirname, 'fixtures', 'b23-stub-cli.cjs');
const AGENT = path.join(__dirname, '..', 'agent', 'agent-daemon.cjs');

function socketPathFor(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\vplay-b23-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  }
  return path.join(root, 'agent.sock');
}

async function startAgent(root, options = {}) {
  const socketPath = options.socketPath || socketPathFor(root);
  const child = spawn(
    process.execPath,
    [AGENT, '--socket', socketPath, '--cli', STUB, '--allowed-root', root],
    {
      env: { ...process.env, VPLAY_IPC_HMAC_KEY: options.ipcKey || IPC_KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`agent did not start:\n${output}`)), 15000);
    const check = () => {
      if (output.includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      check();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
      check();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`agent exited early (${code}):\n${output}`));
    });
  });
  return {
    socketPath,
    child,
    output: () => output,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

function rawConnect(socketPath, ipcKey) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const frames = [];
    const reader = createFrameReader(
      (message) => {
        if (message.type === 'ready') resolve({ socket, send: (msg) => socket.write(encodeFrame(msg)), frames });
        else frames.push(message);
      },
      reject,
    );
    socket.on('data', reader);
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(encodeFrame(baseEnvelope('hello', ipcKey, { role: 'control', clientPid: process.pid })));
    });
  });
}

function waitForFrame(frames, type, timeoutMs = 6000) {
  return waitFor(() => frames.find((message) => message.type === type), { timeout: timeoutMs });
}

test('B23-IPC: agent runs a restricted task and never exposes control-plane secrets', async () => {
  const root = makeWorkspace('vplay-b23-ipc-');
  let agent;
  try {
    agent = await startAgent(root);
    const info = await probeAgent({ socketPath: agent.socketPath, ipcKey: IPC_KEY });
    assert.equal(info.ok, true);

    const client = createAgentClient({ socketPath: agent.socketPath, ipcKey: IPC_KEY });
    await client.connect();
    let stdout = '';
    const run = client.run({
      runId: 'run_ok_1',
      taskId: 'task_ok_1',
      prompt: 'hello restricted',
      cwd: root,
      deadlineMs: 8000,
      model: 'qwen3-coder-plus',
      approvalDigest: 'a'.repeat(64),
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, 'home'),
        OPENAI_BASE_URL: 'http://127.0.0.1:18900/v1',
        OPENAI_API_KEY: 'vplay-proxy-placeholder',
      },
      onStdout: (data) => {
        stdout += data;
      },
    });
    const outcome = await run.promise;
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.timedOut, false);
    assert.match(stdout, /STUB_OUT:hello restricted/);

    const marker = JSON.parse(
      fs.readFileSync(path.join(root, 'agent-exec.jsonl'), 'utf-8').trim().split('\n')[0],
    );
    assert.equal(marker.approvalMode, 'default');
    assert.match(marker.coreTools, /--core-tools/);
    assert.equal(marker.env.OPENAI_API_KEY, 'vplay-proxy-placeholder');
    assert.equal(marker.env.hasApprovalKey, false);
    assert.equal(marker.env.hasIpcKey, false);
    assert.equal(marker.env.hasEvidenceKey, false);
    assert.equal(marker.env.hasRemoteToken, false);
    assert.equal(marker.env.HOME, path.join(root, 'home'));
  } finally {
    if (agent) await agent.stop();
    removeWorkspace(root);
  }
});

test('B23-IPC: wrong IPC key is rejected before any run', async () => {
  const root = makeWorkspace('vplay-b23-ipc-key-');
  let agent;
  try {
    agent = await startAgent(root);
    const client = createAgentClient({
      socketPath: agent.socketPath,
      ipcKey: 'wrong-key-0123456789abcdef0123456789',
    });
    await assert.rejects(() => client.connect(), (error) => error.code === 'IPC_HMAC_INVALID');
  } finally {
    if (agent) await agent.stop();
    removeWorkspace(root);
  }
});

test('B23-IPC: non-restricted request, replay and env injection are refused', async () => {
  const root = makeWorkspace('vplay-b23-ipc-neg-');
  let agent;
  try {
    agent = await startAgent(root);
    const { runPayloadHash } = require('../lib/ipc-protocol.cjs');

    const first = await rawConnect(agent.socketPath, IPC_KEY);
    const prompt1 = 'restricted';
    first.send(
      baseEnvelope('run', IPC_KEY, {
        runId: 'run_bad_1',
        taskId: 'task_bad_1',
        prompt: prompt1,
        restricted: false,
        cwd: root,
        deadlineMs: 5000,
        env: { PATH: process.env.PATH },
        payloadHash: runPayloadHash('task_bad_1', 'run_bad_1', prompt1),
      }),
    );
    const nonRestricted = await waitForFrame(first.frames, 'error');
    assert.equal(nonRestricted.code, 'RESTRICTED_REQUIRED');
    first.socket.destroy();

    const probe = await rawConnect(agent.socketPath, IPC_KEY);
    const prompt2 = 'restricted again';
    probe.send(
      baseEnvelope('run', IPC_KEY, {
        runId: 'run_ok_2',
        taskId: 'task_ok_2',
        prompt: prompt2,
        restricted: true,
        cwd: root,
        deadlineMs: 5000,
        env: { OPENAI_BASE_URL: 'http://evil.example/v1', PATH: process.env.PATH },
        payloadHash: runPayloadHash('task_ok_2', 'run_ok_2', prompt2),
      }),
    );
    const envError = await waitForFrame(probe.frames, 'error');
    assert.equal(envError.code, 'IPC_ENV_INVALID');
    probe.socket.destroy();

    const replay = await rawConnect(agent.socketPath, IPC_KEY);
    const p2 = 'unique prompt';
    const hash = runPayloadHash('task_replay', 'run_replay', p2);
    const replayRequest = baseEnvelope('run', IPC_KEY, {
      runId: 'run_replay',
      taskId: 'task_replay',
      prompt: p2,
      restricted: true,
      cwd: root,
      deadlineMs: 5000,
      env: { PATH: process.env.PATH },
      payloadHash: hash,
    });
    replay.send(replayRequest);
    await waitForFrame(replay.frames, 'done');
    replay.send(
      baseEnvelope('run', IPC_KEY, {
        runId: 'run_replay',
        taskId: 'task_replay',
        prompt: p2,
        restricted: true,
        cwd: root,
        deadlineMs: 5000,
        env: { PATH: process.env.PATH },
        payloadHash: hash,
      }),
    );
    const replayError = await waitForFrame(replay.frames, 'error');
    assert.equal(replayError.code, 'RUN_REPLAYED');
    replay.socket.destroy();
  } finally {
    if (agent) await agent.stop();
    removeWorkspace(root);
  }
});

test('B23-IPC: deadline kills the CLI tree and reports RUN_TIMEOUT', async () => {
  const root = makeWorkspace('vplay-b23-ipc-timeout-');
  let agent;
  try {
    agent = await startAgent(root);
    const client = createAgentClient({ socketPath: agent.socketPath, ipcKey: IPC_KEY });
    await client.connect();
    const run = client.run({
      runId: 'run_timeout_1',
      taskId: 'task_timeout_1',
      prompt: 'SLEEP now',
      cwd: root,
      deadlineMs: 1200,
      env: { PATH: process.env.PATH },
    });
    await assert.rejects(() => run.promise, (error) => error.code === 'RUN_TIMEOUT');
    await waitFor(() => fs.existsSync(path.join(root, 'agent-child.pid')), { timeout: 8000 });
    const pid = Number(fs.readFileSync(path.join(root, 'agent-child.pid'), 'utf-8'));
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 8000 },
    );
  } finally {
    if (agent) await agent.stop();
    removeWorkspace(root);
  }
});

test('B23-IPC: cancel stops an in-flight run', async () => {
  const root = makeWorkspace('vplay-b23-ipc-cancel-');
  let agent;
  try {
    agent = await startAgent(root);
    const client = createAgentClient({ socketPath: agent.socketPath, ipcKey: IPC_KEY });
    await client.connect();
    const run = client.run({
      runId: 'run_cancel_1',
      taskId: 'task_cancel_1',
      prompt: 'SLEEP cancel me',
      cwd: root,
      deadlineMs: 20000,
      env: { PATH: process.env.PATH },
    });
    await waitFor(() => fs.existsSync(path.join(root, 'agent-child.pid')), { timeout: 8000 });
    run.cancel();
    await assert.rejects(() => run.promise, (error) => error.code === 'RUN_CANCELLED');
  } finally {
    if (agent) await agent.stop();
    removeWorkspace(root);
  }
});

test('B23-approval: exhausted approval cannot be replayed after state tamper', async () => {
  const root = makeWorkspace('vplay-b23-approval-replay-');
  try {
    const store = createTaskStore({
      runtimeDir: path.join(root, '.opengame'),
      workspaceDir: root,
    });
    const task = store.create({ text: 'one-shot restricted task', restricted: true }).task;
    const payload = buildApprovalPayload({
      task,
      ttlMs: 10 * 60 * 1000,
      maxRuns: 1,
      model: 'qwen3-coder-plus',
      baseVersionId: null,
      runs: 1,
    });
    const keyId = crypto.createHash('sha256').update(APPROVAL_KEY).digest('hex').slice(0, 16);
    store.transition(task.id, 'queued', {
      approval: {
        state: 'approved',
        approvedAt: new Date().toISOString(),
        approvedBy: 'admin',
        rejectedAt: null,
        scope: { projectId: 'default', kind: 'prompt', visionMode: null, allowedFiles: null },
        proof: {
          alg: 'hmac-sha256',
          keyId,
          payload,
          signature: signApprovalPayload(payload, APPROVAL_KEY),
        },
      },
    });

    const worker = createWorker({
      store,
      workspaceDir: root,
      runtimeDir: path.join(root, '.opengame'),
      cliPath: path.join(root, 'dist', 'cli.js'),
      restrictedDeployment: true,
      approvalKey: APPROVAL_KEY,
      approvalModel: 'qwen3-coder-plus',
      restrictedProxy: { url: 'http://127.0.0.1:18900/v1', token: 'dummy' },
      logger: () => {},
    });
    try {
      worker.start();
      await waitFor(() => store.get(task.id).status === 'failed');
      assert.equal(store.get(task.id).error.code, 'APPROVAL_EXHAUSTED');
      assert.equal(fs.existsSync(path.join(root, 'agent-exec.jsonl')), false);
    } finally {
      worker.stop();
    }
  } finally {
    removeWorkspace(root);
  }
});

test('B23-IPC: server worker executes restricted tasks through the separated agent', async () => {
  const root = makeWorkspace('vplay-b23-ipc-server-');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><html></html>\n');
  const token = 'b23-admin-token-0123456789';
  let agent;
  let server;
  try {
    agent = await startAgent(root);
    server = await startServer({
      workspace,
      token,
      env: {
        VPLAY_AGENT_SOCKET: agent.socketPath,
        VPLAY_IPC_HMAC_KEY: IPC_KEY,
        VPLAY_RESTRICTED_DEPLOYMENT: '1',
        REMOTE_ALLOW_TEST_SEAM: '0',
      },
    });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const created = await request(server.port, 'POST', '/prompt', {
      headers,
      body: JSON.stringify({ text: 'agent ipc task' }),
    });
    assert.equal(created.status, 202);
    assert.equal(created.json.task.status, 'awaiting_approval');
    assert.equal(fs.existsSync(path.join(workspace, 'agent-exec.jsonl')), false);

    const approved = await request(server.port, 'POST', `/tasks/${created.json.task.id}/approve`, {
      headers,
    });
    assert.equal(approved.status, 200);

    const done = await waitFor(async () => {
      const res = await request(server.port, 'GET', `/tasks/${created.json.task.id}`, { headers });
      return ['succeeded', 'failed'].includes(res.json.task.status) ? res.json.task : null;
    }, { timeout: 25000 });
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error || done.result));
    assert.ok(done.result.agent && done.result.agent.runId);
    assert.equal(done.result.agent.spawnPid > 0, true);

    const log = await request(server.port, 'GET', `/tasks/${created.json.task.id}/log`, { headers });
    assert.match(log.text, /STUB_OUT:[\s\S]*agent ipc task/);
    const marker = JSON.parse(
      fs.readFileSync(path.join(workspace, 'agent-exec.jsonl'), 'utf-8').trim().split('\n')[0],
    );
    assert.equal(marker.env.hasApprovalKey, false);
    assert.equal(marker.env.hasIpcKey, false);
  } finally {
    if (server) await server.stop();
    if (agent) await agent.stop();
    removeWorkspace(root);
  }
});

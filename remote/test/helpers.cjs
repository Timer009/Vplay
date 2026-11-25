'use strict';

/**
 * Test helpers: temp workspaces, server lifecycle, tiny HTTP client.
 * Used by the node:test suites under remote/test/.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(REPO_ROOT, 'remote', 'server.cjs');
const EXECUTOR = path.join(__dirname, 'fixtures', 'executor.cjs');

function makeWorkspace(prefix = 'vplay-remote-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeWorkspace(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(options) {
  const workspace = options.workspace;
  const port = options.port || (await freePort());
  const previewPort = options.previewPort || (await freePort());
  const env = {
    ...process.env,
    REMOTE_PORT: String(port),
    PREVIEW_PORT: String(previewPort),
    REMOTE_HOST: '127.0.0.1',
    OPENGAME_WORKSPACE: workspace,
    REMOTE_RATE_LIMIT: '1000',
    REMOTE_AUTORUN: options.autorun === false ? '0' : '1',
    ...(options.env || {}),
  };
  delete env.REMOTE_TOKEN;
  delete env.VPLAY_HOME;
  if (options.token) env.REMOTE_TOKEN = options.token;
  if (options.home) env.VPLAY_HOME = options.home;

  const child = spawn(process.execPath, [SERVER, '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`server did not start:\n${output}`)),
      15000,
    );
    const check = () => {
      if (output.includes('listening on') && output.includes('game preview on')) {
        clearTimeout(timeout);
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
      clearTimeout(timeout);
      reject(new Error(`server exited early (code ${code}):\n${output}`));
    });
  });

  await ready;

  return {
    port,
    previewPort,
    workspace,
    child,
    output: () => output,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

function request(port, method, requestPath, options = {}) {
  const body = options.body === undefined ? null : Buffer.from(options.body);
  const headers = { ...(options.headers || {}) };
  if (body) headers['Content-Length'] = body.length;

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: requestPath, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonHeaders(token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function postPrompt(port, token, payload) {
  return request(port, 'POST', '/prompt', {
    headers: jsonHeaders(token),
    body: JSON.stringify(payload),
  });
}

async function waitFor(fn, { timeout = 15000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function readExecutions(workspace) {
  const file = path.join(workspace, 'executions.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Records written when a stub run starts — one per execution. */
function readStarts(workspace) {
  return readExecutions(workspace).filter((item) => item.event === 'start');
}

/** Completed stub runs, with start/end timestamps. */
function readRuns(workspace) {
  return readExecutions(workspace).filter((item) => item.event === 'end');
}

module.exports = {
  REPO_ROOT,
  EXECUTOR,
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  jsonHeaders,
  postPrompt,
  waitFor,
  readExecutions,
  readStarts,
  readRuns,
};

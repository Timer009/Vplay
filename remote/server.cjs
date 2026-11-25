#!/usr/bin/env node
'use strict';

/**
 * Vplay remote bridge.
 *
 * Security model
 * --------------
 * - Authentication happens ONLY at the HTTP layer (REMOTE_TOKEN).
 *   No text inside a prompt can ever grant trust.
 * - If REMOTE_TOKEN is not configured, every control endpoint is disabled (503).
 * - The token is read from the environment (or REMOTE_TOKEN_FILE) and is never
 *   logged, never written to disk by this process, and never committed.
 * - Listens on 127.0.0.1 by default. REMOTE_HOST=0.0.0.0 must be explicit.
 *
 * Task model
 * ----------
 * POST /prompt creates a durable task. A serial worker spawns
 * `dist/cli.js -p "<text>" --yolo` — i.e. the task arrives as a normal user
 * message, not as injected "[REMOTE INSTRUCTIONS]" text.
 *
 * Endpoints
 * ---------
 *   GET  /health              public   service status
 *   GET  /console             public   mobile console (remote/index.html)
 *   POST /auth/verify         public   exchange token for a session cookie
 *   POST /auth/logout         public   clear the session cookie
 *   GET  /status              auth     { phase, message, activeTaskId }
 *   GET  /tasks               auth     recent tasks
 *   GET  /tasks/:id           auth     one task
 *   GET  /tasks/:id/log       auth     captured CLI log (tail)
 *   POST /prompt              auth     enqueue { text, idempotencyKey? }
 *   GET  /artifact            auth     latest game entry point
 *   GET  /game/*              auth     static files of the game workspace
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createTaskStore, ValidationError, DuplicateTaskError } = require('./lib/tasks.cjs');
const { createWorker } = require('./lib/worker.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'cli.js');
const COOKIE_NAME = 'vplay_remote';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function readFlag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function resolveToken() {
  if (process.argv.slice(2).includes('--token')) {
    // A token on the command line leaks via the process list.
    throw new Error('Do not pass --token on the command line. Use REMOTE_TOKEN.');
  }
  const direct = (process.env.REMOTE_TOKEN || '').trim();
  if (direct) return { token: direct, source: 'env' };
  const file = process.env.REMOTE_TOKEN_FILE;
  if (file) {
    try {
      const fromFile = fs.readFileSync(file, 'utf-8').trim();
      if (fromFile) return { token: fromFile, source: 'file' };
    } catch (error) {
      console.error(`[remote] could not read REMOTE_TOKEN_FILE: ${error.message}`);
    }
  }
  return { token: null, source: 'none' };
}

const argv = process.argv.slice(2);
const PORT = Number(readFlag(argv, 'port') || process.env.REMOTE_PORT || 8787);
const HOST = readFlag(argv, 'host') || process.env.REMOTE_HOST || '127.0.0.1';
const WORKSPACE = path.resolve(
  readFlag(argv, 'workspace') || process.env.OPENGAME_WORKSPACE || process.cwd(),
);
const RUNTIME_DIR = path.join(WORKSPACE, '.opengame');
const AUTHORUN = process.env.REMOTE_AUTORUN !== '0';
const TASK_TIMEOUT_MS = Number(
  process.env.REMOTE_TASK_TIMEOUT_MS || 15 * 60 * 1000,
);
const RATE_LIMIT = Number(process.env.REMOTE_RATE_LIMIT || 10);
const RATE_WINDOW_MS = 60 * 1000;

const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken();
const REMOTE_ENABLED = Boolean(TOKEN);

const store = createTaskStore({ runtimeDir: RUNTIME_DIR, workspaceDir: WORKSPACE });

const worker = createWorker({
  store,
  workspaceDir: WORKSPACE,
  cliPath: CLI_PATH,
  executorScript: process.env.REMOTE_EXECUTOR_CMD || null,
  timeoutMs: TASK_TIMEOUT_MS,
  logger: (line) => console.log(line),
});

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function tokenMatches(candidate) {
  if (!REMOTE_ENABLED || typeof candidate !== 'string' || !candidate) return false;
  try {
    return crypto.timingSafeEqual(digest(candidate), digest(TOKEN));
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function credentialFrom(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const header = req.headers['x-remote-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const cookies = parseCookies(req);
  return cookies[COOKIE_NAME] || '';
}

function isAuthed(req) {
  return tokenMatches(credentialFrom(req));
}

function commonHeaders(extra) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(
    code,
    commonHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    }),
  );
  res.end(body);
}

function sendText(res, code, body, contentType) {
  res.writeHead(
    code,
    commonHeaders({
      'Content-Type': contentType || 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    }),
  );
  res.end(body);
}

function deny(res, req) {
  if (!REMOTE_ENABLED) {
    sendJson(res, 503, {
      ok: false,
      error: 'remote control is disabled',
      detail:
        'REMOTE_TOKEN is not configured. Set it in the environment and restart the server.',
    });
    return;
  }
  // Do not leak whether the token was missing, wrong, or malformed.
  console.warn(`[remote] unauthorized ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  sendJson(res, 401, { ok: false, error: 'unauthorized' });
}

function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  deny(res, req);
  return false;
}

function readBody(req, res, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let raw = '';
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      raw += chunk;
      if (raw.length > limit) {
        aborted = true;
        sendJson(res, 413, { ok: false, error: 'request body too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!aborted) resolve(raw);
    });
    req.on('error', () => {
      if (!aborted) resolve(null);
    });
  });
}

const rateBuckets = new Map();

function rateLimited(ip) {
  if (!Number.isFinite(RATE_LIMIT) || RATE_LIMIT <= 0) return false;
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

function computeStatus() {
  const active = store.activeTask();
  if (active) {
    return {
      phase: active.status === 'verifying' ? 'verifying' : 'generating',
      message: `[${active.id}] ${active.text.slice(0, 160)}`,
      activeTaskId: active.id,
      updatedAt: active.updatedAt,
    };
  }
  const tasks = store.list();
  const last = tasks[tasks.length - 1];
  if (last && (last.status === 'succeeded' || last.status === 'failed' || last.status === 'interrupted')) {
    const detail = last.error ? `: ${last.error.message}` : '';
    return {
      phase: 'done',
      message: `${last.id} ${last.status}${detail}`,
      lastTaskId: last.id,
      updatedAt: last.updatedAt,
    };
  }
  return { phase: 'idle', message: 'no generation started yet' };
}

function latestArtifact() {
  const tasks = store.list().reverse();
  for (const task of tasks) {
    if (task.status === 'succeeded' && task.result?.artifactIndexHtml) {
      return { indexHtml: task.result.artifactIndexHtml, taskId: task.id };
    }
  }
  const fallback = path.join(WORKSPACE, 'index.html');
  if (fs.existsSync(fallback)) return { indexHtml: fallback, taskId: null };
  return null;
}

function serveGameFile(req, res, urlPath) {
  const relative = decodeURIComponent(urlPath.replace(/^\/game\/?/, '') || 'index.html');
  const normalized = path.normalize(relative).replace(/^([/\\])+/, '');
  const target = path.resolve(WORKSPACE, normalized);
  if (!target.startsWith(path.resolve(WORKSPACE))) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      sendJson(res, 404, { ok: false, error: 'not found', path: normalized });
      return;
    }
    res.writeHead(
      200,
      commonHeaders({
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      }),
    );
    res.end(data);
  });
}

function serveConsole(res) {
  fs.readFile(path.join(__dirname, 'index.html'), (error, data) => {
    if (error) {
      sendJson(res, 500, { ok: false, error: 'console page missing: remote/index.html' });
      return;
    }
    res.writeHead(
      200,
      commonHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'SAMEORIGIN',
      }),
    );
    res.end(data);
  });
}

function publicTask(task) {
  return {
    id: task.id,
    status: task.status,
    text: task.text,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
    result: task.result
      ? {
          exitCode: task.result.exitCode,
          artifactIndexHtml: task.result.artifactIndexHtml,
          postVerify: task.result.postVerify,
        }
      : null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'vplay-remote',
        remoteEnabled: REMOTE_ENABLED,
        authRequired: true,
        workspace: WORKSPACE,
        autorun: AUTHORUN,
        tokenSource: TOKEN_SOURCE,
      });
      return;
    }

    if (method === 'GET' && pathname === '/console') {
      serveConsole(res);
      return;
    }

    if (method === 'POST' && pathname === '/auth/verify') {
      if (!REMOTE_ENABLED) {
        deny(res, req);
        return;
      }
      const raw = await readBody(req);
      if (raw === null) return;
      let candidate = '';
      try {
        candidate = String(JSON.parse(raw || '{}').token || '');
      } catch {
        candidate = '';
      }
      if (!tokenMatches(candidate)) {
        console.warn(`[remote] failed console login from ${req.socket.remoteAddress}`);
        // Throttle brute force using the same bucket as /prompt.
        rateLimited(req.socket.remoteAddress || 'unknown');
        sendJson(res, 401, { ok: false, error: 'invalid token' });
        return;
      }
      res.writeHead(
        200,
        commonHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
          'Cache-Control': 'no-store',
        }),
      );
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === 'POST' && pathname === '/auth/logout') {
      res.writeHead(
        200,
        commonHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        }),
      );
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/status' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      sendJson(res, 200, computeStatus());
      return;
    }

    if (pathname === '/tasks' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      const limit = Math.min(Number(url.searchParams.get('limit') || 20), 50);
      const tasks = store.list().slice(-limit).reverse().map(publicTask);
      sendJson(res, 200, { ok: true, tasks });
      return;
    }

    if (pathname.startsWith('/tasks/') && method === 'GET') {
      if (!requireAuth(req, res)) return;
      const rest = pathname.slice('/tasks/'.length);
      const [id, action] = rest.split('/');
      const task = store.get(id);
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'task not found' });
        return;
      }
      if (action === 'log') {
        const body = store.readLog(id);
        if (body === null) {
          sendJson(res, 404, { ok: false, error: 'task not found' });
          return;
        }
        sendText(res, 200, body || '(no output yet)');
        return;
      }
      if (action) {
        sendJson(res, 404, { ok: false, error: 'unknown task action' });
        return;
      }
      sendJson(res, 200, { ok: true, task: publicTask(task) });
      return;
    }

    if (pathname === '/prompt' && method === 'POST') {
      if (!requireAuth(req, res)) return;
      if (rateLimited(req.socket.remoteAddress || 'unknown')) {
        sendJson(res, 429, { ok: false, error: 'too many requests, slow down' });
        return;
      }
      const contentType = String(req.headers['content-type'] || '');
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(res, 415, {
          ok: false,
          error: 'Content-Type must be application/json',
        });
        return;
      }
      const raw = await readBody(req);
      if (raw === null) return;
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be valid JSON' });
        return;
      }
      try {
        const { task, duplicate } = store.create({
          text: payload.text,
          idempotencyKey: payload.idempotencyKey,
          source: 'remote',
        });
        console.log(
          `[remote] task ${task.id} ${duplicate ? 'already exists (idempotent)' : 'queued'}`,
        );
        sendJson(res, duplicate ? 200 : 202, {
          ok: true,
          duplicate,
          task: publicTask(task),
          queued: store.list().filter((item) => item.status === 'queued').length,
        });
      } catch (error) {
        if (error instanceof DuplicateTaskError) {
          sendJson(res, 409, {
            ok: false,
            error: error.message,
            existingTask: publicTask(error.existing),
          });
          return;
        }
        if (error instanceof ValidationError) {
          sendJson(res, 400, { ok: false, error: error.message });
          return;
        }
        console.error(`[remote] failed to create task: ${error.message}`);
        sendJson(res, 500, { ok: false, error: 'failed to create task' });
      }
      return;
    }

    if (pathname === '/artifact' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      const artifact = latestArtifact();
      if (!artifact) {
        sendJson(res, 404, { ok: false, error: 'no generated index.html yet' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        workspace: WORKSPACE,
        indexHtml: artifact.indexHtml,
        taskId: artifact.taskId,
        url: '/game/index.html',
      });
      return;
    }

    if (pathname === '/game' || pathname.startsWith('/game/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      if (!requireAuth(req, res)) return;
      serveGameFile(req, res, pathname);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    console.error(`[remote] unhandled error: ${error.message}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
  }
});

const recovered = store.recoverOnStartup();
if (recovered.length > 0) {
  console.log(
    `[remote] marked ${recovered.length} interrupted task(s) from a previous run: ${recovered.join(', ')}`,
  );
}

server.listen(PORT, HOST, () => {
  console.log(`[remote] Vplay remote bridge listening on http://${HOST}:${PORT}`);
  console.log(`[remote] workspace: ${WORKSPACE}`);
  console.log(`[remote] cli: ${CLI_PATH}`);
  if (!REMOTE_ENABLED) {
    console.warn(
      '[remote] REMOTE_TOKEN is not set — remote control is DISABLED (all control endpoints return 503).',
    );
  } else {
    console.log(`[remote] authentication enabled (token source: ${TOKEN_SOURCE})`);
  }
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.warn(
      '[remote] WARNING: bound to all interfaces. Only do this on a trusted network.',
    );
  }
  if (AUTHORUN) {
    console.log(`[remote] serial worker enabled (timeout ${TASK_TIMEOUT_MS}ms)`);
  } else {
    console.log('[remote] serial worker disabled (REMOTE_AUTORUN=0)');
  }
  console.log('[remote] GET /console | /status | /tasks | /artifact | POST /prompt');
  if (AUTHORUN) worker.start();
});

function shutdown(signal) {
  console.log(`[remote] ${signal} received, shutting down`);
  worker.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

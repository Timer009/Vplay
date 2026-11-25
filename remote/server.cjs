#!/usr/bin/env node
'use strict';

/**
 * Vplay Studio 远程控制面（Sprint 02）。
 *
 * 安全模型
 * --------
 * - 鉴权只在 HTTP 层（REMOTE_TOKEN）；未配置时控制接口全部 503。
 * - 写接口额外做 Origin 校验：跨源页面（例如 8788 端口的游戏预览）无法借
 *   同站 Cookie 调用管理 API。
 * - 游戏预览在独立端口 + 独立进程，只读静态文件，不含任何管理接口。
 * - 所有项目只能用 projectId 引用；HTTP 不接受系统路径。
 *
 * 两种模式
 * --------
 * - 单工作区模式（默认）：沿用 Sprint 01，任务写入 OPENGAME_WORKSPACE。
 * - 项目模式（设置 VPLAY_HOME）：Adopt Mode，任务按 projectId 映射到受控工作区，
 *   每次执行前自动快照，可查看差异 / 回退。
 *
 * 端点
 * ----
 *   GET  /health                     公开
 *   GET  /console                    公开（页面本身）
 *   POST /auth/verify                公开（Origin 校验）
 *   POST /auth/logout                公开
 *   GET  /status                     鉴权
 *   GET  /tasks, /tasks/:id, /tasks/:id/log
 *   POST /prompt                     鉴权 + Origin 校验
 *   GET  /artifact                   鉴权
 *   GET  /projects, /projects/:id    鉴权
 *   GET  /projects/:id/diff          鉴权
 *   POST /projects/:id/rollback      鉴权 + Origin 校验
 *   POST /projects/import            明确禁止（导入只能走本地 CLI）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createTaskStore, ValidationError, DuplicateTaskError } = require('./lib/tasks.cjs');
const { createWorker, resolveExecutorScript } = require('./lib/worker.cjs');
const { createProjectRegistry, ProjectError } = require('./lib/projects.cjs');
const { createPreviewServer } = require('./lib/preview.cjs');
const { recoverStaleLeases } = require('./lib/leases.cjs');
const { copyPreviewTree } = require('./lib/paths.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'cli.js');
const COOKIE_NAME = 'vplay_session';
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;

function readFlag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function resolveToken() {
  if (process.argv.slice(2).includes('--token')) {
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
const PREVIEW_PORT = Number(
  process.env.PREVIEW_PORT || (PORT === 0 ? 8788 : PORT + 1),
);
const PUBLIC_MODE =
  process.env.VPLAY_PUBLIC_MODE === '1' || HOST === '0.0.0.0' || HOST === '::';
const AUTHORUN = process.env.REMOTE_AUTORUN !== '0';
const TASK_TIMEOUT_MS = Number(process.env.REMOTE_TASK_TIMEOUT_MS || 15 * 60 * 1000);
const PROMPT_RATE_LIMIT = Number(process.env.REMOTE_RATE_LIMIT || 10);
const LOGIN_RATE_LIMIT = Number(process.env.REMOTE_LOGIN_RATE_LIMIT || 10);
const RATE_WINDOW_MS = 60 * 1000;

const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken();
const REMOTE_ENABLED = Boolean(TOKEN);

const projects = process.env.VPLAY_HOME
  ? createProjectRegistry({ home: process.env.VPLAY_HOME })
  : null;
const RUNTIME_ROOT = projects ? projects.home : WORKSPACE;
const RUNTIME_DIR = projects
  ? path.join(projects.home, '.opengame')
  : path.join(WORKSPACE, '.opengame');

const store = createTaskStore({
  runtimeDir: RUNTIME_DIR,
  workspaceDir: RUNTIME_ROOT,
  redactSecrets: TOKEN ? [TOKEN] : [],
});

const worker = createWorker({
  store,
  projects,
  workspaceDir: WORKSPACE,
  runtimeDir: RUNTIME_DIR,
  cliPath: CLI_PATH,
  executorScript: resolveExecutorScript(process.env),
  timeoutMs: TASK_TIMEOUT_MS,
  publicMode: PUBLIC_MODE,
  allowYolo: process.env.VPLAY_ALLOW_YOLO !== '0',
  secrets: TOKEN ? [TOKEN] : [],
  onFinished: ({ projectId }) => {
    try {
      if (projects) projects.buildPreview(projectId);
      else rebuildLegacyPreview();
    } catch {
      // 预览重建失败不影响任务结果
    }
  },
  logger: (line) => console.log(line),
});

// 单工作区模式：预览只读「独立产物目录」，不直读工作区
const LEGACY_PREVIEW_DIR = path.join(RUNTIME_DIR, '.preview-legacy');

function rebuildLegacyPreview() {
  if (projects) return null;
  try {
    copyPreviewTree(WORKSPACE, LEGACY_PREVIEW_DIR);
    return fs.existsSync(path.join(LEGACY_PREVIEW_DIR, 'index.html'))
      ? LEGACY_PREVIEW_DIR
      : null;
  } catch {
    return null;
  }
}

const previewServer = createPreviewServer({
  projects,
  // 单工作区模式也只暴露独立预览产物目录；项目模式只暴露 .preview
  legacyRoot: projects ? null : LEGACY_PREVIEW_DIR,
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

// ---- 短期 Session（P1-2）：服务端可吊销，Cookie 值不等于主 Token ----
const sessions = new Map();

function sessionKey(sessionId) {
  return crypto.createHash('sha256').update(sessionId).digest('hex');
}

function pruneSessions() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS || now - session.lastSeen > SESSION_IDLE_MS) {
      sessions.delete(key);
    }
  }
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (let i = 0; i < sessions.size - MAX_SESSIONS; i += 1) {
      sessions.delete(oldest[i][0]);
    }
  }
}

function createSession() {
  pruneSessions();
  const sessionId = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  sessions.set(sessionKey(sessionId), { createdAt: now, lastSeen: now });
  return sessionId;
}

function validSession(sessionId) {
  if (!sessionId) return false;
  const key = sessionKey(sessionId);
  const session = sessions.get(key);
  if (!session) return false;
  const now = Date.now();
  if (now - session.createdAt > SESSION_TTL_MS || now - session.lastSeen > SESSION_IDLE_MS) {
    sessions.delete(key);
    return false;
  }
  session.lastSeen = now;
  return true;
}

function dropSession(sessionId) {
  if (sessionId) sessions.delete(sessionKey(sessionId));
}

// ---- Host / Origin 白名单（P1-3）----
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
if (HOST && HOST !== '0.0.0.0' && HOST !== '::') ALLOWED_HOSTS.add(String(HOST).toLowerCase());
for (const entry of String(process.env.REMOTE_ALLOWED_HOSTS || '').split(',')) {
  const value = entry.trim().toLowerCase();
  if (value) ALLOWED_HOSTS.add(value);
}

function hostAllowed(req) {
  const raw = String(req.headers.host || '');
  const hostname = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return Boolean(hostname) && ALLOWED_HOSTS.has(hostname);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / 脚本调用
  const host = req.headers.host;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host;
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

function bearerFrom(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const header = req.headers['x-remote-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return '';
}

function sessionFrom(req) {
  return parseCookies(req)[COOKIE_NAME] || '';
}

/** 鉴权来源：主 Token（Bearer）或短期 Session（Cookie）。 */
function authVia(req) {
  if (tokenMatches(bearerFrom(req))) return 'token';
  if (validSession(sessionFrom(req))) return 'session';
  return null;
}

function isAuthed(req) {
  return Boolean(authVia(req));
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
      detail: 'REMOTE_TOKEN is not configured. Set it in the environment and restart the server.',
    });
    return;
  }
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

// P1-1：登录与任务使用独立限流桶，避免暴力破解与正常任务互相影响
const promptBuckets = new Map();
const loginBuckets = new Map();

function bucketLimited(buckets, ip, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const now = Date.now();
  if (buckets.size > 5000) {
    for (const [key, bucket] of buckets) {
      if (now > bucket.resetAt) buckets.delete(key);
    }
  }
  const bucket = buckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

function computeStatus() {
  const active = store.activeTask();
  if (active) {
    return {
      phase: active.status === 'verifying' ? 'verifying' : 'generating',
      message: `[${active.id}] ${active.text.slice(0, 160)}`,
      activeTaskId: active.id,
      projectId: active.projectId || null,
      updatedAt: active.updatedAt,
    };
  }
  const tasks = store.list();
  const last = tasks[tasks.length - 1];
  if (
    last &&
    (last.status === 'succeeded' || last.status === 'failed' || last.status === 'interrupted')
  ) {
    const detail = last.error ? `: ${last.error.message}` : '';
    return {
      phase: 'done',
      message: `${last.id} ${last.status}${detail}`,
      lastTaskId: last.id,
      projectId: last.projectId || null,
      updatedAt: last.updatedAt,
    };
  }
  return { phase: 'idle', message: 'no generation started yet', projectId: null };
}

function publicTask(task) {
  return {
    id: task.id,
    projectId: task.projectId || 'default',
    status: task.status,
    text: task.text,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    snapshotSeq: task.snapshotSeq ?? null,
    error: task.error,
    result: task.result
      ? {
          exitCode: task.result.exitCode,
          artifactPath: task.result.artifactPath,
          postVerify: task.result.postVerify,
          verified: task.result.verified,
          outcome: task.result.outcome,
          noChanges: task.result.noChanges,
          verification: task.result.verification,
          changedFiles: task.result.changedFiles,
          diffSummary: task.result.diffSummary,
        }
      : null,
  };
}

function previewLink(req, projectId) {
  const hostname = String(req.headers.host || 'localhost').split(':')[0];
  const previewPath = projectId ? `/p/${projectId}/` : '/legacy/';
  return {
    previewPath,
    previewPort: PREVIEW_PORT,
    previewUrl: `http://${hostname}:${PREVIEW_PORT}${previewPath}`,
  };
}

function projectExists(id) {
  if (!projects) return id === 'default';
  try {
    projects.get(id);
    return true;
  } catch {
    return false;
  }
}

function resolveRequestedProject(payloadProjectId) {
  if (projects) {
    if (payloadProjectId) return String(payloadProjectId);
    const all = projects.list();
    if (all.length === 1) return all[0].id;
    return null;
  }
  return 'default';
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
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      }),
    );
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  try {
    // P1-3：Host 白名单，防 DNS rebinding
    if (!hostAllowed(req)) {
      sendJson(res, 400, { ok: false, error: 'host not allowed' });
      return;
    }

    if (method === 'GET' && pathname === '/health') {
      // P2-1：公开端点只返回最小信息
      sendJson(res, 200, {
        ok: true,
        service: 'vplay-remote',
        version: 2,
        remoteEnabled: REMOTE_ENABLED,
      });
      return;
    }

    if (method === 'GET' && pathname === '/console') {
      serveConsole(res);
      return;
    }

    const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    if (mutating && !originAllowed(req)) {
      console.warn(`[remote] origin rejected ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' });
      return;
    }

    if (method === 'POST' && pathname === '/auth/verify') {
      if (!REMOTE_ENABLED) {
        deny(res, req);
        return;
      }
      const ip = req.socket.remoteAddress || 'unknown';
      // P1-1：先判后记，登录与任务桶分离
      if (bucketLimited(loginBuckets, ip, LOGIN_RATE_LIMIT)) {
        sendJson(res, 429, {
          ok: false,
          error: 'too many login attempts, slow down',
        });
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
        console.warn(`[remote] failed console login from ${ip}`);
        sendJson(res, 401, { ok: false, error: 'invalid token' });
        return;
      }
      // P1-2：下发短期 Session，而不是把主 Token 写进 Cookie
      const sessionId = createSession();
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
      const cookie = [
        `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        ...(secure ? ['Secure'] : []),
      ].join('; ');
      res.writeHead(
        200,
        commonHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': cookie,
          'Cache-Control': 'no-store',
        }),
      );
      res.end(JSON.stringify({ ok: true, expiresIn: SESSION_TTL_MS / 1000 }));
      return;
    }

    if (method === 'POST' && pathname === '/auth/logout') {
      // P1-3：登出同样需要鉴权，避免任意网页把用户登出
      if (!requireAuth(req, res)) return;
      dropSession(sessionFrom(req));
      const cookie = [
        `${COOKIE_NAME}=`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        'Max-Age=0',
      ].join('; ');
      res.writeHead(
        200,
        commonHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': cookie,
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
      const projectFilter = url.searchParams.get('projectId');
      let tasks = store.list();
      if (projectFilter) tasks = tasks.filter((t) => (t.projectId || 'default') === projectFilter);
      tasks = tasks.slice(-limit).reverse().map(publicTask);
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
      if (bucketLimited(promptBuckets, req.socket.remoteAddress || 'unknown', PROMPT_RATE_LIMIT)) {
        sendJson(res, 429, { ok: false, error: 'too many requests, slow down' });
        return;
      }
      const contentType = String(req.headers['content-type'] || '');
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(res, 415, { ok: false, error: 'Content-Type must be application/json' });
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

      const projectId = resolveRequestedProject(payload.projectId);
      if (!projectId) {
        sendJson(res, 400, {
          ok: false,
          error: 'projectId is required when multiple projects exist',
        });
        return;
      }
      if (!projectExists(projectId)) {
        sendJson(res, 404, { ok: false, error: `unknown projectId: ${projectId}` });
        return;
      }

      try {
        const { task, duplicate } = store.create({
          text: payload.text,
          idempotencyKey: payload.idempotencyKey,
          source: 'remote',
          projectId,
        });
        console.log(
          `[remote] task ${task.id} ${duplicate ? 'already exists (idempotent)' : 'queued'} project=${projectId}`,
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
      const projectId = url.searchParams.get('projectId') || (projects ? null : 'default');
      if (projects && !projectId) {
        const all = projects.list();
        sendJson(res, 200, {
          ok: true,
          mode: 'projects',
          projects: all.map((item) => ({ id: item.id, ...previewLink(req, item.id) })),
        });
        return;
      }
      if (projectId && !projectExists(projectId)) {
        sendJson(res, 404, { ok: false, error: 'unknown projectId' });
        return;
      }
      const link = previewLink(req, projects ? projectId : null);
      sendJson(res, 200, {
        ok: true,
        projectId,
        ...link,
      });
      return;
    }

    if (pathname === '/projects/import') {
      sendJson(res, 403, {
        ok: false,
        error: 'import is disabled over HTTP',
        detail: '使用本地命令：node remote/cli.cjs project import <path> --id <id>',
      });
      return;
    }

    if (pathname === '/projects' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      if (!projects) {
        sendJson(res, 200, { ok: true, mode: 'workspace', projects: [] });
        return;
      }
      const items = projects.list().map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        framework: item.framework,
        entry: item.entry,
        createdAt: item.createdAt,
        locked: item.locked,
        rounds: projects.memory(item.id).rounds.length,
        ...previewLink(req, item.id),
      }));
      sendJson(res, 200, { ok: true, mode: 'projects', projects: items });
      return;
    }

    if (pathname.startsWith('/projects/') && method === 'GET') {
      if (!requireAuth(req, res)) return;
      if (!projects) {
        sendJson(res, 404, { ok: false, error: 'projects mode is not enabled' });
        return;
      }
      const rest = pathname.slice('/projects/'.length).split('/');
      const projectId = rest[0];
      try {
        const detail = projects.get(projectId);
        if (rest[1] === 'diff') {
          const from = Number(url.searchParams.get('from'));
          const toParam = url.searchParams.get('to');
          const to = !toParam || toParam === 'current' ? 'current' : Number(toParam);
          if (!Number.isFinite(from) || from <= 0) {
            sendJson(res, 400, { ok: false, error: 'from must be a snapshot seq' });
            return;
          }
          sendJson(res, 200, { ok: true, ...projects.diff(projectId, from, to) });
          return;
        }
        if (rest[1]) {
          sendJson(res, 404, { ok: false, error: 'unknown project action' });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          project: {
            ...detail,
            ...previewLink(req, projectId),
          },
        });
      } catch (error) {
        if (error instanceof ProjectError) {
          sendJson(res, error.statusCode, { ok: false, error: error.message, code: error.code });
          return;
        }
        throw error;
      }
      return;
    }

    if (pathname.startsWith('/projects/') && pathname.endsWith('/rollback') && method === 'POST') {
      if (!requireAuth(req, res)) return;
      if (!projects) {
        sendJson(res, 404, { ok: false, error: 'projects mode is not enabled' });
        return;
      }
      const projectId = pathname.split('/')[2];
      const active = store.activeTask();
      if (active && (active.projectId || 'default') === projectId) {
        sendJson(res, 409, {
          ok: false,
          error: 'task is running for this project; rollback is not allowed',
          taskId: active.id,
        });
        return;
      }
      const raw = await readBody(req);
      if (raw === null) return;
      let seq;
      try {
        seq = Number(JSON.parse(raw || '{}').seq);
      } catch {
        seq = NaN;
      }
      if (!Number.isFinite(seq) || seq <= 0) {
        sendJson(res, 400, { ok: false, error: 'body must be { "seq": <snapshot number> }' });
        return;
      }
      try {
        const result = projects.rollback(projectId, seq);
        console.log(`[remote] project ${projectId} rolled back to #${seq} (backup #${result.backupSeq})`);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        if (error instanceof ProjectError) {
          sendJson(res, error.statusCode, { ok: false, error: error.message, code: error.code });
          return;
        }
        throw error;
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    console.error(`[remote] unhandled error: ${error.message}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
  }
});

// ---- 启动 ----
// P1-6：单工作区互斥锁，防止两个实例同时写同一工作区
const SERVER_LOCK = path.join(RUNTIME_DIR, 'server.lock');

function acquireServerLock() {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(SERVER_LOCK, 'wx');
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, port: PORT, startedAt: new Date().toISOString() }),
      );
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(SERVER_LOCK, 'utf-8'));
      } catch {
        holder = null;
      }
      let alive = false;
      if (holder && holder.pid) {
        try {
          process.kill(holder.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (alive) {
        console.error(
          `[remote] another server is already using this workspace (pid=${holder.pid}, port=${holder.port}). Refusing to start.`,
        );
        return false;
      }
      fs.rmSync(SERVER_LOCK, { force: true });
    }
  }
  return false;
}

if (!acquireServerLock()) {
  process.exit(1);
}

rebuildLegacyPreview();

const recovered = store.recoverOnStartup();
if (recovered.length > 0) {
  console.log(
    `[remote] marked ${recovered.length} interrupted task(s) from a previous run: ${recovered.join(', ')}`,
  );
}
const leaseActions = recoverStaleLeases({
  leasesDir: path.join(RUNTIME_DIR, 'leases'),
  maxAgeMs: Number(process.env.VPLAY_LEASE_MAX_AGE_MS || 15000),
  logger: (line) => console.log(line),
});
const killed = leaseActions.filter((item) => item.action.startsWith('killed'));
if (killed.length > 0) {
  console.log(`[remote] reaped ${killed.length} orphan process(es) from a previous run`);
}

server.listen(PORT, HOST, () => {
  console.log(`[remote] Vplay remote bridge listening on http://${HOST}:${PORT}`);
  console.log(`[remote] mode: ${projects ? `projects (${projects.home})` : 'workspace'}`);
  console.log(`[remote] workspace: ${projects ? projects.home : WORKSPACE}`);
  console.log(`[remote] cli: ${CLI_PATH}`);
  console.log(`[remote] public mode: ${PUBLIC_MODE ? 'yes (yolo disabled)' : 'no'}`);
  if (!REMOTE_ENABLED) {
    console.warn(
      '[remote] REMOTE_TOKEN is not set — remote control is DISABLED (all control endpoints return 503).',
    );
  } else {
    console.log(`[remote] authentication enabled (token source: ${TOKEN_SOURCE})`);
  }
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.warn('[remote] WARNING: bound to all interfaces. Only do this on a trusted network.');
  }
  if (AUTHORUN) {
    console.log(`[remote] serial worker enabled (timeout ${TASK_TIMEOUT_MS}ms)`);
  } else {
    console.log('[remote] serial worker disabled (REMOTE_AUTORUN=0)');
  }
  if (AUTHORUN) worker.start();

  previewServer.listen(PREVIEW_PORT, HOST, () => {
    console.log(`[preview] game preview on http://${HOST}:${PREVIEW_PORT} (read-only, no control API)`);
  });
});

function shutdown(signal) {
  console.log(`[remote] ${signal} received, shutting down`);
  worker.stop();
  try {
    fs.rmSync(SERVER_LOCK, { force: true });
  } catch {
    // 忽略
  }
  try {
    previewServer.close();
  } catch {
    // 忽略
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

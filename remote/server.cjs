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
const os = require('os');
const crypto = require('crypto');

const { createTaskStore, ValidationError, DuplicateTaskError } = require('./lib/tasks.cjs');
const { createWorker, resolveExecutorScript } = require('./lib/worker.cjs');
const { createProjectRegistry, ProjectError } = require('./lib/projects.cjs');
const { createPreviewServer } = require('./lib/preview.cjs');
const { recoverStaleLeases } = require('./lib/leases.cjs');
const { copyPreviewTree } = require('./lib/paths.cjs');
const { createEventStore } = require('./lib/events.cjs');
const { createEvidenceStore } = require('./lib/evidence.cjs');
const { createDeviceStore } = require('./lib/devices.cjs');
const { createVisionService, recoverVisionApplies } = require('./lib/vision-service.cjs');

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
const TRUST_PROXY = process.env.REMOTE_TRUST_PROXY === '1';
const SERVE_MODE = process.env.VPLAY_PUBLIC_MODE === '1' || TRUST_PROXY;
const PUBLIC_MODE =
  SERVE_MODE || HOST === '0.0.0.0' || HOST === '::';
const AUTHORUN = process.env.REMOTE_AUTORUN !== '0';
const TASK_TIMEOUT_MS = Number(process.env.REMOTE_TASK_TIMEOUT_MS || 15 * 60 * 1000);
const PROMPT_RATE_LIMIT = Number(process.env.REMOTE_RATE_LIMIT || 10);
const LOGIN_RATE_LIMIT = Number(process.env.REMOTE_LOGIN_RATE_LIMIT || 10);
const RATE_WINDOW_MS = 60 * 1000;

// P1-3：Host 白名单（控制面与预览面共用；必须在创建预览服务前定义）
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
if (HOST && HOST !== '0.0.0.0' && HOST !== '::') ALLOWED_HOSTS.add(String(HOST).toLowerCase());
for (const entry of String(process.env.REMOTE_ALLOWED_HOSTS || '').split(',')) {
  const value = entry.trim().toLowerCase();
  if (value) ALLOWED_HOSTS.add(value);
}

const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken();
const REMOTE_ENABLED = Boolean(TOKEN);
// B10 / C09 B-09：预览鉴权改为「短期、会话绑定、可吊销」的票据。
// PREVIEW_ACCESS_KEY 仅作为启用开关（不再把静态哈希写进 Cookie）。
const PREVIEW_AUTH_ENABLED = Boolean((process.env.PREVIEW_ACCESS_KEY || '').trim());
const PREVIEW_TICKET_TTL_MS = 4 * 60 * 60 * 1000;

const projects = process.env.VPLAY_HOME
  ? createProjectRegistry({ home: process.env.VPLAY_HOME })
  : null;
const RUNTIME_ROOT = projects ? projects.home : WORKSPACE;
const RUNTIME_DIR = projects
  ? path.join(projects.home, '.opengame')
  : path.join(WORKSPACE, '.opengame');

const EVIDENCE_HMAC_KEY = process.env.EVIDENCE_HMAC_KEY || null;
const eventStore = createEventStore({
  file: projects
    ? path.join(RUNTIME_ROOT, 'events', 'events.jsonl')
    : path.join(RUNTIME_DIR, 'events', 'events.jsonl'),
  hmacKey: EVIDENCE_HMAC_KEY,
  logger: (line) => console.log(line),
});
const evidenceStore = createEvidenceStore({
  home: RUNTIME_ROOT,
  // 单工作区模式：证据放到 .opengame 内（被 hashTree/快照排除），避免污染任务变更检测
  root: projects ? path.join(RUNTIME_ROOT, 'evidence') : path.join(RUNTIME_DIR, 'evidence'),
  hmacKey: EVIDENCE_HMAC_KEY,
});
const devices = createDeviceStore({
  file: projects ? path.join(projects.home, 'devices.json') : path.join(RUNTIME_DIR, 'devices.json'),
});

// ---- 预览票据（B10 / C09 B-09）：内存存储、会话绑定、可即时吊销 ----
const previewTickets = new Map();

function prunePreviewTickets() {
  const now = Date.now();
  for (const [value, ticket] of previewTickets) {
    if (now > ticket.expiresAt) previewTickets.delete(value);
  }
}

function issuePreviewTicket({ projectId = null, deviceId = null, admin = false, sessionKey: boundKey = null, ttlMs = PREVIEW_TICKET_TTL_MS } = {}) {
  if (!PREVIEW_AUTH_ENABLED) return null;
  prunePreviewTickets();
  const value = crypto.randomBytes(32).toString('base64url');
  previewTickets.set(value, {
    projectId,
    deviceId,
    admin: admin === true,
    sessionKey: boundKey,
    expiresAt: Date.now() + Number(ttlMs || PREVIEW_TICKET_TTL_MS),
  });
  return value;
}

function revokePreviewTickets(predicate) {
  let removed = 0;
  for (const [value, ticket] of previewTickets) {
    if (!predicate || predicate(ticket)) {
      previewTickets.delete(value);
      removed += 1;
    }
  }
  return removed;
}

/**
 * 预览面授权：票据有效 + 设备未被吊销 + 项目授权。
 * 设备吊销后，下一次请求立即 401（不依赖票据过期）。
 */
function authorizePreview(value, projectId) {
  if (!PREVIEW_AUTH_ENABLED) return true;
  if (!value) return false;
  const ticket = previewTickets.get(value);
  if (!ticket) return false;
  if (Date.now() > ticket.expiresAt) {
    previewTickets.delete(value);
    return false;
  }
  if (ticket.admin) return true;
  if (ticket.deviceId) {
    const device = devices.get(ticket.deviceId);
    if (!device || device.revoked) return false;
    if (projectId && !devices.isProjectAllowed(device, projectId)) return false;
    return true;
  }
  if (ticket.projectId && projectId && ticket.projectId !== projectId) return false;
  return true;
}

const store = createTaskStore({
  runtimeDir: RUNTIME_DIR,
  workspaceDir: RUNTIME_ROOT,
  redactSecrets: TOKEN ? [TOKEN] : [],
});

const visionService = createVisionService({
  registry: projects,
  home: projects ? RUNTIME_ROOT : RUNTIME_DIR,
  eventStore,
  logger: (line) => console.log(line),
  deps: {
    previewPort: PREVIEW_PORT,
    // 短期票据只存在于本进程内存，注入浏览器 context 后立即失效；不写盘、不进模型上下文
    previewTicketProvider: ({ projectId, taskId }) =>
      issuePreviewTicket({
        projectId,
        admin: true,
        ttlMs: 5 * 60 * 1000,
        sessionKey: `vision:${taskId}`,
      }),
  },
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
  allowYolo: process.env.VPLAY_ALLOW_YOLO === '1',
  secrets: TOKEN ? [TOKEN] : [],
  visionService,
  eventStore,
  evidenceStore,
  home: RUNTIME_ROOT,
  onFinished: ({ projectId, verified }) => {
    try {
      // C07-P1-03：只有功能验证通过的任务才切换预览；失败保留 last-known-good。
      // 项目模式：worker 在 settle 内已完成「发布 + 全量校验」，这里只处理单工作区。
      if (!verified) {
        console.log(`[remote] project ${projectId} not verified; preview kept`);
        return;
      }
      if (!projects) rebuildLegacyPreview();
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
    const result = copyPreviewTree(WORKSPACE, LEGACY_PREVIEW_DIR);
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(RUNTIME_DIR, '.publish-legacy-manifest.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), ...result.manifest }, null, 2),
        'utf-8',
      );
    } catch {
      // 清单写入失败不影响预览
    }
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
  allowedHosts: ALLOWED_HOSTS,
  previewAuthEnabled: PREVIEW_AUTH_ENABLED,
  authorizePreview: (value, projectId) => authorizePreview(value, projectId),
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

function createSession(deviceId = null, admin = false) {
  pruneSessions();
  const sessionId = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  sessions.set(sessionKey(sessionId), {
    createdAt: now,
    lastSeen: now,
    tokenFingerprint: REMOTE_ENABLED ? digest(TOKEN).toString('hex') : null,
    deviceId,
    admin: admin === true,
  });
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
  // C07-P1-09：session 绑定当前 token 指纹；token 轮换后旧 session 自动失效
  const current = REMOTE_ENABLED ? digest(TOKEN).toString('hex') : null;
  if (session.tokenFingerprint !== current) {
    sessions.delete(key);
    return false;
  }
  // B10：设备被吊销后，现有 Session 立即失效（不等待 TTL）
  if (session.deviceId && !devices.isActive(session.deviceId)) {
    sessions.delete(key);
    return false;
  }
  session.lastSeen = now;
  return true;
}

function revokeAllSessions() {
  const count = sessions.size;
  sessions.clear();
  // 预览票据与会话同生命周期：全部吊销
  revokePreviewTickets(() => true);
  return count;
}

function dropSession(sessionId) {
  if (!sessionId) return;
  const key = sessionKey(sessionId);
  sessions.delete(key);
  // 只吊销与该会话绑定的预览票据
  revokePreviewTickets((ticket) => ticket.sessionKey === key);
}

// ---- Host / Origin 白名单（P1-3）----
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

/** 鉴权来源：管理员主 Token / 设备 Token / 短期 Session（Cookie）。 */
function authState(req) {
  const bearer = bearerFrom(req);
  if (tokenMatches(bearer)) return { kind: 'admin', deviceId: null };
  const device = devices.authenticate(bearer);
  if (device) return { kind: 'device', deviceId: device.id, device };
  const sessionId = sessionFrom(req);
  if (validSession(sessionId)) {
    const session = sessions.get(sessionKey(sessionId));
    const deviceId = session ? session.deviceId || null : null;
    return {
      kind: 'session',
      deviceId,
      admin: Boolean(session && session.admin === true),
      device: deviceId ? devices.get(deviceId) : null,
    };
  }
  return null;
}

function authVia(req) {
  const state = authState(req);
  if (!state) return null;
  if (state.kind === 'admin') return 'token';
  return state.kind;
}

function isAuthed(req) {
  return Boolean(authState(req));
}

/** 设备项目授权：管理员始终允许。 */
function projectAllowed(auth, projectId) {
  if (!auth) return false;
  if (auth.kind === 'admin' || auth.admin === true) return true;
  const device = auth.device || (auth.deviceId ? devices.get(auth.deviceId) : null);
  if (!device || device.revoked) return false;
  return devices.isProjectAllowed(device, projectId);
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
    kind: task.kind || 'prompt',
    createdBy: task.createdBy || 'admin',
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
          versionId: task.result.versionId || null,
          artifactId: task.result.artifactId || null,
          previewPath: task.result.previewPath || null,
          vision: task.result.vision
            ? {
                status: task.result.vision.status || null,
                mode: task.result.vision.mode || null,
                reportFile: task.result.vision.reportFile || null,
                artifactId: task.result.vision.artifactId || null,
                error: task.result.vision.error || null,
              }
            : null,
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
  // NEW-01：不信任 Host 做 URL 解析，畸形 Host 只返回 400，绝不抛异常
  const method = req.method || 'GET';
  let pathname = '/';
  let params = new URLSearchParams();
  try {
    const rawUrl = String(req.url || '/');
    const qIndex = rawUrl.indexOf('?');
    const rawPath = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    pathname = rawPath.replace(/\/+$/, '') || '/';
    params = new URLSearchParams(qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '');
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad request' });
    return;
  }

  try {
    // P1-3：Host 白名单，防 DNS rebinding
    if (!hostAllowed(req)) {
      sendJson(res, 400, { ok: false, error: 'host not allowed' });
      return;
    }

    // C07-P1-02：API 的 GET 不接受跨站请求（预览源脚本携带 Cookie 的弱边界加固）
    const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (
      secFetchSite === 'cross-site' &&
      method === 'GET' &&
      (pathname === '/status' ||
        pathname === '/events' ||
        pathname === '/tasks' ||
        pathname.startsWith('/tasks/') ||
        pathname === '/projects' ||
        pathname.startsWith('/projects/'))
    ) {
      sendJson(res, 403, { ok: false, error: 'cross-site request blocked' });
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
      const isAdmin = tokenMatches(candidate);
      const device = isAdmin ? null : devices.authenticate(candidate);
      if (!isAdmin && !device) {
        console.warn(`[remote] failed console login from ${ip}`);
        sendJson(res, 401, { ok: false, error: 'invalid token' });
        return;
      }
      // P1-2：下发短期 Session，而不是把主 Token 写进 Cookie
      const sessionId = createSession(device ? device.id : null, isAdmin);
      // B10：只有明确信任回环代理（Tailscale Serve）时才接受 X-Forwarded-Proto
      const secure =
        Boolean(req.socket.encrypted) ||
        (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
      const cookie = [
        `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        ...(secure ? ['Secure'] : []),
      ].join('; ');
      const cookies = [cookie];
      const previewTicket = PREVIEW_AUTH_ENABLED
        ? issuePreviewTicket({
            deviceId: device ? device.id : null,
            admin: isAdmin,
            sessionKey: sessionKey(sessionId),
          })
        : null;
      if (previewTicket) {
        cookies.push(
          [
            `vplay_preview=${encodeURIComponent(previewTicket)}`,
            'HttpOnly',
            'SameSite=Strict',
            'Path=/',
            `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
            ...(secure ? ['Secure'] : []),
          ].join('; '),
        );
      }
      res.writeHead(
        200,
        commonHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': cookies,
          'Cache-Control': 'no-store',
        }),
      );
      res.end(JSON.stringify({
        ok: true,
        role: isAdmin ? 'admin' : 'device',
        device: device ? { id: device.id, name: device.name, projects: device.projects } : null,
        expiresIn: SESSION_TTL_MS / 1000,
      }));
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
      const cookies = [
        cookie,
        // B10：登出立即吊销预览票据（服务端），并清除客户端 Cookie
        ['vplay_preview=', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'].join('; '),
      ];
      res.writeHead(
        200,
        commonHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': cookies,
        }),
      );
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === 'POST' && pathname === '/auth/revoke-all') {
      // C07-P1-09：token 轮换/应急时吊销全部 session；只接受 Bearer 主 token
      if (!requireAuth(req, res)) return;
      if (authVia(req) !== 'token') {
        sendJson(res, 403, { ok: false, error: 'bearer token required' });
        return;
      }
      const revoked = revokeAllSessions();
      sendJson(res, 200, { ok: true, revoked });
      return;
    }

    if (pathname === '/status' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      sendJson(res, 200, computeStatus());
      return;
    }

    if (pathname === '/events' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      res.writeHead(
        200,
        commonHeaders({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        }),
      );
      const last = req.headers['last-event-id'] || params.get('lastEventId') || '0';
      let closed = false;
      let unsubscribe = () => {};
      let ping = null;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        unsubscribe();
      };
      // B10 / C-1：事件按项目授权过滤；未授权设备不得获得项目/任务元数据。
      const send = (record) => {
        if (closed) return;
        const current = authState(req);
        if (!current) {
          // 设备被吊销 / 会话失效：立即断开现有 SSE
          cleanup();
          try {
            res.end();
          } catch {
            // 忽略
          }
          return;
        }
        if (record.projectId && !projectAllowed(current, record.projectId)) {
          const createdBy = record.data && record.data.createdBy;
          if (!(current.deviceId && createdBy === current.deviceId)) return;
        }
        res.write(`id: ${record.id}\ndata: ${JSON.stringify(record)}\n\n`);
      };
      res.write('retry: 3000\n\n');
      for (const record of eventStore.listAfter(last, 2000)) send(record);
      unsubscribe = eventStore.subscribe((record) => {
        try {
          send(record);
        } catch {
          // 连接已断开
        }
      });
      ping = setInterval(() => {
        try {
          if (!authState(req)) {
            cleanup();
            res.end();
            return;
          }
          res.write(': ping\n\n');
        } catch {
          // 忽略
        }
      }, 15000);
      req.on('close', cleanup);
      req.on('error', cleanup);
      res.on('close', cleanup);
      return;
    }

    if (pathname === '/tasks' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      const auth = authState(req);
      const limit = Math.min(Number(params.get('limit') || 20), 50);
      const projectFilter = params.get('projectId');
      let tasks = store.list();
      // B10 / C-1：同一用户授权的设备可查看共同工程的任务；未授权设备不得读取元数据。
      if (auth && auth.kind !== 'admin' && auth.admin !== true) {
        tasks = tasks.filter(
          (t) =>
            (t.createdBy || 'admin') === auth.deviceId ||
            projectAllowed(auth, t.projectId || 'default'),
        );
      }
      if (projectFilter) tasks = tasks.filter((t) => (t.projectId || 'default') === projectFilter);
      tasks = tasks.slice(-limit).reverse().map(publicTask);
      sendJson(res, 200, { ok: true, tasks, role: auth && auth.kind });
      return;
    }

    if (pathname.startsWith('/tasks/') && method === 'GET') {
      if (!requireAuth(req, res)) return;
      const auth = authState(req);
      const rest = pathname.slice('/tasks/'.length);
      const [id, action] = rest.split('/');
      const task = store.get(id);
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'task not found' });
        return;
      }
      if (
        auth &&
        auth.kind !== 'admin' &&
        auth.admin !== true &&
        (task.createdBy || 'admin') !== auth.deviceId &&
        !projectAllowed(auth, task.projectId || 'default')
      ) {
        sendJson(res, 403, { ok: false, error: 'task is not visible to this device' });
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
      const auth = authState(req);
      if (!projectAllowed(auth, projectId)) {
        sendJson(res, 403, { ok: false, error: 'device is not authorized for this project' });
        return;
      }

      const via = authVia(req);
      // C07-P0-01：yolo 必须由主 token 显式按任务申请；Session/设备不能开启 yolo
      const requestedYolo = payload.allowYolo === true;
      if (requestedYolo && via !== 'token') {
        sendJson(res, 403, { ok: false, error: 'yolo requires bearer token authorization' });
        return;
      }

      try {
        const { task, duplicate } = store.create({
          text: payload.text,
          idempotencyKey: payload.idempotencyKey,
          source: 'remote',
          projectId,
          createdBy: (auth && auth.deviceId) || 'admin',
          allowYolo: requestedYolo && via === 'token',
        });
        console.log(
          `[remote] task ${task.id} ${duplicate ? 'already exists (idempotent)' : 'queued'} project=${projectId}`,
        );
        if (!duplicate) {
          eventStore.append({
            type: 'task.created',
            taskId: task.id,
            projectId,
            status: 'queued',
            data: { kind: task.kind || 'prompt', createdBy: task.createdBy || 'admin' },
          });
        }
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
      const auth = authState(req);
      const projectId = params.get('projectId') || (projects ? null : 'default');
      if (projects && !projectId) {
        const all = projects.list().filter((item) => projectAllowed(auth, item.id));
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
      if (projectId && !projectAllowed(auth, projectId)) {
        sendJson(res, 403, { ok: false, error: 'device is not authorized for this project' });
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
      const auth = authState(req);
      const visible = projects
        .list()
        .filter((item) => projectAllowed(auth, item.id));
      const items = visible.map((item) => ({
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

    if (/^\/projects\/[a-z0-9-]+\/vision\/[a-zA-Z0-9_-]+$/.test(pathname) && method === 'GET') {
      if (!requireAuth(req, res)) return;
      const parts = pathname.split('/');
      const projectId = parts[2];
      const taskId = parts[4];
      if (!projectAllowed(authState(req), projectId)) {
        sendJson(res, 403, { ok: false, error: 'device is not authorized for this project' });
        return;
      }
      const task = store.get(taskId);
      if (!task || task.kind !== 'vision' || (task.projectId || 'default') !== projectId) {
        sendJson(res, 404, { ok: false, error: 'vision task not found' });
        return;
      }
      const dir = path.join(RUNTIME_ROOT, 'evidence', projectId, taskId);
      let report = null;
      try {
        const file = path.join(dir, 'vision-report.json');
        if (fs.existsSync(file) && fs.statSync(file).size <= 2 * 1024 * 1024) {
          report = JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
      } catch {
        report = null;
      }
      let screenshots = [];
      try {
        const shotDir = path.join(dir, 'screenshots');
        screenshots = fs
          .readdirSync(shotDir)
          .filter((name) => name.endsWith('.png'))
          .slice(0, 20)
          .map((name) => `/projects/${projectId}/vision/${taskId}/screenshot/${name}`);
      } catch {
        screenshots = [];
      }
      sendJson(res, 200, { ok: true, task: publicTask(task), report, screenshots });
      return;
    }

    if (/^\/projects\/[a-z0-9-]+\/vision\/[a-zA-Z0-9_-]+\/screenshot\/[A-Za-z0-9._-]+\.png$/.test(pathname) && method === 'GET') {
      if (!requireAuth(req, res)) return;
      const parts = pathname.split('/');
      const projectId = parts[2];
      const taskId = parts[4];
      const name = parts[6];
      if (!projectAllowed(authState(req), projectId)) {
        sendJson(res, 403, { ok: false, error: 'device is not authorized for this project' });
        return;
      }
      const task = store.get(taskId);
      if (!task || task.kind !== 'vision' || (task.projectId || 'default') !== projectId) {
        sendJson(res, 404, { ok: false, error: 'vision task not found' });
        return;
      }
      const file = path.join(RUNTIME_ROOT, 'evidence', projectId, taskId, 'screenshots', name);
      const base = path.join(RUNTIME_ROOT, 'evidence', projectId, taskId, 'screenshots');
      if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) {
        sendJson(res, 404, { ok: false, error: 'screenshot not found' });
        return;
      }
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
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
      if (!projectAllowed(authState(req), projectId)) {
        sendJson(res, 403, { ok: false, error: 'device is not authorized for this project' });
        return;
      }
      try {
        const detail = projects.get(projectId);
        if (rest[1] === 'diff') {
          const from = Number(params.get('from'));
          const toParam = params.get('to');
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

    if (pathname.startsWith('/projects/') && pathname.endsWith('/vision') && method === 'POST') {
      if (!requireAuth(req, res)) return;
      if (!projects) {
        sendJson(res, 404, { ok: false, error: 'projects mode is not enabled' });
        return;
      }
      const projectId = pathname.split('/')[2];
      const auth = authState(req);
      if (!projectAllowed(auth, projectId)) {
        sendJson(res, 403, { ok: false, error: 'device is not authorized for this project' });
        return;
      }
      const raw = await readBody(req);
      if (raw === null) return;
      let payload = {};
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be valid JSON' });
        return;
      }
      const mode = ['analyze', 'verify', 'repair'].includes(payload.mode)
        ? payload.mode
        : 'analyze';
      const allowedFiles = (Array.isArray(payload.allowedFiles) ? payload.allowedFiles : [])
        .filter((item) => typeof item === 'string' && /\.(html?|css)$/i.test(item))
        .slice(0, 5);
      try {
        const { task, duplicate } = store.create({
          text: `Vision ${mode} · ${projectId}`,
          idempotencyKey: payload.idempotencyKey,
          source: 'remote',
          projectId,
          kind: 'vision',
          visionMode: mode,
          allowedFiles,
          createdBy: (auth && auth.deviceId) || 'admin',
          allowYolo: false,
        });
        if (!duplicate) {
          eventStore.append({
            type: 'task.created',
            taskId: task.id,
            projectId,
            status: 'queued',
            data: { kind: 'vision', mode },
          });
        }
        sendJson(res, duplicate ? 200 : 202, {
          ok: true,
          duplicate,
          task: publicTask(task),
          poll: `/projects/${projectId}/vision/${task.id}`,
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
        console.error(`[remote] vision task create failed: ${error.message}`);
        sendJson(res, 500, { ok: false, error: 'failed to create vision task' });
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
      if (!projectAllowed(authState(req), projectId)) {
        sendJson(res, 403, { ok: false, error: 'device is not authorized for this project' });
        return;
      }
      const active = store.activeTask();
      if (active && (active.projectId || 'default') === projectId) {
        sendJson(res, 409, {
          ok: false,
          error: 'task is running for this project; rollback is not allowed',
          taskId: active.id,
        });
        return;
      }
      // C07 ORD-15：任何持有项目锁的写入方（含 Vision）都应阻止回退
      if (projects.readLock(projectId)) {
        sendJson(res, 409, {
          ok: false,
          error: 'project is locked by another writer; rollback is not allowed',
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
        const result = await projects.rollback(projectId, seq);
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

// NEW-01：畸形请求只影响当前连接/请求，不让进程崩溃
server.on('clientError', (error, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  } catch {
    // 忽略
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

// NEW-02：上次回退中途崩溃时，用 journal 指向的备份还原工作区
if (projects) {
  try {
    const quarantined = projects.recoverOrphanSnapshots();
    if (quarantined.length > 0) {
      console.log(`[remote] orphan snapshots quarantined: ${JSON.stringify(quarantined)}`);
    }
    const recoveredRollbacks = projects.recoverInterruptedRollbacks();
    if (recoveredRollbacks.length > 0) {
      console.log(
        `[remote] rollback recovery: ${JSON.stringify(recoveredRollbacks)}`,
      );
    }
  } catch (error) {
    console.error(`[remote] recovery failed: ${error.message}`);
  }
}

const recovered = store.recoverOnStartup();
if (recovered.length > 0) {
  console.log(
    `[remote] marked ${recovered.length} interrupted task(s) from a previous run: ${recovered.join(', ')}`,
  );
  for (const taskId of recovered) {
    const task = store.get(taskId);
    eventStore.append({
      type: 'task.interrupted',
      taskId,
      projectId: (task && task.projectId) || 'default',
      status: 'interrupted',
      data: { reason: 'service restarted while running' },
    });
  }
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

// C07 §2.2 / 方案 A：禁止 0.0.0.0 等通配监听；REMOTE_HOST 必须是本机已存在的地址
function isBindableHost(host) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host === '0.0.0.0' || host === '::') return false;
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const item of list || []) {
      if (item && item.address === host) return true;
    }
  }
  return false;
}

if (!isBindableHost(HOST)) {
  console.error(
    `[remote] refuse to start: REMOTE_HOST=${HOST} is wildcard or not a local interface address.\n` +
      '[remote] Bind 127.0.0.1 (Tailscale Serve mode) or a specific local/Tailscale IP.',
  );
  process.exit(1);
}

// C07-P0-02 / C09 B-07：测试后门不允许与任何对外暴露模式（Serve/代理/通配）共存
if (
  (process.env.REMOTE_ALLOW_TEST_SEAM === '1' || process.env.NODE_ENV === 'test') &&
  (PUBLIC_MODE || SERVE_MODE || !['127.0.0.1', 'localhost', '::1'].includes(HOST))
) {
  console.error(
    '[remote] refuse to start: test seam is loopback-only and forbidden in Serve/proxy/public mode; unset REMOTE_ALLOW_TEST_SEAM/REMOTE_EXECUTOR_CMD for networked runs.',
  );
  process.exit(1);
}
if (process.env.VPLAY_ALLOW_YOLO === '1' && PUBLIC_MODE) {
  console.warn('[remote] VPLAY_ALLOW_YOLO=1 ignored: public/Serve mode forces controlled approval.');
}
if (process.env.REMOTE_ALLOW_TEST_SEAM === '1') {
  console.warn('[remote] WARNING: test seam enabled (loopback only). Never use for acceptance or production.');
}

// B10：上次 Vision 写入中断时，复核 journal（不自动改写源码，交给快照与人工）
try {
  const journals = recoverVisionApplies({
    home: projects ? RUNTIME_ROOT : RUNTIME_DIR,
    logger: (line) => console.log(line),
  });
  if (journals.length > 0) {
    console.log(`[remote] vision apply journals reviewed: ${JSON.stringify(journals)}`);
  }
} catch (error) {
  console.error(`[remote] vision journal recovery failed: ${error.message}`);
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

// 异常边界：未捕获错误记录后优雅退出，避免进程处于半死状态
process.on('uncaughtException', (error) => {
  console.error(`[remote] uncaught exception: ${error && error.stack ? error.stack : error}`);
  try {
    fs.rmSync(SERVER_LOCK, { force: true });
  } catch {
    // 忽略
  }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[remote] unhandled rejection: ${reason}`);
});

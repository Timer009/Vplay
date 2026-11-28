'use strict';

/**
 * Durable task store for the Vplay remote bridge.
 *
 * Everything lives under <workspace>/.opengame/remote/:
 *   tasks.json          task records (atomic replace)
 *   logs/<taskId>.log   captured CLI output per task
 *
 * The store is intentionally synchronous and single-process: the HTTP server
 * and the serial worker share one instance.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TASK_STATUSES = [
  'awaiting_approval',
  'queued',
  'running',
  'verifying',
  'succeeded',
  'failed',
  'interrupted',
  'rejected',
];

const ACTIVE_STATUSES = new Set(['running', 'verifying']);

/** Allowed state transitions. Anything else is a bug and throws. */
const TRANSITIONS = {
  awaiting_approval: ['queued', 'rejected'],
  queued: ['running', 'failed', 'interrupted'],
  running: ['verifying', 'succeeded', 'failed', 'interrupted'],
  verifying: ['succeeded', 'failed', 'interrupted'],
  succeeded: [],
  failed: [],
  interrupted: [],
  rejected: [],
};

const MAX_TEXT_LENGTH = 4000;
const MAX_TASKS = 200;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
// B22：任务 id / 项目 id 是文件路径的一部分，必须严格限制字符集。
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

class DuplicateTaskError extends Error {
  constructor(existing) {
    super(`an identical task is already ${existing.status}: ${existing.id}`);
    this.name = 'DuplicateTaskError';
    this.statusCode = 409;
    this.existing = existing;
  }
}

/**
 * B11 / C10-03：idempotencyKey 只在 (createdBy, projectId) 作用域内去重。
 * 跨用户/跨项目复用同一个 key 属于冲突，必须拒绝且不泄漏已有任务。
 */
class IdempotencyConflictError extends Error {
  constructor() {
    super('idempotencyKey is already used in another user/project scope');
    this.name = 'IdempotencyConflictError';
    this.statusCode = 409;
    this.code = 'IDEMPOTENCY_CONFLICT';
  }
}

function normalizeText(raw) {
  if (typeof raw !== 'string') {
    throw new ValidationError('"text" must be a string');
  }
  // Normalise newlines, reject NUL and other control characters that could
  // confuse logs or argv handling. Tab/newline/CR are allowed.
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) {
    throw new ValidationError('"text" must not be empty');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(
      `"text" is too long (${text.length} > ${MAX_TEXT_LENGTH} characters)`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new ValidationError('"text" contains unsupported control characters');
  }
  return text;
}

function normalizeIdempotencyKey(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new ValidationError(
      '"idempotencyKey" must be 1-128 chars of [A-Za-z0-9._:-]',
    );
  }
  return raw;
}

function compactText(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function newTaskId() {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `task_${stamp}_${rand}`;
}

function createTaskStore(options) {
  const runtimeDir = path.resolve(options.runtimeDir);
  const remoteDir = path.join(runtimeDir, 'remote');
  const logsDir = path.join(remoteDir, 'logs');
  const tasksFile = path.join(remoteDir, 'tasks.json');
  const logsPrefix = path
    .relative(runtimeDir, logsDir)
    .split(path.sep)
    .join('/');
  const redactSecrets = (options.redactSecrets || []).filter(
    (secret) => typeof secret === 'string' && secret.length >= 6,
  );
  const maxLogBytes = Number(options.maxLogBytes || 5 * 1024 * 1024);
  const logSizes = new Map();
  const truncated = new Set();

  fs.mkdirSync(logsDir, { recursive: true });

  /** 日志脱敏（P0-4）：Token / API Key / Session 一律替换为 ***。 */
  function redact(text) {
    let out = String(text);
    for (const secret of redactSecrets) {
      out = out.split(secret).join('***');
      try {
        out = out.split(encodeURIComponent(secret)).join('***');
      } catch {
        // 非法编码忽略
      }
    }
    out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
    out = out.replace(
      /((?:OPENAI|GEMINI|QWEN|QWEN_VL|DASHSCOPE|ANTHROPIC|DEEPSEEK|VISION|VPLAY_VISION|VPLAY_TEXT)_API_KEY\s*[=:]\s*)\S+/gi,
      '$1***',
    );
    out = out.replace(/(REMOTE_TOKEN(?:_FILE)?\s*[=:]\s*)\S+/gi, '$1***');
    out = out.replace(/(Authorization\s*:\s*Bearer\s+)\S+/gi, '$1***');
    out = out.replace(/vplay_session=[^;\s"']+/g, 'vplay_session=***');
    return out;
  }

  let tasks = load();

  /** 服务端派生的唯一合法日志路径；不信任 tasks.json 中保存的值。 */
  function expectedLogPath(id) {
    return `.opengame/${logsPrefix}/${id}.log`;
  }

  /**
   * B22：tasks.json 可能被同机进程改写。加载时只接受结构合法、字符集受限、
   * 状态合法的记录；logPath 一律重算，杜绝 `../` 越界写。
   */
  function sanitizeLoaded(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!TASK_ID_PATTERN.test(id)) return null;
    if (!TASK_STATUSES.includes(raw.status)) return null;
    if (typeof raw.text !== 'string') return null;
    const task = { ...raw };
    task.id = id;
    task.text = raw.text;
    task.projectId =
      typeof raw.projectId === 'string' && PROJECT_ID_PATTERN.test(raw.projectId)
        ? raw.projectId
        : 'default';
    task.kind = ['vision', 'code_change'].includes(raw.kind) ? raw.kind : 'prompt';
    task.restricted = raw.restricted === true || task.kind === 'code_change';
    task.allowYolo = task.restricted ? false : raw.allowYolo === true;
    task.logPath = expectedLogPath(id);
    if (!raw.approval || typeof raw.approval !== 'object') {
      task.approval = task.restricted
        ? { state: 'pending', approvedAt: null, approvedBy: null, rejectedAt: null }
        : null;
    }
    if (!task.codeChange || typeof task.codeChange !== 'object') task.codeChange = null;
    return task;
  }

  function load() {
    try {
      const raw = fs.readFileSync(tasksFile, 'utf-8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.tasks)) return [];
      return parsed.tasks.map(sanitizeLoaded).filter(Boolean);
    } catch {
      return [];
    }
  }

  function persist() {
    // Keep the newest MAX_TASKS records; never drop an active task.
    if (tasks.length > MAX_TASKS) {
      const keep = tasks.slice(-MAX_TASKS);
      const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
      const merged = [...new Set([...active, ...keep])].sort((a, b) =>
        String(a.createdAt).localeCompare(String(b.createdAt)),
      );
      tasks = merged.slice(-MAX_TASKS);
    }
    const tmp = `${tasksFile}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, tasks }, null, 2),
      'utf-8',
    );
    fs.renameSync(tmp, tasksFile);
  }

  function list() {
    return tasks.map((task) => ({ ...task }));
  }

  function get(id) {
    const found = tasks.find((task) => task.id === id);
    return found ? { ...found } : null;
  }

  function activeTask() {
    return tasks.find((task) => ACTIVE_STATUSES.has(task.status)) || null;
  }

  /**
   * Create a task. Two layers of duplicate protection:
   *  1. Same idempotencyKey -> return the existing task (HTTP 200, duplicate=true).
   *  2. Same normalised text already queued/running -> throw DuplicateTaskError.
   */
  function create(input) {
    const text = normalizeText(input && input.text);
    const idempotencyKey = normalizeIdempotencyKey(
      input && input.idempotencyKey,
    );
    const projectId =
      typeof (input && input.projectId) === 'string' && input.projectId
        ? input.projectId
        : 'default';
    const createdBy = (input && input.createdBy) || 'admin';

    if (idempotencyKey) {
      const byKey = tasks.find((task) => task.idempotencyKey === idempotencyKey);
      if (byKey) {
        const sameScope =
          (byKey.createdBy || 'admin') === createdBy &&
          (byKey.projectId || 'default') === projectId;
        if (sameScope) return { task: { ...byKey }, duplicate: true };
        throw new IdempotencyConflictError();
      }
    }

    const fingerprint = compactText(text);
    const sameText = tasks.find(
      (task) =>
        (task.status === 'queued' ||
          task.status === 'running' ||
          task.status === 'awaiting_approval') &&
        (task.projectId || 'default') === projectId &&
        compactText(task.text || '') === fingerprint,
    );
    if (sameText) throw new DuplicateTaskError(sameText);

    const now = new Date().toISOString();
    const id = newTaskId();
    const kind =
      input && ['vision', 'code_change'].includes(input.kind) ? input.kind : 'prompt';
    const restricted = Boolean(input && input.restricted === true) || kind === 'code_change';
    const task = {
      id,
      projectId,
      text,
      idempotencyKey,
      source: (input && input.source) || 'remote',
      kind,
      visionMode:
        input && ['analyze', 'verify', 'repair'].includes(input.visionMode)
          ? input.visionMode
          : 'analyze',
      allowedFiles:
        input && Array.isArray(input.allowedFiles)
          ? input.allowedFiles
              .filter((item) => typeof item === 'string' && /\.(html?|css)$/i.test(item))
              .slice(0, 5)
          : null,
      defectId:
        input && typeof input.defectId === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(input.defectId)
          ? input.defectId
          : null,
      defectAssertionIds:
        input && Array.isArray(input.defectAssertionIds)
          ? input.defectAssertionIds
              .filter((item) => typeof item === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(item))
              .slice(0, 10)
          : null,
      codeChange:
        kind === 'code_change' && input && input.codeChange && typeof input.codeChange === 'object'
          ? input.codeChange
          : null,
      createdBy,
      allowYolo: restricted ? false : Boolean(input && input.allowYolo === true),
      restricted,
      approval: restricted
        ? { state: 'pending', approvedAt: null, approvedBy: null, rejectedAt: null }
        : null,
      status: restricted ? 'awaiting_approval' : 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      pid: null,
      logPath: expectedLogPath(id),
      error: null,
      result: null,
    };
    tasks.push(task);
    persist();
    return { task: { ...task }, duplicate: false };
  }

  /**
   * Move a task to the next state. Invalid transitions throw, which surfaces
   * programming errors instead of silently corrupting task history.
   */
  function transition(id, next, patch) {
    const task = tasks.find((item) => item.id === id);
    if (!task) throw new Error(`unknown task: ${id}`);
    if (!TASK_STATUSES.includes(next)) {
      throw new Error(`unknown task status: ${next}`);
    }
    const allowed = TRANSITIONS[task.status] || [];
    if (!allowed.includes(next)) {
      throw new Error(`illegal transition ${task.status} -> ${next} (${id})`);
    }
    task.status = next;
    task.updatedAt = new Date().toISOString();
    if (patch && typeof patch === 'object') Object.assign(task, patch);
    if (next === 'failed' || next === 'interrupted' || next === 'succeeded' || next === 'rejected') {
      task.finishedAt = task.updatedAt;
    }
    persist();
    return { ...task };
  }

  /**
   * B22：受控更新（审批消费 runs、code_change 结果等）。仅供服务端内部使用；
   * 不经过状态机，但保留 updatedAt 并原子持久化。
   */
  function patch(id, fields) {
    const task = tasks.find((item) => item.id === id);
    if (!task) throw new Error(`unknown task: ${id}`);
    if (fields && typeof fields === 'object') Object.assign(task, fields);
    task.updatedAt = new Date().toISOString();
    persist();
    return { ...task };
  }

  /**
   * Startup recovery: tasks caught mid-flight are marked interrupted and are
   * NEVER resumed automatically. Queued tasks were never executed, so they stay
   * queued and will run in order.
   */
  function recoverOnStartup(reason) {
    const message =
      reason || 'service restarted while the task was running; not retried';
    const recovered = [];
    for (const task of tasks) {
      if (!ACTIVE_STATUSES.has(task.status)) continue;
      const previous = task.status;
      task.status = 'interrupted';
      task.updatedAt = new Date().toISOString();
      task.finishedAt = task.updatedAt;
      task.pid = null;
      task.error = {
        code: 'INTERRUPTED',
        message: `${message} (was ${previous})`,
      };
      recovered.push(task.id);
    }
    if (recovered.length > 0) persist();
    return recovered;
  }

  function appendLog(id, chunk) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    // B22：永远使用派生路径，忽略可能被篡改的 task.logPath。
    const file = path.resolve(options.workspaceDir, expectedLogPath(task.id));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let size = logSizes.get(id);
      if (size === undefined) {
        try {
          size = fs.statSync(file).size;
        } catch {
          size = 0;
        }
      }
      if (size >= maxLogBytes) {
        if (!truncated.has(id)) {
          truncated.add(id);
          fs.appendFileSync(file, '\n[remote] log limit reached (5 MB), further output dropped\n');
        }
        return;
      }
      let text = redact(chunk);
      const remaining = maxLogBytes - size;
      if (Buffer.byteLength(text, 'utf-8') > remaining) {
        text = `${text.slice(0, Math.max(0, remaining))}\n[remote] log truncated at 5 MB\n`;
        truncated.add(id);
      }
      fs.appendFileSync(file, text, 'utf-8');
      logSizes.set(id, size + Buffer.byteLength(text, 'utf-8'));
    } catch {
      // Logging must never break task execution.
    }
  }

  function readLog(id, maxBytes = 8000) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return null;
    const file = path.resolve(options.workspaceDir, expectedLogPath(task.id));
    try {
      const stat = fs.statSync(file);
      if (stat.size <= maxBytes) {
        return fs.readFileSync(file, 'utf-8');
      }
      // 只读尾部，避免把 5 MB 日志整块读进内存
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
        return buffer.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  function nextQueued() {
    return tasks.find((task) => task.status === 'queued') || null;
  }

  return {
    runtimeDir,
    remoteDir,
    tasksFile,
    list,
    get,
    activeTask,
    create,
    transition,
    patch,
    recoverOnStartup,
    appendLog,
    readLog,
    nextQueued,
  };
}

module.exports = {
  createTaskStore,
  normalizeText,
  normalizeIdempotencyKey,
  ValidationError,
  DuplicateTaskError,
  IdempotencyConflictError,
  TASK_STATUSES,
  MAX_TEXT_LENGTH,
};

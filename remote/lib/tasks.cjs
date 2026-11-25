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
  'queued',
  'running',
  'verifying',
  'succeeded',
  'failed',
  'interrupted',
];

const ACTIVE_STATUSES = new Set(['running', 'verifying']);

/** Allowed state transitions. Anything else is a bug and throws. */
const TRANSITIONS = {
  queued: ['running', 'failed', 'interrupted'],
  running: ['verifying', 'succeeded', 'failed', 'interrupted'],
  verifying: ['succeeded', 'failed', 'interrupted'],
  succeeded: [],
  failed: [],
  interrupted: [],
};

const MAX_TEXT_LENGTH = 4000;
const MAX_TASKS = 200;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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

  fs.mkdirSync(logsDir, { recursive: true });

  let tasks = load();

  function load() {
    try {
      const raw = fs.readFileSync(tasksFile, 'utf-8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.tasks)) return [];
      return parsed.tasks.filter((task) => task && typeof task.id === 'string');
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

    if (idempotencyKey) {
      const byKey = tasks.find(
        (task) => task.idempotencyKey === idempotencyKey,
      );
      if (byKey) return { task: { ...byKey }, duplicate: true };
    }

    const fingerprint = compactText(text);
    const sameText = tasks.find(
      (task) =>
        (task.status === 'queued' || task.status === 'running') &&
        compactText(task.text || '') === fingerprint,
    );
    if (sameText) throw new DuplicateTaskError(sameText);

    const now = new Date().toISOString();
    const id = newTaskId();
    const task = {
      id,
      text,
      idempotencyKey,
      source: (input && input.source) || 'remote',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      pid: null,
      logPath: `.opengame/${logsPrefix}/${id}.log`,
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
    if (next === 'failed' || next === 'interrupted' || next === 'succeeded') {
      task.finishedAt = task.updatedAt;
    }
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
    const file = path.resolve(options.workspaceDir, task.logPath);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, chunk, 'utf-8');
    } catch {
      // Logging must never break task execution.
    }
  }

  function readLog(id, maxBytes = 8000) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return null;
    const file = path.resolve(options.workspaceDir, task.logPath);
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      return raw.length > maxBytes ? raw.slice(-maxBytes) : raw;
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
  TASK_STATUSES,
  MAX_TEXT_LENGTH,
};

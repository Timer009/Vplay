'use strict';

/**
 * B23 P0：control ↔ agent 受限 IPC 协议（不依赖测试后门）。
 *
 * 传输：Unix domain socket（Linux）或命名管道（Windows 测试）。
 * 帧：一行一个 JSON；每条消息带 v/type/nonce/ts/hmac。
 * 身份：
 *  - 文件系统层：socket 目录 0750、socket 0660，仅 control 组可连（systemd SocketMode）；
 *  - 消息层：独立 `VPLAY_IPC_HMAC_KEY`（≠ 审批密钥）+ 时间窗 + nonce/runId 防重放。
 * Node 核心不暴露 SO_PEERCRED，因此 UID 级对端校验由 socket 权限 + systemd 单元
 * 保证；需要 SO_PEERCRED 时由 Harness 的小型 native shim 补充（见文档 §6）。
 */

const crypto = require('crypto');
const { canonicalJson, sha256Hex } = require('./approval.cjs');

const IPC_VERSION = 1;
const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_ENV_BYTES = 16 * 1024;
const MAX_PROMPT_CHARS = 6000;
const MAX_SKEW_MS = 60 * 1000;
const MAX_DEADLINE_MS = 60 * 60 * 1000;
const MIN_DEADLINE_MS = 1000;

const RUN_ENV_ALLOW = new Set([
  'PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'NODE_ENV',
  'SHELL',
  'TERM',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
]);

const RUN_ENV_DENY_PREFIX = ['APPROVAL_', 'EVIDENCE_', 'REMOTE_', 'VPLAY_'];

class IpcError extends Error {
  constructor(message, code = 'IPC_ERROR') {
    super(message);
    this.name = 'IpcError';
    this.code = code;
  }
}

function signEnvelope(message, key) {
  if (!key) throw new IpcError('IPC key is not configured', 'IPC_KEY_MISSING');
  const body = { ...message };
  delete body.hmac;
  return crypto.createHmac('sha256', key).update(canonicalJson(body)).digest('hex');
}

function verifyEnvelope(message, key, options = {}) {
  if (!message || typeof message !== 'object') {
    return { ok: false, reason: 'IPC_MESSAGE_INVALID' };
  }
  if (message.v !== IPC_VERSION) return { ok: false, reason: 'IPC_VERSION_UNSUPPORTED' };
  if (typeof message.type !== 'string' || !message.type) {
    return { ok: false, reason: 'IPC_TYPE_INVALID' };
  }
  if (typeof message.nonce !== 'string' || !/^[a-f0-9]{16,64}$/.test(message.nonce)) {
    return { ok: false, reason: 'IPC_NONCE_INVALID' };
  }
  const ts = Number(message.ts);
  const now = Number(options.now || Date.now());
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) {
    return { ok: false, reason: 'IPC_TS_INVALID' };
  }
  if (!key) return { ok: false, reason: 'IPC_KEY_MISSING' };
  const expected = signEnvelope(message, key);
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(String(message.hmac || ''), 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return { ok: false, reason: 'IPC_HMAC_INVALID' };
  }
  if (options.seenNonces && options.seenNonces.has(message.nonce)) {
    return { ok: false, reason: 'IPC_NONCE_REPLAYED' };
  }
  return { ok: true };
}

function baseEnvelope(type, key, extra = {}) {
  const message = {
    v: IPC_VERSION,
    type,
    nonce: crypto.randomBytes(16).toString('hex'),
    ts: Date.now(),
    ...extra,
  };
  message.hmac = signEnvelope(message, key);
  return message;
}

function runPayloadHash(taskId, runId, prompt) {
  return sha256Hex([String(taskId), String(runId), String(prompt)].join('\n'));
}

function assertSafeToken(value, pattern, label, code = 'IPC_FIELD_INVALID') {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new IpcError(`invalid ${label}`, code);
  }
  return value;
}

/** 校验并裁剪 control 传入的受限运行环境；任何审批/证据/控制面变量一律拒绝。 */
function sanitizeRunEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new IpcError('env must be an object', 'IPC_ENV_INVALID');
  }
  const out = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(env)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new IpcError(`env ${key} must be a string`, 'IPC_ENV_INVALID');
    }
    if (RUN_ENV_DENY_PREFIX.some((prefix) => key.startsWith(prefix))) {
      throw new IpcError(`env ${key} is forbidden`, 'IPC_ENV_FORBIDDEN');
    }
    if (!RUN_ENV_ALLOW.has(key)) {
      throw new IpcError(`env ${key} is not in the allowlist`, 'IPC_ENV_FORBIDDEN');
    }
    if (/[\u0000]/.test(value)) throw new IpcError(`env ${key} contains NUL`, 'IPC_ENV_INVALID');
    bytes += Buffer.byteLength(`${key}=${value}\0`, 'utf8');
    out[key] = value;
  }
  if (bytes > MAX_ENV_BYTES) throw new IpcError('env is too large', 'IPC_ENV_TOO_LARGE');
  const baseUrl = out.OPENAI_BASE_URL;
  if (baseUrl) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new IpcError('OPENAI_BASE_URL is invalid', 'IPC_ENV_INVALID');
    }
    const host = parsed.hostname.toLowerCase();
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      !['127.0.0.1', 'localhost', '::1'].includes(host)
    ) {
      throw new IpcError('OPENAI_BASE_URL must be loopback', 'IPC_ENV_INVALID');
    }
  }
  return out;
}

/** 校验 run 请求；调用方负责 HMAC 与重放检查。 */
function validateRunRequest(message, options = {}) {
  const allowedRoot = options.allowedRoot ? require('path').resolve(options.allowedRoot) : null;
  const path = require('path');
  assertSafeToken(message.runId, /^[A-Za-z0-9._:-]{1,80}$/, 'runId');
  assertSafeToken(message.taskId, /^[A-Za-z0-9_-]{1,80}$/, 'taskId');
  if (message.restricted !== true) {
    throw new IpcError('agent only accepts restricted tasks', 'RESTRICTED_REQUIRED');
  }
  if (typeof message.prompt !== 'string' || !message.prompt.trim()) {
    throw new IpcError('prompt is required', 'IPC_FIELD_INVALID');
  }
  if (message.prompt.length > MAX_PROMPT_CHARS) {
    throw new IpcError('prompt is too long', 'IPC_FIELD_INVALID');
  }
  if (message.payloadHash !== runPayloadHash(message.taskId, message.runId, message.prompt)) {
    throw new IpcError('payload hash mismatch', 'IPC_PAYLOAD_MISMATCH');
  }
  if (typeof message.cwd !== 'string' || !path.isAbsolute(message.cwd)) {
    throw new IpcError('cwd must be absolute', 'IPC_FIELD_INVALID');
  }
  const cwd = path.resolve(message.cwd);
  if (allowedRoot && cwd !== allowedRoot && !cwd.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new IpcError('cwd escapes the agent workspace root', 'IPC_CWD_ESCAPE');
  }
  const deadlineMs = Number(message.deadlineMs);
  if (!Number.isFinite(deadlineMs) || deadlineMs < MIN_DEADLINE_MS || deadlineMs > MAX_DEADLINE_MS) {
    throw new IpcError('deadlineMs is out of range', 'IPC_FIELD_INVALID');
  }
  if (message.approvalDigest !== null && message.approvalDigest !== undefined) {
    assertSafeToken(message.approvalDigest, /^[a-f0-9]{64}$/, 'approvalDigest');
  }
  return {
    runId: message.runId,
    taskId: message.taskId,
    prompt: message.prompt,
    cwd,
    deadlineMs,
    env: sanitizeRunEnv(message.env),
    model: typeof message.model === 'string' ? message.model.slice(0, 120) : null,
    approvalDigest: message.approvalDigest || null,
  };
}

function encodeFrame(message) {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new IpcError('message too large', 'IPC_MESSAGE_TOO_LARGE');
  }
  return `${text}\n`;
}

/** 增量分帧；单帧超限直接报错（防止内存耗尽）。 */
function createFrameReader(onMessage, onError) {
  let buffer = '';
  return function feed(chunk) {
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES * 2) {
      onError(new IpcError('frame buffer too large', 'IPC_MESSAGE_TOO_LARGE'));
      buffer = '';
      return;
    }
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          onMessage(JSON.parse(line));
        } catch (error) {
          onError(error instanceof IpcError ? error : new IpcError('invalid JSON frame', 'IPC_FRAME_INVALID'));
        }
      }
      index = buffer.indexOf('\n');
    }
  };
}

module.exports = {
  IPC_VERSION,
  IpcError,
  signEnvelope,
  verifyEnvelope,
  baseEnvelope,
  runPayloadHash,
  sanitizeRunEnv,
  validateRunRequest,
  encodeFrame,
  createFrameReader,
  MAX_MESSAGE_BYTES,
  MAX_DEADLINE_MS,
  MIN_DEADLINE_MS,
  RUN_ENV_ALLOW,
};

'use strict';

/**
 * B22 / C19 B21-5：审批记录防伪与绑定。
 *
 * - 审批由可信控制面用 HMAC 密钥签名；密钥只存在于服务端进程环境，
 *   buildChildEnv 会剥离 VPLAY_ 与 APPROVAL_ 前缀变量，Agent CLI 不可读。
 * - 签名覆盖：任务 id、项目、类型、模式、内容哈希、模型、基线版本、
 *   文件范围、有效期、执行次数上限与随机 nonce。
 * - worker 在 spawn 前验签并消费一次（runs+1 后重新签名），拒绝重放。
 * - tasks.json 被篡改（改文本/范围/scope/runs）都会导致验签失败。
 */

const crypto = require('crypto');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** 密钥必须显式配置且至少 32 字符；否则视为未配置（失败关闭）。 */
function resolveApprovalKey(env = process.env) {
  const raw = String(env.VPLAY_APPROVAL_HMAC_KEY || env.APPROVAL_HMAC_KEY || '').trim();
  return raw.length >= 32 ? raw : null;
}

function resolveApprovalModel(env = process.env) {
  return (
    String(env.VPLAY_APPROVAL_MODEL || env.OPENAI_MODEL || '').trim() ||
    'qwen3-coder-plus'
  );
}

/** 任务内容哈希：任何字段被改写都会改变哈希。 */
function taskContentHash(task) {
  const kind = (task && task.kind) || 'prompt';
  return sha256Hex(
    canonicalJson({
      id: task.id,
      projectId: task.projectId || 'default',
      text: task.text,
      kind,
      visionMode: kind === 'vision' ? task.visionMode || 'analyze' : null,
      allowedFiles: kind === 'vision' ? task.allowedFiles || [] : null,
      defectId: task.defectId || null,
      defectAssertionIds: task.defectAssertionIds || [],
      codeChange:
        kind === 'code_change' && task.codeChange
          ? {
              baseHash: task.codeChange.baseHash || null,
              diffSha256: task.codeChange.diffSha256 || null,
              files: (task.codeChange.files || []).map((file) => ({
                path: file.path,
                sha256: file.sha256,
              })),
            }
          : null,
    }),
  );
}

function buildApprovalPayload({
  task,
  now = Date.now(),
  ttlMs,
  maxRuns = 1,
  model = null,
  baseVersionId = null,
  runs = 0,
  nonce = crypto.randomBytes(12).toString('hex'),
}) {
  const ttl =
    ttlMs === undefined || ttlMs === null ? 30 * 60 * 1000 : Number(ttlMs);
  const expireMs = Number.isFinite(ttl) ? ttl : 30 * 60 * 1000;
  return {
    v: 1,
    alg: 'hmac-sha256',
    taskId: task.id,
    projectId: task.projectId || 'default',
    kind: task.kind || 'prompt',
    visionMode: task.kind === 'vision' ? task.visionMode || 'analyze' : null,
    allowedFiles:
      task.kind === 'vision' && Array.isArray(task.allowedFiles)
        ? [...task.allowedFiles]
        : null,
    contentHash: taskContentHash(task),
    model: model || null,
    baseVersionId: baseVersionId || null,
    codeChange:
      task.kind === 'code_change' && task.codeChange
        ? {
            baseHash: task.codeChange.baseHash || null,
            diffSha256: task.codeChange.diffSha256 || null,
            files: (task.codeChange.files || []).map((file) => ({
              path: file.path,
              sha256: file.sha256,
            })),
          }
        : null,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expireMs).toISOString(),
    maxRuns: Math.max(1, Math.min(10, Number(maxRuns) || 1)),
    runs: Math.max(0, Number(runs) || 0),
    nonce,
  };
}

function signApprovalPayload(payload, key) {
  if (!key) throw new Error('approval key is not configured');
  return crypto.createHmac('sha256', key).update(canonicalJson(payload)).digest('hex');
}

function buildProof(payload, key) {
  return {
    alg: 'hmac-sha256',
    keyId: sha256Hex(key).slice(0, 16),
    payload,
    signature: signApprovalPayload(payload, key),
  };
}

/** 创建审批证明（服务端 approve 时调用）。 */
function createApprovalProof({
  task,
  key,
  ttlMs,
  maxRuns = 1,
  model = null,
  baseVersionId = null,
  now = Date.now(),
}) {
  if (!key) throw new Error('approval key is not configured');
  const payload = buildApprovalPayload({
    task,
    now,
    ttlMs,
    maxRuns,
    model,
    baseVersionId,
  });
  return { ttlMs, proof: buildProof(payload, key) };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sameList(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * 验签 + 绑定校验。
 * context: { task, key, now, model, baseVersionId }
 */
function verifyApprovalProof(approval, context = {}) {
  const { task, key, now = Date.now(), model = null, baseVersionId = null } = context;
  if (!task) return { ok: false, reason: 'TASK_MISSING' };
  if (!approval || approval.state !== 'approved') {
    return { ok: false, reason: 'APPROVAL_REQUIRED' };
  }
  const proof = approval.proof;
  if (!proof || proof.alg !== 'hmac-sha256' || !proof.payload || !proof.signature) {
    return { ok: false, reason: 'APPROVAL_UNSIGNED' };
  }
  if (!key) return { ok: false, reason: 'APPROVAL_KEY_MISSING' };
  if (proof.keyId !== sha256Hex(key).slice(0, 16)) {
    return { ok: false, reason: 'APPROVAL_KEY_MISMATCH' };
  }
  const expected = signApprovalPayload(proof.payload, key);
  if (!safeEqual(expected, proof.signature)) {
    return { ok: false, reason: 'APPROVAL_SIGNATURE_INVALID' };
  }
  const payload = proof.payload;
  if (payload.v !== 1) return { ok: false, reason: 'APPROVAL_VERSION_UNSUPPORTED' };
  if (payload.taskId !== task.id) return { ok: false, reason: 'APPROVAL_TASK_MISMATCH' };
  if (payload.projectId !== (task.projectId || 'default')) {
    return { ok: false, reason: 'APPROVAL_PROJECT_MISMATCH' };
  }
  if (payload.kind !== ((task.kind || 'prompt'))) {
    return { ok: false, reason: 'APPROVAL_KIND_MISMATCH' };
  }
  if (payload.contentHash !== taskContentHash(task)) {
    return { ok: false, reason: 'APPROVAL_CONTENT_MISMATCH' };
  }
  const expectedMode = task.kind === 'vision' ? task.visionMode || 'analyze' : null;
  if (payload.visionMode !== expectedMode) {
    return { ok: false, reason: 'APPROVAL_MODE_MISMATCH' };
  }
  if (task.kind === 'vision' && !sameList(payload.allowedFiles, task.allowedFiles || [])) {
    return { ok: false, reason: 'APPROVAL_SCOPE_MISMATCH' };
  }
  if (payload.model !== (model || null)) {
    return { ok: false, reason: 'APPROVAL_MODEL_MISMATCH' };
  }
  if (payload.baseVersionId !== (baseVersionId || null)) {
    return { ok: false, reason: 'APPROVAL_BASE_MISMATCH' };
  }
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { ok: false, reason: 'APPROVAL_EXPIRED' };
  }
  if (!(Number(payload.runs) < Number(payload.maxRuns))) {
    return { ok: false, reason: 'APPROVAL_EXHAUSTED' };
  }
  if (task.kind === 'code_change' && task.codeChange) {
    const signed = payload.codeChange || {};
    if (
      signed.baseHash !== (task.codeChange.baseHash || null) ||
      signed.diffSha256 !== (task.codeChange.diffSha256 || null) ||
      canonicalJson(signed.files || []) !==
        canonicalJson(
          (task.codeChange.files || []).map((file) => ({
            path: file.path,
            sha256: file.sha256,
          })),
        )
    ) {
      return { ok: false, reason: 'APPROVAL_CODE_CHANGE_MISMATCH' };
    }
  }
  return { ok: true, payload };
}

/** 消费一次执行额度：runs+1 后用同一密钥重新签名。 */
function consumeApprovalProof(approval, key) {
  if (!key || !approval || !approval.proof) {
    throw new Error('approval proof is not signable');
  }
  const payload = {
    ...approval.proof.payload,
    runs: Number(approval.proof.payload.runs || 0) + 1,
  };
  const proof = buildProof(payload, key);
  return {
    ...approval,
    proof,
    consumedAt: new Date().toISOString(),
  };
}

module.exports = {
  canonicalJson,
  sha256Hex,
  resolveApprovalKey,
  resolveApprovalModel,
  taskContentHash,
  buildApprovalPayload,
  signApprovalPayload,
  createApprovalProof,
  verifyApprovalProof,
  consumeApprovalProof,
};

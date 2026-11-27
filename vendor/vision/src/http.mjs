/**
 * Minimal OpenAI-compatible HTTP client with explicit error taxonomy.
 *
 * Security:
 *  - non-loopback model endpoints must be HTTPS unless VPLAY_ALLOW_INSECURE_MODEL=1;
 *  - optional VPLAY_MODEL_ALLOWED_HOSTS allowlist;
 *  - response body is capped (default 8 MB) before parsing;
 *  - 401/403/402/429/quota are never retried automatically.
 */
import crypto from 'node:crypto';
import {
  VisionError,
  ERROR_CATEGORIES,
  classifyHttpStatus,
  classifyNetworkError,
  shouldRetry,
} from './errors.mjs';

export function joinChatCompletionsUrl(baseUrl) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
}

export function joinModelsUrl(baseUrl) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/models`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export function assertModelUrl(baseUrl, env = process.env) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new VisionError('model baseUrl is not a valid URL', { category: ERROR_CATEGORIES.CONFIG, code: 'INVALID_BASE_URL' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new VisionError('model baseUrl must be http(s)', { category: ERROR_CATEGORIES.CONFIG, code: 'INVALID_BASE_URL' });
  }
  const allowInsecure = env.VPLAY_ALLOW_INSECURE_MODEL === '1';
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname) && !allowInsecure) {
    throw new VisionError('model endpoint must use HTTPS (or VPLAY_ALLOW_INSECURE_MODEL=1 for local test)', {
      category: ERROR_CATEGORIES.CONFIG,
      code: 'INSECURE_MODEL_URL',
    });
  }
  const allowlist = String(env.VPLAY_MODEL_ALLOWED_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length && !allowlist.includes(parsed.hostname.toLowerCase())) {
    throw new VisionError(`model host is not in VPLAY_MODEL_ALLOWED_HOSTS: ${parsed.hostname}`, {
      category: ERROR_CATEGORIES.CONFIG,
      code: 'MODEL_HOST_NOT_ALLOWED',
    });
  }
  return parsed;
}

async function readTextLimited(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new VisionError(`model response exceeds ${maxBytes} bytes`, {
      category: ERROR_CATEGORIES.HTTP,
      code: 'RESPONSE_TOO_LARGE',
      status: response.status,
    });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength || 0;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new VisionError(`model response exceeds ${maxBytes} bytes`, {
          category: ERROR_CATEGORIES.HTTP,
          code: 'RESPONSE_TOO_LARGE',
          status: response.status,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

async function readJsonSafe(response, maxBytes) {
  const text = await readTextLimited(response, maxBytes);
  if (!text) return { payload: null, text: '' };
  try {
    return { payload: JSON.parse(text), text };
  } catch {
    return { payload: null, text };
  }
}

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.apiKey
 * @param {object} options.body
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.provider]
 * @param {{maxAttempts?:number,retryOn5xx?:boolean,retryOnRateLimit?:boolean,backoffMs?:number}} [options.retry]
 * @param {(info:object)=>void} [options.onAttempt]
 * @param {(info:object)=>void} [options.onRetry]
 * @param {{maxResponseBytes?:number}} [options.security]
 */
export async function postJson({
  baseUrl,
  apiKey,
  body,
  timeoutMs = 120000,
  fetchImpl = fetch,
  provider = 'provider',
  retry = {},
  onAttempt,
  onRetry,
  security = {},
}) {
  if (!baseUrl) throw new VisionError('baseUrl is required', { category: ERROR_CATEGORIES.CONFIG, code: 'CONFIG' });
  if (!apiKey) throw new VisionError('apiKey is required', { category: ERROR_CATEGORIES.CONFIG, code: 'CONFIG' });
  assertModelUrl(baseUrl);
  const maxResponseBytes = Number(security.maxResponseBytes || process.env.VPLAY_MODEL_MAX_RESPONSE_BYTES || 8 * 1024 * 1024);
  const maxAttempts = Math.max(1, Number(retry.maxAttempts) || 1);
  const retryOptions = {
    retryOn5xx: retry.retryOn5xx !== false,
    retryOnRateLimit: retry.retryOnRateLimit === true,
  };
  const backoffMs = Math.max(0, Number(retry.backoffMs) || 0);
  const requestId = crypto.randomUUID();
  const url = joinChatCompletionsUrl(baseUrl);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    const attemptInfo = { requestId, attempt, maxAttempts, provider, url };
    if (onAttempt) onAttempt(attemptInfo);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-Request-Id': requestId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = classifyNetworkError(error);
      lastError.requestId = requestId;
      lastError.provider = provider;
      lastError.details = { ...(lastError.details || {}), attempt };
      if (shouldRetry(lastError, retryOptions) && attempt < maxAttempts) {
        if (onRetry) onRetry({ error: lastError, attempt, maxAttempts, requestId });
        if (backoffMs) await sleep(backoffMs * attempt);
        continue;
      }
      throw lastError;
    }

    const { payload, text } = await readJsonSafe(response, maxResponseBytes);
    const responseId = response.headers?.get?.('x-request-id')
      || response.headers?.get?.('x-dashscope-request-id')
      || null;
    if (!response.ok) {
      lastError = classifyHttpStatus({
        status: response.status,
        payload,
        provider,
        requestId: responseId || requestId,
      });
      lastError.details = { ...(lastError.details || {}), attempt, requestId };
      if (shouldRetry(lastError, retryOptions) && attempt < maxAttempts) {
        if (onRetry) onRetry({ error: lastError, attempt, maxAttempts, requestId });
        if (backoffMs) await sleep(backoffMs * attempt);
        continue;
      }
      throw lastError;
    }
    if (!payload) {
      throw new VisionError('provider returned non-JSON or empty JSON response', {
        category: ERROR_CATEGORIES.INVALID_JSON,
        retryable: false,
        status: response.status,
        provider,
        requestId: responseId || requestId,
        rawContent: text.slice(0, 2000),
        details: { attempt },
      });
    }
    return {
      payload,
      requestId: responseId || requestId,
      localRequestId: requestId,
      status: response.status,
      latencyMs: Date.now() - started,
      attempts: attempt,
    };
  }
  throw lastError || new VisionError('request failed', { category: ERROR_CATEGORIES.UNKNOWN, code: 'UNKNOWN' });
}

/**
 * GET /models (metadata only; no model call). Used for diagnostics, never to
 * guess a model ID automatically.
 */
export async function getModels({
  baseUrl,
  apiKey,
  timeoutMs = 30000,
  fetchImpl = fetch,
  provider = 'provider',
  security = {},
}) {
  if (!baseUrl) throw new VisionError('baseUrl is required', { category: ERROR_CATEGORIES.CONFIG, code: 'CONFIG' });
  if (!apiKey) throw new VisionError('apiKey is required', { category: ERROR_CATEGORIES.CONFIG, code: 'CONFIG' });
  assertModelUrl(baseUrl);
  const maxResponseBytes = Number(security.maxResponseBytes || process.env.VPLAY_MODEL_MAX_RESPONSE_BYTES || 8 * 1024 * 1024);
  const requestId = crypto.randomUUID();
  const url = joinModelsUrl(baseUrl);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'X-Request-Id': requestId },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const { payload } = await readJsonSafe(response, maxResponseBytes);
    if (!response.ok) {
      throw classifyHttpStatus({ status: response.status, payload, provider, requestId });
    }
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    return {
      ok: true,
      status: response.status,
      endpoint: url,
      requestId,
      models: rows
        .map((row) => (typeof row === 'string' ? row : row?.id || row?.model || row?.name || ''))
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim()),
    };
  } catch (error) {
    if (error instanceof VisionError) throw error;
    throw classifyNetworkError(error);
  }
}

/**
 * Error taxonomy for model and browser failures.
 *
 * 401/403 are never retried automatically. Network/5xx may be retried once by
 * the HTTP client, within the caller's budget. Quota/rate-limit and truncated
 * output are surfaced explicitly so the host can decide (e.g. raise max tokens
 * once, or stop and ask the user).
 */
export const ERROR_CATEGORIES = Object.freeze({
  AUTH: 'auth',
  PERMISSION: 'permission',
  QUOTA: 'quota',
  RATE_LIMIT: 'rate_limit',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  SERVER: 'server',
  HTTP: 'http',
  INVALID_JSON: 'invalid_json',
  OUTPUT_TRUNCATED: 'output_truncated',
  SCHEMA: 'schema',
  EMPTY_RESPONSE: 'empty_response',
  BUDGET: 'budget',
  BROWSER: 'browser',
  CONFIG: 'config',
  UNKNOWN: 'unknown',
});

export class VisionError extends Error {
  constructor(message, {
    category = ERROR_CATEGORIES.UNKNOWN,
    retryable = false,
    status = null,
    code = null,
    requestId = null,
    provider = null,
    rawContent = null,
    finishReason = null,
    usage = null,
    details = null,
  } = {}) {
    super(message);
    this.name = 'VisionError';
    this.category = category;
    this.retryable = Boolean(retryable);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.provider = provider;
    this.rawContent = rawContent;
    this.finishReason = finishReason;
    this.usage = usage;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
      status: this.status,
      code: this.code,
      requestId: this.requestId,
      provider: this.provider,
      finishReason: this.finishReason,
      details: this.details,
    };
  }
}

function safeMessage(payload, fallback) {
  const value = payload?.error?.message || payload?.message || payload?.error || payload?.code;
  return String(value || fallback || '').slice(0, 400);
}

function providerCode(payload) {
  return String(payload?.error?.code || payload?.code || payload?.error?.type || '').slice(0, 120);
}

/**
 * Classify a non-2xx HTTP response. The body is already parsed JSON (or null).
 */
export function classifyHttpStatus({ status, payload = null, provider = '', requestId = null }) {
  const code = providerCode(payload);
  const text = safeMessage(payload, `HTTP ${status}`);
  const lower = `${code} ${text}`.toLowerCase();
  const base = { status, code: code || `HTTP_${status}`, provider, requestId, details: payload ? { providerCode: code } : null };

  if (status === 401) {
    return new VisionError(`authentication failed (401): ${text}`, { ...base, category: ERROR_CATEGORIES.AUTH, retryable: false });
  }
  if (status === 403) {
    return new VisionError(`permission denied (403): ${text}`, { ...base, category: ERROR_CATEGORIES.PERMISSION, retryable: false });
  }
  if (status === 402) {
    return new VisionError(`quota/billing blocked (402): ${text}`, { ...base, category: ERROR_CATEGORIES.QUOTA, retryable: false });
  }
  if (status === 429) {
    const quotaLike = /quota|insufficient|arrears|allocation|limit exceeded|exceeded your current/.test(lower);
    const category = quotaLike ? ERROR_CATEGORIES.QUOTA : ERROR_CATEGORIES.RATE_LIMIT;
    return new VisionError(`${category} (429): ${text}`, { ...base, category, retryable: false });
  }
  if (status === 408 || status === 504) {
    return new VisionError(`timeout (${status}): ${text}`, { ...base, category: ERROR_CATEGORIES.TIMEOUT, retryable: false });
  }
  if (status >= 500) {
    return new VisionError(`server error (${status}): ${text}`, { ...base, category: ERROR_CATEGORIES.SERVER, retryable: true });
  }
  return new VisionError(`http error (${status}): ${text}`, { ...base, category: ERROR_CATEGORIES.HTTP, retryable: false });
}

export function classifyNetworkError(error) {
  const name = error?.name || 'Error';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new VisionError(`request aborted/timeout: ${name}`, {
      category: ERROR_CATEGORIES.TIMEOUT,
      retryable: false,
      code: name,
    });
  }
  return new VisionError(`network error: ${name}`, {
    category: ERROR_CATEGORIES.NETWORK,
    retryable: true,
    code: name,
  });
}

/**
 * Classify a successful HTTP response whose content cannot be used.
 */
export function classifyOutput({ finishReason, error, schemaErrors, rawContent, usage, provider }) {
  const base = { finishReason, rawContent, usage, provider };
  if (finishReason === 'length') {
    return new VisionError('model output was truncated (finish_reason=length); raise maxOutputTokens and retry explicitly', {
      ...base,
      category: ERROR_CATEGORIES.OUTPUT_TRUNCATED,
      retryable: false,
      code: 'FINISH_LENGTH',
    });
  }
  if (schemaErrors?.length) {
    return new VisionError(`structured output failed schema validation: ${schemaErrors.join('; ')}`, {
      ...base,
      category: ERROR_CATEGORIES.SCHEMA,
      retryable: false,
      code: 'SCHEMA_INVALID',
      details: { schemaErrors },
    });
  }
  return new VisionError(`invalid model JSON: ${error?.message || 'parse failed'}`, {
    ...base,
    category: ERROR_CATEGORIES.INVALID_JSON,
    retryable: false,
    code: 'INVALID_JSON',
  });
}

export function shouldRetry(error, { retryOn5xx = true, retryOnRateLimit = false } = {}) {
  if (!error || !error.retryable) return false;
  if (error.category === ERROR_CATEGORIES.SERVER) return Boolean(retryOn5xx);
  if (error.category === ERROR_CATEGORIES.RATE_LIMIT) return Boolean(retryOnRateLimit);
  return error.category === ERROR_CATEGORIES.NETWORK;
}

export function errorCategoryOf(error) {
  return error?.category || ERROR_CATEGORIES.UNKNOWN;
}

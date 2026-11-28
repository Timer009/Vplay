/**
 * Configuration for the portable Vplay vision package.
 *
 * Defaults are the models verified in E02:
 *   vision: qwen4-max on the China OpenAI-compatible endpoint
 *   text:   deepseek-v4-flash on api.deepseek.com
 *
 * Every value can be overridden. Keys come only from the environment or an
 * explicit `overrides` object supplied by the host; they are never placed in
 * the browser config.
 */
export const VERIFIED_DEFAULTS = Object.freeze({
  vision: {
    provider: 'qwen',
    model: 'qwen4-max',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    verifiedAt: '2026-11-26',
  },
  text: {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    verifiedAt: '2026-11-26',
  },
});

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value));
}

function visionKey(env) {
  return env.VPLAY_VISION_API_KEY || env.VISION_API_KEY || env.DASHSCOPE_API_KEY || env.QWEN_VL_API_KEY || '';
}

function textKey(env) {
  if (env.VPLAY_TEXT_API_KEY || env.TEXT_API_KEY) return env.VPLAY_TEXT_API_KEY || env.TEXT_API_KEY;
  if (env.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY;
  // Reuse OpenGame's reasoning key only when it points at DeepSeek.
  const base = env.OPENGAME_REASONING_BASE_URL || '';
  if (env.OPENGAME_REASONING_API_KEY && /(^|\/\/|\.)api\.deepseek\.com/i.test(base)) {
    return env.OPENGAME_REASONING_API_KEY;
  }
  return '';
}

export function loadConfig(env = process.env, overrides = {}) {
  const v = overrides.vision || {};
  const t = overrides.text || {};
  const b = overrides.budget || {};
  const r = overrides.retry || {};
  const br = overrides.browser || {};

  const vision = {
    provider: v.provider || env.VPLAY_VISION_PROVIDER || VERIFIED_DEFAULTS.vision.provider,
    model: v.model || env.VPLAY_VISION_MODEL || env.VISION_MODEL || VERIFIED_DEFAULTS.vision.model,
    baseUrl: trimSlash(v.baseUrl || env.VPLAY_VISION_BASE_URL || env.VISION_BASE_URL || env.DASHSCOPE_BASE_URL || VERIFIED_DEFAULTS.vision.baseUrl),
    apiKey: v.apiKey || visionKey(env),
    timeoutMs: number(v.timeoutMs ?? env.VPLAY_VISION_TIMEOUT_MS ?? env.VISION_TIMEOUT_MS, 180000),
    maxOutputTokens: number(v.maxOutputTokens ?? env.VPLAY_VISION_MAX_TOKENS, 6000),
    temperature: 0,
    structuredOutput: v.structuredOutput || env.VPLAY_VISION_STRUCTURED_OUTPUT || 'prompt',
    verifiedAt: VERIFIED_DEFAULTS.vision.verifiedAt,
  };
  const text = {
    provider: t.provider || env.VPLAY_TEXT_PROVIDER || VERIFIED_DEFAULTS.text.provider,
    model: t.model || env.VPLAY_TEXT_MODEL || env.TEXT_MODEL || env.DEEPSEEK_MODEL || VERIFIED_DEFAULTS.text.model,
    baseUrl: trimSlash(t.baseUrl || env.VPLAY_TEXT_BASE_URL || env.TEXT_BASE_URL || env.DEEPSEEK_BASE_URL || VERIFIED_DEFAULTS.text.baseUrl),
    apiKey: t.apiKey || textKey(env),
    timeoutMs: number(t.timeoutMs ?? env.VPLAY_TEXT_TIMEOUT_MS ?? env.TEXT_TIMEOUT_MS, 120000),
    maxOutputTokens: number(t.maxOutputTokens ?? env.VPLAY_TEXT_MAX_TOKENS, 4096),
    temperature: 0,
    verifiedAt: VERIFIED_DEFAULTS.text.verifiedAt,
  };
  const budget = {
    maxVisionCalls: number(b.maxVisionCalls ?? env.VPLAY_MAX_VISION_CALLS, 12),
    maxTextCalls: number(b.maxTextCalls ?? env.VPLAY_MAX_TEXT_CALLS, 4),
    visionInputPricePerMillion: b.visionInputPricePerMillion ?? env.VPLAY_VISION_INPUT_PRICE_PER_MTOK ?? null,
    visionOutputPricePerMillion: b.visionOutputPricePerMillion ?? env.VPLAY_VISION_OUTPUT_PRICE_PER_MTOK ?? null,
    textInputPricePerMillion: b.textInputPricePerMillion ?? env.VPLAY_TEXT_INPUT_PRICE_PER_MTOK ?? null,
    textOutputPricePerMillion: b.textOutputPricePerMillion ?? env.VPLAY_TEXT_OUTPUT_PRICE_PER_MTOK ?? null,
  };
  const retry = {
    maxAttempts: number(r.maxAttempts ?? env.VPLAY_MODEL_MAX_ATTEMPTS, 2),
    retryOn5xx: bool(r.retryOn5xx ?? env.VPLAY_RETRY_ON_5XX, true),
    retryOnRateLimit: bool(r.retryOnRateLimit ?? env.VPLAY_RETRY_ON_RATE_LIMIT, false),
    backoffMs: number(r.backoffMs ?? env.VPLAY_RETRY_BACKOFF_MS, 400),
  };
  const browser = {
    executablePath: br.executablePath || env.VPLAY_BROWSER_EXECUTABLE || env.BROWSER_EXECUTABLE || null,
    headless: bool(br.headless ?? env.VPLAY_BROWSER_HEADLESS, true),
    launchArgs: br.launchArgs || [],
    // Deliberately no apiKey/token fields here.
  };

  return { vision, text, budget, retry, browser };
}

export function assertModelConfig(config, role) {
  const item = config?.[role];
  if (!item) {
    throw Object.assign(new Error(`unknown model role: ${role}`), { code: 'CONFIG', category: 'config' });
  }
  if (!item.apiKey) {
    throw Object.assign(
      new Error(`${role} API key is missing; set ${role === 'vision' ? 'DASHSCOPE_API_KEY/VPLAY_VISION_API_KEY' : 'DEEPSEEK_API_KEY/VPLAY_TEXT_API_KEY'}`),
      { code: 'CONFIG', category: 'config' },
    );
  }
  if (!item.model) {
    throw Object.assign(new Error(`${role} model ID is missing`), { code: 'CONFIG', category: 'config' });
  }
  if (!item.baseUrl) {
    throw Object.assign(new Error(`${role} base URL is missing`), { code: 'CONFIG', category: 'config' });
  }
  return item;
}

export function redactConfig(config) {
  const vision = { ...config.vision, apiKey: config.vision.apiKey ? `<set:${config.vision.apiKey.length}>` : '' };
  const text = { ...config.text, apiKey: config.text.apiKey ? `<set:${config.text.apiKey.length}>` : '' };
  return { ...config, vision, text };
}

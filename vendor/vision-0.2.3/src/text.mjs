import { postJson } from './http.mjs';
import { buildPatchMessages } from './prompts.mjs';
import { validatePatchPlanShape } from './schema.mjs';
import { VisionError, ERROR_CATEGORIES, classifyOutput } from './errors.mjs';
import { extractJson } from './vision.mjs';

export function parsePatchPlan({ content, finishReason = null, allowedFiles = ['index.html'], provider = 'deepseek' }) {
  if (!content || typeof content !== 'string') {
    throw new VisionError('provider returned empty patch content', {
      category: ERROR_CATEGORIES.EMPTY_RESPONSE,
      provider,
      finishReason,
      code: 'EMPTY_CONTENT',
    });
  }
  if (finishReason === 'length') throw classifyOutput({ finishReason, provider, rawContent: content });
  let parsed;
  try {
    parsed = extractJson(content);
  } catch (error) {
    throw classifyOutput({ finishReason, error, provider, rawContent: content });
  }
  const validation = validatePatchPlanShape(parsed, { allowedFiles });
  if (!validation.ok) {
    throw classifyOutput({ finishReason, schemaErrors: validation.errors, provider, rawContent: content });
  }
  return validation.plan;
}

export async function proposePatchPlan({
  config,
  report,
  sourceContext,
  allowedFiles = ['index.html'],
  extra = '',
  budget = null,
  fetchImpl = fetch,
  retry = {},
  onAttempt = null,
  onRetry = null,
}) {
  if (!config?.apiKey) throw new VisionError('text API key is missing', { category: ERROR_CATEGORIES.CONFIG, code: 'CONFIG' });
  if (!config?.model) throw new VisionError('text model ID is missing', { category: ERROR_CATEGORIES.CONFIG, code: 'CONFIG' });
  if (!sourceContext) throw new VisionError('sourceContext is required', { category: ERROR_CATEGORIES.CONFIG, code: 'CONFIG' });
  const messages = buildPatchMessages({ report, sourceContext, allowedFiles, extra });
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0,
    max_tokens: config.maxOutputTokens ?? 4096,
    stream: false,
  };
  if (budget) budget.assertCanCall('text');
  const started = Date.now();
  try {
    const response = await postJson({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      body,
      timeoutMs: config.timeoutMs,
      fetchImpl,
      provider: 'deepseek',
      retry,
      onAttempt,
      onRetry,
    });
    const content = response.payload?.choices?.[0]?.message?.content;
    const finishReason = response.payload?.choices?.[0]?.finish_reason || null;
    const textContent = Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
      : content;
    const plan = parsePatchPlan({ content: textContent, finishReason, allowedFiles, provider: 'deepseek' });
    if (budget) {
      budget.record('text', {
        usage: response.payload?.usage || null,
        durationMs: Date.now() - started,
        model: response.payload?.model || config.model,
        label: 'patch',
      });
    }
    return {
      plan,
      rawContent: textContent,
      meta: {
        provider: 'deepseek',
        model: response.payload?.model || config.model,
        usage: response.payload?.usage || null,
        finishReason,
        requestId: response.requestId,
        attempts: response.attempts,
        latencyMs: Date.now() - started,
      },
    };
  } catch (error) {
    if (budget) {
      budget.recordFailure('text', {
        usage: error?.usage || null,
        durationMs: Date.now() - started,
        model: config.model,
        label: 'patch',
        errorCategory: error?.category || ERROR_CATEGORIES.UNKNOWN,
      });
    }
    throw error;
  }
}

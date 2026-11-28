import { postJson } from './http.mjs';
import { prepareImage } from './images.mjs';
import { buildVisionMessages } from './prompts.mjs';
import { validateReport } from './schema.mjs';
import { VisionError, ERROR_CATEGORIES, classifyOutput } from './errors.mjs';

export function extractJson(textValue) {
  if (typeof textValue !== 'string') throw new Error('expected string');
  const fenced = textValue.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : textValue;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Parse and validate a vision reply. Kept separate so tests can replay real
 * E02 responses without any network call.
 */
export function parseVisionReport({ content, finishReason = null, provider = 'qwen' }) {
  if (!content || typeof content !== 'string') {
    throw new VisionError('provider returned empty content', {
      category: ERROR_CATEGORIES.EMPTY_RESPONSE,
      provider,
      finishReason,
      code: 'EMPTY_CONTENT',
    });
  }
  if (finishReason === 'length') {
    throw classifyOutput({ finishReason, provider, rawContent: content });
  }
  let parsed;
  try {
    parsed = extractJson(content);
  } catch (error) {
    throw classifyOutput({ finishReason, error, provider, rawContent: content });
  }
  const validation = validateReport(parsed);
  if (!validation.ok) {
    throw classifyOutput({ finishReason, schemaErrors: validation.errors, provider, rawContent: content });
  }
  return validation.report;
}

function contentOf(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return typeof content === 'string' ? content : '';
}

/**
 * Real Qwen vision call through an OpenAI-compatible endpoint.
 * The browser never receives any of this configuration.
 */
export async function analyzeScreenshots({
  config,
  images,
  context = '',
  userPrompt = '',
  budget = null,
  fetchImpl = fetch,
  retry = {},
  onAttempt = null,
  onRetry = null,
}) {
  if (!config?.apiKey) throw new VisionError('vision API key is missing', { category: ERROR_CATEGORIES.CONFIG, code: 'CONFIG' });
  if (!config?.model) throw new VisionError('vision model ID is missing', { category: ERROR_CATEGORIES.CONFIG, code: 'CONFIG' });
  if (!images?.length) throw new VisionError('at least one image is required', { category: ERROR_CATEGORIES.CONFIG, code: 'CONFIG' });
  const prepared = [];
  for (const image of images) prepared.push(await prepareImage(image));
  const messages = buildVisionMessages({ images: prepared, context, userPrompt });
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0,
    max_tokens: config.maxOutputTokens ?? 6000,
    stream: false,
    ...(config.structuredOutput === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
  };

  if (budget) budget.assertCanCall('vision');
  const started = Date.now();
  let response;
  try {
    response = await postJson({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      body,
      timeoutMs: config.timeoutMs,
      fetchImpl,
      provider: 'qwen',
      retry,
      onAttempt,
      onRetry,
    });
    const content = contentOf(response.payload);
    const finishReason = response.payload?.choices?.[0]?.finish_reason || null;
    let report;
    try {
      report = parseVisionReport({ content, finishReason, provider: 'qwen' });
    } catch (error) {
      if (!error.usage) error.usage = response.payload?.usage || null;
      throw error;
    }
    if (budget) {
      budget.record('vision', {
        usage: response.payload?.usage || null,
        durationMs: Date.now() - started,
        model: response.payload?.model || config.model,
        label: 'vision',
      });
    }
    return {
      report,
      rawContent: content,
      meta: {
        provider: 'qwen',
        model: response.payload?.model || config.model,
        usage: response.payload?.usage || null,
        finishReason,
        requestId: response.requestId,
        attempts: response.attempts,
        latencyMs: Date.now() - started,
        images: prepared.map((image) => ({ fileName: image.fileName, bytes: image.bytes, sha256: image.sha256 })),
        structuredOutput: config.structuredOutput || 'prompt',
      },
    };
  } catch (error) {
    if (budget) {
      budget.recordFailure('vision', {
        usage: error?.usage || null,
        durationMs: Date.now() - started,
        model: config.model,
        label: 'vision',
        errorCategory: error?.category || ERROR_CATEGORIES.UNKNOWN,
      });
    }
    throw error;
  }
}

import { loadConfig, redactConfig, assertModelConfig } from './config.mjs';
import { Budget } from './budget.mjs';
import { analyzeScreenshots } from './vision.mjs';
import { proposePatchPlan } from './text.mjs';
import { getModels } from './http.mjs';

/**
 * Model gateway facade. It holds model configuration and budget, and is kept
 * separate from the browser runner so no API key reaches the browser.
 */
export function createModelGateway({
  config = loadConfig(),
  budget = null,
  fetchImpl = fetch,
} = {}) {
  const callBudget = budget || new Budget(config.budget);
  const retry = config.retry;

  return {
    config: redactConfig(config),
    budget: callBudget,
    async analyzeScreenshots({ images, context = '', userPrompt = '' }) {
      const vision = assertModelConfig(config, 'vision');
      return analyzeScreenshots({
        config: vision,
        images,
        context,
        userPrompt,
        budget: callBudget,
        fetchImpl,
        retry,
      });
    },
    async proposePatchPlan({ report, sourceContext, allowedFiles = ['index.html'], extra = '' }) {
      const text = assertModelConfig(config, 'text');
      return proposePatchPlan({
        config: text,
        report,
        sourceContext,
        allowedFiles,
        extra,
        budget: callBudget,
        fetchImpl,
        retry,
      });
    },
    async listVisionModels() {
      const vision = assertModelConfig(config, 'vision');
      return getModels({
        baseUrl: vision.baseUrl,
        apiKey: vision.apiKey,
        fetchImpl,
        provider: 'qwen',
      });
    },
    summary() {
      return callBudget.summary();
    },
  };
}

/**
 * Call/token budget. Enforces caps and records usage/latency. Cost is only
 * computed when the host supplies per-million prices; no price is hardcoded.
 */
import { VisionError, ERROR_CATEGORIES } from './errors.mjs';

export class Budget {
  constructor({
    maxVisionCalls = 12,
    maxTextCalls = 4,
    visionInputPricePerMillion = null,
    visionOutputPricePerMillion = null,
    textInputPricePerMillion = null,
    textOutputPricePerMillion = null,
  } = {}) {
    this.limits = { vision: maxVisionCalls, text: maxTextCalls };
    this.calls = { vision: 0, text: 0 };
    this.usage = {
      vision: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      text: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    this.durationMs = { vision: 0, text: 0 };
    this.prices = {
      vision: { input: price(visionInputPricePerMillion), output: price(visionOutputPricePerMillion) },
      text: { input: price(textInputPricePerMillion), output: price(textOutputPricePerMillion) },
    };
    this.events = [];
  }

  assertCanCall(kind) {
    if (!(kind in this.calls)) throw new Error(`unknown call kind: ${kind}`);
    if (this.calls[kind] >= this.limits[kind]) {
      throw new VisionError(`${kind} call budget exhausted (${this.calls[kind]}/${this.limits[kind]})`, {
        category: ERROR_CATEGORIES.BUDGET,
        retryable: false,
        code: 'BUDGET_EXHAUSTED',
      });
    }
  }

  record(kind, { usage = null, durationMs = 0, model = null, label = '' } = {}) {
    this.assertCanCall(kind);
    this._add(kind, { usage, durationMs, model, label, failed: false, errorCategory: null });
  }

  /** Count a failed provider call (e.g. 401, truncated output) against the budget. */
  recordFailure(kind, { usage = null, durationMs = 0, model = null, label = '', errorCategory = null } = {}) {
    this.assertCanCall(kind);
    this._add(kind, { usage, durationMs, model, label, failed: true, errorCategory });
  }

  _add(kind, { usage, durationMs, model, label, failed, errorCategory }) {
    this.calls[kind] += 1;
    this.durationMs[kind] += Number(durationMs) || 0;
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      this.usage[kind][key] += Number(usage?.[key]) || 0;
    }
    this.events.push({
      kind,
      model,
      label,
      durationMs: Number(durationMs) || 0,
      usage: usage || null,
      failed: Boolean(failed),
      errorCategory: errorCategory || null,
      at: new Date().toISOString(),
    });
  }

  cost(kind) {
    const usage = this.usage[kind];
    const price = this.prices[kind];
    if (price.input == null && price.output == null) return null;
    const input = price.input == null ? 0 : (usage.prompt_tokens / 1e6) * price.input;
    const output = price.output == null ? 0 : (usage.completion_tokens / 1e6) * price.output;
    return Number((input + output).toFixed(6));
  }

  summary() {
    return {
      limits: { ...this.limits },
      calls: { ...this.calls },
      usage: {
        vision: { ...this.usage.vision },
        text: { ...this.usage.text },
      },
      durationMs: { ...this.durationMs },
      cost: { vision: this.cost('vision'), text: this.cost('text') },
      priceConfigured: {
        vision: this.prices.vision.input != null || this.prices.vision.output != null,
        text: this.prices.text.input != null || this.prices.text.output != null,
      },
      events: [...this.events],
    };
  }
}

function price(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

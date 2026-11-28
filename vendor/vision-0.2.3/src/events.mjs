import crypto from 'node:crypto';
import { redactObject } from './redaction.mjs';

export const EVENT_TYPES = Object.freeze({
  TASK_STARTED: 'vision.task.started',
  CAPTURE_COMPLETED: 'vision.capture.completed',
  ANALYSIS_STARTED: 'vision.analysis.started',
  ANALYSIS_COMPLETED: 'vision.analysis.completed',
  PATCH_PROPOSED: 'vision.patch.proposed',
  PATCH_REJECTED: 'vision.patch.rejected',
  PATCH_VALIDATED: 'vision.patch.validated',
  PATCH_MATERIALIZED: 'vision.patch.materialized',
  SNAPSHOT_CREATED: 'vision.snapshot.created',
  PATCH_APPLIED: 'vision.patch.applied',
  DIFF_COMPLETED: 'vision.diff.completed',
  VERIFICATION_COMPLETED: 'vision.verification.completed',
  ROLLBACK_COMPLETED: 'vision.rollback.completed',
  TASK_COMPLETED: 'vision.task.completed',
  TASK_FAILED: 'vision.task.failed',
});

const SECRET_KEY = /^(api[_-]?key|authorization|cookie|set-cookie|token|secret|password|credential|headers)$/i;

/**
 * Event payload redaction (E07).
 *
 * 0.2.0 only replaced `sk-*` and secret-named keys; free text such as
 * `password = "..."` or a `Set-Cookie` header survived into JSONL/SSE.
 * 0.2.1 runs the full redaction rule set on every string value.
 */
export function redact(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '<redacted>' : redact(item);
    }
    return out;
  }
  return redactObject(value);
}

/**
 * Structured task-event sink. It does NOT persist, queue, or own task state;
 * Vplay's task store/log is the consumer.
 */
export function createEventSink({
  taskId,
  projectId = null,
  onEvent = null,
  clock = () => new Date().toISOString(),
  idFactory = () => crypto.randomUUID(),
} = {}) {
  if (!taskId) throw new Error('createEventSink requires taskId');
  let seq = 0;
  const events = [];
  const valid = new Set(Object.values(EVENT_TYPES));

  function emit(type, payload = {}, artifacts = []) {
    if (!valid.has(type)) throw new Error(`unknown vision event type: ${type}`);
    seq += 1;
    const event = {
      schemaVersion: 1,
      eventId: idFactory(),
      taskId,
      projectId,
      seq,
      type,
      at: clock(),
      payload: redact(payload),
      artifacts: artifacts.map((item) => (typeof item === 'string' ? { path: item } : redact(item))),
    };
    events.push(event);
    if (onEvent) {
      try {
        onEvent(event);
      } catch {
        // A consumer failure must not break verification; the event is still
        // returned in the in-memory list for the caller/CLI.
      }
    }
    return event;
  }

  return {
    emit,
    events,
    get seq() { return seq; },
  };
}

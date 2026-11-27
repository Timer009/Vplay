/**
 * Public API of @vplay/vision.
 *
 * The package is ESM-only and runs on standard Node.js >= 20. It does not
 * reference ZCode/Electron, and it does not implement projects, tasks,
 * snapshots, queues, or rollback. Those belong to Vplay Sprint 02; the host
 * passes them in through `runVisionTask({ host })`.
 */
export { loadConfig, assertModelConfig, redactConfig, VERIFIED_DEFAULTS } from './config.mjs';
export { Budget } from './budget.mjs';
export {
  VisionError,
  ERROR_CATEGORIES,
  classifyHttpStatus,
  classifyNetworkError,
  classifyOutput,
  shouldRetry,
  errorCategoryOf,
} from './errors.mjs';
export { postJson, getModels, assertModelUrl, joinChatCompletionsUrl, joinModelsUrl } from './http.mjs';
export { redactText, redactSource, redactObject, scanSensitive } from './redaction.mjs';
export { prepareImage, imagePart, MAX_IMAGE_BYTES } from './images.mjs';
export { parseVisionReport, analyzeScreenshots, extractJson } from './vision.mjs';
export { parsePatchPlan, proposePatchPlan } from './text.mjs';
export { validateReport, validatePatchPlanShape, DEFECT_TYPES, SEVERITIES } from './schema.mjs';
export { validatePatchPlan, materializePatch, describeDelta, validateCss, validateHtmlFragment, scriptRanges, hashContent } from './patch/validator.mjs';
export {
  normalizeStructural,
  structuralFindings,
  validateStructureDelta,
  validateFragmentStructure,
  changedRangesFromOperations,
} from './patch/structure.mjs';
export { selectDefect } from './patch/defect.mjs';
export { createModelGateway } from './gateway.mjs';
export { createBrowserRunner, loadPlaywrightCore, normalizePreviewAuth } from './browser/runner.mjs';
export { installNetworkGuard } from './browser/guard.mjs';
export { sanitizeBrowserEnv, findSecretEnvKeys } from './browser/env.mjs';
export { findBrowserExecutable } from './browser/discover.mjs';
export { elementState, hitTest, clickAndWait, readText } from './verification/assertions.mjs';
export { compareVerification, defectKeyOf } from './verification/compare.mjs';
export { createDomAdapter } from './verification/adapters/dom.mjs';
export { createSpacerAdapter } from './verification/adapters/spacer.mjs';
export { createEventSink, redact, EVENT_TYPES } from './events.mjs';
export { runVisionTask } from './orchestrator.mjs';

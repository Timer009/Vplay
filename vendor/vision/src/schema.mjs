/**
 * Structured output contracts.
 */
export const DEFECT_TYPES = Object.freeze([
  'ui_occlusion',
  'landing_platform',
  'support_structure',
  'layout',
  'rendering',
  'input_affordance',
  'other',
]);

export const SEVERITIES = Object.freeze(['blocker', 'major', 'minor', 'info']);

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function region(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const w = Number(value.w ?? value.width);
  const h = Number(value.h ?? value.height);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function validateReport(input, { requireDefects = false } = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['report must be an object'], report: null };
  }
  const summary = text(input.summary);
  if (!summary) errors.push('summary is required');
  const rawDefects = Array.isArray(input.defects) ? input.defects : null;
  if (!rawDefects) errors.push('defects must be an array');
  const defects = [];
  for (const [index, raw] of (rawDefects || []).entries()) {
    const prefix = `defects[${index}]`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const defectType = text(raw.defect_type || raw.type);
    if (!DEFECT_TYPES.includes(defectType)) errors.push(`${prefix}.defect_type is invalid`);
    const severity = text(raw.severity);
    if (!SEVERITIES.includes(severity)) errors.push(`${prefix}.severity is invalid`);
    const locationRaw = raw.location;
    const location = typeof locationRaw === 'string'
      ? { screen: 'unknown', description: locationRaw, region: null }
      : {
          screen: text(locationRaw?.screen, 'unknown') || 'unknown',
          description: text(locationRaw?.description),
          region: region(locationRaw?.region),
        };
    if (!location.description) errors.push(`${prefix}.location.description is required`);
    const screenshots = Array.isArray(raw.evidence?.screenshots)
      ? raw.evidence.screenshots.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [];
    if (!screenshots.length) errors.push(`${prefix}.evidence.screenshots must contain at least one path`);
    const observation = text(raw.evidence?.observation || raw.observation);
    if (!observation) errors.push(`${prefix}.evidence.observation is required`);
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) errors.push(`${prefix}.confidence must be 0..1`);
    const recommendation = text(raw.recommendation || raw.fix);
    if (!recommendation) errors.push(`${prefix}.recommendation is required`);
    const verification = text(raw.verification || raw.verify);
    if (!verification) errors.push(`${prefix}.verification is required`);
    defects.push({
      id: text(raw.id, `V-${String(index + 1).padStart(3, '0')}`) || `V-${String(index + 1).padStart(3, '0')}`,
      defect_type: DEFECT_TYPES.includes(defectType) ? defectType : 'other',
      location,
      severity: SEVERITIES.includes(severity) ? severity : 'info',
      evidence: { screenshots, observation },
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
      recommendation,
      verification,
    });
  }
  if (requireDefects && defects.length === 0) errors.push('at least one defect is required');
  const limitations = Array.isArray(input.limitations)
    ? input.limitations.filter((item) => typeof item === 'string' && item.trim())
    : [];
  if (defects.length === 0 && limitations.length === 0) errors.push('a no-defect report must include limitations');
  return { ok: errors.length === 0, errors, report: errors.length === 0 ? { summary, defects, limitations } : null };
}

export function validatePatchPlanShape(plan, { allowedFiles = ['index.html'], maxPatches = 3, maxChars = 12000 } = {}) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan must be an object'], plan: null };
  const diagnosis = text(plan.diagnosis);
  if (!diagnosis) errors.push('diagnosis is required');
  const rawPatches = Array.isArray(plan.patches) ? plan.patches : null;
  if (!rawPatches || rawPatches.length === 0) errors.push('patches must be a non-empty array');
  if (rawPatches && rawPatches.length > maxPatches) errors.push(`patches must contain at most ${maxPatches} entries`);
  const patches = [];
  for (const [index, raw] of (rawPatches || []).entries()) {
    const prefix = `patches[${index}]`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const file = text(raw.file);
    if (!file) errors.push(`${prefix}.file is required`);
    if (allowedFiles.length && !allowedFiles.includes(file)) errors.push(`${prefix}.file is not allowed: ${file}`);
    const oldString = typeof raw.old_string === 'string' ? raw.old_string : '';
    const newString = typeof raw.new_string === 'string' ? raw.new_string : '';
    if (!oldString) errors.push(`${prefix}.old_string is required`);
    if (oldString.length > maxChars) errors.push(`${prefix}.old_string exceeds ${maxChars} chars`);
    if (newString.length > maxChars) errors.push(`${prefix}.new_string exceeds ${maxChars} chars`);
    if (oldString === newString) errors.push(`${prefix} is a no-op`);
    const reason = text(raw.reason);
    if (!reason) errors.push(`${prefix}.reason is required`);
    patches.push({ file, old_string: oldString, new_string: newString, reason });
  }
  const verification = Array.isArray(plan.verification)
    ? plan.verification.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
  if (!verification.length) errors.push('verification must be a non-empty array');
  if (errors.length) return { ok: false, errors, plan: null };
  return { ok: true, errors: [], plan: { diagnosis, patches, verification } };
}

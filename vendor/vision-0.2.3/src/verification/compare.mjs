/**
 * E10 / 0.2.2 verification comparison.
 *
 * Fixes C12-P1-04/P1-05 and the E09 gate gaps:
 *   - an assertion that only exists in the AFTER capture and fails is a NEW
 *     failure (previously classified as persisting);
 *   - a BEFORE assertion that disappears from AFTER is `missing` and blocks
 *     verification (deleting evidence must not prove a repair);
 *   - a defect has a stable key and explicit defect assertion ids; a visual
 *     change or an unrelated before-failure cannot satisfy it.
 */
import crypto from 'node:crypto';

function assertionMap(capture) {
  const byViewport = new Map();
  for (const viewport of capture?.viewports || []) {
    const assertions = new Map();
    for (const assertion of viewport.assertions || []) {
      assertions.set(assertion.id, assertion);
    }
    byViewport.set(viewport.viewport, {
      ok: viewport.ok === true,
      assertions,
      sha256: viewport.sha256 || null,
      pageErrors: viewport.diagnostics?.pageErrors?.length || 0,
    });
  }
  return byViewport;
}

function failureOf(assertion) {
  return {
    id: assertion.id,
    critical: assertion.critical !== false,
    detail: assertion.detail ?? null,
  };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Stable defect identity for evidence and host gates. The model-provided
 * `id` may change between runs; this key is derived from the defect's
 * semantic fields. Hosts may also pass their own `defectKey`.
 */
export function defectKeyOf(defect) {
  if (!defect) return null;
  if (typeof defect.defectKey === 'string' && defect.defectKey.trim()) return defect.defectKey.trim();
  const region = defect.location?.region || {};
  const material = [
    normalizeText(defect.defect_type || defect.type),
    normalizeText(defect.location?.screen),
    normalizeText(defect.location?.description),
    Number.isFinite(Number(region.x)) ? Math.round(Number(region.x)) : '',
    Number.isFinite(Number(region.y)) ? Math.round(Number(region.y)) : '',
    Number.isFinite(Number(region.w ?? region.width)) ? Math.round(Number(region.w ?? region.width)) : '',
    Number.isFinite(Number(region.h ?? region.height)) ? Math.round(Number(region.h ?? region.height)) : '',
  ].join('|');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function defectComparison({ beforeMap, afterMap, defect, defectAssertionIds }) {
  const ids = Array.from(new Set((defectAssertionIds || []).filter((id) => typeof id === 'string' && id.trim())));
  const key = defectKeyOf(defect);
  if (ids.length === 0) {
    return {
      id: defect?.id || null,
      key,
      assertionIds: [],
      beforeFailed: false,
      afterPassed: false,
      missing: [],
      ok: false,
      reason: 'no-defect-assertions',
    };
  }
  const beforeFailures = [];
  const afterFailures = [];
  const missing = [];
  for (const viewport of afterMap.keys()) {
    for (const id of ids) {
      const beforeAssertion = beforeMap.get(viewport)?.assertions.get(id) || null;
      const afterAssertion = afterMap.get(viewport)?.assertions.get(id) || null;
      if (!afterAssertion) {
        missing.push({ viewport, id });
        continue;
      }
      if (beforeAssertion && beforeAssertion.ok === false) beforeFailures.push({ viewport, id });
      if (afterAssertion.ok !== true) afterFailures.push({ viewport, id });
    }
  }
  const beforeFailed = beforeFailures.length > 0;
  const afterPassed = afterFailures.length === 0 && missing.length === 0;
  let reason = null;
  if (missing.length) reason = 'defect-assertion-missing';
  else if (!beforeFailed) reason = 'defect-not-reproduced-before';
  else if (!afterPassed) reason = 'defect-still-present-after';
  return {
    id: defect?.id || null,
    key,
    assertionIds: ids,
    beforeFailed,
    afterPassed,
    missing,
    ok: Boolean(beforeFailed && afterPassed),
    reason,
  };
}

export function compareVerification({ before = null, after = null, defect = null, defectAssertionIds = [] } = {}) {
  const beforeMap = assertionMap(before);
  const afterMap = assertionMap(after);
  const viewports = [];
  const newFailures = [];
  const resolvedFailures = [];
  const persistingFailures = [];
  const missingAssertions = [];

  for (const [viewportName, afterViewport] of afterMap) {
    const beforeViewport = beforeMap.get(viewportName) || null;
    const ids = new Set([
      ...(beforeViewport ? beforeViewport.assertions.keys() : []),
      ...afterViewport.assertions.keys(),
    ]);
    const entries = [];
    for (const id of ids) {
      const beforeAssertion = beforeViewport?.assertions.get(id) || null;
      const afterAssertion = afterViewport.assertions.get(id) || null;
      if (beforeAssertion && !afterAssertion) {
        missingAssertions.push({
          viewport: viewportName,
          id,
          critical: beforeAssertion.critical !== false,
          before: beforeAssertion.ok,
        });
        entries.push({ id, before: beforeAssertion.ok, after: null, critical: beforeAssertion.critical !== false });
        continue;
      }
      if (!beforeAssertion && afterAssertion) {
        if (afterAssertion.ok !== true) {
          newFailures.push({
            viewport: viewportName,
            id,
            ...failureOf(afterAssertion),
            before: null,
            after: false,
            added: true,
          });
        }
        entries.push({ id, before: null, after: afterAssertion.ok, critical: afterAssertion.critical !== false });
        continue;
      }
      if (beforeAssertion && afterAssertion) {
        if (beforeAssertion.ok === false && afterAssertion.ok === true) {
          resolvedFailures.push({
            viewport: viewportName,
            id,
            ...failureOf(beforeAssertion),
            before: false,
            after: true,
          });
        } else if (beforeAssertion.ok === true && afterAssertion.ok === false) {
          newFailures.push({
            viewport: viewportName,
            id,
            ...failureOf(afterAssertion),
            before: true,
            after: false,
          });
        } else if (beforeAssertion.ok === false && afterAssertion.ok === false) {
          persistingFailures.push({
            viewport: viewportName,
            id,
            ...failureOf(afterAssertion),
            before: false,
            after: false,
          });
        }
        entries.push({ id, before: beforeAssertion.ok, after: afterAssertion.ok, critical: afterAssertion.critical !== false });
      }
    }
    viewports.push({
      viewport: viewportName,
      beforeOk: beforeViewport ? beforeViewport.ok : null,
      afterOk: afterViewport.ok,
      assertions: entries,
    });
  }

  // Viewports present before but absent after are also missing evidence.
  for (const viewportName of beforeMap.keys()) {
    if (!afterMap.has(viewportName)) {
      missingAssertions.push({ viewport: viewportName, id: '*', critical: true, before: null });
    }
  }

  const beforeHashes = (before?.screenshots || []).map((item) => item.sha256).filter(Boolean).sort();
  const afterHashes = (after?.screenshots || []).map((item) => item.sha256).filter(Boolean).sort();
  const screenshotsChanged = JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes);
  const beforeOk = before ? before.ok === true : null;
  const afterOk = after ? after.ok === true : false;
  const newCriticalFailures = newFailures.filter((item) => item.critical);
  const resolvedCriticalFailures = resolvedFailures.filter((item) => item.critical);
  const defectResult = defectComparison({ beforeMap, afterMap, defect, defectAssertionIds });
  const hasDefectIds = defectResult.assertionIds.length > 0;

  // `ok` is a repair gate: after passes, no new critical failures, no deleted
  // assertions, evidence of change, and (when ids are supplied) a defect
  // assertion that failed before and passes after.
  const ok = Boolean(
    afterOk
    && newCriticalFailures.length === 0
    && missingAssertions.length === 0
    && (beforeOk === false || resolvedCriticalFailures.length > 0 || screenshotsChanged)
    && (!hasDefectIds || defectResult.ok),
  );

  return {
    ok,
    beforeOk,
    afterOk,
    screenshotsChanged,
    beforeHashes,
    afterHashes,
    newFailures,
    newCriticalFailures,
    resolvedFailures,
    resolvedCriticalFailures,
    persistingFailures,
    missingAssertions,
    defect: defectResult,
    defectKey: defectResult.key,
    viewports,
    policy: 'after-pass + no-new-critical + no-missing-assertions + change-evidence + defect-assertions',
  };
}

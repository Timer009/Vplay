/**
 * E07: before/after verification comparison.
 *
 * 0.2.0 considered a repair "verified" when the AFTER capture passed its
 * assertions and the diff was non-empty. That cannot distinguish:
 *   - a real fix (failures resolved / visual change),
 *   - a no-op that happened to pass,
 *   - a patch that hides UI instead of fixing it.
 *
 * This module is deliberately data-only: it reports what changed between the
 * baseline and the after capture. The host remains responsible for requiring
 * `ok` (or its own defect-specific predicate) before publishing.
 */
function viewportEntries(capture) {
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

export function compareVerification({ before = null, after = null, defect = null } = {}) {
  const beforeMap = viewportEntries(before);
  const afterMap = viewportEntries(after);
  const viewports = [];
  const newFailures = [];
  const resolvedFailures = [];
  const persistingFailures = [];

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
      if (beforeAssertion && afterAssertion && beforeAssertion.ok !== afterAssertion.ok) {
        const entry = {
          viewport: viewportName,
          id,
          ...failureOf(afterAssertion.ok ? beforeAssertion : afterAssertion),
          before: beforeAssertion.ok,
          after: afterAssertion.ok,
        };
        if (afterAssertion.ok) resolvedFailures.push(entry);
        else newFailures.push(entry);
      } else if (afterAssertion && afterAssertion.ok === false) {
        persistingFailures.push({
          viewport: viewportName,
          id,
          ...failureOf(afterAssertion),
          before: beforeAssertion ? beforeAssertion.ok : null,
          after: false,
        });
      }
      if (beforeAssertion || afterAssertion) {
        entries.push({
          id,
          before: beforeAssertion ? beforeAssertion.ok : null,
          after: afterAssertion ? afterAssertion.ok : null,
          critical: (afterAssertion || beforeAssertion).critical !== false,
        });
      }
    }
    viewports.push({
      viewport: viewportName,
      beforeOk: beforeViewport ? beforeViewport.ok : null,
      afterOk: afterViewport.ok,
      assertions: entries,
    });
  }

  const beforeHashes = (before?.screenshots || []).map((item) => item.sha256).filter(Boolean).sort();
  const afterHashes = (after?.screenshots || []).map((item) => item.sha256).filter(Boolean).sort();
  const screenshotsChanged = JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes);

  const beforeOk = before ? before.ok === true : null;
  const afterOk = after ? after.ok === true : false;
  const newCriticalFailures = newFailures.filter((item) => item.critical);
  const resolvedCriticalFailures = resolvedFailures.filter((item) => item.critical);
  // `ok` is a repair gate: after must pass, no new critical failures, and
  // there must be evidence of change (resolved failure, before failure, or a
  // changed screenshot). It is not a claim that the defect is causally fixed.
  const ok = afterOk
    && newCriticalFailures.length === 0
    && (beforeOk === false || resolvedCriticalFailures.length > 0 || screenshotsChanged);

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
    viewports,
    defectId: defect?.id || null,
    policy: 'after-pass + no-new-critical + change-evidence',
  };
}

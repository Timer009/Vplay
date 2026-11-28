/**
 * Reusable browser assertions. Adapters call these; the generic runner does
 * not know any game-specific selectors.
 */
export async function elementState(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { exists: false, visible: false, rect: null, display: null, visibility: null, opacity: null };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const rect = { x: r.x, y: r.y, w: r.width, h: r.height };
    const visible = cs.display !== 'none'
      && cs.visibility !== 'hidden'
      && Number(cs.opacity) > 0.01
      && r.width > 0
      && r.height > 0;
    return { exists: true, visible, rect, display: cs.display, visibility: cs.visibility, opacity: Number(cs.opacity) };
  }, selector);
}

export async function hitTest(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false, reason: 'missing-target' };
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const owner = top?.closest?.('[id]');
    return {
      found: true,
      x,
      y,
      id: owner?.id || top?.tagName || null,
      tag: top?.tagName || null,
      targetId: el.id || null,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  }, selector);
}

export async function clickAndWait(page, selector, waitMs = 150) {
  await page.click(selector);
  if (waitMs) await page.waitForTimeout(waitMs);
}

export async function readText(page, selector) {
  return page.locator(selector).innerText().catch(() => null);
}

export function diagnosticAssertions(diagnostics, { critical = true } = {}) {
  return [
    {
      id: 'page-errors',
      ok: (diagnostics?.pageErrors?.length || 0) === 0,
      critical,
      detail: { count: diagnostics?.pageErrors?.length || 0, errors: diagnostics?.pageErrors || [] },
    },
  ];
}

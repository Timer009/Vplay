/**
 * Spacer adapter. Spacer-specific concepts (window.game, #btnT, fuel) live
 * here, NOT in the generic runner. Other games provide their own adapter.
 *
 * Acceptance is functional: visible control, hit-test, touch interaction, fuel
 * drop. An overlay may remain in the DOM as long as it is not visible and does
 * not intercept the control; DOM absence is not required.
 */
const VIEWPORTS = [
  { name: 'pc', width: 1280, height: 720, deviceScaleFactor: 1 },
  {
    name: 'mobile-landscape',
    width: 844,
    height: 390,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  },
];

async function holdThrust(page, cdp, selector, ms = 900) {
  const before = await page.evaluate(() => window.game?.ship?.fuel ?? null);
  const rect = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
  if (rect && rect.w > 0 && rect.h > 0) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, id: 1, radiusX: 8, radiusY: 8, force: 1 }],
    });
    await page.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(150);
  }
  const after = await page.evaluate(() => window.game?.ship?.fuel ?? null);
  return {
    before,
    after,
    delta: typeof before === 'number' && typeof after === 'number' ? Number((after - before).toFixed(2)) : null,
    rect,
  };
}

export function createSpacerAdapter({
  id = 'spacer',
  overlaySelector = null,
  buttonSelector = '#btnT',
  minFuelDrop = 0.5,
  viewports = VIEWPORTS,
} = {}) {
  return {
    id,
    viewports,
    async ready(page) {
      await page.waitForFunction(() => Boolean(window.game) && document.readyState === 'complete', undefined, { timeout: 15000 });
      await page.waitForTimeout(300);
    },
    async setup(page, { scenario = 'default' } = {}) {
      if (scenario === 'title') {
        await page.waitForTimeout(300);
        return;
      }
      await page.evaluate(() => window.game.jump(0));
      await page.waitForFunction(() => window.game.state === 'playing', undefined, { timeout: 12000 });
      await page.waitForTimeout(450);
    },
    async assert({ page, cdp, viewport, helpers }) {
      const assertions = [];
      const add = (idValue, ok, detail, critical = true) => assertions.push({ id: idValue, ok: Boolean(ok), critical, detail });
      const state = await page.evaluate(() => window.game.state);
      add('state-playing', state === 'playing', { state });
      const button = await helpers.elementState(page, buttonSelector);
      add('button-visible', button.visible, button);
      const hit = await helpers.hitTest(page, buttonSelector);
      const targetId = await page.evaluate((sel) => document.querySelector(sel)?.id || null, buttonSelector);
      add('button-hit-test', hit.id === targetId, { expected: targetId, actual: hit });
      if (overlaySelector) {
        const overlay = await helpers.elementState(page, overlaySelector);
        // Visibility, not DOM absence: display:none / visibility:hidden passes.
        add('overlay-not-visible', overlay.visible === false, overlay);
      }
      if (viewport.hasTouch) {
        const fuel = await holdThrust(page, cdp, buttonSelector);
        add('touch-thrust', typeof fuel.delta === 'number' && fuel.delta <= -minFuelDrop, { ...fuel, minFuelDrop });
      }
      return assertions;
    },
  };
}

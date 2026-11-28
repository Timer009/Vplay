/**
 * Generic DOM adapter: ready selector + interactive selector + optional click
 * effect. This is the non-Spacer example and the template for other games.
 */
export function createDomAdapter({
  id = 'dom',
  viewports = [{ name: 'desktop', width: 1280, height: 720, deviceScaleFactor: 1 }],
  readySelector = '#app',
  interactiveSelector,
  expectedHitId = null,
  action = 'click',
  expectedTextSelector = null,
  expectedText = null,
  waitMs = 150,
  redaction = null,
} = {}) {
  if (!interactiveSelector) throw new Error('createDomAdapter requires interactiveSelector');
  return {
    id,
    viewports,
    redaction,
    async ready(page) {
      await page.waitForSelector(readySelector, { state: 'visible', timeout: 15000 });
    },
    async setup() {},
    async assert({ page, helpers }) {
      const assertions = [];
      const add = (idValue, ok, detail, critical = true) => assertions.push({ id: idValue, ok: Boolean(ok), critical, detail });
      const ready = await helpers.elementState(page, readySelector);
      add('ready-visible', ready.visible, ready);
      const interactive = await helpers.elementState(page, interactiveSelector);
      add('interactive-visible', interactive.visible, interactive);
      const hit = await helpers.hitTest(page, interactiveSelector);
      const targetId = expectedHitId || await page.evaluate((sel) => document.querySelector(sel)?.id || null, interactiveSelector);
      add('interactive-hit-test', hit.id === targetId, { expected: targetId, actual: hit });
      if (action === 'click') {
        await helpers.clickAndWait(page, interactiveSelector, waitMs);
        add('interactive-clicked', true, { selector: interactiveSelector });
      } else if (typeof action === 'function') {
        await action({ page, helpers });
        add('interactive-action', true, { selector: interactiveSelector });
      }
      if (expectedTextSelector && expectedText != null) {
        const value = await helpers.readText(page, expectedTextSelector);
        add('expected-text', value === expectedText, { selector: expectedTextSelector, expected: expectedText, actual: value });
      }
      return assertions;
    },
  };
}

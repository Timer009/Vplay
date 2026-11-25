'use strict';

/**
 * Mobile-viewport acceptance test for the console page.
 *
 * This is a SIMULATION: a 390x844 mobile viewport in headless Edge, not a real
 * phone on the LAN. It proves the page can log in, submit a task, show progress
 * and surface the result.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  EXECUTOR,
  makeWorkspace,
  removeWorkspace,
  startServer,
} = require('./helpers.cjs');

const TOKEN = 'mobile-token-abc123';
const SHOTS = path.resolve(__dirname, '..', '..', '.review-artifacts', 'sprint-01-mobile');

function loadPlaywright() {
  try {
    return require('playwright-core');
  } catch {
    return null;
  }
}

test('mobile viewport: login, send a task, see progress and result', async (t) => {
  const playwright = loadPlaywright();
  if (!playwright) return t.skip('playwright-core is not installed');

  let browser;
  try {
    browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  } catch (error) {
    return t.skip(`headless Edge unavailable: ${error.message}`);
  }

  const workspace = makeWorkspace('vplay-remote-mobile-');
  fs.copyFileSync(
    path.join(__dirname, '..', 'fixtures', 'test-game', 'index.html'),
    path.join(workspace, 'index.html'),
  );
  fs.mkdirSync(SHOTS, { recursive: true });

  const server = await startServer({
    workspace,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: EXECUTOR },
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const page = await context.newPage();
    const consoleUrl = `http://127.0.0.1:${server.port}/console`;

    await page.goto(consoleUrl, { waitUntil: 'domcontentloaded' });

    // 1. The gate must be shown before authentication.
    await page.waitForSelector('#gate.show', { timeout: 15000 });
    assert.deepEqual(page.viewportSize(), { width: 390, height: 844 });
    await page.screenshot({ path: path.join(SHOTS, '01-locked.png') });

    // 2. A wrong token must be rejected.
    await page.fill('#tokenInput', 'definitely-wrong');
    await page.click('#loginBtn');
    await page.waitForFunction(
      () => document.getElementById('gateErr')?.classList.contains('show'),
      undefined,
      { timeout: 10000 },
    );
    assert.match(await page.textContent('#gateErr'), /令牌无效/);

    // 3. The correct token unlocks the console.
    await page.fill('#tokenInput', TOKEN);
    await page.click('#loginBtn');
    await page.waitForSelector('#gate.show', { state: 'hidden', timeout: 15000 });
    await page.waitForFunction(
      () => document.getElementById('connText')?.textContent === '已连接',
      undefined,
      { timeout: 15000 },
    );
    // The credential must live in an HttpOnly cookie, not in JS or the URL.
    assert.equal(await page.evaluate(() => document.cookie), '');
    assert.doesNotMatch(page.url(), new RegExp(TOKEN));

    // 4. Submit a task from the mobile UI.
    await page.fill('#promptInput', 'BACKGROUND mobile task');
    await page.waitForFunction(
      () => !document.getElementById('sendBtn')?.disabled,
      undefined,
      { timeout: 5000 },
    );
    await page.click('#sendBtn');

    // 5. Wait for the task to finish and show up in the list.
    await page.waitForSelector('.task-badge[data-s="succeeded"]', { timeout: 30000 });
    await page.click('.task-item');
    const detail = await page.textContent('.task-detail');
    assert.match(detail, /post-verify|产物/);

    // 6. The artifact card must be visible with a same-origin link.
    await page.waitForSelector('#artifactReady.show', { timeout: 15000 });
    const href = await page.getAttribute('#artifactLink', 'href');
    assert.match(href, /\/game\/index\.html$/);
    await page.screenshot({ path: path.join(SHOTS, '02-done.png'), fullPage: true });

    // 7. The generated game is reachable with the session cookie.
    const game = await page.goto(`http://127.0.0.1:${server.port}/game/index.html`, {
      waitUntil: 'domcontentloaded',
    });
    assert.equal(game.status(), 200);
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    );
    assert.equal(bg, '#7c3aed');
    await page.screenshot({ path: path.join(SHOTS, '03-game.png') });

    await context.close();
  } finally {
    await server.stop();
    await browser.close();
    removeWorkspace(workspace);
  }
});

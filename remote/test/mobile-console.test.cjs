/* global document, getComputedStyle */
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

test('mobile viewport: projects mode selects a project and opens the isolated preview', async (t) => {
  const playwright = loadPlaywright();
  if (!playwright) return t.skip('playwright-core is not installed');

  let browser;
  try {
    browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  } catch (error) {
    return t.skip(`headless Edge unavailable: ${error.message}`);
  }

  const root = makeWorkspace('vplay-mobile-projects-');
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const source = path.join(root, 'source');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(
    path.join(source, 'index.html'),
    '<style>:root{--bg: #101014}</style><h1>Projects Mode Game</h1>',
    'utf-8',
  );

  const { createProjectRegistry } = require('../lib/projects.cjs');
  createProjectRegistry({ home }).importProject({ sourceDir: source, id: 'demo-game', name: 'Demo Game' });

  const server = await startServer({
    workspace,
    home,
    token: TOKEN,
    env: { REMOTE_EXECUTOR_CMD: EXECUTOR },
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/console`, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#gate.show', { timeout: 15000 });
    await page.fill('#tokenInput', TOKEN);
    await page.click('#loginBtn');
    await page.waitForSelector('#gate.show', { state: 'hidden', timeout: 15000 });

    // 项目选择器可见，且只有导入的那个项目
    await page.waitForSelector('#projectCard', { state: 'visible', timeout: 15000 });
    const options = await page.$$eval('#projectSelect option', (nodes) =>
      nodes.map((n) => ({ value: n.value, text: n.textContent })),
    );
    assert.equal(options.length, 1);
    assert.equal(options[0].value, 'demo-game');

    await page.fill('#promptInput', 'BACKGROUND mobile project task');
    await page.waitForFunction(() => !document.getElementById('sendBtn')?.disabled);
    await page.click('#sendBtn');

    await page.waitForSelector('.task-badge[data-s="succeeded"]', { timeout: 30000 });
    await page.click('.task-item');
    // 详情面板异步渲染；等待目标文本出现，避免读取早一帧（断言保持不变）
    await page.waitForFunction(
      () => (document.querySelector('.task-detail')?.textContent || '').includes('demo-game'),
      undefined,
      { timeout: 15000 },
    );
    const detail = await page.textContent('.task-detail');
    assert.match(detail, /demo-game/);

    await page.waitForSelector('#artifactReady.show', { timeout: 15000 });
    const href = await page.getAttribute('#artifactLink', 'href');
    assert.match(href, new RegExp(`:${server.previewPort}/p/demo-game/$`));

    const game = await page.goto(`http://127.0.0.1:${server.previewPort}/p/demo-game/`, {
      waitUntil: 'domcontentloaded',
    });
    assert.equal(game.status(), 200);
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    );
    assert.equal(bg, '#7c3aed');

    await context.close();
  } finally {
    await server.stop();
    await browser.close();
    removeWorkspace(root);
  }
});

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
    assert.match(detail, /验证: (通过|未通过)/);

    // 6. The artifact card must be visible and point at the preview origin.
    await page.waitForSelector('#artifactReady.show', { timeout: 15000 });
    const href = await page.getAttribute('#artifactLink', 'href');
    assert.match(href, new RegExp(`:${server.previewPort}/legacy/$`));
    await page.screenshot({ path: path.join(SHOTS, '02-done.png'), fullPage: true });

    // 7. The generated game is reachable on the isolated preview origin.
    const game = await page.goto(`http://127.0.0.1:${server.previewPort}/legacy/index.html`, {
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

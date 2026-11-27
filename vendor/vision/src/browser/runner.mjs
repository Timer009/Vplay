import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findBrowserExecutable } from './discover.mjs';
import { sanitizeBrowserEnv } from './env.mjs';
import { elementState, hitTest, clickAndWait, readText } from '../verification/assertions.mjs';
import { installNetworkGuard } from './guard.mjs';
import { VisionError, ERROR_CATEGORIES } from '../errors.mjs';

const require = createRequire(import.meta.url);

export function loadPlaywrightCore() {
  try {
    return require('playwright-core');
  } catch (error) {
    throw new VisionError(
      'playwright-core is not installed; install it or provide a host that supplies playwright-core',
      { category: ERROR_CATEGORIES.BROWSER, code: 'PLAYWRIGHT_MISSING', details: { cause: error.message } },
    );
  }
}

function contextOptions(viewport) {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    screen: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    isMobile: Boolean(viewport.isMobile),
    hasTouch: Boolean(viewport.hasTouch),
    locale: viewport.locale || 'zh-CN',
    ...(viewport.userAgent ? { userAgent: viewport.userAgent } : {}),
  };
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
}

/**
 * Create a browser runner. The caller supplies a URL (Vplay's preview server),
 * an adapter, and an output directory. No static/project server is created here.
 *
 * Browser launch uses a sanitized environment; model API keys are never passed
 * into the browser process.
 */
export function createBrowserRunner({
  executablePath = null,
  headless = true,
  launchArgs = [],
  env = process.env,
  timeoutMs = 30000,
  cookies = [],
} = {}) {
  const resolved = executablePath || findBrowserExecutable({ env });
  if (!resolved) {
    throw new VisionError(
      'no Chromium/Edge executable found; set VPLAY_BROWSER_EXECUTABLE or BROWSER_EXECUTABLE',
      { category: ERROR_CATEGORIES.BROWSER, code: 'BROWSER_NOT_FOUND' },
    );
  }

  async function runCapture({ url, adapter, scenario = 'default', outDir, captureId = '', allowedExtraOrigins = [] }) {
    if (!url) throw new Error('runCapture requires url');
    if (!adapter || !Array.isArray(adapter.viewports) || !adapter.viewports.length) {
      throw new Error('adapter.viewports is required');
    }
    if (typeof adapter.ready !== 'function' || typeof adapter.assert !== 'function') {
      throw new Error('adapter.ready and adapter.assert are required');
    }
    const { chromium } = loadPlaywrightCore();
    const started = Date.now();
    const browserEnv = sanitizeBrowserEnv(env);
    const browser = await chromium.launch({
      executablePath: resolved,
      headless,
      args: launchArgs,
      env: browserEnv,
    });
    const results = [];
    try {
      for (const viewport of adapter.viewports) {
        const viewportStarted = Date.now();
        const context = await browser.newContext({
          ...contextOptions(viewport),
          serviceWorkers: 'block',
          acceptDownloads: false,
        });
        // B10 / E06 B2：短期预览票据只注入浏览器内存上下文，不落盘、不进入页面文本。
        if (Array.isArray(cookies) && cookies.length) {
          await context.addCookies(cookies);
        }
        const guard = await installNetworkGuard({ context, previewUrl: url, allowedExtraOrigins });
        const page = await context.newPage();
        guard.setMainPage(page);
        page.setDefaultTimeout(timeoutMs);
        const cdp = await context.newCDPSession(page);
        const diagnostics = { console: [], pageErrors: [], requestFailures: [] };
        page.on('console', (msg) => {
          if (msg.type() === 'error' || msg.type() === 'warning') {
            diagnostics.console.push({ type: msg.type(), text: msg.text() });
          }
        });
        page.on('pageerror', (error) => diagnostics.pageErrors.push({ message: error.message }));
        page.on('requestfailed', (request) => diagnostics.requestFailures.push({
          url: request.url(),
          failure: request.failure()?.errorText || 'unknown',
        }));

        await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
        await adapter.ready(page, { viewport, scenario });
        if (typeof adapter.setup === 'function') await adapter.setup(page, { viewport, scenario });
        const screenshot = path.join(outDir, `${safeName(adapter.id || 'adapter')}-${safeName(viewport.name)}-${safeName(scenario)}${captureId ? `-${safeName(captureId)}` : ''}.png`);
        await fs.mkdir(path.dirname(screenshot), { recursive: true });
        const redaction = adapter.redaction || {};
        const masks = [];
        for (const selector of redaction.selectors || []) {
          const locator = page.locator(selector);
          const count = await locator.count();
          for (let i = 0; i < count; i += 1) masks.push(locator.nth(i));
        }
        const redactionIds = [];
        if (Array.isArray(redaction.regions) && redaction.regions.length) {
          await page.evaluate((regions) => {
            regions.forEach((region, index) => {
              const id = `__vplay_redaction_${index}`;
              const div = document.createElement('div');
              div.id = id;
              div.style.cssText = `position:fixed;left:${region.x}px;top:${region.y}px;width:${region.w}px;height:${region.h}px;background:#000;z-index:2147483647;pointer-events:none;`;
              document.body.appendChild(div);
            });
          }, redaction.regions);
          for (let i = 0; i < redaction.regions.length; i += 1) redactionIds.push(`__vplay_redaction_${i}`);
        }
        await page.screenshot({ path: screenshot, animations: 'disabled', ...(masks.length ? { mask: masks, maskColor: '#000' } : {}) });
        if (redactionIds.length) {
          await page.evaluate((ids) => ids.forEach((id) => document.getElementById(id)?.remove()), redactionIds);
        }
        const buffer = await fs.readFile(screenshot);
        const assertions = await adapter.assert({
          page,
          cdp,
          viewport,
          scenario,
          diagnostics,
          helpers: { elementState, hitTest, clickAndWait, readText, wait: (ms) => page.waitForTimeout(ms) },
        });
        assertions.push({
          id: 'page-errors',
          ok: diagnostics.pageErrors.length === 0,
          critical: true,
          detail: { count: diagnostics.pageErrors.length, errors: diagnostics.pageErrors },
        });
        const network = guard.summary();
        assertions.push({
          id: 'network-navigation-blocked',
          ok: network.navigationBlocked === 0,
          critical: true,
          detail: network,
        });
        assertions.push({
          id: 'network-external-blocked',
          ok: true,
          critical: false,
          detail: network,
        });
        const criticalFailures = assertions.filter((assertion) => assertion.critical !== false && !assertion.ok);
        results.push({
          viewport: viewport.name,
          screenshot,
          bytes: buffer.length,
          sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
          assertions,
          diagnostics,
          network,
          redaction: { selectors: redaction.selectors || [], regions: redaction.regions || [], maskedSelectors: masks.length },
          ok: criticalFailures.length === 0 && diagnostics.pageErrors.length === 0,
          durationMs: Date.now() - viewportStarted,
        });
        await context.close();
      }
      return {
        ok: results.every((result) => result.ok),
        adapterId: adapter.id || 'adapter',
        scenario,
        url,
        viewports: results,
        screenshots: results.map((result) => ({
          viewport: result.viewport,
          path: result.screenshot,
          bytes: result.bytes,
          sha256: result.sha256,
        })),
        browserVersion: browser.version(),
        executablePath: resolved,
        durationMs: Date.now() - started,
        browserEnvKeys: Object.keys(browserEnv).sort(),
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  return { runCapture, executablePath: resolved };
}

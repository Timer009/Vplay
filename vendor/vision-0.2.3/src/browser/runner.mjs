import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findBrowserExecutable } from './discover.mjs';
import { sanitizeBrowserEnv } from './env.mjs';
import { elementState, hitTest, clickAndWait, readText } from '../verification/assertions.mjs';
import { installNetworkGuard } from './guard.mjs';
import { VisionError, ERROR_CATEGORIES } from '../errors.mjs';
import { redactObject } from '../redaction.mjs';

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

const COOKIE_NAME = /^[A-Za-z0-9_]+$/;
const COOKIE_VALUE = /^[^\s;,\u0000-\u001f\u007f]+$/;

/**
 * E16 / C18 VN-08: the browser sandbox is not configurable in this candidate.
 * These arguments can disable or weaken Chromium's own sandbox; they are
 * rejected before Playwright is loaded or a browser is launched. There is no
 * retry/fallback path that removes them.
 */
const SANDBOX_FORBIDDEN_ARGS = Object.freeze([
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox',
  '--disable-seccomp-filter-sandbox',
  '--disable-namespace-sandbox',
  '--single-process',
  '--no-zygote',
]);

const SANDBOX_ENV_KEYS = new Set([
  'VPLAY_DISABLE_SANDBOX',
  'PLAYWRIGHT_DISABLE_SANDBOX',
  'CHROMIUM_DISABLE_SANDBOX',
  'CHROME_DISABLE_SANDBOX',
  'VPLAY_BROWSER_ARGS',
  'PLAYWRIGHT_CHROMIUM_ARGS',
  'CHROMIUM_FLAGS',
  'CHROME_FLAGS',
]);

function isForbiddenSandboxArg(value) {
  const arg = String(value).trim();
  return SANDBOX_FORBIDDEN_ARGS.some((forbidden) => arg === forbidden || arg.startsWith(`${forbidden}=`));
}

function sandboxBypassError(message, details = null) {
  return new VisionError(message, {
    category: ERROR_CATEGORIES.BROWSER,
    retryable: false,
    code: 'BROWSER_SANDBOX_BYPASS',
    details,
  });
}

/**
 * Validate launch inputs at construction time. This deliberately fails before
 * browser discovery/launch, so an invalid configuration cannot produce a
 * sandbox-disabled process or trigger a fallback.
 */
function validateSandboxLaunchInputs({ launchArgs, env }) {
  if (!Array.isArray(launchArgs)) {
    throw sandboxBypassError('launchArgs must be an array; browser sandbox cannot be configured by non-array input');
  }
  const forbidden = launchArgs.filter((arg) => isForbiddenSandboxArg(arg));
  if (forbidden.length) {
    throw sandboxBypassError('browser sandbox cannot be disabled by launchArgs', { arguments: forbidden.map(String) });
  }
  for (const [key, value] of Object.entries(env || {})) {
    if (!SANDBOX_ENV_KEYS.has(key)) continue;
    if (/^(1|true|yes|on)$/i.test(String(value || ''))) {
      throw sandboxBypassError(`browser sandbox cannot be disabled by environment variable: ${key}`, { variable: key });
    }
    if (/(^|\s)--(?:no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|single-process|no-zygote)(?:=|\s|$)/i.test(String(value || ''))) {
      throw sandboxBypassError(`browser sandbox bypass argument is not allowed in environment variable: ${key}`, { variable: key });
    }
  }
  return launchArgs.slice();
}

/**
 * Minimal-privilege preview authentication (E07).
 *
 * The caller passes a single cookie value in memory (normally the preview
 * access hash, never the raw key). It is scoped to the preview origin and the
 * preview path, never exposed as an option to Playwright `storageState` files,
 * never written to disk, and never included in results/errors/logs.
 */
export function normalizePreviewAuth(previewAuth, previewUrl) {
  if (!previewAuth) return null;
  let parsed;
  try {
    parsed = new URL(String(previewUrl));
  } catch {
    throw new VisionError('previewUrl must be a valid http(s) URL for preview auth', {
      category: ERROR_CATEGORIES.CONFIG,
      code: 'INVALID_PREVIEW_URL',
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new VisionError('preview auth requires an http(s) preview origin', {
      category: ERROR_CATEGORIES.CONFIG,
      code: 'INVALID_PREVIEW_URL',
    });
  }
  const name = String(previewAuth.name || 'vplay_preview');
  if (!COOKIE_NAME.test(name)) {
    throw new VisionError('preview auth cookie name is invalid', {
      category: ERROR_CATEGORIES.CONFIG,
      code: 'PREVIEW_AUTH_INVALID',
    });
  }
  const value = String(previewAuth.value ?? '');
  if (!value || !COOKIE_VALUE.test(value)) {
    // Deliberately never echo the value.
    throw new VisionError('preview auth cookie value is missing or contains invalid characters', {
      category: ERROR_CATEGORIES.CONFIG,
      code: 'PREVIEW_AUTH_INVALID',
    });
  }
  const scope = String(previewAuth.path || parsed.pathname || '/');
  if (!scope.startsWith('/') || scope.includes('..') || scope.includes('\\')) {
    throw new VisionError('preview auth path must be an absolute preview path without dot segments', {
      category: ERROR_CATEGORIES.CONFIG,
      code: 'PREVIEW_AUTH_INVALID',
    });
  }
  const path = scope.endsWith('/') ? scope : `${scope}/`;
  return {
    name,
    value,
    // `url` scopes the cookie to this exact origin + path; no domain wildcard.
    url: `${parsed.origin}${path}`,
    sameSite: 'Strict',
    httpOnly: true,
    secure: parsed.protocol === 'https:',
    path,
  };
}

function redactCapture(value) {
  return redactObject(value);
}

/**
 * Create a browser runner. The caller supplies a URL (Vplay's preview server),
 * an adapter, and an output directory. No static/project server is created here.
 *
 * Browser launch uses a sanitized environment; model API keys are never passed
 * into the browser process.
 *
 * E16: the Chromium sandbox is enforced unconditionally. A launch failure is
 * propagated to the caller; this function never retries with --no-sandbox or
 * falls back to an unsandboxed browser.
 */
export function createBrowserRunner({
  executablePath = null,
  headless = true,
  launchArgs = [],
  env = process.env,
  timeoutMs = 30000,
  previewAuth = null,
} = {}) {
  const safeLaunchArgs = validateSandboxLaunchInputs({ launchArgs, env });
  const resolved = executablePath || findBrowserExecutable({ env });
  if (!resolved) {
    throw new VisionError(
      'no Chromium/Edge executable found; set VPLAY_BROWSER_EXECUTABLE or BROWSER_EXECUTABLE',
      { category: ERROR_CATEGORIES.BROWSER, code: 'BROWSER_NOT_FOUND' },
    );
  }

  async function runCapture({ url, adapter, scenario = 'default', outDir, captureId = '', allowedExtraOrigins = [], previewAuth: perCaptureAuth = null }) {
    if (!url) throw new Error('runCapture requires url');
    if (!adapter || !Array.isArray(adapter.viewports) || !adapter.viewports.length) {
      throw new Error('adapter.viewports is required');
    }
    if (typeof adapter.ready !== 'function' || typeof adapter.assert !== 'function') {
      throw new Error('adapter.ready and adapter.assert are required');
    }
    // Resolve once; the raw value never leaves this closure.
    const auth = normalizePreviewAuth(perCaptureAuth || previewAuth, url);
    const { chromium } = loadPlaywrightCore();
    const started = Date.now();
    const browserEnv = sanitizeBrowserEnv(env);
    const browser = await chromium.launch({
      executablePath: resolved,
      headless,
      // E16 / C18 VN-08: explicit and unconditional. Playwright only omits
      // --no-sandbox when this value is exactly true. Do not make this
      // configurable and do not retry with sandbox disabled.
      chromiumSandbox: true,
      args: safeLaunchArgs,
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
        if (auth) {
          // In-memory, host+path scoped cookie; no storageState file.
          await context.addCookies([{
            name: auth.name,
            value: auth.value,
            url: auth.url,
            sameSite: auth.sameSite,
            httpOnly: auth.httpOnly,
            secure: auth.secure,
          }]);
        }
        const guard = await installNetworkGuard({ context, previewUrl: url, allowedExtraOrigins });
        const page = await context.newPage();
        guard.setMainPage(page);
        page.setDefaultTimeout(timeoutMs);
        const cdp = await context.newCDPSession(page);
        // E10: server-side redirects bypass context.route; CDP Fetch pauses
        // document requests (including redirect targets) and fails closed.
        await guard.enableRedirectGuard(cdp);
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

        try {
          await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
        } catch (error) {
          const redirect = guard.summary().blocked.find((entry) => entry.reason === 'redirect-document');
          if (redirect) {
            throw new VisionError('navigation was blocked: redirect left the preview origin', {
              category: ERROR_CATEGORIES.BROWSER,
              code: 'REDIRECT_OUT_OF_SCOPE',
              details: { blocked: redirect },
            });
          }
          throw error;
        }
        const expected = new URL(url);
        const finalUrl = new URL(page.url());
        const previewPath = guard.summary().previewPath;
        if (finalUrl.origin !== expected.origin || !finalUrl.pathname.startsWith(previewPath)) {
          guard.recordNavigation({
            url: page.url(),
            resourceType: 'document',
            isNavigation: true,
            reason: 'navigation-path',
          });
          throw new VisionError('navigation left the preview project path', {
            category: ERROR_CATEGORIES.BROWSER,
            code: 'NAVIGATION_OUT_OF_SCOPE',
            details: { url: page.url(), expectedPrefix: previewPath },
          });
        }
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
          // Redact diagnostics/URLs: console errors and blocked URLs can carry
          // secrets or preview cookies and must not reach evidence files.
          assertions: redactCapture(assertions),
          diagnostics: redactCapture(diagnostics),
          network: redactCapture(network),
          redaction: {
            selectors: redaction.selectors || [],
            regions: redaction.regions || [],
            maskedSelectors: masks.length,
            previewAuth: auth ? { cookieName: auth.name, path: auth.path, injected: true } : null,
          },
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
        previewAuth: auth ? { cookieName: auth.name, path: auth.path, injected: true } : null,
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  return { runCapture, executablePath: resolved };
}

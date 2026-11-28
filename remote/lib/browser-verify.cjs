'use strict';

/**
 * B23 P1：code_change 的真实浏览器验证（独立于 Vision 0.2.2）。
 *
 * - 强制 `chromiumSandbox: true`，不接受任何 no-sandbox 降级；
 * - 只访问本机预览（127.0.0.1:<previewPort>/p/<projectId>/）；
 * - 需要 preview 鉴权时由控制面签发短期票据，经 cookie 注入；
 * - 只收集 pageerror / console.error / HTTP 状态，不执行项目外的任何脚本；
 * - 未安装 playwright 或浏览器启动失败 → 失败关闭（调用方必须回滚变更）。
 */

const { parseBrowserArgs } = require('./linux-config.cjs');

function previewUrl(previewPort, projectId) {
  return `http://127.0.0.1:${Number(previewPort)}/p/${encodeURIComponent(projectId)}/`;
}

function createBrowserVerifier(options = {}) {
  const previewPort = Number(options.previewPort || process.env.PREVIEW_PORT || 8788);
  const executablePath =
    options.executablePath || process.env.VPLAY_BROWSER_EXECUTABLE || undefined;
  const headless = String(process.env.VPLAY_BROWSER_HEADLESS || 'true') !== 'false';
  const timeoutMs = Number(options.timeoutMs || 20000);

  return async function verify({ projectId, previewCookie = null, taskId = null } = {}) {
    let chromium;
    try {
      ({ chromium } = await import('playwright-core'));
    } catch (error) {
      return {
        ok: false,
        reason: 'PLAYWRIGHT_UNAVAILABLE',
        error: error.message,
        url: previewUrl(previewPort, projectId),
      };
    }
    let args;
    try {
      args = parseBrowserArgs(process.env.VPLAY_BROWSER_ARGS);
    } catch (error) {
      return { ok: false, reason: 'BROWSER_ARGS_REJECTED', error: error.message };
    }
    let browser = null;
    const pageErrors = [];
    const consoleErrors = [];
    const url = previewUrl(previewPort, projectId);
    try {
      browser = await chromium.launch({
        executablePath,
        headless,
        // E16 原则：硬编码 sandbox，不提供关闭开关。
        chromiumSandbox: true,
        args,
        timeout: timeoutMs,
      });
      const context = await browser.newContext();
      if (previewCookie) {
        await context.addCookies([
          {
            name: 'vplay_preview',
            value: String(previewCookie),
            domain: '127.0.0.1',
            path: '/',
            httpOnly: true,
            sameSite: 'Strict',
          },
        ]);
      }
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push(String(error.message || error).slice(0, 300)));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
      });
      const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      await page.waitForTimeout(400);
      const status = response ? response.status() : null;
      await browser.close();
      browser = null;
      const ok = status === 200 && pageErrors.length === 0 && consoleErrors.length === 0;
      return {
        ok,
        reason: ok ? null : 'BROWSER_CHECK_FAILED',
        url,
        projectId,
        taskId,
        status,
        pageErrors,
        consoleErrors,
        sandbox: 'chromiumSandbox:true',
      };
    } catch (error) {
      if (browser) {
        try {
          await browser.close();
        } catch {
          // 忽略
        }
      }
      return {
        ok: false,
        reason: 'BROWSER_LAUNCH_FAILED',
        error: String(error.message || error).slice(0, 400),
        url,
      };
    }
  };
}

module.exports = { createBrowserVerifier, previewUrl };

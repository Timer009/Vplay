import { VisionError, ERROR_CATEGORIES } from '../errors.mjs';

function originOf(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function allowedNonHttp(protocol, resourceType) {
  if (protocol !== 'data:' && protocol !== 'blob:') return false;
  return resourceType === 'image' || resourceType === 'font' || resourceType === 'media';
}

/**
 * Browser egress guard (C07-P1-10 / P0-05).
 *
 * Only the preview origin may be contacted. data:/blob: are allowed only for
 * passive image/font/media resources. All other requests are aborted before
 * the network, and the attempt is recorded as evidence. New pages/popups,
 * downloads, dialogs, WebSockets and sendBeacon are blocked.
 */
export async function installNetworkGuard({
  context,
  previewUrl,
  allowedExtraOrigins = [],
  maxBlocked = 100,
  stripCookiesFromExtraOrigins = true,
}) {
  const previewOrigin = originOf(previewUrl);
  if (!previewOrigin) {
    throw new VisionError('previewUrl must be an http(s) origin', {
      category: ERROR_CATEGORIES.CONFIG,
      code: 'INVALID_PREVIEW_URL',
    });
  }
  const allowedOrigins = new Set([previewOrigin, ...allowedExtraOrigins.map((item) => originOf(item)).filter(Boolean)]);
  const blocked = [];
  const redirects = [];
  let mainPage = null;

  const record = (entry) => {
    if (blocked.length < maxBlocked) blocked.push(entry);
  };

  /**
   * B13 预请求重定向边界：
   * Playwright route 对“服务端 302 → 外部 origin”不再触发，因此这里用
   * route.fetch({maxRedirects:0}) 自己检查每一跳；外部 Location 直接 abort，
   * 浏览器不会发出该请求。最终 URL 检查仍保留作为纵深防御。
   */
  async function fetchWithRedirectCheck(route, request) {
    const method = request.method();
    const followable = method === 'GET' || method === 'HEAD';
    const seen = new Set([request.url()]);
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0 });
    } catch (error) {
      record({
        url: request.url(),
        resourceType: request.resourceType(),
        isNavigation: request.isNavigationRequest(),
        reason: `fetch-failed:${error.message}`,
      });
      await route.abort('blockedbyclient');
      return;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const status = response.status();
      if (!(status >= 300 && status < 400)) break;
      const location = response.headers().location;
      if (!location) {
        record({ url: request.url(), resourceType: request.resourceType(), isNavigation: request.isNavigationRequest(), reason: 'redirect-without-location' });
        await route.abort('blockedbyclient');
        return;
      }
      let target;
      try {
        target = new URL(location, response.url()).href;
      } catch {
        record({ url: request.url(), resourceType: request.resourceType(), isNavigation: request.isNavigationRequest(), reason: 'redirect-invalid' });
        await route.abort('blockedbyclient');
        return;
      }
      const targetOrigin = originOf(target);
      if (!followable || !targetOrigin || !allowedOrigins.has(targetOrigin)) {
        redirects.push({ from: request.url(), to: target, reason: 'origin' });
        record({
          url: target,
          resourceType: request.resourceType(),
          isNavigation: request.isNavigationRequest(),
          reason: 'redirect-external',
        });
        await route.abort('blockedbyclient');
        return;
      }
      if (seen.has(target)) {
        record({ url: target, resourceType: request.resourceType(), isNavigation: request.isNavigationRequest(), reason: 'redirect-loop' });
        await route.abort('blockedbyclient');
        return;
      }
      seen.add(target);
      try {
        response = await route.fetch({ url: target, maxRedirects: 0 });
      } catch {
        record({ url: target, resourceType: request.resourceType(), isNavigation: request.isNavigationRequest(), reason: 'redirect-fetch-failed' });
        await route.abort('blockedbyclient');
        return;
      }
      redirects.push({ from: request.url(), to: target, allowed: true, origin: targetOrigin || null });
    }
    if (response.status() >= 300 && response.status() < 400) {
      record({ url: request.url(), resourceType: request.resourceType(), isNavigation: request.isNavigationRequest(), reason: 'redirect-too-many' });
      await route.abort('blockedbyclient');
      return;
    }
    await route.fulfill({ response });
  }

  await context.addInitScript(() => {
    // Network primitives that are not reliably covered by route interception.
    try {
      Object.defineProperty(window, 'open', { value: () => null, configurable: true });
    } catch { /* ignore */ }
    try {
      // Same-origin WebSocket is not needed by Vplay games; block all.
      window.WebSocket = class BlockedWebSocket {
        constructor() { throw new Error('WebSocket blocked by Vision network policy'); }
      };
    } catch { /* ignore */ }
    try {
      navigator.sendBeacon = () => false;
    } catch { /* ignore */ }
    try {
      HTMLFormElement.prototype.submit = function blockedSubmit() {
        throw new Error('form submit blocked by Vision network policy');
      };
    } catch { /* ignore */ }
  });

  await context.route('**/*', async (route) => {
    const request = route.request();
    let parsed;
    try {
      parsed = new URL(request.url());
    } catch {
      record({ url: request.url(), resourceType: request.resourceType(), isNavigation: request.isNavigationRequest(), reason: 'invalid-url' });
      await route.abort('blockedbyclient');
      return;
    }
    const resourceType = request.resourceType();
    // A subframe document request also reports isNavigationRequest()===true.
    // Only main-frame document navigation should fail the critical navigation
    // assertion; subframes are still blocked but recorded separately.
    const isNavigation = request.isNavigationRequest();
    let mainFrameNavigation = false;
    if (isNavigation) {
      try {
        const frame = request.frame();
        mainFrameNavigation = Boolean(frame && frame.page() && frame === frame.page().mainFrame());
      } catch {
        // Unknown frame for a navigation request: fail closed.
        mainFrameNavigation = true;
      }
    }
    const sameOrigin = allowedOrigins.has(parsed.origin);
    const allow = (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      ? sameOrigin
      : allowedNonHttp(parsed.protocol, resourceType);
    if (!allow) {
      record({
        url: request.url(),
        resourceType,
        isNavigation: mainFrameNavigation,
        subframe: isNavigation && !mainFrameNavigation,
        reason: sameOrigin ? 'scheme/type' : 'origin',
      });
      await route.abort('blockedbyclient');
      return;
    }
    // B13：预览源的每个请求先在宿主侧解析重定向；外部 Location 在请求前阻断
    if (sameOrigin) {
      await fetchWithRedirectCheck(route, request);
      return;
    }
    // Defense in depth: never forward preview credentials to an allowed
    // non-preview origin (extra origins are rare; preview auth is host-scoped).
    if (stripCookiesFromExtraOrigins && parsed.origin !== previewOrigin) {
      try {
        const headers = await request.allHeaders();
        delete headers.cookie;
        delete headers.authorization;
        await route.continue({ headers });
        return;
      } catch {
        // Fall through to a plain continue; the URL is not the preview origin.
      }
    }
    await route.continue();
  });

  context.on('page', (page) => {
    if (!mainPage) {
      mainPage = page;
      return;
    }
    record({ url: page.url(), resourceType: 'document', isNavigation: true, reason: 'new-page' });
    page.close().catch(() => {});
  });

  return {
    previewOrigin,
    blocked,
    setMainPage(page) {
      mainPage = page;
      page.on('popup', (popup) => {
        record({ url: popup.url(), resourceType: 'document', isNavigation: true, reason: 'popup' });
        popup.close().catch(() => {});
      });
      page.on('download', (download) => {
        record({ url: download.url(), resourceType: 'download', isNavigation: false, reason: 'download' });
        download.cancel().catch(() => {});
      });
      page.on('dialog', (dialog) => {
        record({ url: page.url(), resourceType: 'dialog', isNavigation: false, reason: 'dialog' });
        dialog.dismiss().catch(() => {});
      });
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame() && frame.url() && frame.url() !== 'about:blank') {
          const origin = originOf(frame.url());
          if (!origin || !allowedOrigins.has(origin)) {
            record({ url: frame.url(), resourceType: 'document', isNavigation: true, reason: 'frame-navigation' });
            // 纵深防御：最终 URL 已越界时立即关闭页面，避免继续执行/截图
            page.close().catch(() => {});
          }
        }
      });
    },
    summary() {
      return {
        previewOrigin,
        blockedCount: blocked.length,
        blocked: [...blocked],
        navigationBlocked: blocked.filter((entry) => entry.isNavigation).length,
        redirectChecks: redirects.length,
        redirectBlocked: redirects.filter((entry) => entry.allowed === false || entry.reason === 'origin').length,
        redirects: [...redirects],
      };
    },
  };
}

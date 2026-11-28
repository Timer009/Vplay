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
  const previewPathPrefix = (() => {
    try {
      const pathname = new URL(String(previewUrl)).pathname;
      return pathname.endsWith('/') ? pathname : `${pathname}/`;
    } catch {
      return '/';
    }
  })();
  const blocked = [];
  let mainPage = null;

  const record = (entry) => {
    if (blocked.length < maxBlocked) blocked.push(entry);
  };

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
            return;
          }
          // Same-origin but outside the project's preview prefix: close before
          // any adapter/screenshot can observe another project's page.
          try {
            const parsed = new URL(frame.url());
            if (!parsed.pathname.startsWith(previewPathPrefix)) {
              record({ url: frame.url(), resourceType: 'document', isNavigation: true, reason: 'frame-path' });
            }
          } catch {
            record({ url: frame.url(), resourceType: 'document', isNavigation: true, reason: 'frame-navigation' });
            page.close().catch(() => {});
          }
        }
      });
    },
    recordNavigation(entry) {
      record(entry);
    },
    /**
     * E10: CDP Fetch intercepts server-side redirects, which Playwright's
     * context.route does not see. Only document requests are paused; the
     * existing route still handles subresources and records evidence.
     */
    async enableRedirectGuard(cdp) {
      if (!cdp || typeof cdp.send !== 'function' || typeof cdp.on !== 'function') {
        throw new VisionError('CDP session is required for redirect boundary', {
          category: ERROR_CATEGORIES.BROWSER,
          code: 'REDIRECT_GUARD_UNAVAILABLE',
        });
      }
      try {
        await cdp.send('Fetch.enable', {
          patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
        });
      } catch (error) {
        throw new VisionError(`redirect boundary unavailable: ${error.message}`, {
          category: ERROR_CATEGORIES.BROWSER,
          code: 'REDIRECT_GUARD_UNAVAILABLE',
        });
      }
      const onPaused = async (event) => {
        let parsed = null;
        try { parsed = new URL(event.request.url); } catch { parsed = null; }
        const aboutBlank = parsed && parsed.protocol === 'about:' && parsed.pathname === 'blank';
        const allowed = Boolean(
          aboutBlank
          || (parsed && ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === previewOrigin),
        );
        try {
          if (allowed) {
            await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
          } else {
            record({ url: event.request.url, resourceType: 'document', isNavigation: true, reason: 'redirect-document' });
            await cdp.send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: 'BlockedByClient',
            });
          }
        } catch {
          // Fail closed if CDP rejects the command.
          try {
            await cdp.send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: 'BlockedByClient',
            });
          } catch {
            // Session may already be closed.
          }
        }
      };
      cdp.on('Fetch.requestPaused', onPaused);
      return {
        async disable() {
          try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
        },
      };
    },
    summary() {
      return {
        previewOrigin,
        previewPath: previewPathPrefix,
        blockedCount: blocked.length,
        blocked: [...blocked],
        navigationBlocked: blocked.filter((entry) => entry.isNavigation).length,
      };
    },
  };
}

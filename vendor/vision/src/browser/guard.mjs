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
    const isNavigation = request.isNavigationRequest();
    const sameOrigin = allowedOrigins.has(parsed.origin);
    const allow = (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      ? sameOrigin
      : allowedNonHttp(parsed.protocol, resourceType);
    if (!allow) {
      record({
        url: request.url(),
        resourceType,
        isNavigation,
        reason: sameOrigin ? 'scheme/type' : 'origin',
      });
      await route.abort('blockedbyclient');
      return;
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
      };
    },
  };
}

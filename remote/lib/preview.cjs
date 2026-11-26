'use strict';

/**
 * 游戏预览服务（独立源）。
 *
 * 为什么单独一个端口：控制面（/ console、/prompt、/tasks）与预览面必须不同源。
 * 浏览器 Cookie 不区分端口，所以仅靠「换端口」不能防 CSRF —— 控制面的写接口
 * 另外做了 Origin 校验（见 server.cjs）。预览面本身不带任何鉴权与管理接口，
 * 只读静态文件。
 *
 * 硬化点：
 *  - 只允许 GET/HEAD
 *  - 拒绝点文件（.env/.git/.opengame）
 *  - 拒绝 ../ 与编码穿越
 *  - realpath 后二次边界校验，挡住 symlink/junction 逃逸
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { resolveStaticFile } = require('./paths.cjs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  sendText(res, status, JSON.stringify(payload, null, 2), 'application/json; charset=utf-8');
}

function createPreviewServer(options) {
  const projects = options.projects;
  const legacyRoot = options.legacyRoot || null;
  const allowedHosts = options.allowedHosts || null;
  const logger = options.logger || ((line) => console.log(line));

  const server = http.createServer((req, res) => {
    try {
      const method = req.method || 'GET';
      // NEW-01 / OBS-01：不信任 Host 解析 URL，且补上预览面 Host 白名单
      const rawUrl = String(req.url || '/');
      const qIndex = rawUrl.indexOf('?');
      const pathname = ((qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl).replace(/\/+$/, '')) || '/';

      if (allowedHosts) {
        const hostname = String(req.headers.host || '')
          .replace(/:\d+$/, '')
          .replace(/^\[|\]$/g, '')
          .toLowerCase();
        if (!hostname || !allowedHosts.has(hostname)) {
          sendJson(res, 400, { ok: false, error: 'host not allowed' });
          return;
        }
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }

      if (pathname === '/health') {
        sendJson(res, 200, { ok: true, service: 'vplay-preview', auth: 'none' });
        return;
      }

      // 单工作区模式：只暴露一个 legacy 根目录
      if (pathname === '/legacy' || pathname.startsWith('/legacy/')) {
        if (!legacyRoot) {
          sendJson(res, 404, { ok: false, error: 'legacy preview is not configured' });
          return;
        }
        const rest = pathname.replace(/^\/legacy/, '') || '/';
        const resolved = resolveStaticFile(legacyRoot, rest);
        if (!resolved.ok) {
          sendJson(res, resolved.status, {
            ok: false,
            error: resolved.status === 403 ? 'forbidden' : 'not found',
          });
          return;
        }
        fs.readFile(resolved.file, (error, data) => {
          if (error) {
            sendJson(res, 404, { ok: false, error: 'not found' });
            return;
          }
          const ext = path.extname(resolved.file).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': data.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'X-Frame-Options': 'SAMEORIGIN',
            'Content-Security-Policy': "frame-ancestors 'self'",
          });
          res.end(method === 'HEAD' ? undefined : data);
        });
        return;
      }

      const match = /^\/p\/([a-z0-9][a-z0-9-]{1,39})(\/.*)?$/.exec(pathname);
      if (!match) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const projectId = match[1];
      const rest = match[2] || '/';

      let root;
      try {
        root = projects.previewRoot(projectId);
      } catch {
        sendJson(res, 404, { ok: false, error: 'unknown project' });
        return;
      }
      if (!root) {
        sendJson(res, 409, {
          ok: false,
          error: 'preview not built',
          detail: 'Vite 项目需要先产出 dist/，或该项目缺少入口文件',
        });
        return;
      }

      const resolved = resolveStaticFile(root, rest);
      if (!resolved.ok) {
        sendJson(res, resolved.status, {
          ok: false,
          error: resolved.status === 403 ? 'forbidden' : 'not found',
        });
        return;
      }

      fs.readFile(resolved.file, (error, data) => {
        if (error) {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const ext = path.extname(resolved.file).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'X-Frame-Options': 'SAMEORIGIN',
          'Content-Security-Policy': "frame-ancestors 'self'",
        });
        res.end(method === 'HEAD' ? undefined : data);
      });
    } catch (error) {
      // 任何解析/处理异常都只影响当前请求
      try {
        if (!res.headersSent) sendJson(res, 400, { ok: false, error: 'bad request' });
      } catch {
        // 连接可能已断开
      }
      logger(`[preview] request error: ${error.message}`);
    }
  });

  server.on('clientError', (error, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch {
      // 忽略
    }
  });

  server.on('error', (error) => logger(`[preview] error: ${error.message}`));
  return server;
}

module.exports = { createPreviewServer };

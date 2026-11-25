#!/usr/bin/env node
/**
 * OpenGame remote bridge — minimal forwarding skeleton (no UI).
 *
 * Endpoints:
 *   GET  /console  -> mobile web console (remote/index.html)
 *   GET  /status   -> { phase, message }        (read from .opengame/runtime-status.json)
 *   POST /prompt   -> append { text } to .opengame/queue.json
 *   GET  /artifact -> { indexHtml, url }        (latest generated game entry point)
 *   GET  /*        -> static file serving of the active game workspace
 *
 * Config (env or CLI flags):
 *   REMOTE_PORT / --port           default 8787
 *   OPENGAME_WORKSPACE / --workspace   default process.cwd()
 *
 * This server never starts generation; it only forwards state and instructions.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

function readFlag(argv, name) {
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

const argv = process.argv.slice(2);
const PORT = Number(readFlag(argv, 'port') || process.env.REMOTE_PORT || 8787);
const WORKSPACE = path.resolve(
  readFlag(argv, 'workspace') || process.env.OPENGAME_WORKSPACE || process.cwd(),
);
const RUNTIME_DIR = path.join(WORKSPACE, '.opengame');
const STATUS_FILE = path.join(RUNTIME_DIR, 'runtime-status.json');
const QUEUE_FILE = path.join(RUNTIME_DIR, 'queue.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function readStatus() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
    return {
      phase: parsed.phase || 'idle',
      message: String(parsed.message || ''),
      workspace: parsed.workspace
        ? path.resolve(parsed.workspace)
        : WORKSPACE,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return { phase: 'idle', message: 'no generation started yet', workspace: WORKSPACE };
  }
}

function activeWorkspace(status) {
  return status.workspace || WORKSPACE;
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function appendToQueue(text) {
  ensureRuntimeDir();
  let queue = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    if (Array.isArray(parsed)) queue = parsed;
  } catch {
    queue = [];
  }
  queue.push({ text, createdAt: new Date().toISOString() });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
  return queue.length;
}

function serveStatic(res, rootDir, urlPath) {
  const relative = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = path
    .normalize(relative === '/' ? '/index.html' : relative)
    .replace(/^([/\\])+/, '');
  const target = path.resolve(rootDir, normalized);
  if (!target.startsWith(path.resolve(rootDir))) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'not found', path: target });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.split('?')[0].replace(/\/$/, '') === '/console') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        sendJson(res, 500, { error: 'console page missing: remote/index.html' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && url.startsWith('/status')) {
    const status = readStatus();
    sendJson(res, 200, { phase: status.phase, message: status.message });
    return;
  }

  if (req.method === 'POST' && url.startsWith('/prompt')) {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      let text = '';
      try {
        const parsed = JSON.parse(raw || '{}');
        text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      } catch {
        text = '';
      }
      if (!text) {
        sendJson(res, 400, { ok: false, error: 'body must be JSON: { "text": "..." }' });
        return;
      }
      const queued = appendToQueue(text);
      console.log(`[remote] prompt queued (${queued} pending): ${text}`);
      sendJson(res, 200, { ok: true, queued });
    });
    return;
  }

  if (req.method === 'GET' && url.startsWith('/artifact')) {
    const status = readStatus();
    const workspace = activeWorkspace(status);
    const indexHtml = path.join(workspace, 'index.html');
    if (!fs.existsSync(indexHtml)) {
      sendJson(res, 404, {
        ok: false,
        error: 'no generated index.html yet',
        workspace,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      workspace,
      indexHtml,
      url: `http://${req.headers.host || `localhost:${PORT}`}/`,
    });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(res, activeWorkspace(readStatus()), url);
    return;
  }

  sendJson(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[remote] OpenGame remote bridge listening on http://0.0.0.0:${PORT}`);
  console.log(`[remote] workspace: ${WORKSPACE}`);
  console.log(`[remote] mobile console: http://<本机局域网IP>:${PORT}/console`);
  console.log('[remote] GET /console | GET /status | POST /prompt | GET /artifact | GET /* (static)');
});

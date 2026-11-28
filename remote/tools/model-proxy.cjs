#!/usr/bin/env node
'use strict';

/**
 * 最小模型凭据代理（C18 P-5 / B20）。
 *
 * - 真实模型 Key 只从 0600 文件读取，绝不出现在命令行/日志/响应；
 * - Vplay/Agent 只持有一次性 run token（--token-file）与 loopback URL；
 * - 仅允许 POST /v1/chat/completions（或 /chat/completions），模型白名单；
 * - 限制请求次数、请求体大小；非流式响应可校验 usage tokens；
 * - 默认监听 127.0.0.1:18790（与 C18 统一，替代 B19 的 18900 示例）。
 *
 * 不做 DNS/网络级出口控制；systemd/eBPF 由部署层负责。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');

function readFlag(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function readSecret(file, envName) {
  if (file) return fs.readFileSync(file, 'utf8').trim();
  const value = process.env[envName];
  return value ? String(value).trim() : '';
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createModelProxy(options = {}) {
  const upstream = new URL(options.upstream || 'http://127.0.0.1:9/v1');
  const realKey = String(options.realKey || '');
  const runToken = String(options.runToken || '');
  const models = new Set((options.models || []).map((item) => String(item).trim()).filter(Boolean));
  const maxRequests = Number(options.maxRequests || 20);
  const maxBodyBytes = Number(options.maxBodyBytes || 1024 * 1024);
  const maxTokens = Number(options.maxTokens || 0);
  const logger = options.logger || (() => {});
  let requests = 0;
  let tokens = 0;

  function fail(res, status, code) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code, message: code } }));
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!['/v1/chat/completions', '/chat/completions'].includes(url.pathname)) {
      return fail(res, 404, 'path_not_allowed');
    }
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!runToken || !timingSafeEqual(bearer, runToken)) {
      return fail(res, 401, 'invalid_run_token');
    }

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        fail(res, 413, 'request_too_large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return fail(res, 400, 'invalid_json');
      }
      if (models.size > 0 && !models.has(String(body.model || ''))) {
        return fail(res, 400, 'model_not_allowed');
      }
      if (requests >= maxRequests) return fail(res, 429, 'request_budget_exhausted');
      requests += 1;
      const stream = body.stream === true;
      const payload = Buffer.from(JSON.stringify(body));
      const basePath = upstream.pathname.replace(/\/+$/, '');
      const targetPath = basePath.endsWith('/v1')
        ? `${basePath}/chat/completions`
        : url.pathname;
      const target = new URL(`${targetPath}${url.search}`, upstream.origin);
      const transport = target.protocol === 'https:' ? https : http;
      const headers = {
        'content-type': 'application/json',
        'content-length': payload.length,
        authorization: `Bearer ${realKey}`,
        accept: stream ? 'text/event-stream' : 'application/json',
      };
      const upstreamReq = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: target.pathname + target.search,
          method: 'POST',
          headers,
          timeout: 120000,
        },
        (upstreamRes) => {
          if (stream) {
            res.writeHead(upstreamRes.statusCode || 502, {
              'content-type': upstreamRes.headers['content-type'] || 'text/event-stream',
              'cache-control': 'no-cache',
            });
            upstreamRes.pipe(res);
            logger(`proxy: stream status=${upstreamRes.statusCode} model=${body.model}`);
            return;
          }
          const out = [];
          upstreamRes.on('data', (chunk) => out.push(chunk));
          upstreamRes.on('end', () => {
            const responseBody = Buffer.concat(out);
            try {
              const parsed = JSON.parse(responseBody.toString('utf8'));
              const used = Number(parsed && parsed.usage && parsed.usage.total_tokens);
              if (Number.isFinite(used)) tokens += used;
            } catch {
              // 非 JSON 响应不计数
            }
            if (maxTokens > 0 && tokens > maxTokens) {
              return fail(res, 429, 'token_budget_exhausted');
            }
            res.writeHead(upstreamRes.statusCode || 502, {
              'content-type': upstreamRes.headers['content-type'] || 'application/json',
            });
            res.end(responseBody);
            logger(`proxy: request status=${upstreamRes.statusCode} model=${body.model} tokens=${tokens}`);
          });
        },
      );
      upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
      upstreamReq.on('error', () => fail(res, 502, 'upstream_error'));
      upstreamReq.end(payload);
    });
  });

  return {
    server,
    upstream: `${upstream.origin}${upstream.pathname}`,
    summary: () => ({ requests, tokens, maxRequests, maxTokens, models: [...models] }),
    listen(port = 18790, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, resolve));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) {
    console.log(
      'usage: node remote/tools/model-proxy.cjs --upstream <url> --key-file <0600> ' +
      '--token-file <0600> [--models m1,m2] [--port 18790] [--max-requests 20] ' +
      '[--max-body-bytes 1048576] [--max-tokens 0]',
    );
    process.exit(0);
  }
  const realKey = readSecret(readFlag(argv, 'key-file'), 'VPLAY_PROXY_REAL_KEY');
  const runToken = readSecret(readFlag(argv, 'token-file'), 'VPLAY_PROXY_RUN_TOKEN');
  if (!realKey || !runToken) {
    console.error('refuse to start: real key and run token are required');
    process.exit(1);
  }
  const proxy = createModelProxy({
    upstream: readFlag(argv, 'upstream', process.env.VPLAY_PROXY_UPSTREAM),
    realKey,
    runToken,
    models: String(readFlag(argv, 'models', process.env.VPLAY_PROXY_MODELS || '')).split(','),
    maxRequests: Number(readFlag(argv, 'max-requests', 20)),
    maxBodyBytes: Number(readFlag(argv, 'max-body-bytes', 1024 * 1024)),
    maxTokens: Number(readFlag(argv, 'max-tokens', 0)),
    logger: (line) => console.log(line),
  });
  const port = Number(readFlag(argv, 'port', 18790));
  proxy.listen(port, '127.0.0.1').then(() => {
    console.log(`[proxy] listening on 127.0.0.1:${port} (upstream=${proxy.upstream})`);
  });
  process.on('SIGTERM', () => proxy.close().then(() => process.exit(0)));
  process.on('SIGINT', () => proxy.close().then(() => process.exit(0)));
}

module.exports = { createModelProxy };

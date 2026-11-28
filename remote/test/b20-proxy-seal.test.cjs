'use strict';

/**
 * B20：受限执行层、模型代理、证据封存 定点测试。
 * 全部使用本地 mock 上游；不调用真实模型。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { createModelProxy } = require('../tools/model-proxy.cjs');
const { sealEvidence } = require('../tools/seal-evidence.cjs');
const { makeWorkspace, removeWorkspace } = require('./helpers.cjs');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('B20-P1 execution layer: actual isToolEnabled rejects shell/edit/write/web', async () => {
  const modulePath = path.join(
    __dirname, '..', '..', 'packages', 'core', 'dist', 'src', 'utils', 'tool-utils.js',
  );
  if (!fs.existsSync(modulePath)) {
    test.skip?.('compiled core tool-utils missing; run npm run build');
    return;
  }
  const { isToolEnabled } = await import(pathToFileURL(modulePath).href);
  const core = ['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory'];
  const excluded = [
    'run_shell_command', 'edit', 'write_file', 'web_fetch', 'web_search',
    'task', 'skill', 'generate_game_assets', 'generate_tilemap', 'generate_gdd',
    'exit_plan_mode', 'save_memory',
  ];
  assert.equal(isToolEnabled('read_file', core, excluded), true);
  assert.equal(isToolEnabled('grep_search', core, excluded), true);
  for (const name of ['run_shell_command', 'edit', 'write_file', 'web_fetch', 'web_search']) {
    assert.equal(isToolEnabled(name, core, excluded), false, name);
  }
});

test('B20-P5 model proxy: token/model/size/count limits and non-stream passthrough', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock',
        model: body.model,
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { total_tokens: 7 },
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = createModelProxy({
    upstream: `http://127.0.0.1:${upstreamPort}/v1`,
    realKey: 'real-secret-key',
    runToken: 'run-token-123',
    models: ['mock-model'],
    maxRequests: 1,
    maxBodyBytes: 512,
    maxTokens: 100,
  });
  const proxyPort = await listen(proxy.server);
  const endpoint = `http://127.0.0.1:${proxyPort}/v1/chat/completions`;
  try {
    const ok = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer run-token-123', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', stream: false, messages: [] }),
    });
    assert.equal(ok.status, 200);
    assert.equal(seen[0].auth, 'Bearer real-secret-key');
    assert.equal(seen[0].url, '/v1/chat/completions');
    assert.equal(seen[0].body.model, 'mock-model');

    const badToken = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [] }),
    });
    assert.equal(badToken.status, 401);

    const badModel = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer run-token-123', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'other-model', messages: [] }),
    });
    assert.equal(badModel.status, 400);

    const tooLarge = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer run-token-123', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', pad: 'x'.repeat(1024) }),
    });
    assert.equal(tooLarge.status, 413);

    const exhausted = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer run-token-123', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [] }),
    });
    assert.equal(exhausted.status, 429);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test('B20-P2 evidence seal: manifest, copy and external HMAC anchor; refuses non-empty/symlink', () => {
  const root = makeWorkspace('vplay-b20-seal-');
  try {
    const staging = path.join(root, 'staging');
    write(path.join(staging, 'events.jsonl'), '{"id":1}\n');
    write(path.join(staging, 'nested', 'report.json'), '{"ok":true}\n');
    const sealed = path.join(root, 'sealed');
    const anchorOut = path.join(root, 'anchor', 'seal.json');
    const result = sealEvidence({ staging, sealed, anchorOut, hmacKey: 'b20-seal-key' });
    assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);
    const manifest = JSON.parse(fs.readFileSync(path.join(sealed, 'manifest.json'), 'utf8'));
    assert.equal(manifest.files.length, 2);
    assert.ok(fs.existsSync(path.join(sealed, 'events.jsonl')));
    const anchor = JSON.parse(fs.readFileSync(anchorOut, 'utf8'));
    assert.equal(anchor.manifestSha256, result.manifestSha256);
    assert.match(anchor.hmac, /^[0-9a-f]{64}$/);
    assert.throws(() => sealEvidence({ staging, sealed, hmacKey: 'b20-seal-key' }), /not empty/);

    const linkStaging = path.join(root, 'link-staging');
    fs.mkdirSync(linkStaging);
    try {
      fs.symlinkSync(path.join(root, 'target'), path.join(linkStaging, 'link'));
      assert.throws(
        () => sealEvidence({ staging: linkStaging, sealed: path.join(root, 'sealed2'), hmacKey: 'k' }),
        /symlink/,
      );
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    }
  } finally {
    removeWorkspace(root);
  }
});

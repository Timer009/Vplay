'use strict';

/**
 * B12 / C11 安全部署门禁：
 *  - Serve/代理模式缺少必要配置时必须 fail-closed
 *  - 回环监听、Host 白名单、HMAC 强制
 *  - Secure Cookie 强制（即使请求未带 X-Forwarded-Proto）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

const { makeWorkspace, removeWorkspace, freePort, request } = require('./helpers.cjs');

const SERVER = path.join(__dirname, '..', 'server.cjs');

function runServer(env, waitMs = 6000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let done = false;
    const stop = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 忽略
      }
    };
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (!done && out.includes('listening on')) {
        done = true;
        resolve({ code: null, out, child, started: true });
      }
    });
    child.stderr.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      resolve({ code, out, started: false });
    });
    setTimeout(() => {
      if (done) return;
      done = true;
      stop();
      resolve({ code: null, out, started: false });
    }, waitMs);
  });
}

test('B12-deploy: Serve/proxy mode fails closed without required configuration', async () => {
  const baseEnv = { REMOTE_HOST: '127.0.0.1', REMOTE_PORT: '0' };
  const cases = [
    {
      name: 'missing preview key',
      env: { VPLAY_PUBLIC_MODE: '1' },
      expect: /PREVIEW_ACCESS_KEY/i,
    },
    {
      name: 'missing HMAC key',
      env: { VPLAY_PUBLIC_MODE: '1', PREVIEW_ACCESS_KEY: '0123456789abcdef' },
      expect: /EVIDENCE_HMAC_KEY/i,
    },
    {
      name: 'missing external host',
      env: {
        VPLAY_PUBLIC_MODE: '1',
        PREVIEW_ACCESS_KEY: '0123456789abcdef',
        EVIDENCE_HMAC_KEY: 'fedcba9876543210',
      },
      expect: /REMOTE_ALLOWED_HOSTS/i,
    },
    {
      name: 'non-loopback host',
      env: {
        VPLAY_PUBLIC_MODE: '1',
        REMOTE_HOST: '100.78.136.34',
        PREVIEW_ACCESS_KEY: '0123456789abcdef',
        EVIDENCE_HMAC_KEY: 'fedcba9876543210',
        REMOTE_ALLOWED_HOSTS: 'timer009.tail199672.ts.net',
      },
      expect: /loopback/i,
    },
    {
      name: 'short preview key',
      env: {
        VPLAY_PUBLIC_MODE: '1',
        PREVIEW_ACCESS_KEY: 'short',
        EVIDENCE_HMAC_KEY: 'fedcba9876543210',
        REMOTE_ALLOWED_HOSTS: 'timer009.tail199672.ts.net',
      },
      expect: /PREVIEW_ACCESS_KEY/i,
    },
  ];
  for (const item of cases) {
    const home = makeWorkspace('vplay-b12-deploy-');
    try {
      const result = await runServer({ ...baseEnv, VPLAY_HOME: home, ...item.env });
      assert.equal(result.code, 1, `${item.name} must exit 1; out=${result.out}`);
      assert.match(result.out, item.expect, item.name);
    } finally {
      removeWorkspace(home);
    }
  }
});

test('B12-deploy: Serve mode forces Secure cookies without trusting client XFP', async () => {
  const root = makeWorkspace('vplay-b12-secure-');
  const home = path.join(root, 'home');
  const port = await freePort();
  const previewPort = await freePort();
  let started = null;
  try {
    // 不设置 REMOTE_ALLOW_TEST_SEAM，避免与服务门禁冲突
    const result = await runServer({
      VPLAY_HOME: home,
      REMOTE_HOST: '127.0.0.1',
      REMOTE_PORT: String(port),
      PREVIEW_PORT: String(previewPort),
      REMOTE_TOKEN: 'b12-token',
      REMOTE_AUTORUN: '0',
      REMOTE_TRUST_PROXY: '1',
      PREVIEW_ACCESS_KEY: '0123456789abcdef',
      EVIDENCE_HMAC_KEY: 'fedcba9876543210',
      REMOTE_ALLOWED_HOSTS: 'timer009.tail199672.ts.net,127.0.0.1',
    });
    started = result;
    assert.equal(result.started, true, result.out);
    const login = await request(port, 'POST', '/auth/verify', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'b12-token' }),
    });
    assert.equal(login.status, 200);
    const cookies = [].concat(login.headers['set-cookie'] || []).map(String);
    assert.ok(cookies.some((item) => /vplay_session=/.test(item) && /Secure/.test(item)));
    assert.ok(cookies.some((item) => /vplay_preview=/.test(item) && /Secure/.test(item)));
  } finally {
    if (started && started.child && started.child.exitCode === null) {
      try {
        started.child.kill('SIGKILL');
      } catch {
        // 忽略
      }
    }
    removeWorkspace(root);
  }
});

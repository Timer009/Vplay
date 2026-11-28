'use strict';

/**
 * B19 ARM64/Linux 配置单元测试（Windows 上也可运行，纯函数）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BrowserArgsError,
  parseBrowserArgs,
  parseMaxSnapshots,
  parseUmask,
  spawnDetachedOptions,
  killProcessGroup,
} = require('../lib/linux-config.cjs');

test('B19 browser args: allowlisted low-memory flags only', () => {
  const args = parseBrowserArgs(
    '--disable-dev-shm-usage --disable-gpu --renderer-process-limit=2 --js-flags=--max-old-space-size=768',
  );
  assert.deepEqual(args, [
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--renderer-process-limit=2',
    '--js-flags=--max-old-space-size=768',
  ]);
  assert.equal(args.some((arg) => /no-sandbox|disable-setuid-sandbox|single-process/.test(arg)), false);
});

test('B19 browser args: sandbox/security weakening flags are rejected', () => {
  for (const bad of [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--single-process',
    '--disable-web-security',
    '--allow-running-insecure-content',
    '--remote-debugging-port=9222',
  ]) {
    assert.throws(
      () => parseBrowserArgs(bad),
      (error) => error instanceof BrowserArgsError && error.code === 'VPLAY_BROWSER_ARGS_REJECTED',
      bad,
    );
  }
});

test('B19 browser args: unknown flags fail closed (no arbitrary env injection)', () => {
  assert.throws(() => parseBrowserArgs('--disable-dev-shm-usage --user-data-dir=/tmp/x'));
  assert.throws(() => parseBrowserArgs('--renderer-process-limit=99'));
  assert.throws(() => parseBrowserArgs('--js-flags=--max-old-space-size=16384'));
  assert.deepEqual(parseBrowserArgs(''), []);
});

test('B19 runtime config: snapshot limit clamp and POSIX umask', () => {
  assert.equal(parseMaxSnapshots(undefined), 200);
  assert.equal(parseMaxSnapshots('20'), 20);
  assert.equal(parseMaxSnapshots('1'), 2);
  assert.equal(parseMaxSnapshots('999'), 200);
  assert.equal(parseMaxSnapshots('bad'), 200);

  assert.equal(parseUmask(undefined), 0o027);
  assert.equal(parseUmask('027'), 0o027);
  assert.equal(parseUmask('0o077'), 0o077);
  assert.equal(parseUmask('999'), 0o027);
});

test('B19 process group: POSIX detached and kill(-pid) without touching Windows behavior', () => {
  assert.deepEqual(spawnDetachedOptions({ windowsHide: true }, 'linux'), {
    windowsHide: true,
    detached: true,
  });
  assert.deepEqual(spawnDetachedOptions({ windowsHide: true }, 'win32'), {
    windowsHide: true,
    detached: false,
  });

  const calls = [];
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (pid < 0) throw new Error('no group');
  };
  const ok = killProcessGroup(1234, { platform: 'linux', kill });
  assert.equal(ok, true);
  assert.deepEqual(calls, [[-1234, 'SIGKILL'], [1234, 'SIGKILL']]);
  assert.equal(killProcessGroup(1234, { platform: 'win32', kill: () => calls.push('win') }), false);
});

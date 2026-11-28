'use strict';

/**
 * B23-ADD：Vision 0.2.3 集成定点（产物身份、版本切换、sandbox 硬编码、0.2.2 冻结）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const {
  resolveVisionVendor,
  verifyVisionVendor,
  VISION_VENDORS,
} = require('../lib/vision-service.cjs');

const REPO = path.resolve(__dirname, '..', '..');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('B23-V: authoritative agent identities match E16-HASH', () => {
  assert.equal(
    VISION_VENDORS['0.2.3'].tgzSha256,
    '415cae0ec26687f2c2804a4f0954ce9ac0affd581aa33c9a8efca2903d17d91d',
  );
  assert.equal(
    VISION_VENDORS['0.2.2'].tgzSha256,
    'c7679c021082824bb30f6fe7a06573d83ead945361efd60c37ac2bff10b5f74e',
  );
  assert.equal(
    sha256File(path.join(REPO, 'vendor', 'vision-0.2.3', 'vplay-vision-0.2.3.tgz')),
    VISION_VENDORS['0.2.3'].tgzSha256,
  );
  assert.equal(
    sha256File(path.join(REPO, 'vendor', 'vision', 'vplay-vision-0.2.2.tgz')),
    VISION_VENDORS['0.2.2'].tgzSha256,
  );
});

test('B23-V: default is 0.2.3, explicit 0.2.2 fallback works, unknown fails closed', () => {
  const current = resolveVisionVendor({});
  assert.equal(current.version, '0.2.3');
  assert.match(current.entry, /vendor[\\/]vision-0\.2\.3[\\/]src[\\/]index\.mjs$/);

  const legacy = resolveVisionVendor({ VPLAY_VISION_VERSION: '0.2.2' });
  assert.equal(legacy.version, '0.2.2');
  assert.match(legacy.entry, /vendor[\\/]vision[\\/]src[\\/]index\.mjs$/);

  assert.throws(
    () => resolveVisionVendor({ VPLAY_VISION_VERSION: '9.9.9' }),
    (error) => error.code === 'VISION_VERSION_UNSUPPORTED',
  );
});

test('B23-V: vendor integrity mismatch fails closed before import', () => {
  const vendor = resolveVisionVendor({});
  assert.equal(verifyVisionVendor(vendor).ok, true);
  assert.throws(
    () => verifyVisionVendor({ ...vendor, expectedSha256: '0'.repeat(64) }),
    (error) => error.code === 'VISION_VENDOR_INTEGRITY',
  );
  assert.throws(
    () => verifyVisionVendor({ ...vendor, entry: path.join(vendor.dir, 'missing', 'index.mjs') }),
    (error) => error.code === 'VISION_VENDOR_MISSING',
  );
});

test('B23-V: 0.2.3 runner hardcodes chromiumSandbox and keeps launchArgs', () => {
  const runner = fs.readFileSync(
    path.join(REPO, 'vendor', 'vision-0.2.3', 'src', 'browser', 'runner.mjs'),
    'utf-8',
  );
  assert.match(runner, /chromiumSandbox:\s*true/);
  assert.match(runner, /BROWSER_SANDBOX_BYPASS/);
  assert.match(runner, /launchArgs/);
  assert.equal(
    sha256File(path.join(REPO, 'vendor', 'vision-0.2.3', 'src', 'browser', 'runner.mjs')),
    '13426252470d182e67cd9da7e39cb7a051b16e826f9dabd12fda4cf574deddbd',
  );
});

test('B23-V: 0.2.2 frozen runner is untouched', () => {
  const runner = fs.readFileSync(
    path.join(REPO, 'vendor', 'vision', 'src', 'browser', 'runner.mjs'),
    'utf-8',
  );
  assert.doesNotMatch(runner, /chromiumSandbox:\s*true/);
  assert.equal(
    sha256File(path.join(REPO, 'vendor', 'vision', 'src', 'browser', 'runner.mjs')),
    'c28ef05387d1b923056d6a8ed181967d0839e96c7d2bbd19d2d61eb6ccb4d4b3',
  );
});

test('B23-V: 0.2.3 module imports with the expected export surface', async () => {
  const vendor = resolveVisionVendor({});
  const mod = await import(pathToFileURL(vendor.entry).href);
  assert.ok(Object.keys(mod).length >= 60, `exports=${Object.keys(mod).length}`);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO, 'vendor', 'vision-0.2.3', 'package.json'), 'utf-8'),
  );
  assert.equal(pkg.version, '0.2.3');
});

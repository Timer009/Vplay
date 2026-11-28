#!/usr/bin/env node
/**
 * Runtime self-check for deployment. Prints no secret values.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { findBrowserExecutable } from '../src/browser/discover.mjs';
import { findSecretEnvKeys } from '../src/browser/env.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const major = Number(process.versions.node.split('.')[0]);
const out = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  nodeOk: major >= 20,
  playwrightCore: null,
  browser: null,
  secretEnvKeys: findSecretEnvKeys(process.env),
  packageRoot: path.resolve(here, '..'),
};

try {
  const pw = require('playwright-core');
  out.playwrightCore = { resolved: require.resolve('playwright-core'), version: pw.chromium ? 'available' : 'unknown' };
} catch (error) {
  out.playwrightCore = { error: error.message };
}

try {
  out.browser = findBrowserExecutable({});
} catch (error) {
  out.browser = { error: error.message };
}

console.log(JSON.stringify(out, null, 2));
process.exit(out.nodeOk ? 0 : 1);

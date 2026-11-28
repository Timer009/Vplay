#!/usr/bin/env node
'use strict';

/**
 * 证据封存（C18 P-6 / B20）。
 *
 * staging（Agent 可写）→ sealed（vplay-evidence 0700）：
 *  - 拒绝 staging/sealed 内的 symlink/junction；
 *  - 逐文件 sha256 + manifest.json；
 *  - seal.json 使用操作员/外部 HMAC key 覆盖 manifest 摘要；
 *  - 可选 --anchor-out 写 Pi 之外的锚点副本（不含真实 key）。
 *
 * 本程序不修改源文件；sealed 必须为空或不存在（可逆）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function walk(root, rel = '') {
  const dir = path.join(root, rel);
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = rel ? path.join(rel, item.name) : item.name;
    const full = path.join(root, next);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`symlink not allowed: ${full}`);
    if (stat.isDirectory()) entries.push(...walk(root, next));
    else if (stat.isFile()) entries.push(next.split(path.sep).join('/'));
    else throw new Error(`unsupported file type: ${full}`);
  }
  return entries;
}

function sealEvidence({ staging, sealed, anchorOut = null, hmacKey }) {
  if (!staging || !sealed) throw new Error('staging and sealed are required');
  if (!hmacKey) throw new Error('HMAC key is required for external anchor');
  const source = path.resolve(staging);
  const target = path.resolve(sealed);
  if (!fs.existsSync(source)) throw new Error(`staging missing: ${source}`);
  if (source === target || target.startsWith(source + path.sep)) {
    throw new Error('sealed must be outside staging');
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`sealed is not empty: ${target}`);
  }
  const files = walk(source).sort();
  const manifestFiles = [];
  for (const rel of files) {
    const data = fs.readFileSync(path.join(source, rel));
    manifestFiles.push({ file: rel, bytes: data.length, sha256: sha256(data) });
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    staging: source,
    files: manifestFiles,
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  const manifestSha256 = sha256(Buffer.from(manifestText));
  const anchor = {
    schemaVersion: 1,
    generatedAt: manifest.generatedAt,
    manifestSha256,
    fileCount: manifestFiles.length,
    hmac: crypto.createHmac('sha256', hmacKey).update(manifestText).digest('hex'),
  };
  fs.mkdirSync(target, { recursive: true });
  for (const rel of files) {
    const destination = path.join(target, ...rel.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, rel), destination);
  }
  fs.writeFileSync(path.join(target, 'manifest.json'), manifestText);
  fs.writeFileSync(path.join(target, 'seal.json'), JSON.stringify(anchor, null, 2));
  if (anchorOut) {
    fs.mkdirSync(path.dirname(path.resolve(anchorOut)), { recursive: true });
    fs.writeFileSync(path.resolve(anchorOut), JSON.stringify(anchor, null, 2));
  }
  return { sealed: target, manifestSha256, anchor };
}

function readFlag(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) {
    console.log(
      'usage: node remote/tools/seal-evidence.cjs --staging <dir> --sealed <dir> ' +
      '[--anchor-out <file>] --key-file <0600>',
    );
    process.exit(0);
  }
  const keyFile = readFlag(argv, 'key-file');
  const hmacKey = keyFile
    ? fs.readFileSync(keyFile, 'utf8').trim()
    : process.env.EVIDENCE_HMAC_KEY;
  if (!hmacKey) {
    console.error('refuse: --key-file or EVIDENCE_HMAC_KEY required');
    process.exit(1);
  }
  try {
    const result = sealEvidence({
      staging: readFlag(argv, 'staging'),
      sealed: readFlag(argv, 'sealed'),
      anchorOut: readFlag(argv, 'anchor-out'),
      hmacKey,
    });
    console.log(JSON.stringify({
      ok: true,
      sealed: result.sealed,
      manifestSha256: result.manifestSha256,
      fileCount: result.anchor.fileCount,
    }, null, 2));
  } catch (error) {
    console.error(`seal failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { sealEvidence };

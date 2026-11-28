#!/usr/bin/env node
'use strict';

/**
 * B22：证据封存 CLI（staging → sealed + 外部锚点）。
 *
 * 用法：
 *   node remote/tools/seal-evidence.cjs \
 *     --staging /srv/vplay-lab/evidence-staging/spacer-lab/task_x \
 *     --sealed  /srv/vplay-lab/evidence/spacer-lab/task_x \
 *     --anchor-out /srv/vplay-lab/evidence-anchors/task_x.anchor.json
 *
 * 密钥只从 EVIDENCE_HMAC_KEY 读取；不写日志、不回显。
 * 真实 sealed 目录应由 vplay-evidence UID 拥有（RP03-B），本工具不负责改权限。
 */

const { sealEvidence } = require('../lib/evidence-seal.cjs');

function readFlag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help')) {
    console.log(
      'usage: node remote/tools/seal-evidence.cjs --staging <dir> --sealed <dir> [--anchor-out <file>]',
    );
    return 0;
  }
  const stagingDir = readFlag(argv, 'staging');
  const sealedDir = readFlag(argv, 'sealed');
  const anchorOut = readFlag(argv, 'anchor-out') || null;
  if (!stagingDir || !sealedDir) {
    console.error('staging and sealed are required');
    return 2;
  }
  const result = sealEvidence({
    stagingDir,
    sealedDir,
    anchorOut,
    hmacKey: process.env.EVIDENCE_HMAC_KEY,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        sealedDir: result.sealedDir,
        fileCount: result.fileCount,
        sealHmac: result.sealHmac,
        anchorOut,
      },
      null,
      2,
    ),
  );
  return 0;
}

process.exitCode = main();

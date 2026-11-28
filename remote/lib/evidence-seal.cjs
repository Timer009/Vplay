'use strict';

/**
 * B22 / C19 B21-12：证据 staging → sealed 的最小组件。
 *
 * - staging 目录由 Agent/worker 可写；sealed 目录应由独立 UID（vplay-evidence）
 *   拥有，Agent 不可写（OS 层由 RP03-B 落地）。
 * - 本模块只做“拷贝 + 全量清单 + HMAC 封条”，并输出外部锚点文件；
 *   离线校验用 verifySeal()，运行时证据校验继续用 evidence.cjs 的 verifyEvidence()。
 * - 无 HMAC 密钥时失败关闭，不生成无签名封条。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
    else throw new Error(`non-regular evidence entry: ${full}`);
  }
  return out;
}

function sealEvidence({ stagingDir, sealedDir, hmacKey, anchorOut = null }) {
  if (!hmacKey || String(hmacKey).length < 16) {
    throw new Error('EVIDENCE_HMAC_KEY (>=16 chars) is required to seal evidence');
  }
  const staging = path.resolve(stagingDir);
  const sealed = path.resolve(sealedDir);
  if (!fs.existsSync(staging)) throw new Error(`staging directory not found: ${staging}`);
  if (sealed === staging || staging.startsWith(`${sealed}${path.sep}`)) {
    throw new Error('sealedDir must not contain stagingDir');
  }
  if (fs.existsSync(sealed) && fs.readdirSync(sealed).length > 0) {
    throw new Error(`sealed directory is not empty: ${sealed}`);
  }
  fs.mkdirSync(sealed, { recursive: true });

  const files = [];
  for (const rel of walk(staging).sort()) {
    const source = path.join(staging, ...rel.split('/'));
    const target = path.join(sealed, ...rel.split('/'));
    if (target !== sealed && !target.startsWith(`${sealed}${path.sep}`)) {
      throw new Error(`evidence path escapes sealed dir: ${rel}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    const sha256 = sha256File(target);
    if (sha256 !== sha256File(source)) throw new Error(`seal fidelity failed: ${rel}`);
    files.push({ path: rel, bytes: fs.statSync(target).size, sha256 });
  }

  const seal = {
    schemaVersion: 1,
    alg: 'hmac-sha256',
    keyFingerprint: crypto.createHash('sha256').update(hmacKey).digest('hex').slice(0, 16),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
    sealedAt: new Date().toISOString(),
  };
  const body = JSON.stringify(seal);
  seal.hmac = crypto.createHmac('sha256', hmacKey).update(body).digest('hex');
  fs.writeFileSync(path.join(sealed, 'seal.json'), JSON.stringify(seal, null, 2), 'utf-8');

  if (anchorOut) {
    const anchor = {
      sealedDir: sealed,
      fileCount: seal.fileCount,
      totalBytes: seal.totalBytes,
      keyFingerprint: seal.keyFingerprint,
      sealHmac: seal.hmac,
      sealedAt: seal.sealedAt,
      external: true,
    };
    fs.mkdirSync(path.dirname(path.resolve(anchorOut)), { recursive: true });
    fs.writeFileSync(path.resolve(anchorOut), JSON.stringify(anchor, null, 2), 'utf-8');
  }
  return { sealedDir: sealed, fileCount: seal.fileCount, sealHmac: seal.hmac };
}

function verifySeal({ sealedDir, hmacKey }) {
  const reasons = [];
  const root = path.resolve(sealedDir);
  let seal;
  try {
    seal = JSON.parse(fs.readFileSync(path.join(root, 'seal.json'), 'utf-8'));
  } catch {
    return { ok: false, reasons: ['SEAL_MISSING'] };
  }
  if (!hmacKey) return { ok: false, reasons: ['HMAC_KEY_MISSING'] };
  const { hmac, ...rest } = seal;
  const expected = crypto.createHmac('sha256', hmacKey).update(JSON.stringify(rest)).digest('hex');
  if (expected !== hmac) reasons.push('SEAL_HMAC_MISMATCH');
  if (seal.keyFingerprint !== crypto.createHash('sha256').update(hmacKey).digest('hex').slice(0, 16)) {
    reasons.push('SEAL_KEY_WRONG');
  }
  const listed = new Set();
  for (const item of Array.isArray(seal.files) ? seal.files : []) {
    listed.add(item.path);
    try {
      const actual = sha256File(path.join(root, ...item.path.split('/')));
      if (actual !== item.sha256) reasons.push(`FILE_TAMPERED:${item.path}`);
    } catch {
      reasons.push(`FILE_MISSING:${item.path}`);
    }
  }
  for (const rel of walk(root)) {
    if (rel === 'seal.json') continue;
    if (!listed.has(rel)) reasons.push(`FILE_EXTRA:${rel}`);
  }
  return { ok: reasons.length === 0, reasons };
}

module.exports = { sealEvidence, verifySeal, sha256File };

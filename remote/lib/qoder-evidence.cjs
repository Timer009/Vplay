'use strict';

/**
 * Qoder 独立证据链契约适配器（B10 / D）。
 *
 * 复用 Qoder 的 `evidence/verify-run.cjs`（12 步离线校验器），不在产品内复制其判定逻辑。
 * 额外硬化：
 *  - `requireHmac` 时要求链上每条记录声明 `alg: hmac-sha256`，拒绝「降级为纯 SHA-256」；
 *  - 结果只返回 Qoder 的 verdict/code，不把产品自身报告当作独立证据。
 *
 * 注意：HMAC 只证明「持有宿主密钥的进程生成过该包」；当前无 OS 隔离，
 * 能读取密钥/证据目录的高权限进程仍可伪造，不宣称不可篡改。
 */

const fs = require('fs');
const path = require('path');

// B11：默认加载仓库内 vendored 校验器，保证可移植；可用 QODER_VERIFY_RUN 覆盖。
const DEFAULT_VERIFY_RUN = path.join(__dirname, '..', 'tools', 'qoder', 'verify-run.cjs');

function resolveVerifyRun() {
  return process.env.QODER_VERIFY_RUN || DEFAULT_VERIFY_RUN;
}

function readChain(file) {
  try {
    return fs
      .readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * @returns {{available:boolean, verdict:string, codes:string[], reason?:string, result?:object}}
 */
function verifyWithQoder(evidenceDir, options = {}) {
  const verifyRunPath = resolveVerifyRun();
  if (!fs.existsSync(verifyRunPath)) {
    return {
      available: false,
      verdict: 'BLOCKED',
      codes: [],
      reason: `Qoder verify-run not found: ${verifyRunPath}`,
    };
  }
  const hmacKey = options.hmacKey || '';
  if (options.requireHmac === true) {
    const chain = readChain(path.join(path.resolve(evidenceDir), '02-server-chain.jsonl'));
    if (!chain.length) {
      return { available: true, verdict: 'FAIL', codes: ['CHAIN_MISSING'] };
    }
    if (!chain.every((record) => record && record.alg === 'hmac-sha256')) {
      return { available: true, verdict: 'FAIL', codes: ['HMAC_REQUIRED'] };
    }
  }
  // 动态加载 Qoder 的校验器（路径由部署环境提供）
  const { verifyRun } = require(verifyRunPath);
  const result = verifyRun(evidenceDir, { hmacKey });
  return {
    available: true,
    verdict: result.verdict,
    codes: [...(result.failed || []), ...(result.inconclusive || [])],
    result,
  };
}

module.exports = { verifyWithQoder, resolveVerifyRun, DEFAULT_VERIFY_RUN };

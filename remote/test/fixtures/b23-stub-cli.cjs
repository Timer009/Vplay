'use strict';

/**
 * B23 测试用受限 CLI 替身（由 agent daemon 以生产参数启动）。
 * 记录执行环境，验证 Agent 不持有审批/证据/控制面密钥。
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const promptIndex = argv.indexOf('-p');
const prompt = promptIndex >= 0 ? argv[promptIndex + 1] || '' : '';
const dir = process.cwd();

fs.writeFileSync(
  path.join(dir, 'agent-child.pid'),
  String(process.pid),
  'utf-8',
);
fs.appendFileSync(
  path.join(dir, 'agent-exec.jsonl'),
  `${JSON.stringify({
    event: 'start',
    pid: process.pid,
    prompt,
    approvalMode: argv[argv.indexOf('--approval-mode') + 1] || null,
    coreTools: (argv.find((item) => item.startsWith('--core-tools')) || '').slice(0, 200),
    env: {
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || null,
      HOME: process.env.HOME || null,
      hasApprovalKey: Boolean(process.env.VPLAY_APPROVAL_HMAC_KEY || process.env.APPROVAL_HMAC_KEY),
      hasIpcKey: Boolean(process.env.VPLAY_IPC_HMAC_KEY),
      hasEvidenceKey: Boolean(process.env.EVIDENCE_HMAC_KEY),
      hasRemoteToken: Boolean(process.env.REMOTE_TOKEN),
    },
  })}\n`,
  'utf-8',
);

process.stdout.write(`STUB_OUT:${prompt}\n`);

function finish(code) {
  fs.appendFileSync(
    path.join(dir, 'agent-exec.jsonl'),
    `${JSON.stringify({ event: 'end', pid: process.pid, code })}\n`,
    'utf-8',
  );
  process.exit(code);
}

const delay = prompt.includes('SLEEP') ? 10000 : 60;
setTimeout(() => {
  if (prompt.includes('FAIL')) {
    process.stderr.write('stub simulated failure\n');
    finish(3);
    return;
  }
  finish(0);
}, delay);

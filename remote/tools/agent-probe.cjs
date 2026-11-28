#!/usr/bin/env node
'use strict';

/**
 * B23：agent IPC 健康探测（control UID 运行）。
 * 只做 hello/ready，不触发任务、不输出密钥。
 */

const { probeAgent } = require('../lib/agent-client.cjs');

async function main() {
  const socketPath = process.env.VPLAY_AGENT_SOCKET;
  const ipcKey = process.env.VPLAY_IPC_HMAC_KEY;
  if (!socketPath || !ipcKey) {
    console.error('VPLAY_AGENT_SOCKET and VPLAY_IPC_HMAC_KEY are required');
    return 2;
  }
  try {
    const info = await probeAgent({ socketPath, ipcKey, timeoutMs: 4000 });
    console.log(JSON.stringify({ ok: true, socket: socketPath, ...info }, null, 2));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, socket: socketPath, code: error.code || 'IPC_ERROR', message: error.message }, null, 2));
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});

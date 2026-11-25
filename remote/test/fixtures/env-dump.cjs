'use strict';

/**
 * 安全探针夹具：把子进程实际拿到的环境变量写下来，并故意打印模型 Key，
 * 用于验证「最小环境变量集合」与「日志脱敏」。
 */

const fs = require('fs');
const path = require('path');

const snapshot = {
  hasRemoteToken: Boolean(process.env.REMOTE_TOKEN),
  hasRemoteTokenFile: Boolean(process.env.REMOTE_TOKEN_FILE),
  hasRemoteExecutor: Boolean(process.env.REMOTE_EXECUTOR_CMD),
  hasVplayHome: Boolean(process.env.VPLAY_HOME),
  hasTaskId: Boolean(process.env.OPENGAME_REMOTE_TASK_ID),
  hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
  keys: Object.keys(process.env).sort(),
};

fs.writeFileSync(
  path.join(process.cwd(), 'env-dump.json'),
  JSON.stringify(snapshot, null, 2),
  'utf-8',
);

// 故意输出凭据，验证日志脱敏（服务端不得把明文写入日志）
console.log(`[env-dump] REMOTE_TOKEN=${process.env.REMOTE_TOKEN || ''}`);
console.log(`[env-dump] OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''}`);
console.log(`[env-dump] task=${process.env.OPENGAME_REMOTE_TASK_ID || ''}`);

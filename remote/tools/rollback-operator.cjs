#!/usr/bin/env node
'use strict';

/**
 * B23-FINAL：回滚 operator（由 root oneshot 单元执行）。
 *
 * 设计约束：control/agent 都不长期持有 workspace 写权限；回滚是一个**显式、
 * 一次性**的 root 操作。工具只接受 operator 请求文件或显式参数，并写入 journal。
 *
 * 用法：
 *   VPLAY_ROLLBACK_OPERATOR=1 node remote/tools/rollback-operator.cjs \
 *     --home /srv/vplay-lab/home --project spacer-lab --seq 12
 *
 * 或：
 *   VPLAY_ROLLBACK_OPERATOR=1 node remote/tools/rollback-operator.cjs \
 *     --request /srv/vplay-lab/state/rollback-request.json
 *
 * 请求文件：{ "home": "...", "projectId": "...", "seq": 12 }
 */

const fs = require('fs');
const path = require('path');
const { createProjectRegistry } = require('../lib/projects.cjs');

function readFlag(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function parseRequest(argv) {
  const requestFile = readFlag(argv, 'request');
  if (requestFile) {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(requestFile), 'utf-8'));
    return {
      home: parsed.home,
      projectId: parsed.projectId,
      seq: Number(parsed.seq),
    };
  }
  return {
    home: readFlag(argv, 'home'),
    projectId: readFlag(argv, 'project'),
    seq: Number(readFlag(argv, 'seq')),
  };
}

async function main() {
  if (process.env.VPLAY_ROLLBACK_OPERATOR !== '1') {
    console.error('[rollback] refuse: VPLAY_ROLLBACK_OPERATOR=1 is required (root oneshot only)');
    return 2;
  }
  const { home, projectId, seq } = parseRequest(process.argv.slice(2));
  if (!home || !projectId || !Number.isInteger(seq) || seq < 1) {
    console.error('[rollback] home/project/seq are required');
    return 2;
  }
  const registry = createProjectRegistry({ home: path.resolve(home) });
  const result = await registry.rollback(projectId, seq);
  console.log(
    JSON.stringify(
      {
        ok: true,
        projectId,
        seq,
        backupSeq: result && result.backupSeq,
        verified: result && result.verified,
      },
      null,
      2,
    ),
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`[rollback] failed: ${error.message}`);
    process.exitCode = 1;
  },
);

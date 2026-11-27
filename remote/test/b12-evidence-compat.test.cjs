'use strict';

/** B12：旧事件链（v1，无 anchor）升级兼容 + HMAC/降级检查。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createEventStore } = require('../lib/events.cjs');
const { createEvidenceStore } = require('../lib/evidence.cjs');
const { makeWorkspace, removeWorkspace } = require('./helpers.cjs');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

test('B12-compat: legacy v1 event chain is adopted and stays verifiable', () => {
  const root = makeWorkspace('vplay-b12-legacy-');
  const file = path.join(root, 'events', 'events.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 模拟 B10 记录：hash 不含 seq、无 anchor
    let prev = 'GENESIS';
    const lines = [];
    for (let i = 1; i <= 3; i += 1) {
      const body = {
        id: String(i),
        type: 'task.created',
        taskId: `t${i}`,
        projectId: 'demo',
        status: 'queued',
        at: new Date(Date.now() + i).toISOString(),
        data: null,
      };
      const hash = sha256(`${prev}\n${JSON.stringify(body)}`);
      lines.push(JSON.stringify({ ...body, seq: i, prevHash: prev, hash }));
      prev = hash;
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    const store = createEventStore({ file });
    const first = store.verify();
    assert.equal(first.ok, true, first.problems.join(','));
    assert.equal(first.count, 3);

    store.append({ type: 'task.running', taskId: 't4', projectId: 'demo', status: 'running' });
    const second = store.verify();
    assert.equal(second.ok, true, second.problems.join(','));
    assert.equal(second.count, 4);
    assert.ok(fs.existsSync(path.join(root, 'events', 'events.anchor.json')));
  } finally {
    removeWorkspace(root);
  }
});

test('B12-compat: evidence verifier rejects HMAC downgrade and accepts correct key', () => {
  const root = makeWorkspace('vplay-b12-evidence-');
  const home = path.join(root, 'home');
  try {
    const events = [];
    const store = createEvidenceStore({
      home,
      root: path.join(home, 'evidence'),
      hmacKey: 'b12-evidence-key-0123456789',
    });
    const written = store.writeTaskEvidence({
      task: { id: 'task_b12', projectId: 'demo', status: 'succeeded' },
      result: { verified: true, outcome: 'verified' },
      versionId: '002-uid',
      events,
      logText: 'ok\n',
    });
    const good = store.verifyEvidence(written.dir, {
      hmacKey: 'b12-evidence-key-0123456789',
      requireHmac: true,
    });
    assert.equal(good.ok, true, good.reasons.join(','));

    const anchorFile = path.join(written.dir, 'anchor.json');
    const anchor = JSON.parse(fs.readFileSync(anchorFile, 'utf-8'));
    fs.writeFileSync(
      anchorFile,
      JSON.stringify({ ...anchor, alg: 'sha256', hmac: null }, null, 2),
    );
    const downgraded = store.verifyEvidence(written.dir, {
      hmacKey: 'b12-evidence-key-0123456789',
      requireHmac: true,
    });
    assert.equal(downgraded.ok, false);
    assert.ok(downgraded.reasons.includes('HMAC_REQUIRED'));
  } finally {
    removeWorkspace(root);
  }
});

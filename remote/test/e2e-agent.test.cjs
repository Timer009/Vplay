'use strict';

/**
 * Real end-to-end check: a remote instruction must actually change the test
 * game through the OpenGame agent (DeepSeek), not through a stub.
 *
 * Disabled by default because it calls the model and takes minutes:
 *   $env:RUN_REMOTE_E2E = "1"; npm run test:remote
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  makeWorkspace,
  removeWorkspace,
  startServer,
  request,
  jsonHeaders,
  postPrompt,
  waitFor,
} = require('./helpers.cjs');

const ENABLED = process.env.RUN_REMOTE_E2E === '1';
const TOKEN = 'e2e-token-please-change';

/**
 * The spawned CLI runs with cwd = the temp game workspace, so it will not find
 * the repo's .env by itself. Load the keys into this process instead; the server
 * and its child CLI inherit them. Values are never printed.
 */
function loadRepoEnv() {
  const file = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function copyFixtureGame(workspace) {
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'test-game'), workspace, {
    recursive: true,
  });
}

test(
  'real agent: remote instruction changes the game background',
  { skip: ENABLED ? false : 'set RUN_REMOTE_E2E=1 to run the real-agent test', timeout: 900000 },
  async () => {
    loadRepoEnv();
    const workspace = makeWorkspace('vplay-remote-e2e-');
    copyFixtureGame(workspace);
    const server = await startServer({ workspace, token: TOKEN });
    try {
      const prompt =
        '这是一个测试任务。请只修改 index.html 中 :root 里的 --bg 变量，' +
        '把 #101014 改成 #7c3aed。不要新建文件，不要修改其他内容。';

      const created = await postPrompt(server.port, TOKEN, { text: prompt });
      assert.ok(
        created.status === 202 || created.status === 200,
        `unexpected status: ${created.status} ${created.text}`,
      );
      const id = created.json.task.id;

      const task = await waitFor(
        async () => {
          const res = await request(server.port, 'GET', `/tasks/${id}`, {
            headers: jsonHeaders(TOKEN),
          });
          if (res.status !== 200) return null;
          const status = res.json.task.status;
          return ['succeeded', 'failed', 'interrupted'].includes(status)
            ? res.json.task
            : null;
        },
        { timeout: 840000, interval: 3000 },
      );

      assert.equal(task.status, 'succeeded', JSON.stringify(task.error));

      const html = fs.readFileSync(path.join(workspace, 'index.html'), 'utf-8');
      assert.match(html, /--bg:\s*#7c3aed/i);

      // post-verify must still run inside the spawned CLI (no regression).
      const postVerifyFile = path.join(workspace, '.opengame', 'post-verify.json');
      assert.ok(fs.existsSync(postVerifyFile), 'post-verify.json missing');
      const postVerify = JSON.parse(fs.readFileSync(postVerifyFile, 'utf-8'));
      assert.equal(typeof postVerify.checkedImports, 'number');
      assert.ok(task.result.postVerify, 'task result should include post-verify');

      const artifact = await request(server.port, 'GET', '/artifact', {
        headers: jsonHeaders(TOKEN),
      });
      assert.equal(artifact.status, 200);
    } finally {
      await server.stop();
      // Keep the workspace around for inspection when the test fails.
      if (!process.env.KEEP_E2E_WORKSPACE) removeWorkspace(workspace);
    }
  },
);

'use strict';

/**
 * 预览面安全测试：不得读取敏感文件、不得路径穿越、不得借助 junction 逃逸，
 * 且预览端口不提供任何控制接口。
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
} = require('./helpers.cjs');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

test('preview: dotfiles, traversal and junctions are blocked; no control API', async () => {
  const workspace = makeWorkspace('vplay-preview-');
  const outside = makeWorkspace('vplay-preview-outside-');
  write(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
  write(path.join(workspace, 'index.html'), '<h1>preview</h1>');
  write(path.join(workspace, 'notes.txt'), 'public note');
  write(path.join(workspace, '.env'), 'OPENAI_API_KEY=sk-DUMMY');
  write(path.join(workspace, '.git', 'config'), '[core]');
  write(path.join(workspace, '.opengame', 'remote', 'tasks.json'), '{"tasks":[]}');

  let junctionCreated = false;
  try {
    fs.symlinkSync(outside, path.join(workspace, 'escape-link'), 'junction');
    junctionCreated = true;
  } catch {
    // 某些环境不允许创建 junction/symlink
  }

  const server = await startServer({
    workspace,
    token: 'preview-token',
    env: { REMOTE_AUTORUN: '0' },
  });

  try {
    const ok = await request(server.previewPort, 'GET', '/legacy/index.html');
    assert.equal(ok.status, 200);
    assert.match(ok.text, /preview/);

    const note = await request(server.previewPort, 'GET', '/legacy/notes.txt');
    assert.equal(note.status, 200);

    const dotenv = await request(server.previewPort, 'GET', '/legacy/.env');
    assert.equal(dotenv.status, 403);

    const gitConfig = await request(server.previewPort, 'GET', '/legacy/.git/config');
    assert.equal(gitConfig.status, 403);

    const taskState = await request(server.previewPort, 'GET', '/legacy/.opengame/remote/tasks.json');
    assert.equal(taskState.status, 403);

    const traversal = [
      '/legacy/../secret.txt',
      '/legacy/..%2fsecret.txt',
      '/legacy/%2e%2e/secret.txt',
      '/legacy/%2e%2e%2fsecret.txt',
      '/legacy/....//secret.txt',
    ];
    for (const url of traversal) {
      const res = await request(server.previewPort, 'GET', url);
      assert.notEqual(res.status, 200, `${url} must not be served`);
      assert.doesNotMatch(res.text, /OUTSIDE-SECRET/);
    }

    if (junctionCreated) {
      const viaJunction = await request(server.previewPort, 'GET', '/legacy/escape-link/secret.txt');
      assert.equal(viaJunction.status, 403);
      assert.doesNotMatch(viaJunction.text, /OUTSIDE-SECRET/);
    }

    const missing = await request(server.previewPort, 'GET', '/legacy/missing.txt');
    assert.equal(missing.status, 404);

    const post = await request(server.previewPort, 'POST', '/legacy/index.html', {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(post.status, 405);

    const controlPost = await request(server.previewPort, 'POST', '/prompt', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(controlPost.status, 405);

    // 控制面不再暴露 /game/*
    const { jsonHeaders } = require('./helpers.cjs');
    const legacyGame = await request(server.port, 'GET', '/game/index.html', {
      headers: jsonHeaders('preview-token'),
    });
    assert.equal(legacyGame.status, 404);
  } finally {
    await server.stop();
    removeWorkspace(workspace);
    removeWorkspace(outside);
  }
});

test('preview: vite project serves dist only when it exists', async () => {
  const root = makeWorkspace('vplay-preview-vite-');
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  write(path.join(workspace, 'index.html'), '<h1>src</h1>');
  const source = path.join(root, 'vite-project');
  write(
    path.join(source, 'package.json'),
    JSON.stringify({ devDependencies: { vite: '^5.0.0' }, scripts: { build: 'vite build' } }),
  );
  write(path.join(source, 'vite.config.js'), 'export default {}');
  write(path.join(source, 'index.html'), '<div id="app">src</div>');
  write(path.join(source, 'dist', 'index.html'), '<div>built</div>');

  const { createProjectRegistry } = require('../lib/projects.cjs');
  const registry = createProjectRegistry({ home });
  registry.importProject({ sourceDir: source, id: 'vite-demo' });

  const server = await startServer({
    workspace,
    home,
    token: 'vite-token',
    env: { REMOTE_AUTORUN: '0' },
  });
  try {
    const page = await request(server.previewPort, 'GET', '/p/vite-demo/');
    assert.equal(page.status, 200);
    assert.match(page.text, /built/);
    assert.doesNotMatch(page.text, /id="app"/);

    const artifact = await request(server.port, 'GET', '/artifact?projectId=vite-demo', {
      headers: { Authorization: 'Bearer vite-token' },
    });
    assert.equal(artifact.status, 200);
    assert.equal(artifact.json.previewPath, '/p/vite-demo/');
    assert.equal(artifact.json.previewPort, server.previewPort);

    // 项目模式下不暴露 legacy 根（不能把仓库/工作区当静态目录）
    const legacy = await request(server.previewPort, 'GET', '/legacy/index.html');
    assert.equal(legacy.status, 404);
  } finally {
    await server.stop();
    removeWorkspace(root);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createTaskStore,
  ValidationError,
  DuplicateTaskError,
} = require('../lib/tasks.cjs');
const { makeWorkspace, removeWorkspace } = require('./helpers.cjs');

function freshStore() {
  const workspace = makeWorkspace();
  const store = createTaskStore({
    runtimeDir: path.join(workspace, '.opengame'),
    workspaceDir: workspace,
  });
  return { workspace, store };
}

test('task store: creates a queued task with a unique id', () => {
  const { workspace, store } = freshStore();
  try {
    const { task, duplicate } = store.create({ text: 'make a snake game' });
    assert.equal(duplicate, false);
    assert.match(task.id, /^task_[a-z0-9]+_[0-9a-f]{8}$/);
    assert.equal(task.status, 'queued');
    assert.equal(task.text, 'make a snake game');
    assert.equal(store.list().length, 1);
  } finally {
    removeWorkspace(workspace);
  }
});

test('task store: rejects invalid text', () => {
  const { workspace, store } = freshStore();
  try {
    assert.throws(() => store.create({ text: '' }), ValidationError);
    assert.throws(() => store.create({ text: '   ' }), ValidationError);
    assert.throws(() => store.create({ text: 42 }), ValidationError);
    assert.throws(() => store.create({ text: 'x'.repeat(4001) }), ValidationError);
    assert.throws(
      () => store.create({ text: 'ok', idempotencyKey: 'bad key with spaces' }),
      ValidationError,
    );
  } finally {
    removeWorkspace(workspace);
  }
});

test('task store: identical queued text is rejected as duplicate', () => {
  const { workspace, store } = freshStore();
  try {
    store.create({ text: 'Change the background to purple' });
    assert.throws(
      () => store.create({ text: 'change   the background to PURPLE' }),
      DuplicateTaskError,
    );
  } finally {
    removeWorkspace(workspace);
  }
});

test('task store: same idempotencyKey returns the existing task', () => {
  const { workspace, store } = freshStore();
  try {
    const first = store.create({ text: 'task one', idempotencyKey: 'k-1' });
    const second = store.create({ text: 'task two', idempotencyKey: 'k-1' });
    assert.equal(second.duplicate, true);
    assert.equal(second.task.id, first.task.id);
    assert.equal(store.list().length, 1);
  } finally {
    removeWorkspace(workspace);
  }
});

test('task store: illegal transitions throw and do not mutate state', () => {
  const { workspace, store } = freshStore();
  try {
    const { task } = store.create({ text: 'x' });
    assert.throws(() => store.transition(task.id, 'succeeded'));
    assert.equal(store.get(task.id).status, 'queued');
    store.transition(task.id, 'running');
    store.transition(task.id, 'failed', {
      error: { code: 'X', message: 'boom' },
    });
    assert.throws(() => store.transition(task.id, 'running'));
  } finally {
    removeWorkspace(workspace);
  }
});

test('task store: persistence survives reopen', () => {
  const workspace = makeWorkspace();
  try {
    const options = {
      runtimeDir: path.join(workspace, '.opengame'),
      workspaceDir: workspace,
    };
    const first = createTaskStore(options);
    const { task } = first.create({ text: 'persisted task' });

    const reopened = createTaskStore(options);
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.get(task.id).text, 'persisted task');
  } finally {
    removeWorkspace(workspace);
  }
});

test('task store: restart marks running/verifying as interrupted, queued stays queued', () => {
  const workspace = makeWorkspace();
  try {
    const options = {
      runtimeDir: path.join(workspace, '.opengame'),
      workspaceDir: workspace,
    };
    const store = createTaskStore(options);
    const running = store.create({ text: 'running task' }).task;
    const verifying = store.create({ text: 'verifying task' }).task;
    const queued = store.create({ text: 'queued task' }).task;
    store.transition(running.id, 'running');
    store.transition(verifying.id, 'running');
    store.transition(verifying.id, 'verifying');

    const reopened = createTaskStore(options);
    const recovered = reopened.recoverOnStartup();
    assert.deepEqual(recovered.sort(), [running.id, verifying.id].sort());
    assert.equal(reopened.get(running.id).status, 'interrupted');
    assert.equal(reopened.get(verifying.id).status, 'interrupted');
    assert.equal(reopened.get(queued.id).status, 'queued');
    assert.equal(reopened.get(running.id).error.code, 'INTERRUPTED');

    // A second recovery is a no-op.
    assert.deepEqual(reopened.recoverOnStartup(), []);
  } finally {
    removeWorkspace(workspace);
  }
});

test('task store: log files are written under .opengame/remote/logs', () => {
  const { workspace, store } = freshStore();
  try {
    const { task } = store.create({ text: 'log task' });
    store.appendLog(task.id, 'hello\n');
    assert.equal(store.readLog(task.id), 'hello\n');
    const file = path.join(workspace, task.logPath);
    assert.ok(fs.existsSync(file));
    assert.ok(file.endsWith('.log'));
  } finally {
    removeWorkspace(workspace);
  }
});

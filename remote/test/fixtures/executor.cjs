'use strict';

/**
 * Deterministic stand-in for the OpenGame CLI, used by the remote bridge tests
 * through REMOTE_EXECUTOR_CMD. It is NOT used in normal operation.
 *
 * Protocol: argv[2] is the task text. Two JSON lines are appended to
 * <cwd>/executions.jsonl: one when the run starts, one when it ends. The "start"
 * record lets tests prove that a task is never re-run after a restart.
 */

const fs = require('fs');
const path = require('path');

const text = process.argv[2] || '';
const dir = process.cwd();
const file = path.join(dir, 'executions.jsonl');

const start = Date.now();

fs.appendFileSync(
  file,
  `${JSON.stringify({ event: 'start', pid: process.pid, start, text })}\n`,
);

function finish(code) {
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      event: 'end',
      pid: process.pid,
      start,
      end: Date.now(),
      code,
      text,
    })}\n`,
  );
  process.exit(code);
}

function applyBackgroundChange() {
  const target = path.join(dir, 'index.html');
  if (!fs.existsSync(target)) return;
  const html = fs.readFileSync(target, 'utf-8');
  fs.writeFileSync(
    target,
    html.replace(/--bg:\s*#(?:000000|101014)/i, '--bg: #7c3aed'),
    'utf-8',
  );
}

const delay = text.includes('SLOW') ? 1500 : 50;

setTimeout(() => {
  if (text.includes('FAIL')) {
    process.stderr.write('executor: simulated failure marker XYZ\n');
    finish(3);
    return;
  }
  if (text.includes('BACKGROUND')) applyBackgroundChange();
  finish(0);
}, delay);

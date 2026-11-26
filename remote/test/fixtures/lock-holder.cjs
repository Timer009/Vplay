'use strict';

/** 持锁进程夹具：用于验证崩溃后的锁回收与活锁保护（NEW-C04-02）。 */
const fs = require('fs');
const { withHomeLock } = require('../../lib/projects.cjs');

const [home, readyFile] = process.argv.slice(2);
const buffer = new SharedArrayBuffer(4);

withHomeLock(home, () => {
  fs.writeFileSync(readyFile, String(process.pid), 'utf-8');
  // 持锁 30 秒；父进程会 SIGKILL 它
  Atomics.wait(new Int32Array(buffer), 0, 0, 30000);
});

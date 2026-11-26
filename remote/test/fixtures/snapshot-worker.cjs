'use strict';

/** 并发快照夹具：模拟两个进程同时写同一项目的快照注册表（NEW-06）。 */
const { createProjectRegistry } = require('../../lib/projects.cjs');

const [home, id, count] = process.argv.slice(2);
const registry = createProjectRegistry({ home });
for (let i = 0; i < Number(count || 5); i += 1) {
  registry.snapshot(id, `concurrent-${process.pid}-${i}`);
}

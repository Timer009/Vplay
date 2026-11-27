'use strict';

/** B11 并发事件写入夹具：模拟 CLI 与 server 同时向同一事件文件追加。 */
const { createEventStore } = require('../../lib/events.cjs');

const [file, count, prefix] = process.argv.slice(2);
const store = createEventStore({ file });
for (let i = 0; i < Number(count || 10); i += 1) {
  store.append({
    type: 'task.created',
    taskId: `${prefix}-${i}`,
    projectId: 'demo',
    status: 'queued',
    data: { createdBy: prefix },
  });
}

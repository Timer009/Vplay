'use strict';

/**
 * 持久化任务事件流（C08 X-01..X-05 / Sprint03B Connect L2）。
 *
 * - append-only JSONL：`<runtime>/events/events.jsonl`
 * - 单调 id（字符串数字），带 prevHash/hash 哈希链
 * - 可选 HMAC 锚定（密钥只在宿主进程环境，不传给 Agent 子进程）
 * - 事件只含元数据：taskId/status/projectId，绝不含 prompt 正文或绝对路径
 * - 内存保留最近窗口，供 SSE 直播与 Last-Event-ID 补发
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_MEMORY_EVENTS = 5000;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hmac(key, text) {
  return crypto.createHmac('sha256', key).update(text).digest('hex');
}

function createEventStore(options = {}) {
  const file = path.resolve(options.file);
  const hmacKey = options.hmacKey || null;
  const logger = options.logger || (() => {});
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let events = [];
  let nextId = 1;
  let prevHash = 'GENESIS';
  const listeners = new Set();

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record && record.id) {
            events.push(record);
            nextId = Math.max(nextId, Number(record.id) + 1);
            prevHash = record.hash || prevHash;
          }
        } catch {
          // 损坏行跳过，但不影响后续追加
        }
      }
      if (events.length > MAX_MEMORY_EVENTS) {
        events = events.slice(-MAX_MEMORY_EVENTS);
      }
    } catch {
      // 首次启动没有文件
    }
  }
  load();

  function append(input) {
    const id = String(nextId);
    nextId += 1;
    const at = new Date().toISOString();
    const payload = {
      id,
      type: String(input && input.type ? input.type : 'task.event'),
      taskId: input && input.taskId ? String(input.taskId) : null,
      projectId: input && input.projectId ? String(input.projectId) : null,
      status: input && input.status ? String(input.status) : null,
      at,
      data: input && input.data && typeof input.data === 'object' ? input.data : null,
    };
    const body = JSON.stringify(payload);
    const hash = sha256(`${prevHash}\n${body}`);
    const record = {
      ...payload,
      seq: Number(id),
      prevHash,
      hash,
      ...(hmacKey ? { hmac: hmac(hmacKey, hash) } : {}),
    };
    prevHash = hash;
    try {
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (error) {
      logger(`[events] append failed: ${error.message}`);
      return null;
    }
    events.push(record);
    if (events.length > MAX_MEMORY_EVENTS) events.shift();
    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // 监听器异常不影响写入
      }
    }
    return record;
  }

  function listAfter(lastId, limit = 1000) {
    const after = Number(lastId);
    const filtered = Number.isFinite(after)
      ? events.filter((item) => Number(item.id) > after)
      : events.slice();
    return filtered.slice(-Math.max(1, Number(limit) || 1000));
  }

  function listForTask(taskId, limit = 2000) {
    return events.filter((item) => item.taskId === taskId).slice(-limit);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function lastId() {
    return String(nextId - 1);
  }

  return { file, append, listAfter, listForTask, subscribe, lastId };
}

module.exports = { createEventStore };

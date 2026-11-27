'use strict';

/**
 * 持久化任务事件流（C08 X-01..X-05 / Sprint03B / B11）。
 *
 * - append-only JSONL：`<runtime>/events/events.jsonl`
 * - 单调 id/seq，prevHash/hash 哈希链（B11：seq 参与哈希，v2 记录带 hashAlg）
 * - 可选 HMAC 锚定（密钥只在宿主进程环境，不传给 Agent 子进程）
 * - B11：跨进程 append 互斥 + anchor（count/lastId/head）→ 可检出尾删/截断
 * - 事件只含元数据：taskId/status/projectId，绝不含 prompt 正文或绝对路径
 * - 内存保留最近窗口，供 SSE 直播与 Last-Event-ID 补发
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_MEMORY_EVENTS = 5000;
const HASH_ALG = 'seq-in-body-v2';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hmac(key, text) {
  return crypto.createHmac('sha256', key).update(text).digest('hex');
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function recordBody(record) {
  const base = {
    id: record.id,
    type: record.type,
    taskId: record.taskId,
    projectId: record.projectId,
    status: record.status,
    at: record.at,
    data: record.data,
  };
  if (record.hashAlg === HASH_ALG) base.seq = record.seq;
  return JSON.stringify(base);
}

/**
 * Anchor HMAC material.
 * v2（B14）覆盖 alg，防止把 alg 降级为 sha256 后重写 count/head；
 * v1（B12 及更早）仍按旧材料校验，保证已存在证据可读。
 */
function anchorMaterial(anchor) {
  if (Number(anchor.version) >= 2) {
    return `v2\n${anchor.alg}\n${anchor.count}\n${anchor.lastId}\n${anchor.head || ''}`;
  }
  return `${anchor.count}\n${anchor.lastId}\n${anchor.head || ''}`;
}

function createEventStore(options = {}) {
  const file = path.resolve(options.file);
  const dir = path.dirname(file);
  const anchorFile = path.join(dir, 'events.anchor.json');
  const lockFile = path.join(dir, 'events.lock');
  const hmacKey = options.hmacKey || null;
  const requireHmac = options.requireHmac === true;
  if (requireHmac && !hmacKey) {
    const error = new Error('EVIDENCE_HMAC_KEY is required when requireHmac=true');
    error.code = 'HMAC_KEY_MISSING';
    throw error;
  }
  const logger = options.logger || (() => {});
  const keyFingerprint = hmacKey ? sha256(hmacKey).slice(0, 16) : null;
  fs.mkdirSync(dir, { recursive: true });

  let events = [];
  let nextId = 1;
  let prevHash = 'GENESIS';
  let totalCount = 0;
  let lastSize = 0;
  let anchor = null;
  let anchorAdopted = false;
  const listeners = new Set();
  let lastBroken = 0;

  function readAnchor() {
    try {
      return JSON.parse(fs.readFileSync(anchorFile, 'utf-8'));
    } catch {
      return null;
    }
  }

  function parseLines(raw) {
    const records = [];
    for (const line of String(raw || '').split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && record.id) records.push(record);
        else lastBroken += 1;
      } catch {
        lastBroken += 1;
      }
    }
    return records;
  }

  function applyRecords(records) {
    events = records.slice(-MAX_MEMORY_EVENTS);
    totalCount = records.length;
    nextId = 1;
    prevHash = 'GENESIS';
    for (const record of records) {
      nextId = Math.max(nextId, Number(record.id) + 1);
      prevHash = record.hash || prevHash;
    }
  }

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      applyRecords(parseLines(raw));
      lastSize = Buffer.byteLength(raw, 'utf-8');
    } catch {
      events = [];
      nextId = 1;
      prevHash = 'GENESIS';
      totalCount = 0;
      lastSize = 0;
    }
    anchor = readAnchor();
    if (!anchor && totalCount > 0) {
      // C13-P1-02：已签名证据链缺失 anchor 时不得自动收养。
      // 仅允许「无 HMAC key 的旧链」在显式 VPLAY_ALLOW_ANCHOR_ADOPT=1 下收养，
      // 并永久标记 adopted，verify() 必须报告 ANCHOR_ADOPTED。
      const canAdopt = !hmacKey && process.env.VPLAY_ALLOW_ANCHOR_ADOPT === '1';
      if (canAdopt) {
        anchorAdopted = true;
        writeAnchor({ adopted: true });
        anchor = readAnchor();
        logger('[events] anchor adopted from existing unsigned chain (explicit opt-in)');
      } else {
        logger(
          '[events] anchor missing for non-empty chain; refusing automatic adoption ' +
          '(set VPLAY_ALLOW_ANCHOR_ADOPT=1 only for unsigned legacy chains)',
        );
      }
    } else if (anchor && anchor.adopted === true) {
      anchorAdopted = true;
    }
    if (anchor && Number.isFinite(Number(anchor.count)) && Number(anchor.count) > totalCount) {
      logger(
        `[events] WARNING: anchor count ${anchor.count} > file records ${totalCount}; possible tail truncation`,
      );
    }
  }
  load();

  function reloadFromDisk() {
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      applyRecords(parseLines(raw));
      lastSize = Buffer.byteLength(raw, 'utf-8');
    } catch {
      // 文件刚被删除或尚未创建：保持当前状态
    }
  }

  function withLock(fn) {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (error) {
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        let info = null;
        try {
          info = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
        } catch {
          info = null;
        }
        let stale = false;
        if (info) {
          try {
            process.kill(Number(info.pid), 0);
            stale = Date.now() - Number(info.at || 0) > 30000;
          } catch {
            stale = true;
          }
        } else {
          try {
            stale = Date.now() - fs.statSync(lockFile).mtimeMs > 5000;
          } catch {
            stale = false;
          }
        }
        if (stale) {
          try {
            fs.rmSync(lockFile, { force: true });
          } catch {
            // 忽略
          }
          continue;
        }
        if (Date.now() > deadline) {
          const busy = new Error('event store is busy');
          busy.code = 'EVENT_STORE_BUSY';
          throw busy;
        }
        sleepSync(15);
      }
    }
    try {
      return fn();
    } finally {
      try {
        fs.rmSync(lockFile, { force: true });
      } catch {
        // 忽略
      }
    }
  }

  function writeAnchor(options = {}) {
    const head = events.length ? events[events.length - 1].hash : null;
    const payload = {
      version: 2,
      count: totalCount,
      lastId: String(nextId - 1),
      head,
      hashAlg: HASH_ALG,
      alg: hmacKey ? 'hmac-sha256' : 'sha256',
      keyFingerprint,
      updatedAt: new Date().toISOString(),
    };
    if (options.adopted === true || anchorAdopted) payload.adopted = true;
    if (hmacKey) {
      payload.hmac = hmac(
        hmacKey,
        anchorMaterial(payload),
      );
    }
    const tmp = `${anchorFile}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tmp, anchorFile);
      anchor = payload;
    } catch (error) {
      logger(`[events] anchor write failed: ${error.message}`);
    }
  }

  function append(input) {
    return withLock(() => {
      // C13-P1-02：非空链缺 anchor 且未显式收养时，拒绝写入（否则会用新 anchor 掩盖尾删）
      if (!anchor && totalCount > 0 && !anchorAdopted) {
        logger('[events] append refused: anchor missing for existing chain (tamper evidence)');
        return null;
      }
      // 其它进程可能已追加：按文件实际大小同步内存状态
      try {
        if (fs.statSync(file).size !== lastSize) reloadFromDisk();
      } catch {
        // 首次创建
      }
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
      const record = {
        ...payload,
        seq: Number(id),
        hashAlg: HASH_ALG,
      };
      const body = recordBody(record);
      const hash = sha256(`${prevHash}\n${body}`);
      record.prevHash = prevHash;
      record.hash = hash;
      if (hmacKey) record.hmac = hmac(hmacKey, hash);
      prevHash = hash;
      const line = `${JSON.stringify(record)}\n`;
      try {
        fs.appendFileSync(file, line, 'utf-8');
      } catch (error) {
        logger(`[events] append failed: ${error.message}`);
        return null;
      }
      totalCount += 1;
      lastSize += Buffer.byteLength(line, 'utf-8');
      events.push(record);
      if (events.length > MAX_MEMORY_EVENTS) events.shift();
      writeAnchor();
      for (const listener of listeners) {
        try {
          listener(record);
        } catch {
          // 监听器异常不影响写入
        }
      }
      return record;
    });
  }

  function listAfter(lastId, limit = 1000) {
    const after = Number(lastId);
    const filtered = Number.isFinite(after)
      ? events.filter((item) => Number(item.id) > after)
      : events.slice();
    return filtered.slice(-Math.max(1, Number(limit) || 1000));
  }

  /** B11：补发时显式告知是否因内存窗口丢掉了早期事件。 */
  function listAfterInfo(lastId, limit = 1000) {
    const after = Number(lastId);
    const firstInWindow = events.length ? Number(events[0].id) : null;
    const truncated = Number.isFinite(after) && firstInWindow !== null && after < firstInWindow - 1;
    return {
      events: listAfter(lastId, limit),
      truncated,
      windowStart: firstInWindow,
    };
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

  /**
   * 离线/运行期校验：逐条重算 hash、检查 seq/id、prevHash 连续性、HMAC 与 anchor。
   * 不修改文件；anchor 缺失或 count 不一致都会报问题（尾删/截断可检出）。
   */
  function verify(options = {}) {
    const problems = [];
    let records = [];
    lastBroken = 0;
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      records = parseLines(raw);
    } catch {
      if (totalCount > 0) problems.push('EVENTS_UNREADABLE');
    }
    const currentAnchor = readAnchor();
    const chainUsesHmac =
      records.some((record) => Boolean(record.hmac)) ||
      Boolean(currentAnchor && currentAnchor.alg === 'hmac-sha256');
    const mustHaveKey = options.requireHmac === true || requireHmac || chainUsesHmac;
    if (mustHaveKey && !hmacKey) {
      // HMAC_KEY_REQUIRED 为 C13 语义；HMAC_KEY_MISSING 保留为 B13 兼容别名
      problems.push('HMAC_KEY_REQUIRED');
      problems.push('HMAC_KEY_MISSING');
    }
    if (anchorAdopted || (currentAnchor && currentAnchor.adopted === true)) {
      problems.push('ANCHOR_ADOPTED');
    }
    let prev = 'GENESIS';
    let lastIdValue = null;
    for (const record of records) {
      if (record.seq !== Number(record.id)) problems.push(`SEQ_ID_MISMATCH:${record.id}`);
      if (record.prevHash !== prev) problems.push(`CHAIN_BROKEN:${record.id}`);
      const body = recordBody(record);
      const expected = sha256(`${prev}\n${body}`);
      if (record.hash !== expected) problems.push(`HASH_MISMATCH:${record.id}`);
      if (hmacKey && !record.hmac) {
        // C13-P1-03：持 key/强制签名时，缺失签名同样不可接受
        problems.push(`RECORD_HMAC_MISSING:${record.id}`);
      }
      if (record.hmac && hmacKey) {
        const expectedMac = hmac(hmacKey, record.hash);
        if (record.hmac !== expectedMac) problems.push(`HMAC_MISMATCH:${record.id}`);
      }
      prev = record.hash;
      lastIdValue = record.id;
    }
    if (!currentAnchor) {
      if (records.length) problems.push('ANCHOR_MISSING');
    } else {
      if (Number(currentAnchor.count) !== records.length) problems.push('ANCHOR_COUNT_MISMATCH');
      if (String(currentAnchor.lastId) !== String(lastIdValue)) {
        problems.push('ANCHOR_LAST_ID_MISMATCH');
      }
      if ((currentAnchor.head || null) !== (records.length ? records[records.length - 1].hash : null)) {
        problems.push('ANCHOR_HEAD_MISMATCH');
      }
      if (hmacKey) {
        // C13-P1-03：有 key 时 anchor 必须保持 hmac-sha256，且 HMAC 覆盖 alg
        if (currentAnchor.alg !== 'hmac-sha256') problems.push('ANCHOR_ALG_DOWNGRADE');
        if (!currentAnchor.hmac) {
          problems.push('ANCHOR_HMAC_MISSING');
        } else if (currentAnchor.hmac !== hmac(hmacKey, anchorMaterial(currentAnchor))) {
          problems.push('ANCHOR_HMAC_MISMATCH');
        }
        if (
          currentAnchor.keyFingerprint &&
          keyFingerprint &&
          currentAnchor.keyFingerprint !== keyFingerprint
        ) {
          problems.push('ANCHOR_KEY_MISMATCH');
        }
      }
    }
    if (lastBroken > 0) problems.push(`BROKEN_LINES:${lastBroken}`);
    return {
      ok: problems.length === 0,
      count: records.length,
      lastId: lastIdValue,
      head: records.length ? records[records.length - 1].hash : null,
      problems: problems.slice(0, 50),
    };
  }

  return {
    file,
    anchorFile,
    append,
    listAfter,
    listAfterInfo,
    listForTask,
    subscribe,
    lastId,
    verify,
  };
}

module.exports = { createEventStore, HASH_ALG, recordBody };

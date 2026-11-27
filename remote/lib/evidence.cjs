'use strict';

/**
 * 项目外证据存储（C07-P1-11 / C08 §6）。
 *
 * 目录：<VPLAY_HOME>/evidence/<projectId>/<taskId>/
 *   meta.json       任务/项目/版本/产物 ID、状态、模型 requestId/usage（若可用）
 *   events.jsonl    该任务的持久化事件（含哈希链）
 *   task.log        任务日志（已脱敏）
 *   report.json     结构化结果（publicTask 安全子集）
 *   anchor.json     artifactId + 宿主 HMAC（密钥不传给 Agent 子进程）
 *
 * 说明：这不是 OS 级不可篡改存储；HMAC 只证明“由持有宿主密钥的进程生成”，
 * 不能抵御同样能读取宿主密钥的本机高权限进程。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function safePart(value, fallback) {
  const text = String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return text || fallback;
}

function createEvidenceStore(options = {}) {
  const home = path.resolve(options.home);
  const hmacKey = options.hmacKey || null;
  const root = options.root ? path.resolve(options.root) : path.join(home, 'evidence');

  function writeTaskEvidence({ task, result, versionId, events = [], logText = '', extra = null }) {
    const projectId = safePart(task.projectId || 'default', 'default');
    const taskId = safePart(task.id, 'task');
    const dir = path.join(root, projectId, taskId);
    fs.mkdirSync(dir, { recursive: true });

    const eventLines = events.map((item) => JSON.stringify(item)).join('\n');
    const eventsFile = path.join(dir, 'events.jsonl');
    fs.writeFileSync(eventsFile, eventLines ? `${eventLines}\n` : '', 'utf-8');

    const logFile = path.join(dir, 'task.log');
    fs.writeFileSync(logFile, String(logText || ''), 'utf-8');

    const report = {
      schemaVersion: 1,
      taskId: task.id,
      projectId: task.projectId || 'default',
      kind: task.kind || 'prompt',
      createdBy: task.createdBy || 'admin',
      status: task.status,
      verified: result && result.verified === true,
      outcome: (result && result.outcome) || null,
      versionId: versionId || null,
      error: task.error || null,
      result: result
        ? {
            verified: result.verified,
            outcome: result.outcome,
            changedFiles: result.changedFiles,
            diffSummary: result.diffSummary,
            verification: result.verification,
            vision: result.vision || null,
            model: result.model || null,
            usage: result.usage || null,
          }
        : null,
      extra: extra || null,
      at: new Date().toISOString(),
    };
    const reportFile = path.join(dir, 'report.json');
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');

    const eventsHash = sha256(eventLines);
    const reportHash = sha256(fs.readFileSync(reportFile));
    const artifactId = sha256(`${task.id}\n${versionId || ''}\n${eventsHash}\n${reportHash}`);
    const chainHead = events.length
      ? events[events.length - 1].hash || null
      : null;
    const anchor = {
      taskId: task.id,
      projectId: task.projectId || 'default',
      versionId: versionId || null,
      artifactId,
      eventsHash,
      reportHash,
      chainHead,
      alg: hmacKey ? 'hmac-sha256' : 'sha256',
      keyFingerprint: hmacKey ? sha256(hmacKey).slice(0, 16) : null,
      hmac: hmacKey ? crypto.createHmac('sha256', hmacKey).update(artifactId).digest('hex') : null,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'anchor.json'), JSON.stringify(anchor, null, 2), 'utf-8');

    const meta = {
      taskId: task.id,
      projectId: task.projectId || 'default',
      versionId: versionId || null,
      artifactId,
      dir,
      createdAt: task.createdAt || null,
      finishedAt: task.finishedAt || null,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

    // 全量清单：列出证据目录所有文件（不含清单本身），供离线校验「缺失/多余/篡改」
    const files = [];
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === 'manifest.json') continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({ path: name, bytes: stat.size, sha256: sha256(fs.readFileSync(full)) });
    }
    const manifest = {
      schemaVersion: 1,
      taskId: task.id,
      projectId: task.projectId || 'default',
      alg: anchor.alg,
      keyFingerprint: anchor.keyFingerprint,
      artifactId,
      files,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    return { dir, artifactId, anchor, versionId: versionId || null };
  }

  /**
   * 离线校验（B10 / C09 B-10）：重算 artifactId、HMAC、事件链与全量清单。
   * 这不是「不可篡改」证明：能读取宿主密钥的进程仍可伪造。
   */
  function verifyEvidence(dir, options = {}) {
    const root = path.resolve(dir);
    const hmacKey = options.hmacKey || '';
    const requireHmac = options.requireHmac === true;
    const reasons = [];
    const read = (name, fallback) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, name), 'utf-8'));
      } catch {
        return fallback;
      }
    };
    const anchor = read('anchor.json', null);
    const manifest = read('manifest.json', null);
    const report = read('report.json', null);
    if (!anchor) return { ok: false, reasons: ['ANCHOR_MISSING'] };
    if (!manifest) reasons.push('MANIFEST_MISSING');

    let eventsText = '';
    try {
      eventsText = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf-8').replace(/\n$/, '');
    } catch {
      reasons.push('EVENTS_MISSING');
    }
    let reportHash = null;
    try {
      reportHash = sha256(fs.readFileSync(path.join(root, 'report.json')));
    } catch {
      reasons.push('REPORT_MISSING');
    }
    const eventsHash = sha256(eventsText);
    const artifactId = sha256(
      `${anchor.taskId}\n${anchor.versionId || ''}\n${eventsHash}\n${reportHash || ''}`,
    );
    if (anchor.eventsHash !== eventsHash) reasons.push('EVENTS_TAMPERED');
    if (reportHash && anchor.reportHash !== reportHash) reasons.push('REPORT_TAMPERED');
    if (anchor.artifactId !== artifactId) reasons.push('ARTIFACT_MISMATCH');

    // 事件哈希链连续性
    if (eventsText) {
      let prev = 'GENESIS';
      for (const line of eventsText.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          reasons.push('EVENT_PARSE');
          break;
        }
        const body = JSON.stringify({
          id: record.id,
          type: record.type,
          taskId: record.taskId,
          projectId: record.projectId,
          status: record.status,
          at: record.at,
          data: record.data,
        });
        if (record.prevHash !== prev) {
          reasons.push('EVENT_CHAIN_BROKEN');
          break;
        }
        const expected = sha256(`${prev}\n${body}`);
        if (record.hash !== expected) {
          reasons.push('EVENT_HASH_MISMATCH');
          break;
        }
        prev = record.hash;
      }
      if (anchor.chainHead && prev !== anchor.chainHead) reasons.push('CHAIN_HEAD_MISMATCH');
    }

    if (requireHmac && anchor.alg !== 'hmac-sha256') reasons.push('HMAC_REQUIRED');
    if (anchor.alg === 'hmac-sha256') {
      if (!hmacKey) reasons.push('HMAC_KEY_MISSING');
      else {
        if (anchor.keyFingerprint !== sha256(hmacKey).slice(0, 16)) reasons.push('HMAC_KEY_WRONG');
        const expected = crypto.createHmac('sha256', hmacKey).update(anchor.artifactId).digest('hex');
        if (anchor.hmac !== expected) reasons.push('HMAC_MISMATCH');
      }
    }

    if (manifest) {
      const listed = new Set();
      for (const item of Array.isArray(manifest.files) ? manifest.files : []) {
        listed.add(item.path);
        try {
          const actual = sha256(fs.readFileSync(path.join(root, item.path)));
          if (actual !== item.sha256) reasons.push(`FILE_TAMPERED:${item.path}`);
        } catch {
          reasons.push(`FILE_MISSING:${item.path}`);
        }
      }
      for (const name of fs.readdirSync(root)) {
        if (name === 'manifest.json') continue;
        const full = path.join(root, name);
        try {
          if (fs.statSync(full).isFile() && !listed.has(name)) reasons.push(`FILE_EXTRA:${name}`);
        } catch {
          // 忽略
        }
      }
    }
    void report;
    return { ok: reasons.length === 0, reasons, artifactId };
  }

  return { root, writeTaskEvidence, verifyEvidence };
}

module.exports = { createEvidenceStore };

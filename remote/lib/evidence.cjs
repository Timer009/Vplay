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
    const anchor = {
      taskId: task.id,
      projectId: task.projectId || 'default',
      versionId: versionId || null,
      artifactId,
      eventsHash,
      reportHash,
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
    return { dir, artifactId, anchor, versionId: versionId || null };
  }

  return { root, writeTaskEvidence };
}

module.exports = { createEvidenceStore };

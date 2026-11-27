'use strict';

/**
 * Vision 宿主适配层（Sprint03B / E05 0.2.0 / C07 HOST-CONTRACT）。
 *
 * 职责边界：
 *  - 不实现项目管理、任务队列、快照、回退、journal —— 全部复用 Sprint02/03 宿主能力；
 *  - 默认假设调用方（worker）已持有项目锁（skipLock=true），绝不释放他人锁；
 *  - 补丁仅允许 HTML/CSS；JS/游戏逻辑仍走普通 Agent 路径；
 *  - 数据外发要求显式同意（VISION_DATA_CONSENT=1 或 deps.consent）；
 *  - 截图/源码发送前脱敏，产物写到项目外 evidence 目录。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { applyPatchAtomically } = require('./vision-policy.cjs');

const VENDOR_ENTRY = path.join(__dirname, '..', '..', 'vendor', 'vision', 'src', 'index.mjs');

const SAFE_FILE = /\.(html?|css)$/i;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isSafeAllowedFile(file) {
  return SAFE_FILE.test(String(file || ''));
}

function createVisionService(options = {}) {
  const registry = options.registry;
  const home = options.home;
  const eventStore = options.eventStore || null;
  const deps = options.deps || {};

  async function loadVision() {
    if (deps.vision) return deps.vision;
    // 可复现 vendoring：仓库内相对路径，不依赖本机绝对路径或 npm registry
    return import(pathToFileURL(VENDOR_ENTRY).href);
  }

  function emit(taskId, projectId, type, data) {
    if (!eventStore) return;
    eventStore.append({
      type: `vision.${type}`,
      taskId,
      projectId,
      status: data && data.status ? String(data.status) : null,
      data: data
        ? {
            round: data.round || null,
            ok: data.ok === undefined ? null : Boolean(data.ok),
            blocked: Number(data.blocked || 0),
            verified: data.verified === undefined ? null : Boolean(data.verified),
          }
        : null,
    });
  }

  async function run(input) {
    const {
      taskId,
      projectId,
      mode = 'analyze',
      allowedFiles: requestedFiles,
      skipLock = true,
      previewUrl: previewUrlOverride = null,
      scenario = 'default',
    } = input || {};

    const consent = deps.consent === true || process.env.VISION_DATA_CONSENT === '1';
    if (!consent) {
      const error = new Error(
        'Vision 会将截图/源码片段发送给模型；请设置 VISION_DATA_CONSENT=1 表示已获用户同意',
      );
      error.code = 'VISION_CONSENT_REQUIRED';
      throw error;
    }

    const vision = await loadVision();
    const project = registry.get(projectId);
    const allowedFiles = (requestedFiles && requestedFiles.length
      ? requestedFiles
      : [project.entry && SAFE_FILE.test(project.entry) ? project.entry : 'index.html']
    ).map((item) => String(item).replace(/\\/g, '/'));

    if (!allowedFiles.length || !allowedFiles.every(isSafeAllowedFile)) {
      const error = new Error('Vision 只允许修复 HTML/CSS 文件，拒绝 JS/其他类型');
      error.code = 'VISION_FILE_NOT_ALLOWED';
      throw error;
    }

    // 宿主锁：默认由 worker 持有；仅 skipLock=false 时自行加锁，并只释放自己的 token
    let lockToken = null;
    if (!skipLock) {
      lockToken = registry.acquireLock(projectId, { taskId }).token;
    }

    try {
      // 基线：Vite 先构建，再原子发布并做全量 manifest 校验
      if (project.kind === 'vite') {
        const build = registry.buildProject(project);
        if (!build.ok) {
          throw new Error(`VISION_BUILD_FAILED: ${build.command} exit=${build.status}`);
        }
      }
      const previewRoot = registry.buildPreview(projectId);
      const baseline = registry.verifyPreview(projectId);
      if (!previewRoot || !baseline.ok) {
        throw new Error(`VISION_PREVIEW_STALE: ${baseline.reason}`);
      }

      const previewPort = Number(process.env.PREVIEW_PORT || (Number(process.env.PORT || 8787) + 1));
      const previewUrl =
        previewUrlOverride || `http://127.0.0.1:${previewPort}/p/${projectId}/`;

      const gateway =
        deps.gateway ||
        vision.createModelGateway({ config: vision.loadConfig(process.env) });
      const browserRunner =
        deps.browserRunner ||
        vision.createBrowserRunner({
          executablePath: process.env.VPLAY_BROWSER_EXECUTABLE || null,
          headless: process.env.VPLAY_BROWSER_HEADLESS !== 'false',
        });
      const adapter = deps.adapter || vision.createSpacerAdapter();
      const maskSelectors = String(process.env.VPLAY_VISION_MASK_SELECTORS || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (maskSelectors.length && !adapter.redaction) {
        adapter.redaction = { selectors: maskSelectors };
      }

      const outDir = path.join(home, 'evidence', projectId, taskId, 'screenshots');
      fs.mkdirSync(outDir, { recursive: true });

      const events = vision.createEventSink({
        taskId,
        projectId,
        onEvent: (event) => emit(taskId, projectId, event.type || 'event', event),
      });

      emit(taskId, projectId, 'started', { status: mode });

      const result = await vision.runVisionTask({
        taskId,
        projectId,
        root: project.srcDir,
        previewUrl,
        adapter,
        browserRunner,
        gateway,
        events,
        mode: mode === 'repair' ? 'repair' : 'analyze',
        scenario,
        allowedFiles,
        sourceProvider: async () => {
          const source = fs.readFileSync(path.join(project.srcDir, allowedFiles[0]), 'utf-8');
          const redacted = vision.redactSource(source);
          return redacted.text;
        },
        host: {
          snapshot: (label) => registry.snapshot(projectId, label),
          applyFiles: async (files) => {
            if (!files.every((item) => allowedFiles.includes(String(item.file).replace(/\\/g, '/')))) {
              throw new Error('VISION_PATCH_FILE_NOT_ALLOWED');
            }
            const journal = path.join(home, 'evidence', projectId, taskId, 'apply-journal.json');
            applyPatchAtomically({
              root: project.srcDir,
              files: files.map((item) => ({ file: item.file, content: item.content })),
              allowedFiles,
              journalFile: journal,
            });
            if (project.kind === 'vite') {
              const build = registry.buildProject(project);
              if (!build.ok) throw new Error(`VISION_BUILD_FAILED: ${build.command}`);
            }
            const root = registry.buildPreview(projectId);
            const check = registry.verifyPreview(projectId);
            if (!root || !check.ok) throw new Error(`VISION_PREVIEW_STALE: ${check.reason}`);
          },
          diff: (seq) => registry.diff(projectId, seq, 'current'),
          rollback: async (seq) => {
            const rolled = registry.rollback(projectId, seq);
            if (!rolled.verified || !rolled.previewReady) {
              throw new Error('ROLLBACK_NOT_VERIFIED');
            }
            if (project.kind === 'vite') {
              const build = registry.buildProject(project);
              if (!build.ok) throw new Error('ROLLBACK_BUILD_FAILED');
            }
            const root = registry.buildPreview(projectId);
            const check = registry.verifyPreview(projectId);
            if (!root || !check.ok) throw new Error(`ROLLBACK_PREVIEW_MISMATCH: ${check.reason}`);
          },
        },
        outDir,
      });

      const report = {
        schemaVersion: 1,
        taskId,
        projectId,
        mode,
        previewUrl,
        previewManifest: baseline.checked,
        redaction: {
          maskSelectors,
          sourceRedaction: result.sourceRedaction || null,
        },
        result,
        at: new Date().toISOString(),
      };
      const reportFile = path.join(home, 'evidence', projectId, taskId, 'vision-report.json');
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');
      const artifactId = sha256(JSON.stringify(report));
      emit(taskId, projectId, 'completed', {
        status: result.status || (result.ok ? 'succeeded' : 'failed'),
        ok: result.ok,
        verified: result.validation ? result.validation.ok : result.ok,
      });
      return { result, reportFile, artifactId, outDir };
    } finally {
      if (!skipLock && lockToken) registry.releaseLock(projectId, lockToken);
    }
  }

  return { run };
}

module.exports = { createVisionService, isSafeAllowedFile };

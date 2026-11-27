'use strict';

/**
 * Vision 宿主适配层（Sprint03B / Sprint03C B10 / E05 0.2.0 / C07 HOST-CONTRACT）。
 *
 * 职责边界：
 *  - 不实现项目管理、任务队列、快照、回退、journal —— 全部复用 Sprint02/03 宿主能力；
 *  - 默认假设调用方（worker）已持有项目锁（skipLock=true），绝不释放他人锁；
 *  - 补丁仅允许 HTML/CSS；JS/游戏逻辑仍走普通 Agent 路径；
 *  - 数据外发要求显式同意（VISION_DATA_CONSENT=1 或 deps.consent）；
 *  - 截图/源码发送前脱敏，产物写到项目外 evidence 目录；
 *  - 受保护预览：短期票据只注入浏览器内存 context，不落盘、不进入报告/模型上下文。
 *
 * 与 E06 的差异（B10 修复）：
 *  - 不再把 materialize 的整文件交给「整文件黑名单」扫描，改为宿主独立**增量**校验；
 *  - 不提供任何 client 可传的 `prevalidated`/`contentScan` 放行开关；
 *  - `verify` 不再等价于 analyze：只做浏览器功能复验（断言/pageErrors/截图），不调用模型；
 *  - 报告写盘前脱敏；previewUrl 仅允许 loopback + `/p/<projectId>/`；
 *  - 模型 requestId/usage/latency 进入事件与报告（不含 prompt/源码）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const {
  applyPatchAtomically,
  isAllowedBrowserUrl,
  assertSafeRelPath,
} = require('./vision-policy.cjs');
const visionPolicy = require('./vision-policy.cjs');
const { createDeltaPolicy } = require('./vision-policy-delta.cjs');
const { hashTree, compareManifests, sha256File } = require('./paths.cjs');

const VENDOR_ENTRY = path.join(__dirname, '..', '..', 'vendor', 'vision', 'src', 'index.mjs');

const SAFE_FILE = /\.(html?|css)$/i;

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function isSafeAllowedFile(file) {
  return SAFE_FILE.test(String(file || ''));
}

function normalizeRel(value) {
  return String(value || '').replace(/\\/g, '/');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function createVisionService(options = {}) {
  const registry = options.registry;
  const home = options.home;
  const eventStore = options.eventStore || null;
  const deps = options.deps || {};
  const deltaPolicy = createDeltaPolicy({ policy: visionPolicy, contextLines: 2 });

  async function loadVision() {
    if (deps.vision) return deps.vision;
    // 可复现 vendoring：仓库内相对路径，不依赖本机绝对路径或 npm registry
    return import(pathToFileURL(VENDOR_ENTRY).href);
  }

  function emit(taskId, projectId, type, payload) {
    if (!eventStore) return;
    const data = payload && typeof payload === 'object' ? payload : {};
    eventStore.append({
      type: `vision.${type}`,
      taskId,
      projectId,
      status: data.status ? String(data.status) : null,
      data: {
        round: data.round || null,
        ok: data.ok === undefined ? null : Boolean(data.ok),
        blocked: Number(data.blocked || 0),
        verified: data.verified === undefined ? null : Boolean(data.verified),
        requestId: data.requestId || null,
        usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
        latencyMs: Number.isFinite(Number(data.latencyMs)) ? Number(data.latencyMs) : null,
      },
    });
  }

  function previewPortOf() {
    return Number(
      deps.previewPort ||
        process.env.PREVIEW_PORT ||
        (Number(process.env.PORT || process.env.REMOTE_PORT || 8787) + 1),
    );
  }

  /** 仅允许回环预览源 + 本项目 `/p/<id>/` 前缀，防止截图逃离受控预览。 */
  function resolvePreviewUrl(projectId, override, vision) {
    const port = previewPortOf();
    const origin = `http://127.0.0.1:${port}`;
    const fallback = `${origin}/p/${projectId}/`;
    const url = override || fallback;
    const allowed = isAllowedBrowserUrl(url, origin);
    if (!allowed) {
      throw Object.assign(new Error(`VISION_PREVIEW_URL_DENIED: ${url}`), {
        code: 'VISION_PREVIEW_URL_DENIED',
      });
    }
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith(`/p/${projectId}/`)) {
      throw Object.assign(new Error('VISION_PREVIEW_URL_DENIED: path is not /p/<projectId>/'), {
        code: 'VISION_PREVIEW_URL_DENIED',
      });
    }
    // 触发器：确保 vision 模块已加载（保持签名一致，便于未来校验）
    void vision;
    return url;
  }

  /** 预览鉴权票据只存在宿主内存，按 0.2.1 `previewAuth` 注入独立 context。 */
  function previewAuthOf(projectId, ticket) {
    if (!ticket || !ticket.value) return null;
    return {
      name: ticket.name || 'vplay_preview',
      value: String(ticket.value),
      // 项目级路径：只把票据发往本项目的预览前缀，不做全局 Path=/
      path: `/p/${projectId}/`,
    };
  }

  /**
   * B11/B13：修复成功的宿主硬门禁。
   *
   * 必须绑定稳定 defectId 与缺陷断言 ID：
   *  - 同一断言在 before=false、after=true（至少一个视口，且该 id 的所有出现都不允许缺失/失败）；
   *  - 删除缺陷断言、after 缺失该断言、出现任何新增失败（含 critical）→ 不通过；
   *  - 截图变化、before 整体失败、无关断言 resolved 都不能替代缺陷断言。
   */
  function strictRepairVerification(result, defectId, defectAssertionIds) {
    const comparison = result && result.comparison;
    const id = defectId || (result && result.defect && result.defect.id) || null;
    const assertionIds = (Array.isArray(defectAssertionIds) ? defectAssertionIds : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 10);
    if (!comparison || typeof comparison !== 'object') {
      return { ok: false, reason: 'comparison-missing', defectId: id, defectAssertionIds: assertionIds };
    }
    if (!id || assertionIds.length === 0) {
      return {
        ok: false,
        reason: 'defect-binding-missing',
        defectId: id,
        defectAssertionIds: assertionIds,
      };
    }
    const entries = [];
    for (const viewport of Array.isArray(comparison.viewports) ? comparison.viewports : []) {
      for (const assertion of Array.isArray(viewport.assertions) ? viewport.assertions : []) {
        if (assertionIds.includes(assertion.id)) {
          entries.push({ viewport: viewport.viewport, ...assertion });
        }
      }
    }
    const details = assertionIds.map((assertionId) => {
      const found = entries.filter((item) => item.id === assertionId);
      const missing = found.length === 0;
      const fixed = found.length > 0 && found.every((item) => item.before === false && item.after === true);
      return { id: assertionId, missing, fixed, occurrences: found.length };
    });
    const allFixed = details.every((item) => !item.missing && item.fixed);
    const newFailures = Array.isArray(comparison.newFailures) ? comparison.newFailures : [];
    const newCritical = Array.isArray(comparison.newCriticalFailures)
      ? comparison.newCriticalFailures
      : [];
    const afterOk = comparison.afterOk !== false && result.ok !== false;
    const ok = Boolean(comparison.ok && afterOk && allFixed && newFailures.length === 0 && newCritical.length === 0);
    return {
      ok,
      reason: ok
        ? null
        : !allFixed
          ? 'defect-assertion-not-fixed'
          : newFailures.length || newCritical.length
            ? 'new-failure'
            : 'comparison-not-ok',
      defectId: id,
      defectAssertionIds: assertionIds,
      defectAssertions: details,
      newFailures: newFailures.length,
      newCritical: newCritical.length,
      beforeOk: comparison.beforeOk,
      afterOk: comparison.afterOk,
      screenshotsChanged: Boolean(comparison.screenshotsChanged),
    };
  }

  function captureSummary(capture) {
    if (!capture || !Array.isArray(capture.viewports)) {
      return { ok: Boolean(capture && capture.ok), viewports: [], screenshots: [] };
    }
    return {
      ok: Boolean(capture.ok),
      screenshots: Array.isArray(capture.screenshots) ? capture.screenshots : [],
      viewports: capture.viewports.map((viewport) => ({
        viewport: viewport.viewport,
        ok: viewport.ok,
        pageErrors: (viewport.diagnostics && viewport.diagnostics.pageErrors) || [],
        failures: (viewport.assertions || [])
          .filter((assertion) => assertion.critical !== false && !assertion.ok)
          .map((assertion) => assertion.id),
      })),
    };
  }

  function buildReport({ taskId, projectId, mode, previewUrl, baseline, result, redaction }) {
    return {
      schemaVersion: 2,
      taskId,
      projectId,
      mode,
      previewUrl,
      previewManifest: baseline ? baseline.checked : null,
      redaction,
      model: result && result.analysis
        ? {
            model: result.analysis.model || null,
            requestId: result.analysis.requestId || null,
            usage: result.analysis.usage || null,
            latencyMs: result.analysis.latencyMs ?? null,
          }
        : null,
      result,
      at: new Date().toISOString(),
    };
  }

  function writeRedactedReport(vision, report) {
    const file = path.join(home, 'evidence', report.projectId, report.taskId, 'vision-report.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let safe = report;
    if (vision && typeof vision.redactObject === 'function') {
      try {
        safe = vision.redactObject(JSON.parse(JSON.stringify(report)));
      } catch {
        safe = report;
      }
    }
    const text = JSON.stringify(safe, null, 2);
    fs.writeFileSync(file, text, 'utf-8');
    return { file, artifactId: sha256Text(text) };
  }

  async function run(input) {
    const {
      taskId,
      projectId,
      mode = 'analyze',
      allowedFiles: requestedFiles,
      skipLock = true,
      lockToken: providedLockToken = null,
      previewUrl: previewUrlOverride = null,
      scenario = 'default',
      defectId = null,
      defectAssertionIds = [],
    } = input || {};

    const vision = await loadVision();
    const project = registry.get(projectId);
    const requested = (requestedFiles && requestedFiles.length
      ? requestedFiles
      : [project.entry && SAFE_FILE.test(project.entry) ? project.entry : 'index.html']
    )
      .map(normalizeRel)
      .slice(0, 5);

    // C10-05：宿主独立路径归一化 + 边界/链接校验，sourceProvider 绝不直接 join 用户输入
    const allowedFiles = [];
    for (const rel of requested) {
      if (!isSafeAllowedFile(rel)) {
        const error = new Error('Vision 只允许修复 HTML/CSS 文件，拒绝 JS/其他类型');
        error.code = 'VISION_FILE_NOT_ALLOWED';
        throw error;
      }
      if (!rel || allowedFiles.includes(rel)) continue;
      assertSafeRelPath(project.srcDir, rel);
      allowedFiles.push(rel);
    }
    if (allowedFiles.length === 0) {
      const error = new Error('Vision allowedFiles 为空');
      error.code = 'VISION_FILE_NOT_ALLOWED';
      throw error;
    }

    // 只有需要调用模型/外发源码的模式才要求数据外发同意；verify 完全本地断言。
    if (mode !== 'verify') {
      const consent = deps.consent === true || process.env.VISION_DATA_CONSENT === '1';
      if (!consent) {
        const error = new Error(
          'Vision 会将截图/源码片段发送给模型；请设置 VISION_DATA_CONSENT=1 表示已获用户同意',
        );
        error.code = 'VISION_CONSENT_REQUIRED';
        throw error;
      }
    }

    // 宿主锁：worker 持锁时传 lockToken；否则自行加锁并只释放自己的 token
    let lockToken = providedLockToken;
    let ownsLock = false;
    if (!skipLock) {
      lockToken = registry.acquireLock(projectId, { taskId }).token;
      ownsLock = true;
    }

    try {
      // 基线：Vite 先异步构建，再原子发布并做全量 manifest 校验
      if (project.kind === 'vite') {
        const build = await registry.buildProjectAsync(project);
        if (!build.ok) {
          throw new Error(`VISION_BUILD_FAILED: ${build.command} exit=${build.status}`);
        }
      }
      const previewRoot = registry.buildPreview(projectId);
      const baseline = registry.verifyPreview(projectId);
      if (!previewRoot || !baseline.ok) {
        throw new Error(`VISION_PREVIEW_STALE: ${baseline.reason}`);
      }

      const previewUrl = resolvePreviewUrl(projectId, previewUrlOverride, vision);
      const ticket = deps.previewTicketProvider
        ? deps.previewTicketProvider({ projectId, taskId })
        : null;
      const previewAuth = previewAuthOf(projectId, ticket);

      const browserRunner =
        deps.browserRunner ||
        vision.createBrowserRunner({
          executablePath: process.env.VPLAY_BROWSER_EXECUTABLE || null,
          headless: process.env.VPLAY_BROWSER_HEADLESS !== 'false',
          ...(previewAuth ? { previewAuth } : {}),
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

      emit(taskId, projectId, 'started', { status: mode });

      // B10：verify = 独立的浏览器功能复验（不调用模型、不与 analyze 等价）
      if (mode === 'verify') {
        const capture = await browserRunner.runCapture({
          url: previewUrl,
          adapter,
          scenario: 'after',
          outDir,
          captureId: 'verify',
        });
        const summary = captureSummary(capture);
        const ok = summary.ok;
        const result = {
          ok,
          status: ok ? 'verify_passed' : 'verify_failed',
          mode: 'verify',
          verificationKind: 'functional_recheck',
          repairVerified: false,
          validation: { ok, kind: 'functional_recheck' },
          verification: summary,
          screenshots: summary.screenshots,
          browserVersion: capture && capture.browserVersion ? capture.browserVersion : null,
        };
        const report = buildReport({
          taskId,
          projectId,
          mode,
          previewUrl,
          baseline,
          result,
          redaction: { maskSelectors, sourceRedaction: null, ticket: 'ephemeral-memory-only' },
        });
        const written = writeRedactedReport(vision, report);
        emit(taskId, projectId, 'completed', { status: result.status, ok, verified: ok });
        return { result, reportFile: written.file, artifactId: written.artifactId, outDir };
      }

      // 捕获 Vision 补丁事件里的 redaction 信息（runVisionTask 不直接返回该字段）
      let sourceRedaction = null;
      const events = vision.createEventSink({        taskId,
        projectId,
        onEvent: (event) => {
          const payload = (event && event.payload) || {};
          if (event && event.type === 'vision.patch.proposed' && payload.sourceRedaction) {
            sourceRedaction = payload.sourceRedaction;
          }
          emit(taskId, projectId, event.type || 'event', payload);
        },
      });

      const gateway =
        deps.gateway ||
        vision.createModelGateway({ config: vision.loadConfig(process.env) });

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
        verificationPolicy: 'confirmed',
        scenario,
        allowedFiles,
        sourceProvider: async () => {
          const source = fs.readFileSync(path.join(project.srcDir, allowedFiles[0]), 'utf-8');
          const redacted = vision.redactSource(source);
          return redacted.text;
        },
        host: {
          snapshot: (label) => registry.snapshot(projectId, label),
          applyFiles: async (files, meta = {}) => {
            const normalized = (files || []).map((item) => ({
              file: normalizeRel(item.file),
              content: item.content,
              sha256Before: item.sha256Before,
              sha256After: item.sha256After,
            }));
            if (!normalized.length) throw new Error('VISION_PATCH_EMPTY');
            if (!normalized.every((item) => allowedFiles.includes(item.file))) {
              throw new Error('VISION_PATCH_FILE_NOT_ALLOWED');
            }
            const beforeTree = hashTree(project.srcDir);
            const journal = path.join(home, 'evidence', projectId, taskId, 'apply-journal.json');
            const operations = meta && Array.isArray(meta.operations) ? meta.operations : [];
            let applied = null;
            let deltaMode = false;
            if (operations.length > 0) {
              // 0.2.1 + E07 delta：精确 operation 重放 + 前后 digest 绑定 + 上下文窗口扫描
              const result = deltaPolicy.applyDelta({
                root: project.srcDir,
                files: normalized,
                operations,
                allowedFiles,
                journalFile: journal,
                keepJournal: true,
              });
              applied = result.files;
              deltaMode = true;
            } else {
              // 旧适配层/降级路径：B10 增量校验（仍不跳过扫描）
              applied = applyPatchAtomically({
                root: project.srcDir,
                files: normalized,
                allowedFiles,
                journalFile: journal,
              });
            }

            // 最终文件一致性：只允许声明过的文件发生变化，且内容摘要必须匹配
            const afterTree = hashTree(project.srcDir);
            const changed = compareManifests(beforeTree, afterTree);
            const expected = new Set(normalized.map((item) => item.file));
            const unexpected = [
              ...changed.added,
              ...changed.removed,
              ...changed.modified,
            ].filter((rel) => !expected.has(rel));
            if (unexpected.length) {
              throw new Error(`VISION_UNEXPECTED_FILE_CHANGE: ${unexpected.slice(0, 5).join(',')}`);
            }
            for (const entry of applied) {
              const target = path.join(project.srcDir, entry.file);
              if (sha256File(target) !== entry.sha256After) {
                throw new Error(`VISION_FINAL_DIGEST_MISMATCH: ${entry.file}`);
              }
            }

            if (project.kind === 'vite') {
              const build = await registry.buildProjectAsync(project);
              if (!build.ok) throw new Error(`VISION_BUILD_FAILED: ${build.command}`);
            }
            const previewRoot = registry.buildPreview(projectId);
            const check = registry.verifyPreview(projectId);
            if (!previewRoot || !check.ok) throw new Error(`VISION_PREVIEW_STALE: ${check.reason}`);
            // 发布与全量校验都通过后才 finalize journal
            if (deltaMode) deltaPolicy.finalizeApply(journal);
          },
          diff: (seq) => registry.diff(projectId, seq, 'current'),
          rollback: async (seq) => {
            const rolled = await registry.rollback(projectId, seq, { lockToken });
            if (!rolled.verified || !rolled.previewReady) {
              throw new Error('ROLLBACK_NOT_VERIFIED');
            }
          },
        },
        outDir,
      });

      const report = buildReport({
        taskId,
        projectId,
        mode,
        previewUrl,
        baseline,
        result,
        redaction: {
          maskSelectors,
          sourceRedaction: sourceRedaction || result.sourceRedaction || null,
          ticket: ticket ? 'ephemeral-memory-only' : null,
        },
      });
      report.verificationPolicy = 'confirmed';
      if (mode === 'repair') {
        const strict = strictRepairVerification(
          result,
          defectId || (result && result.defect && result.defect.id) || null,
          defectAssertionIds,
        );
        report.strictVerification = strict;
        result.strictVerification = strict;
        if (result.ok && !strict.ok) {
          result.ok = false;
          result.status = 'repair_unconfirmed';
          result.validation = { ok: false, reason: strict.reason };
        }
      }
      const written = writeRedactedReport(vision, report);
      emit(taskId, projectId, 'completed', {
        status: result.status || (result.ok ? 'succeeded' : 'failed'),
        ok: result.ok,
        verified: result.validation ? result.validation.ok : result.ok,
      });
      return { result, reportFile: written.file, artifactId: written.artifactId, outDir };
    } finally {
      if (ownsLock && lockToken) registry.releaseLock(projectId, lockToken);
    }
  }

  return { run };
}

/**
 * 启动期 Vision journal 复核（B4）：
 * 不猜测业务目标、不自动改写源码；只把上次中断的 apply 标记为
 *  - completed-unverified（当前内容与 after 摘要一致）或
 *  - needs-review（内容已被改变/不完整），交给人工与任务快照处理。
 */
function recoverVisionApplies({ home, logger = () => {} } = {}) {
  const results = [];
  const root = path.join(home, 'evidence');
  const journals = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'apply-journal.json') journals.push(full);
    }
  }
  walk(root, 0);
  for (const journal of journals) {
    const info = readJson(journal, null);
    if (!info || !Array.isArray(info.files) || !['applying', 'verified'].includes(info.state)) continue;
    let intact = Boolean(info.root);
    for (const item of info.files) {
      if (!item.sha256After) {
        intact = false;
        break;
      }
      try {
        const actual = sha256File(path.join(info.root, item.file));
        if (actual !== item.sha256After) {
          intact = false;
          break;
        }
      } catch {
        intact = false;
        break;
      }
    }
    const suffix = intact ? 'completed-unverified' : 'needs-review';
    const target = journal.replace(/apply-journal\.json$/, `apply-journal.${suffix}.json`);
    try {
      fs.renameSync(journal, target);
    } catch {
      continue;
    }
    logger(`[vision] interrupted apply journal marked ${suffix}: ${target}`);
    results.push({ journal: target, status: suffix });
  }
  return results;
}

module.exports = { createVisionService, isSafeAllowedFile, recoverVisionApplies };

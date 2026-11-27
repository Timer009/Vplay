import { createEventSink, EVENT_TYPES } from './events.mjs';
import { selectDefect } from './patch/defect.mjs';
import { validatePatchPlan, materializePatch } from './patch/validator.mjs';
import { VisionError, ERROR_CATEGORIES } from './errors.mjs';
import { redactSource, redactObject } from './redaction.mjs';

function captureArtifacts(capture) {
  return (capture?.screenshots || []).map((shot) => ({
    path: shot.path,
    viewport: shot.viewport,
    sha256: shot.sha256,
    bytes: shot.bytes,
  }));
}

function assertionSummary(capture) {
  return (capture?.viewports || []).map((viewport) => ({
    viewport: viewport.viewport,
    ok: viewport.ok,
    assertions: viewport.assertions.map((assertion) => ({
      id: assertion.id,
      ok: assertion.ok,
      critical: assertion.critical !== false,
      detail: assertion.detail,
    })),
    pageErrors: viewport.diagnostics.pageErrors.length,
  }));
}

function totalChanges(diff) {
  if (!diff?.counts) return null;
  return Number(diff.counts.added || 0) + Number(diff.counts.modified || 0) + Number(diff.counts.removed || 0);
}

function failure(stage, error) {
  return {
    ok: false,
    stage,
    error: error instanceof VisionError
      ? error.toJSON()
      : { name: error?.name || 'Error', message: error?.message || String(error), category: ERROR_CATEGORIES.UNKNOWN },
  };
}

/**
 * One vision task, host-driven.
 *
 * The package does NOT own projects, tasks, snapshots, queues, or rollback.
 * For repair mode the host supplies:
 *   snapshot(label) -> { seq }
 *   applyFiles([{ file, content, ... }]) -> void
 *   diff(seq) -> { counts: { added, modified, removed }, files, patch? }
 *   rollback(seq) -> void
 * In Vplay these map to projects.snapshot/diff/rollback and the host's file
 * writer; see docs/INTEGRATION-SPRINT02.md.
 */
export async function runVisionTask({
  taskId,
  projectId = null,
  root,
  previewUrl,
  adapter,
  browserRunner,
  gateway,
  host = null,
  events = null,
  mode = 'analyze',
  scenario = 'default',
  sourceProvider = null,
  allowedFiles = ['index.html'],
  extraPatchInstructions = '',
  maxRepairRounds = 2,
  minConfidence = 0.5,
  context = '',
  userPrompt = '',
  outDir,
}) {
  if (!taskId) throw new Error('runVisionTask requires taskId');
  if (!previewUrl) throw new Error('runVisionTask requires previewUrl');
  if (!outDir) throw new Error('runVisionTask requires outDir');
  if (!browserRunner || !gateway) throw new Error('browserRunner and gateway are required');
  if (!['analyze', 'repair'].includes(mode)) throw new Error(`unknown vision mode: ${mode}`);
  if (mode === 'repair' && !host) throw new Error('repair mode requires host hooks');
  const sink = events || createEventSink({ taskId, projectId });
  const started = Date.now();
  const baseResult = { taskId, projectId, mode, previewUrl, adapterId: adapter?.id || null, events: sink.events };
  let pendingSnapshot = null;

  try {
    sink.emit(EVENT_TYPES.TASK_STARTED, {
      mode,
      adapterId: adapter?.id || null,
      previewUrl,
      viewports: (adapter?.viewports || []).map((viewport) => viewport.name),
    });

    const beforeScenario = mode === 'repair' ? 'before' : scenario;
    const before = await browserRunner.runCapture({
      url: previewUrl,
      adapter,
      scenario: beforeScenario,
      outDir,
      captureId: mode === 'repair' ? 'before-r0' : 'before',
    });
    sink.emit(EVENT_TYPES.CAPTURE_COMPLETED, {
      phase: 'before',
      ok: before.ok,
      assertions: assertionSummary(before),
      browserVersion: before.browserVersion,
      durationMs: before.durationMs,
    }, captureArtifacts(before));

    sink.emit(EVENT_TYPES.ANALYSIS_STARTED, { modelConfig: 'vision', imageCount: before.screenshots.length });
    const analysis = await gateway.analyzeScreenshots({
      images: before.screenshots.map((shot) => shot.path),
      context,
      userPrompt,
    });
    analysis.report = redactObject(analysis.report);
    sink.emit(EVENT_TYPES.ANALYSIS_COMPLETED, {
      model: analysis.meta.model,
      usage: analysis.meta.usage,
      latencyMs: analysis.meta.latencyMs,
      requestId: analysis.meta.requestId,
      defects: analysis.report.defects.length,
      summary: analysis.report.summary,
      limitations: analysis.report.limitations,
    });

    if (mode === 'analyze') {
      const result = {
        ...baseResult,
        ok: true,
        status: 'analyzed',
        baselineOk: before.ok,
        report: analysis.report,
        analysis: analysis.meta,
        before,
        budget: gateway.summary(),
        durationMs: Date.now() - started,
      };
      sink.emit(EVENT_TYPES.TASK_COMPLETED, {
        status: result.status,
        defects: analysis.report.defects.length,
        usage: gateway.summary(),
      });
      return result;
    }

    const defect = selectDefect(analysis.report, { minConfidence });
    if (!defect) {
      const result = {
        ...baseResult,
        ok: false,
        status: 'no_confirmed_defect',
        report: analysis.report,
        analysis: analysis.meta,
        before,
        budget: gateway.summary(),
        durationMs: Date.now() - started,
      };
      sink.emit(EVENT_TYPES.TASK_FAILED, { stage: 'select-defect', reason: 'no defect above confidence threshold', minConfidence });
      return result;
    }
    if (typeof sourceProvider !== 'function') throw new Error('repair mode requires sourceProvider');
    const sourceContext = await sourceProvider({ root, report: analysis.report, defect, before, analysis });
    if (!sourceContext || typeof sourceContext !== 'string') throw new Error('sourceProvider returned no source context');
    const safeSource = redactSource(sourceContext);

    let feedback = '';
    let last = null;
    for (let round = 1; round <= maxRepairRounds; round += 1) {
      if (round > 1) {
        const refreshed = await browserRunner.runCapture({
          url: previewUrl,
          adapter,
          scenario: 'before',
          outDir,
          captureId: `before-r${round}`,
        });
        sink.emit(EVENT_TYPES.CAPTURE_COMPLETED, {
          phase: 'before',
          round,
          ok: refreshed.ok,
          assertions: assertionSummary(refreshed),
        }, captureArtifacts(refreshed));
      }
      const patch = await gateway.proposePatchPlan({
        report: {
          summary: analysis.report.summary,
          defects: [defect],
          limitations: analysis.report.limitations,
        },
        sourceContext: safeSource.text,
        allowedFiles,
        extra: [extraPatchInstructions, feedback].filter(Boolean).join('\n'),
      });
      sink.emit(EVENT_TYPES.PATCH_PROPOSED, {
        round,
        diagnosis: patch.plan.diagnosis,
        patchCount: patch.plan.patches.length,
        files: [...new Set(patch.plan.patches.map((item) => item.file))],
        model: patch.meta.model,
        usage: patch.meta.usage,
        latencyMs: patch.meta.latencyMs,
        sourceRedaction: { findings: safeSource.findings, truncated: safeSource.truncated },
      }, []);

      const validation = validatePatchPlan({ plan: patch.plan, root, allowedFiles });
      if (!validation.ok) {
        feedback = `Previous patch was rejected by the safety validator: ${validation.errors.join('; ')}`;
        sink.emit(EVENT_TYPES.PATCH_REJECTED, { round, errors: validation.errors });
        last = { ...failure('patch-validation', new VisionError(validation.errors.join('; '), { category: ERROR_CATEGORIES.SCHEMA, code: 'PATCH_REJECTED' })), validation, patch };
        continue;
      }
      sink.emit(EVENT_TYPES.PATCH_VALIDATED, {
        round,
        operationCount: validation.operations.length,
        files: [...new Set(validation.operations.map((item) => item.file))],
        sizes: validation.operations.map((item) => ({ file: item.file, old: item.oldString.length, new: item.newString.length })),
      });

      const materialized = materializePatch({ operations: validation.operations, files: validation.files });
      sink.emit(EVENT_TYPES.PATCH_MATERIALIZED, {
        round,
        files: materialized.files.map((file) => ({
          file: file.file,
          bytes: file.bytes,
          sha256Before: file.sha256Before,
          sha256After: file.sha256After,
        })),
      });

      const snapshot = await host.snapshot(`pre-vision-${taskId}-r${round}`);
      if (!snapshot || !Number.isFinite(Number(snapshot.seq))) throw new Error('host.snapshot must return { seq }');
      sink.emit(EVENT_TYPES.SNAPSHOT_CREATED, { round, seq: snapshot.seq });
      pendingSnapshot = snapshot;
      await host.applyFiles(materialized.files);
      sink.emit(EVENT_TYPES.PATCH_APPLIED, { round, seq: snapshot.seq, files: materialized.files.map((file) => file.file) });

      const after = await browserRunner.runCapture({
        url: previewUrl,
        adapter,
        scenario: 'after',
        outDir,
        captureId: `after-r${round}`,
      });
      sink.emit(EVENT_TYPES.CAPTURE_COMPLETED, {
        phase: 'after',
        round,
        ok: after.ok,
        assertions: assertionSummary(after),
      }, captureArtifacts(after));

      let diff = null;
      if (typeof host.diff === 'function') {
        diff = await host.diff(snapshot.seq);
        sink.emit(EVENT_TYPES.DIFF_COMPLETED, { round, diff: { counts: diff?.counts || null, files: diff?.files?.length ?? null } });
      }
      const changes = totalChanges(diff);
      const verified = after.ok && (changes === null || changes > 0);
      sink.emit(EVENT_TYPES.VERIFICATION_COMPLETED, {
        round,
        verified,
        changes,
        assertions: assertionSummary(after),
      }, captureArtifacts(after));

      if (verified) {
        const result = {
          ...baseResult,
          ok: true,
          status: 'repaired',
          report: analysis.report,
          analysis: analysis.meta,
          defect,
          patch: patch.plan,
          patchMeta: patch.meta,
          validation: { ok: true, operations: validation.operations.length, files: [...new Set(validation.operations.map((item) => item.file))] },
          materialized: materialized.files.map((file) => ({ file: file.file, bytes: file.bytes, sha256After: file.sha256After })),
          snapshot,
          diff,
          before,
          after,
          budget: gateway.summary(),
          durationMs: Date.now() - started,
        };
        pendingSnapshot = null;
        sink.emit(EVENT_TYPES.TASK_COMPLETED, { status: result.status, round, usage: gateway.summary() });
        return result;
      }

      feedback = `After applying the patch, functional verification failed: ${after.viewports.flatMap((viewport) => viewport.assertions.filter((assertion) => assertion.critical !== false && !assertion.ok).map((assertion) => assertion.id)).join(', ') || 'no changed files'}`;
      await host.rollback(snapshot.seq);
      pendingSnapshot = null;
      sink.emit(EVENT_TYPES.ROLLBACK_COMPLETED, { round, seq: snapshot.seq, reason: feedback });
      last = { ...failure('verification', new VisionError(feedback, { category: ERROR_CATEGORIES.BROWSER, code: 'VERIFY_FAILED' })), patch, validation, snapshot, diff, after };
    }

    const result = {
      ...baseResult,
      ok: false,
      status: 'repair_failed',
      report: analysis.report,
      analysis: analysis.meta,
      defect,
      before,
      last,
      budget: gateway.summary(),
      durationMs: Date.now() - started,
    };
    sink.emit(EVENT_TYPES.TASK_FAILED, { stage: 'repair', rounds: maxRepairRounds, lastStatus: last?.stage || null });
    return result;
  } catch (error) {
    let rollback = null;
    if (pendingSnapshot && host && typeof host.rollback === 'function') {
      try {
        await host.rollback(pendingSnapshot.seq);
        rollback = { ok: true, seq: pendingSnapshot.seq };
        sink.emit(EVENT_TYPES.ROLLBACK_COMPLETED, { seq: pendingSnapshot.seq, reason: 'unexpected failure' });
      } catch (rollbackError) {
        rollback = { ok: false, seq: pendingSnapshot.seq, error: rollbackError.message };
      }
    }
    const failureResult = {
      ...baseResult,
      ...failure('unexpected', error),
      rollback,
      budget: gateway?.summary ? gateway.summary() : null,
      durationMs: Date.now() - started,
    };
    sink.emit(EVENT_TYPES.TASK_FAILED, {
      stage: failureResult.stage,
      category: failureResult.error.category,
      message: failureResult.error.message,
    });
    return failureResult;
  }
}

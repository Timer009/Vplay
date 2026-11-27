# 0.2.1 change list (E07)

Baseline: `@vplay/vision@0.2.0` (E05 candidate, SHA256 `96795b68…`).
0.2.1 is an **integration candidate**, not a replacement for the Vplay main tree.
No real model call, no Spacer change, no main-project change.

## Added

| Area           | Change                                                                                                                                                                                      | Files                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Preview auth   | In-memory, host+path scoped cookie injection (`previewAuth`), Strict/HttpOnly, no storageState file, never returned/logged                                                                  | `src/browser/runner.mjs`                                        |
| Guard          | Only main-frame document navigation counts as `navigationBlocked`; subframe documents recorded separately; cookies/authorization stripped on allowed extra origins                          | `src/browser/guard.mjs`                                         |
| Redaction      | Capture diagnostics, request failures and blocked URLs are redacted before returning; `cookie`/`set-cookie` fields and `Cookie:`/`vplay_preview=` text rules                                | `src/browser/runner.mjs`, `src/redaction.mjs`, `src/events.mjs` |
| Delta contract | `describeDelta({operations, files, materialized})` returns per-file `sha256Before/After`, exact hunks and materialized content; self-checks materialized digest                             | `src/patch/validator.mjs`                                       |
| Verification   | `compareVerification({before, after})`: resolved/new/persisting failures, screenshot change, `ok` gate; `verificationPolicy: 'confirmed'` in `runVisionTask`; `comparison` in result/events | `src/verification/compare.mjs`, `src/orchestrator.mjs`          |
| Host hook      | `host.applyFiles(files, { operations, plan, round })` second argument (backward compatible)                                                                                                 | `src/orchestrator.mjs`                                          |
| HTTP           | Non-JSON provider response now carries `code: 'INVALID_JSON'`                                                                                                                               | `src/http.mjs`                                                  |
| Docs           | `HOST-CONTRACT.md` update, `PREVIEW-AUTH.md`, `DELTA-CONTRACT.md`, `VERIFY-SEMANTICS.md`                                                                                                    | `docs/`                                                         |

## Unchanged (by design)

- Vision patch boundary: `.html/.htm/.css` only; fragment allowlist; max 3 patches; no JS/external URLs/scripts/frames/forms.
- Vision still does not own locks, snapshots, journals, rollback, queues.
- Model defaults (`qwen4-max`, `deepseek-v4-flash`); no model call in this package.
- 0.2.0 export surface retained; 3 exports added (`normalizePreviewAuth`, `describeDelta`, `compareVerification`) → 60.

## Explicitly not solved here

- Host `vision-policy.applyPatchAtomically` still needs the 0.2.1 delta path (see `docs/DELTA-CONTRACT.md`); this package cannot edit the host.
- Preview cookie is a bearer value; treat it as a secret, only pass the hash (not `PREVIEW_ACCESS_KEY`), keep it in memory.
- Host must still verify `verified/previewReady` after rollback and publish preview only after verification.

## Test summary

```text
node --test test/*.test.mjs
→ tests 72 / pass 72 / fail 0 / skipped 0  (Node v24.22.3, Windows x64)
```

New suites: `preview-auth`, `compare`, `delta`, `capture-redaction`, `events-redaction`.
Existing 59 tests unchanged and passing.

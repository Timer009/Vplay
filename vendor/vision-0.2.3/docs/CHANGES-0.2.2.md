# 0.2.2 change list (E10)

Baseline: `@vplay/vision@0.2.1` (`d463ba3f…` / `302659f5…`). 0.2.2 is an
**independent candidate**; E07/E08/0.2.1 artifacts remain unchanged.

## Fixed

| ID | Issue | Fix |
| --- | --- | --- |
| E10-R1 / E09-B-2 | Cross-origin server 302 bypassed `context.route` | CDP `Fetch` pauses document requests including redirect targets; non-preview origins `failRequest` before network. Runner also checks final URL origin+`/p/<id>/` path before adapter/screenshot. |
| C12-P1-05 | AFTER-only assertion failure classified as `persisting`, not new | Only-after failures and before-true→after-false are `newFailures`; critical subset blocks. |
| C12-P1-04 / E09-B-1 | Deleting a failing assertion still passed strict verification | BEFORE assertions missing in AFTER are `missingAssertions`; comparison fails; defect gate reports `defect-assertion-missing`. |
| E09 defect identity | Model `defect.id` can vary between runs | `defectKeyOf()` derives a stable key from type/screen/description/region; host may override. |
| E10-R5 | `verify`/repair status ambiguity | `verificationPolicy:'strict-repair'` → `repair_verified` / `repair_unconfirmed`; `confirmed` now requires defect assertions and yields `repair_verified`; `after-only` remains legacy `repaired`. Unconfirmed rolls back. |
| C12-P1-01/02 | `<scr`+`ipt>` and `java`+`script:` across lines | Whitespace/entity-normalized structural matching (`normalizeStructural`, `structuralFindings`). |
| C12-P1-03 | Deleting `-->`/`</style>` + safe insert accepted | Unclosed comment/style/script tokens rejected; complete balanced block removal remains legal. |
| C12-P1-06 | ±2-line window false-rejected legal patches near `<script src>` | Window removed; changed **tag spans** and new fragments are scanned instead. |
| E10-R6 | No structure/differential contract | `src/patch/structure.mjs`: `validateStructureDelta`, `validateFragmentStructure`, `changedRangesFromOperations`; integrated into `validatePatchPlan` (`structure` result field). |

## Interface changes

- `compareVerification({before, after, defect, defectAssertionIds})`:
  new `missingAssertions`, `defect` (`{id, key, assertionIds, beforeFailed, afterPassed, missing, ok, reason}`), `defectKey`; `ok` now requires no missing assertions and, when ids are supplied, `defect.ok`.
- `defectKeyOf(defect)` exported.
- `runVisionTask({ verificationPolicy, defectAssertionIds, defectKey })`:
  `verificationPolicy` accepts `after-only` | `confirmed` | `strict-repair`;
  `confirmed` and `strict-repair` require `defect.ok`; `strict-repair` also rejects any new failure (critical or not);
  results include `comparison`, `strictVerification`, `defect.defectKey`;
  success status `repair_verified` for confirmed/strict, `repaired` for after-only;
  gate failure with a passing after capture returns `repair_unconfirmed` and rolls back.
- `validatePatchPlan` result adds `structure: [{file, ok, violations, changedRanges}]`; plans with structural breakage fail.
- `validateStructureDelta`, `validateFragmentStructure`, `changedRangesFromOperations`, `normalizeStructural`, `structuralFindings` exported.
- Browser: `installNetworkGuard` returns `enableRedirectGuard(cdp)` and `recordNavigation`; `network` summary adds `previewPath`. `runCapture` calls the redirect guard and enforces final URL path.
- Version/exports: 0.2.2; 60 → 66 exports.

## Breaking / migration notes

- `confirmed` no longer passes a screenshot-only change without `defectAssertionIds`.
  Hosts that used `confirmed` must provide stable assertion ids (e.g. `['outcome']`).
- Success status for `confirmed`/`strict-repair` is `repair_verified`, not `repaired`;
  update host status mapping in B13.
- `runVisionTask` without `defectAssertionIds` under `confirmed`/`strict-repair`
  returns `repair_unconfirmed`; use `after-only` only for non-publishing analysis.

## Tests

`node --test test/*.test.mjs` → **91/91** (Node v24.22.3, Windows x64).
New suites: `redirect-boundary`, `structure`, `compare-strict`, `orchestrator-strict`; 72 existing tests updated only where the changed semantics require it.
Host reference tests: `e10/tests/host-delta.test.mjs` → 5/5.

# Verification semantics review (0.2.1)

## 0.2.0 behavior (reviewed, unchanged default)

```js
const verified = after.ok && (changes === null || changes > 0);
```

- `after.ok` means “all critical assertions in the after capture passed and there
  were no page errors”;
- `changes > 0` only means the source diff is non-empty;
- it does **not** prove the defect was reproduced before or addressed after.

Consequences:

1. A patch that hides/removes UI can pass if the adapter has no assertion for it.
2. A no-op visual change passes when the assertions were already green.
3. A regression in a failure that was not asserted is invisible.
4. `changes` is source-only; it says nothing about the rendered result.

## 0.2.1 interface

```js
const comparison = compareVerification({ before, after, defect });
```

Returns:

| Field                                           | Meaning                                           |
| ----------------------------------------------- | ------------------------------------------------- | --- | ----------------- | --- | -------------------- |
| `beforeOk` / `afterOk`                          | capture-level critical assertion result           |
| `resolvedFailures` / `resolvedCriticalFailures` | failed before, passed after                       |
| `newFailures` / `newCriticalFailures`           | passed/missing before, failed after               |
| `persistingFailures`                            | failed on both sides                              |
| `viewports[].assertions[]`                      | per-id before/after matrix                        |
| `screenshotsChanged` + hashes                   | rendered change evidence (multi-viewport, sorted) |
| `ok`                                            | `afterOk && no new critical && (before failed     |     | resolved critical |     | screenshot changed)` |
| `policy`                                        | string documenting the gate                       |

`runVisionTask` adds:

- `verificationPolicy = 'after-only' | 'confirmed'` (default `after-only` for
  backward compatibility);
- `comparison` in the result, in `last`, and in
  `vision.verification.completed.payload.comparison`;
- with `confirmed`, `verified` also requires `comparison.ok`.

## Recommended host gate

```js
if (!result.ok) fail;
if (!result.comparison?.ok) fail; // 0.2.1 confirmed policy
if (!result.validation?.ok) fail;
// plus host-specific defect predicate (region/OCR/DOM/state) for visual defects
// plus rollback.verified && rollback.previewReady on failure paths
```

`comparison.ok` is **not** a claim that the defect is causally fixed. For a
visual-only defect the host should add a defect-specific check (element state,
region pixel diff, `window.game` state). For Spacer F1–F10, keep the functional
assertions (`state`, `padProbe`, fuel) as the authority.

## E07 end-to-end evidence

- Round 1: overlay covers the launch button → `action-hit` fails → `after.ok`
  false → rollback, `comparison.newCriticalFailures=['action-hit']`.
- Round 2: visible kicker patch → after assertions pass, screenshot changed →
  `comparison.ok` true → `verified` with `confirmed` policy.
- Auth failure: capture fails before analysis, zero snapshots, zero writes.

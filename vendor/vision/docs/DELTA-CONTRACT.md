# Delta patch contract (0.2.1 + E07 host reference)

## Problem

- Vision 0.2.x produces **fragment-level** structured validation but materializes
  **whole files**.
- The host keyword blacklist (`scanPatchContent`) on a whole file rejects
  legitimate inline scripts. Real Spacer v2.0.15 `vector-lander/index.html`
  triggers `external-url` (favicon SVG `xmlns`) and `inline-handler`
  (`const onChange =`), i.e. **every** patch would be rejected.
- Simply skipping the host scan would remove the independent backstop.

## Vision side: `describeDelta`

```js
const validation = validatePatchPlan({ plan, root, allowedFiles }); // structured allowlist
const materialized = materializePatch({
  operations: validation.operations,
  files: validation.files,
});
const delta = describeDelta({
  operations: validation.operations,
  files: validation.files,
  materialized: materialized.files,
});
// delta.files: [{ file, sha256Before, sha256After, content, hunks:[{start,end,before,after}], bytes }]
```

- `sha256Before/After` are recomputed from the actual source and materialized content;
- `hunks` are the exact old/new fragments with offsets;
- passing `materialized` makes it throw on any digest mismatch;
- Vision still never writes, snapshots, journals or rolls back.

## Host side: reference `vision-policy-delta.cjs`

Location in E07 evidence: `G:\AI_GAME\Vplay-Vision-POC\e07\host\vision-policy-delta.cjs`
(port to `remote/lib/`; not applied to the main tree).

```js
const policy = createDeltaPolicy({
  policy: require('./vision-policy.cjs'),
  contextLines: 2,
});

policy.applyDelta({
  root: project.srcDir,
  files: delta.files,
  operations: validation.operations, // from the 0.2.1 applyFiles second argument
  allowedFiles: ['vector-lander/index.html'],
  journalFile: path.join(
    home,
    'evidence',
    projectId,
    taskId,
    'apply-journal.json',
  ),
  keepJournal: true,
});
// after buildPreview + verifyPreview succeed:
policy.finalizeApply(journalFile);
```

Required sequence:

1. **Path**: allowlist + `assertSafeRelPath` (dot segments/symlink/realpath) + `.html/.htm/.css`.
2. **Digest binding**: current file sha256 === `sha256Before`; each operation's
   `[start,end)` equals `oldString`; applying operations yields exactly
   `content` with `sha256After`. Any unplanned edit or stale source is rejected.
3. **Scan (not skipped)**:
   - every new fragment: host `scanPatchContent` **plus** delta-local structural
     rules (`<script>/<iframe>/<object>/<link>/<meta>/<form>/<base>/<svg>`,
     `on*=`, `javascript:`, `data:`, `srcdoc`, `@import`, `url(`, `expression`,
     `behavior`, `-moz-binding`, comments);
   - every line-expanded window (context ±2 lines) in the **after** content
     with host `scanPatchContent`, merged per file.
4. **Atomic write**: tmp in the same directory → `fsync` → `rename` → verify
   sha256 on disk. On any failure restore in-memory `before` contents.
5. **Journal**: `applying` → `verified`; caller deletes it only after preview and
   full manifest verification. Startup must surface leftover journals as
   `needs_review`.

## Threat model / limits

- Vision's structured HTML/CSS allowlist is the primary parser; the host delta
  scan is an independent backstop. Neither alone is a sanitizer.
- The delta scan is intentionally restrictive: `url()`/`@import` in the changed
  fragment are rejected even where a browser might accept them.
- Cross-hunk composition is mitigated by merged line windows + structured
  validation; it is not a formal HTML parser.
- Never add `.js` to `allowedFiles` for Vision. JS features go through the
  normal Vplay Agent path.

## Evidence (E07)

- Real Spacer: legitimate HTML (`<h1 class>`) and CSS (`width:clamp`) patches are
  accepted by delta policy, while the B09 whole-file policy rejects them.
- 16 HTML + 6 CSS malicious payloads rejected with `DELTA_CONTENT_REJECTED`;
  file hash unchanged.
- Stale source (`DELTA_SOURCE_CHANGED`), tampered materialized content
  (`DELTA_DIGEST_MISMATCH`), overlapping operations (`DELTA_OPERATION`) rejected.
- End-to-end: bad overlay patch fails functional assertion → rollback; good patch
  passes → `comparison.ok`.

Tests: `e07/tests/host-delta.test.mjs`, `e07/tests/e2e-repair.test.mjs`;
package tests `test/delta.test.mjs`.

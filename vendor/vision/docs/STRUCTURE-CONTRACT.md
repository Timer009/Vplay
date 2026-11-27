# HTML/CSS structure and differential validation contract (0.2.2)

## Problem

Fragment allowlists validate the new text, but not what the new text does to the
document structure. C12 showed:

- `<scr` + `ipt>` / `java` + `script:` split across lines bypassed line-local rules;
- deleting `-->` or `</style>` and inserting a harmless element changed parsing;
- a ±2-line review window rejected legal patches next to a baseline `<script src>`;
- deleting a failing assertion made a repair look successful (verification side).

## Vision contract

`validatePatchPlan` (primary, mandatory for Vision):

1. fragment allowlist (HTML/CSS safe subset) as in 0.2.1;
2. `validateFragmentStructure(newString)` on whitespace/entity-normalized text
   (catches cross-line `<script`, `javascript:`, `data:`, `@import`, `url(`,
   inline handlers, URL attributes);
3. materialize per file in memory, compute AFTER changed ranges from operations,
   then `validateStructureDelta({before, after, changedRanges})`:
   - every changed TAG is scanned in place (baseline+added context covered;
     unchanged neighbour scripts are not scanned);
   - CSS changed regions inside `<style>` are scanned;
   - unclosed/unbalanced comments, style and script tokens are rejected;
   - a complete balanced block removal is allowed.

Output: `validatePatchPlan` adds `structure: [{file, ok, violations, changedRanges}]`
and fails the plan on any violation.

## Host delta contract

The host must not scan a whole file (false rejects) and must not skip scanning:

```text
path/allowlist/.html|.htm|.css
sha256Before == current file
each operation [start,end) == oldString
apply operations == materialized content / sha256After
changed tags + new fragments + changed CSS, normalized + host rules
structure balance (comments/style/script)
atomic tmp+fsync+rename; verify sha256After
journal applying → verified; caller finalizes after preview/manifest
```

Reference: `e10/host/vision-policy-delta.cjs` (B13 port target). It is a CJS
transcription of the same rules; keep it pinned to 0.2.2 and run
`e10/tests/host-delta.test.mjs` plus `e10/tests/conformance.test.mjs` when
porting. Do not add a third rule set.

## Explicitly allowed / rejected

| Case                                                          | Result                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Add safe class / text / style declaration                     | allowed                                                                |
| Remove a complete balanced `<style>…</style>` or `<!-- … -->` | allowed                                                                |
| Remove only `</style>` / `-->`                                | rejected (`unclosed-style` / `unclosed-comment`)                       |
| `<scr` + `ipt>` across lines                                  | rejected (`script-tag`)                                                |
| `java` + `script:` across lines                               | rejected (`javascript-url`)                                            |
| `<img` baseline + added `//evil>`                             | rejected (changed tag: `src=` / `url-attribute`)                       |
| Delete failing assertion in AFTER                             | rejected (`missingAssertions`, `defect-assertion-missing`)             |
| Screenshot-only change                                        | not a repair (`defect-not-reproduced-before` / `no-defect-assertions`) |
| New critical assertion only in AFTER                          | `newCriticalFailures` blocks                                           |

## Limits

This is a conservative structural check, not a full HTML parser. It is scoped to
Vision's safe UI subset (`.html/.htm/.css`, no scripts/JS/URLs/forms/frames).
Full Agent JS work must use the normal Vplay Agent policy, never this allowlist.

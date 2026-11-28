# 0.2.3 change list (E16)

Baseline: `@vplay/vision@0.2.2` (`c7679c02…` tgz / `a74a6c7b…` source).
0.2.3 is an **independent security candidate**; 0.2.2 and all earlier artifacts remain unchanged.

## Fixed

| ID | Issue | Fix |
| --- | --- | --- |
| E15-P0-01 / C18 VN-08 | `createBrowserRunner` called Playwright `chromium.launch` without `chromiumSandbox:true`; Playwright 1.65.1 then added `--no-sandbox` at runtime. | The actual launch now passes `chromiumSandbox: true` unconditionally. |
| E16-S1 | `launchArgs` could contain `--no-sandbox`/`--disable-setuid-sandbox` and silently drop the sandbox. | Inputs are validated at runner construction; forbidden arguments fail with `BROWSER_SANDBOX_BYPASS` before Playwright is loaded or a browser is launched. |
| E16-S2 | Environment could carry a sandbox-disable flag/argument. | `VPLAY_DISABLE_SANDBOX`, `VPLAY_BROWSER_ARGS`, `PLAYWRIGHT_CHROMIUM_ARGS`, `CHROMIUM_FLAGS`, `CHROME_FLAGS` are checked; explicit disable values or bypass arguments fail closed. |
| E16-S3 | A launch failure could invite a future no-sandbox fallback. | No retry/fallback path exists; launch errors propagate. |

## Unchanged (byte-identical to 0.2.2)

- `src/browser/guard.mjs`
- `src/verification/compare.mjs`
- `src/patch/structure.mjs`
- `src/patch/validator.mjs`
- `src/orchestrator.mjs`
- all host/auth/delta/structure/strict-repair semantics
- 66 exports; no public API additions/removals

Only `src/browser/runner.mjs`, `package.json`, `README.md`, docs/tests are changed.

## Low-memory compatibility (B19)

`launchArgs` is still accepted and forwarded unchanged after validation. B19's allowlisted
arguments (`--disable-dev-shm-usage`, `--disable-gpu`, `--renderer-process-limit=1..4`, etc.)
continue to work. The runner does not add or remove them.

## Not in scope

- No change to guard/strict-repair/delta/structure semantics.
- No model calls, no Serve/Funnel, no Pi deployment, no land-pin implementation.
- No 0.2.2 modifications; original tgz/source hashes remain the E10 values.

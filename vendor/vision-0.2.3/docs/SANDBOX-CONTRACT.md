# 0.2.3 Chromium sandbox contract

## Required behavior

`createBrowserRunner(...).runCapture(...)` must launch Chromium through Playwright with:

```js
chromium.launch({
  executablePath,
  headless,
  chromiumSandbox: true,   // exactly true; not configurable
  args: safeLaunchArgs,
  env: sanitizedEnv,
})
```

- Playwright 1.65.1 adds `--no-sandbox` whenever `chromiumSandbox !== true`.
- There is no `sandbox` option and no environment switch in 0.2.3.
- A launch error is returned to the caller; no retry with `--no-sandbox`.

## Rejected launchArgs

Exact or `=value` forms:

```text
--no-sandbox
--disable-setuid-sandbox
--disable-gpu-sandbox
--disable-seccomp-filter-sandbox
--disable-namespace-sandbox
--single-process
--no-zygote
```

Error:

```json
{"category":"browser","code":"BROWSER_SANDBOX_BYPASS","retryable":false}
```

## Rejected environment inputs

Keys:

```text
VPLAY_DISABLE_SANDBOX
PLAYWRIGHT_DISABLE_SANDBOX
CHROMIUM_DISABLE_SANDBOX
CHROME_DISABLE_SANDBOX
VPLAY_BROWSER_ARGS
PLAYWRIGHT_CHROMIUM_ARGS
CHROMIUM_FLAGS
CHROME_FLAGS
```

An explicit true/1/yes/on value, or a sandbox-bypass argument in one of these variables,
fails with `BROWSER_SANDBOX_BYPASS`. Benign B19 low-memory values in `VPLAY_BROWSER_ARGS`
remain acceptable because the host parses them and passes the resulting `launchArgs`.

## Evidence required from the host

- actual browser argv (no `--no-sandbox`) via `/proc/<pid>/cmdline` (Linux) or CIM (Windows);
- `chrome://sandbox`/`chromium://sandbox` status captured from the real browser;
- one temporary `--user-data-dir` per task, deleted after close;
- low-memory args preserved;
- failure of sandboxed launch recorded as failure, never retried unsandboxed.

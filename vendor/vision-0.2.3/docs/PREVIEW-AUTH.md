# Preview authentication injection (0.2.1)

Host preview servers can require a `vplay_preview` cookie (HttpOnly /
SameSite=Strict, value = `sha256(PREVIEW_ACCESS_KEY)`). Vision 0.2.0 had no way
to provide it, so every capture against a protected preview failed with 401.

## API

```js
const runner = createBrowserRunner({
  executablePath: process.env.VPLAY_BROWSER_EXECUTABLE,
  previewAuth: {
    // value = PREVIEW_ACCESS_HASH (sha256 hex), NOT the raw key
    value: process.env.VPLAY_PREVIEW_ACCESS_HASH,
    // optional; defaults to the previewUrl pathname
    path: '/p/<projectId>/',
    // optional; defaults to vplay_preview
    name: 'vplay_preview',
  },
});

await runner.runCapture({ url, adapter, outDir });
```

`runCapture({ previewAuth })` can override per capture. `normalizePreviewAuth()`
is exported for hosts that want to validate before constructing the runner.

## What is enforced

- One cookie only; no domain/`storageState` file, no env var, no disk.
- Scoped by Playwright `url` to the preview origin **and** path prefix.
- `HttpOnly`, `SameSite=Strict`, `secure` iff the preview URL is https.
- Validation rejects empty values, `;`, whitespace/control chars, bad names,
  relative/`..` paths and non-http(s) preview URLs **without echoing the value**.
- The value is never written into the capture result, events, errors, browser
  env, screenshots or logs. The result only exposes
  `previewAuth: { cookieName, path, injected: true }`.
- Cross-origin requests never carry it:
  - non-preview origins are aborted by the network guard;
  - if a host explicitly allows an extra origin, the route strips `cookie` and
    `authorization` headers before continuing.

## Host checklist

1. Pass the hash, not `PREVIEW_ACCESS_KEY`.
2. Keep it in memory; do not persist it in task JSON, evidence, SSE or logs.
3. Keep `PREVIEW_ACCESS_KEY` enabled for tailnet mode; do not disable it to
   make Vision work.
4. On rotation/`/auth/revoke-all`, drop the in-memory value and fail closed.
5. If the cookie is wrong/expired, expect capture failure **before** analysis,
   snapshot or write.

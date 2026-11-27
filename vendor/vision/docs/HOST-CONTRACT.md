# Host contract (E05 / C07)

Vision never owns project locks, snapshots, queues, journals or rollback. The
host (Vplay/TRAE) owns them. This contract makes the boundary explicit.

## 1. Lock ownership

```ts
interface HostLock {
  acquire(
    projectId: string,
    meta: { taskId: string; owner: string },
  ): { token: string; seq?: number };
  release(projectId: string, token: string): void;
  read(
    projectId: string,
  ): { owner: string; taskId: string; token: string } | null;
}
```

- **Default**: host acquires the lock **before** baseline preview/snapshot and holds it until after preview publish/rollback.
- Vision adapter must accept `skipLock: boolean`.
  - `skipLock=false`: adapter acquires and releases **only its own token**.
  - `skipLock=true`: caller already holds the lock; adapter must not acquire, not release, and must not call `releaseLock(projectId)` without the token.
- Never call the old `releaseLock(id)` form that unconditionally deletes the file (C07 ORD-02).
- If the host lock API has no token, `skipLock=true` is **mandatory** for calls from a worker that already holds the lock; otherwise double-lock 409 or releasing another owner's lock.
- Lock covers: baseline manifest/build → capture → analyze → validate → snapshot → apply → build/preview → capture/verify → success/rollback → publish.

## 2. Baseline manifest

Before capture:

```ts
const srcManifest = hashTree(project.srcDir); // Vplay paths.cjs
const previewRoot = buildPreview(project.id);
const previewManifest = hashTree(previewRoot);
assertPreviewFiles(expectedPublishFiles(project), srcManifest, previewManifest);
```

- Static: all published files must match `src`.
- Vite: `buildProject()` must complete successfully first; published files must match `dist`.
- Refuse to capture if the preview is stale or missing. Entry-only comparison is insufficient (C07 ORD-11).

## 3. Atomic apply

```ts
interface AtomicApplyInput {
  projectId: string;
  root: string; // projects/<id>/src
  files: Array<{
    file: string;
    content: string;
    sha256Before: string;
    sha256After: string;
  }>;
  stagingDir: string; // host-owned temp dir
  journalFile: string; // host-owned, outside preview
  manifestBefore: Record<string, string>;
  hashTree: (dir: string) => Record<string, string>;
}
```

Required sequence:

1. `realpath` each target; reject symlink/junction, dot segments, non-regular files.
2. Verify current `sha256` equals `sha256Before` (digest precondition).
3. Write each file to `stagingDir` (same filesystem), `fsync`, then `rename` over target.
4. Write journal before applying: `{ state:'applying', taskId, snapshotSeq, files, manifestBefore }`.
5. After apply: compute full `hashTree(root)`; compare expected changed files and no unexpected changes. Mark journal `verified`.
6. On any error: stop; do **not** continue with a partial manifest; call host rollback to `snapshotSeq`; then verify manifest equals baseline.
7. On startup, host checks journals: `applying` without `verified` → restore snapshot/backup or mark `needs_review`; never silently accept.

Vision exposes only `validatePatchPlan` and `materializePatch` (memory). It does not write or journal.

## 4. Snapshot / rollback

```ts
const snapshot = projects.snapshot(projectId, `pre-vision-${taskId}-r${round}`); // {seq,...}
// apply...
const rollback = projects.rollback(projectId, snapshot.seq);
if (!rollback.verified || !rollback.previewReady)
  throw new Error('ROLLBACK_NOT_VERIFIED');
```

- Snapshot is taken **after** patch validation and **before** any write.
- On failure, call rollback, check `verified/previewReady`.
- After rollback (and for Vite after build), call `buildPreview`; verify full manifest against the target snapshot.
- Do not implement a second snapshot/rollback/journal system in Vision.

## 5. Preview refresh / publish

- Static: `buildPreview(projectId)` after write and after rollback.
- Vite: `buildProject(project)` (host build) → `buildPreview` → verify `dist`/preview manifest.
- Publish atomically if possible (temp dir + rename); never leave a partial `.preview`.
- New browser context opens `/p/<id>/`; no stale cache (preview `Cache-Control:no-store`).
- If preview refresh fails, treat as verification failure and rollback; do not capture.

## 6. Failure mapping

| Failure                      | Host action                                            |
| ---------------------------- | ------------------------------------------------------ |
| 401/403/quota/truncated      | no write; no snapshot; report category                 |
| patch rejected               | no write; no snapshot                                  |
| snapshot failed              | no write; release lock                                 |
| atomic apply failed          | rollback snapshot; verify manifest; rebuild preview    |
| preview stale/build failed   | rollback; verify; rebuild                              |
| functional assertions failed | rollback; verify; rebuild                              |
| rollback not verified        | stop; keep journal; surface `needs_review`             |
| crash                        | startup journal recovery; never auto-retry paid models |

## 7. Vision patch boundary vs full Agent

- Vision patches: `.html/.htm/.css` only; safe UI tags/attrs; no script/JS/URL/frames/forms; no new files.
- Full Agent source development (new game logic, arbitrary JS) uses the normal Vplay Agent/edit path with its own approval/policy; it must **not** reuse or loosen Vision's allowlist.
- Do not pass `allowedFiles` containing `.js`/`.mjs`/`.cjs` to Vision. If a task requires JS, it is not a Vision repair task.

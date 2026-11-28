/**
 * Example host wiring for Vplay Sprint 02 (read-only integration reference).
 * NOT executed by the package tests and NOT part of Vplay's source tree.
 *
 * Prerequisites in Vplay:
 *   - remote/lib/projects.cjs (registry, snapshot, diff, rollback)
 *   - preview server from remote/lib/preview.cjs on PREVIEW_PORT
 *   - @vplay/vision available (workspace package or npm)
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  runVisionTask,
  createModelGateway,
  createBrowserRunner,
  createSpacerAdapter,
  createEventSink,
  loadConfig,
} from '@vplay/vision';

export async function verifyProject({
  registry,
  projectId,
  taskId,
  previewUrl,
  mode = 'analyze',
  adapter = createSpacerAdapter(),
  onEvent = (event) => console.log(JSON.stringify(event)),
}) {
  const project = registry.get(projectId);
  const config = loadConfig(process.env);
  const gateway = createModelGateway({ config });
  const browser = createBrowserRunner({
    executablePath: process.env.VPLAY_BROWSER_EXECUTABLE || null,
    headless: process.env.VPLAY_BROWSER_HEADLESS !== 'false',
  });
  const events = createEventSink({ taskId, projectId, onEvent });

  registry.acquireLock(projectId, { taskId });
  try {
    const result = await runVisionTask({
      taskId,
      projectId,
      root: project.srcDir,
      previewUrl,
      adapter,
      browserRunner: browser,
      gateway,
      events,
      mode,
      allowedFiles: ['index.html'],
      sourceProvider: async ({ root }) => {
        // Host-specific: select only the needed excerpt. Avoid whole-file dumps
        // for large games; this example is intentionally small.
        const file = path.join(root, 'index.html');
        const text = await fsp.readFile(file, 'utf8');
        return text.split(/\r?\n/).map((line, i) => `${i + 1}: ${line}`).join('\n');
      },
      host: {
        snapshot: (label) => registry.snapshot(projectId, label),
        applyFiles: async (files) => {
          const root = path.resolve(project.srcDir);
          for (const file of files) {
            const target = path.resolve(root, file.file);
            if (target !== root && !target.startsWith(root + path.sep)) {
              throw new Error(`path escapes project: ${file.file}`);
            }
            await fsp.writeFile(target, file.content, 'utf8');
          }
        },
        diff: (seq) => registry.diff(projectId, seq, 'current'),
        rollback: (seq) => registry.rollback(projectId, seq),
      },
      outDir: path.join(project.srcDir, '.opengame', 'vision', taskId),
    });

    const artifactDir = path.join(project.srcDir, '.opengame', 'vision');
    await fsp.mkdir(artifactDir, { recursive: true });
    const artifact = path.join(artifactDir, `${taskId}.json`);
    await fsp.writeFile(artifact, JSON.stringify({ result, events: events.events }, null, 2), 'utf8');
    return { result, artifact };
  } finally {
    registry.releaseLock(projectId);
  }
}

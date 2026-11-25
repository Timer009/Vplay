import * as fs from 'fs';
import * as path from 'path';

export type RuntimePhase = 'idle' | 'generating' | 'verifying' | 'done';

export interface RuntimeStatus {
  phase: RuntimePhase;
  message: string;
  workspace: string;
  updatedAt: string;
}

export const OPENGAME_RUNTIME_DIR = '.opengame';
export const RUNTIME_STATUS_FILE = 'runtime-status.json';

function runtimeDir(workspaceDir: string): string {
  return path.join(workspaceDir, OPENGAME_RUNTIME_DIR);
}

/**
 * Persist the current generation phase so out-of-process consumers
 * (e.g. the remote control server) can read it.
 */
export function writeRuntimeStatus(
  workspaceDir: string,
  phase: RuntimePhase,
  message: string,
): void {
  try {
    const dir = runtimeDir(workspaceDir);
    fs.mkdirSync(dir, { recursive: true });
    const status: RuntimeStatus = {
      phase,
      message,
      workspace: path.resolve(workspaceDir),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(dir, RUNTIME_STATUS_FILE),
      JSON.stringify(status, null, 2),
      'utf-8',
    );
  } catch {
    // Status reporting must never break generation.
  }
}

function readJsonFile(filePath: string): unknown {
  // Windows editors/tools may prepend a UTF-8 BOM, which breaks JSON.parse.
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

export function readRuntimeStatus(workspaceDir: string): RuntimeStatus | null {
  try {
    return readJsonFile(
      path.join(runtimeDir(workspaceDir), RUNTIME_STATUS_FILE),
    ) as RuntimeStatus;
  } catch {
    return null;
  }
}

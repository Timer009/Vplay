import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { writeRuntimeStatus } from '../utils/runtime-status.js';

export const POST_VERIFY_DISABLE_ENV = 'OPENGAME_POST_VERIFY';
export const POST_VERIFY_REPORT_DIR = '.opengame';
export const POST_VERIFY_REPORT_FILE = 'post-verify.json';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const RESOLVE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.json',
  '.css',
];
const ASSET_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
  '.mp3',
  '.ogg',
  '.wav',
  '.json',
  '.atlas',
  '.xml',
];

export interface ProtocolHint {
  entryId: string;
  rootCause: string;
  fixDescription: string;
}

export interface PostVerifyIssue {
  code: 'OG001' | 'OG002';
  message: string;
  file?: string;
  detail?: string;
  fixed: boolean;
  fixDescription?: string;
  protocol?: ProtocolHint;
}

export interface PostVerifyResult {
  enabled: boolean;
  workspace: string;
  checkedImports: number;
  checkedAssets: number;
  issues: PostVerifyIssue[];
  fixedCount: number;
  reportPath?: string;
  summary: string;
}

interface DebugProtocolEntry {
  id: string;
  signature?: { errorCode?: string; stage?: string };
  rootCause?: string;
  tags?: string[];
  fix?: { description?: string };
}

interface DebugProtocolFile {
  entries?: DebugProtocolEntry[];
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Locate agent-test/debug-skill/seed-protocol/protocol.json.
 */
async function loadDebugProtocol(
  startDir: string,
): Promise<DebugProtocolFile | null> {
  const envPath = process.env['OPENGAME_DEBUG_PROTOCOL'];
  const candidates: string[] = [];
  if (envPath) candidates.push(envPath);

  let dir = path.resolve(startDir);
  while (true) {
    candidates.push(
      path.join(
        dir,
        'agent-test',
        'debug-skill',
        'seed-protocol',
        'protocol.json',
      ),
    );
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      try {
        return JSON.parse(
          await fs.readFile(candidate, 'utf-8'),
        ) as DebugProtocolFile;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function matchProtocol(
  protocol: DebugProtocolFile | null,
  errorCode: string,
  tags: string[],
): ProtocolHint | undefined {
  const entries = protocol?.entries ?? [];
  const byCode = entries.find((e) => e.signature?.errorCode === errorCode);
  const entry =
    byCode ?? entries.find((e) => tags.some((tag) => e.tags?.includes(tag)));
  if (!entry) return undefined;
  return {
    entryId: entry.id,
    rootCause: entry.rootCause ?? '',
    fixDescription: entry.fix?.description ?? '',
  };
}

function collectPackPaths(node: unknown, acc: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPackPaths(item, acc);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (
        typeof value === 'string' &&
        (key === 'url' || key === 'path') &&
        ASSET_EXTENSIONS.some((ext) => value.toLowerCase().endsWith(ext))
      ) {
        acc.push(value);
      } else {
        collectPackPaths(value, acc);
      }
    }
  }
}

async function checkAssetPack(
  workspaceDir: string,
  protocol: DebugProtocolFile | null,
): Promise<{ checked: number; issues: PostVerifyIssue[] }> {
  const issues: PostVerifyIssue[] = [];
  const packPath = path.join(workspaceDir, 'assets', 'asset-pack.json');
  if (!(await exists(packPath))) {
    return { checked: 0, issues };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(packPath, 'utf-8'));
  } catch {
    return { checked: 0, issues };
  }

  const urls: string[] = [];
  collectPackPaths(raw, urls);
  const unique = [...new Set(urls)];
  let checked = 0;

  for (const url of unique) {
    if (/^https?:\/\//i.test(url)) continue;
    checked += 1;
    const absolute = path.resolve(workspaceDir, url);
    const fallback = path.resolve(workspaceDir, 'assets', url);
    if ((await exists(absolute)) || (await exists(fallback))) continue;

    issues.push({
      code: 'OG001',
      message: `asset referenced by asset-pack.json is missing: ${url}`,
      file: path.relative(workspaceDir, packPath),
      detail: `looked for ${absolute}`,
      fixed: false,
      // Missing binary assets cannot be fabricated without an image/video key.
      fixDescription:
        'Asset generation is unavailable (no image key) — create the file or remove the entry from asset-pack.json.',
      protocol: matchProtocol(protocol, 'TextureNotFound', [
        'asset',
        'key-mismatch',
      ]),
    });
  }

  return { checked, issues };
}

async function resolveImport(
  importingFile: string,
  specifier: string,
): Promise<boolean> {
  const base = path.resolve(path.dirname(importingFile), specifier);
  for (const ext of RESOLVE_EXTENSIONS) {
    if (await exists(base + ext)) return true;
  }
  for (const ext of RESOLVE_EXTENSIONS.filter((e) => e.length > 0)) {
    if (await exists(path.join(base, `index${ext}`))) return true;
  }
  return false;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

async function checkImports(
  workspaceDir: string,
  protocol: DebugProtocolFile | null,
): Promise<{
  checked: number;
  issues: PostVerifyIssue[];
  sources: string[];
}> {
  const srcDir = path.join(workspaceDir, 'src');
  const issues: PostVerifyIssue[] = [];
  if (!(await exists(srcDir))) {
    return { checked: 0, issues, sources: [] };
  }

  const files = (await walk(srcDir)).filter((file) =>
    SOURCE_EXTENSIONS.includes(path.extname(file)),
  );
  const importPattern =
    /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g;
  let checked = 0;

  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }

    const specifiers = new Set<string>();
    // Strip comments so JSDoc usage examples are not treated as real imports.
    const code = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const match of code.matchAll(importPattern)) {
      specifiers.add(match[1]);
    }

    for (const specifier of specifiers) {
      checked += 1;
      if (await resolveImport(file, specifier)) continue;

      const issue: PostVerifyIssue = {
        code: 'OG002',
        message: `unresolved relative import: ${specifier}`,
        file: path.relative(workspaceDir, file),
        detail: `resolved from ${path.dirname(path.relative(workspaceDir, file))}`,
        fixed: false,
        protocol: matchProtocol(protocol, 'TS2307', ['import', 'path']),
      };

      // Auto-fix: if exactly one file under src/ has the same basename,
      // rewrite the specifier to point at it — but only when the rewritten
      // import actually resolves.
      const wantedBase = path.basename(specifier);
      const wantedStem = wantedBase.replace(/\.[^.]+$/, '');
      const candidates = files.filter((candidate) => {
        const stem = path.basename(candidate).replace(/\.[^.]+$/, '');
        return stem === wantedStem || path.basename(candidate) === wantedBase;
      });

      if (candidates.length === 1) {
        const target = candidates[0];
        let newSpecifier = toPosix(
          path.relative(path.dirname(file), target),
        ).replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
        if (!newSpecifier.startsWith('.')) newSpecifier = `./${newSpecifier}`;

        if (!(await resolveImport(file, newSpecifier))) {
          issue.fixDescription = `candidate '${newSpecifier}' does not resolve — left for manual repair`;
          issues.push(issue);
          continue;
        }

        const rewritten = content
          .split(`'${specifier}'`)
          .join(`'${newSpecifier}'`)
          .split(`"${specifier}"`)
          .join(`"${newSpecifier}"`);
        if (rewritten !== content) {
          try {
            await fs.writeFile(file, rewritten, 'utf-8');
            content = rewritten;
            issue.fixed = true;
            issue.fixDescription = `rewrote import to '${newSpecifier}'`;
          } catch {
            issue.fixDescription = 'auto-fix write failed';
          }
        }
      } else if (candidates.length > 1) {
        issue.fixDescription = `ambiguous target (${candidates.length} files share that name) — left for manual repair`;
      } else {
        issue.fixDescription =
          'no matching file found — left for manual repair';
      }

      issues.push(issue);
    }
  }

  return { checked, issues, sources: files };
}

/**
 * Optional post-generation verification.
 *
 * Enabled by default; set OPENGAME_POST_VERIFY=false to disable.
 */
export async function runPostVerify(config: Config): Promise<PostVerifyResult> {
  const workspaceDir = path.resolve(config.getTargetDir());

  if (process.env[POST_VERIFY_DISABLE_ENV] === 'false') {
    return {
      enabled: false,
      workspace: workspaceDir,
      checkedImports: 0,
      checkedAssets: 0,
      issues: [],
      fixedCount: 0,
      summary: `post-verify disabled via ${POST_VERIFY_DISABLE_ENV}=false`,
    };
  }

  writeRuntimeStatus(workspaceDir, 'verifying', 'Running post-verify checks');

  // Synchronous log so the output survives the CLI's process.exit(0).
  const logFile = path.join(
    workspaceDir,
    POST_VERIFY_REPORT_DIR,
    'post-verify.log',
  );
  const log = (line: string): void => {
    console.log(line);
    try {
      fsSync.mkdirSync(path.dirname(logFile), { recursive: true });
      fsSync.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Logging is best effort.
    }
  };

  log(`[post-verify] start (workspace: ${workspaceDir})`);

  const protocol = await loadDebugProtocol(workspaceDir);
  log(
    `[post-verify] protocol: ${protocol ? `${protocol.entries?.length ?? 0} entries` : 'not found (rule hints disabled)'}`,
  );

  const imports = await checkImports(workspaceDir, protocol);
  const assets = await checkAssetPack(workspaceDir, protocol);
  const issues = [...imports.issues, ...assets.issues];
  const fixedCount = issues.filter((issue) => issue.fixed).length;

  for (const issue of issues) {
    const hint = issue.protocol
      ? ` [rule ${issue.protocol.entryId}: ${issue.protocol.rootCause}]`
      : '';
    const action = issue.fixed ? `FIXED (${issue.fixDescription})` : 'UNFIXED';
    log(`[post-verify] ${issue.code} ${action}: ${issue.message}${hint}`);
  }

  const summary =
    issues.length === 0
      ? `post-verify passed: ${imports.checked} imports / ${assets.checked} assets checked, 0 issues`
      : `post-verify found ${issues.length} issue(s), auto-fixed ${fixedCount}`;
  log(`[post-verify] ${summary}`);

  let reportPath: string | undefined;
  try {
    const reportDir = path.join(workspaceDir, POST_VERIFY_REPORT_DIR);
    await fs.mkdir(reportDir, { recursive: true });
    reportPath = path.join(reportDir, POST_VERIFY_REPORT_FILE);
    await fs.writeFile(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          // 供远程 worker 校验「本次任务」的结果，拒绝陈旧报告（P1-4）
          taskId: process.env['OPENGAME_REMOTE_TASK_ID'] ?? null,
          workspace: workspaceDir,
          checkedImports: imports.checked,
          checkedAssets: assets.checked,
          fixedCount,
          issues,
        },
        null,
        2,
      ),
      'utf-8',
    );
  } catch {
    reportPath = undefined;
  }

  writeRuntimeStatus(workspaceDir, 'done', summary);

  return {
    enabled: true,
    workspace: workspaceDir,
    checkedImports: imports.checked,
    checkedAssets: assets.checked,
    issues,
    fixedCount,
    reportPath,
    summary,
  };
}

class PostVerifyInvocation extends BaseToolInvocation<
  Record<string, never>,
  ToolResult
> {
  constructor(private config: Config) {
    super({});
  }

  getDescription(): string {
    return 'Running post-verify static checks on the generated game...';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const result = await runPostVerify(this.config);
    const lines = [
      `post-verify: ${result.summary}`,
      `imports checked: ${result.checkedImports}, assets checked: ${result.checkedAssets}`,
      ...result.issues.map(
        (issue) =>
          `- ${issue.code} ${issue.fixed ? 'FIXED' : 'UNFIXED'}: ${issue.message}${
            issue.fixDescription ? ` (${issue.fixDescription})` : ''
          }`,
      ),
    ];
    return {
      llmContent: lines.join('\n'),
      returnDisplay: `🔎 ${result.summary}`,
    };
  }
}

export class PostVerifyTool extends BaseDeclarativeTool<
  Record<string, never>,
  ToolResult
> {
  static readonly Name = 'PostVerify';

  constructor(private config: Config) {
    super(
      PostVerifyTool.Name,
      'PostVerify',
      `Runs lightweight static verification after generation: checks that every relative import in src/ resolves and that every asset referenced by assets/asset-pack.json exists. Known failures are matched against the debug protocol (seed-protocol/protocol.json); resolvable import paths are rewritten automatically. Disable with ${POST_VERIFY_DISABLE_ENV}=false.`,
      Kind.Execute,
      {
        type: 'object',
        properties: {},
      },
      false,
      true,
    );
  }

  protected createInvocation(
    _params: Record<string, never>,
  ): ToolInvocation<Record<string, never>, ToolResult> {
    return new PostVerifyInvocation(this.config);
  }
}

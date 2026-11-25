import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { writeRuntimeStatus } from '../utils/runtime-status.js';

export const GAME_ARCHETYPES = [
  'platformer',
  'top_down',
  'grid_logic',
  'tower_defense',
  'ui_heavy',
] as const;

export type GameArchetypeName = (typeof GAME_ARCHETYPES)[number];

export interface CopyTemplateParams {
  /**
   * Optional project name (used for package.json name if provided)
   */
  project_name?: string;
  /**
   * Game archetype chosen by the classify-game-type tool.
   * When omitted only the core template is scaffolded.
   */
  archetype?: GameArchetypeName;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the templates root directory.
 *
 * Order:
 *  1. OPENGAME_TEMPLATES_DIR environment variable
 *  2. `agent-test/templates` or `templates` found by walking up from cwd
 */
export async function resolveTemplatesRoot(
  startDir: string,
): Promise<string | null> {
  const envDir = process.env['OPENGAME_TEMPLATES_DIR'];
  if (envDir && (await exists(path.join(envDir, 'core')))) {
    return path.resolve(envDir);
  }

  let dir = path.resolve(startDir);
  while (true) {
    for (const candidate of [
      path.join(dir, 'agent-test', 'templates'),
      path.join(dir, 'templates'),
    ]) {
      if (await exists(path.join(candidate, 'core'))) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

async function copyTemplateDocs(
  docsRoot: string,
  archetype: GameArchetypeName | undefined,
  workspaceDir: string,
): Promise<string[]> {
  const copied: string[] = [];
  const copyFileSafe = async (from: string, to: string) => {
    if (!(await exists(from))) return;
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    copied.push(path.relative(workspaceDir, to));
  };

  await copyFileSafe(
    path.join(docsRoot, 'gdd', 'core.md'),
    path.join(workspaceDir, 'docs', 'gdd', 'core.md'),
  );
  for (const doc of ['asset_protocol.md', 'debug_protocol.md']) {
    await copyFileSafe(
      path.join(docsRoot, doc),
      path.join(workspaceDir, 'docs', doc),
    );
  }
  if (archetype) {
    const moduleDocs = path.join(docsRoot, 'modules', archetype);
    const targetDocs = path.join(workspaceDir, 'docs', 'modules', archetype);
    if (await exists(moduleDocs)) {
      await fs.cp(moduleDocs, targetDocs, {
        recursive: true,
        force: true,
      });
      copied.push(path.relative(workspaceDir, targetDocs));
    }
  }
  return copied;
}

class CopyTemplateInvocation extends BaseToolInvocation<
  CopyTemplateParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: CopyTemplateParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const arch = this.params.archetype
      ? ` (core + ${this.params.archetype} module)`
      : ' (core only)';
    return `Copying game template files${arch} to working directory...`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const workspaceDir = this.config.getTargetDir();

    const templateDir = await resolveTemplatesRoot(workspaceDir);
    if (!templateDir) {
      return {
        llmContent: `Error: Template directory not found. Set OPENGAME_TEMPLATES_DIR or run from inside the OpenGame repository. Started search from: ${workspaceDir}`,
        returnDisplay: '❌ Template Not Found',
        error: { message: 'Template directory missing' },
      };
    }

    const archetype = this.params.archetype;
    const copied: string[] = [];

    try {
      // 1. core/* -> workspace root (do not overwrite files the agent already wrote)
      await fs.cp(path.join(templateDir, 'core'), workspaceDir, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
      copied.push('core/*');

      // 2. modules/<archetype>/src/* -> workspace/src (module overlay wins)
      if (archetype) {
        const moduleSrc = path.join(templateDir, 'modules', archetype, 'src');
        if (await exists(moduleSrc)) {
          await fs.cp(moduleSrc, path.join(workspaceDir, 'src'), {
            recursive: true,
            force: true,
          });
          copied.push(`modules/${archetype}/src/* -> src/`);
        } else {
          copied.push(`modules/${archetype}/src (missing, skipped)`);
        }
      }

      // 3. documentation (best effort; the docs live next to the templates dir)
      const docsRoot =
        process.env['OPENGAME_DOCS_DIR'] ??
        path.join(path.dirname(templateDir), 'docs');
      try {
        copied.push(
          ...(await copyTemplateDocs(docsRoot, archetype, workspaceDir)),
        );
      } catch {
        // Docs are optional, never fail the scaffold because of them.
      }

      // 4. package.json name
      if (this.params.project_name) {
        const pkgPath = path.join(workspaceDir, 'package.json');
        try {
          const pkgData = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
          pkgData.name = this.params.project_name;
          await fs.writeFile(pkgPath, JSON.stringify(pkgData, null, 2));
        } catch {
          // Ignore if package.json not found or parse error.
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error copying template: ${msg}`,
        returnDisplay: `❌ Copy Template Failed: ${msg}`,
        error: { message: msg },
      };
    }

    writeRuntimeStatus(
      workspaceDir,
      'generating',
      `Template scaffolded${archetype ? ` (${archetype})` : ''}`,
    );

    const instruction = `
Template files copied successfully!
Templates root: ${templateDir}
Archetype: ${archetype ?? '(none: core only)'}
Location: ${workspaceDir}

COPIED:
${copied.map((c) => `- ${c}`).join('\n')}

KEY FILES:
- index.html, vite.config.js, tsconfig.json, tailwind.config.js, package.json
- src/main.ts (entry point)
- src/gameConfig.json (game config)
- src/scenes/*.ts (base scenes, preloader, UI)
- docs/ (gdd + asset/debug protocol) when available

NEXT STEPS (strict order):
1. Read 'src/gameConfig.json' and 'docs/gdd/core.md' before writing code.
2. Call 'generate-gdd' (if not done yet).
3. Create entities/scenes by following the copied template patterns (_Template*.ts).
4. Do NOT rewrite index.html / vite.config.js / tsconfig.json from scratch.
`;

    return {
      llmContent: instruction,
      returnDisplay: `✅ Template Files Copied${archetype ? ` (${archetype})` : ''}`,
    };
  }
}

export class CopyTemplateTool extends BaseDeclarativeTool<
  CopyTemplateParams,
  ToolResult
> {
  static readonly Name = 'CopyTemplate';

  constructor(private config: Config) {
    super(
      CopyTemplateTool.Name,
      'CopyTemplate',
      'Copies the pre-built game template (Phaser + Vite + TypeScript) to your working directory. Call this FIRST (right after classify-game-type) before writing any code - do NOT code from scratch! Pass the archetype returned by classify-game-type so the matching module is overlaid.',
      Kind.Execute,
      {
        type: 'object',
        properties: {
          project_name: {
            type: 'string',
            description: 'Name of the game project (optional).',
          },
          archetype: {
            type: 'string',
            enum: [...GAME_ARCHETYPES],
            description:
              'Archetype returned by classify-game-type. Omit to scaffold core only.',
          },
        },
      },
      false,
      true,
    );
  }

  protected createInvocation(
    params: CopyTemplateParams,
  ): ToolInvocation<CopyTemplateParams, ToolResult> {
    return new CopyTemplateInvocation(this.config, params);
  }
}

#!/usr/bin/env node
'use strict';

/**
 * Vplay 本地管理 CLI（Adopt Mode）。
 *
 * 导入必须在本机执行——HTTP 永远不接受系统路径。
 *
 * 用法：
 *   node remote/cli.cjs project import <path> --id <id> [--name <n>] [--entry <rel>]
 *   node remote/cli.cjs project list
 *   node remote/cli.cjs project show <id>
 *   node remote/cli.cjs project snapshot <id> [--label <label>]
 *   node remote/cli.cjs project diff <id> --from <seq> [--to <seq|current>]
 *   node remote/cli.cjs project rollback <id> --seq <n>
 */

const {
  createProjectRegistry,
  defaultHome,
  ProjectError,
} = require('./lib/projects.cjs');

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function positional(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(error) {
  const payload = {
    ok: false,
    error: error.message,
    code: error.code || 'ERROR',
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = positional(argv);
  const home = process.env.VPLAY_HOME || defaultHome();
  const registry = createProjectRegistry({ home });

  const [scope, action, target] = args;
  if (scope !== 'project' || !action) {
    process.stderr.write(
      'usage: node remote/cli.cjs project <import|list|show|snapshot|diff|rollback> ...\n',
    );
    process.exitCode = 2;
    return;
  }

  if (action === 'import') {
    if (!target) throw new ProjectError('缺少导入目录', 400, 'MISSING_PATH');
    const result = registry.importProject({
      sourceDir: target,
      id: flag(argv, 'id') || undefined,
      name: flag(argv, 'name') || undefined,
      entry: flag(argv, 'entry') || undefined,
    });
    print({
      ok: true,
      home,
      projectId: result.project.id,
      srcDir: result.project.srcDir,
      kind: result.project.kind,
      entry: result.project.entry,
      import: result.import,
    });
    return;
  }

  if (action === 'list') {
    print({ ok: true, home, projects: registry.list() });
    return;
  }

  if (action === 'show') {
    print({ ok: true, project: registry.get(target) });
    return;
  }

  if (action === 'snapshot') {
    print({ ok: true, snapshot: registry.snapshot(target, flag(argv, 'label') || 'manual') });
    return;
  }

  if (action === 'diff') {
    const from = Number(flag(argv, 'from'));
    const toRaw = flag(argv, 'to');
    if (!Number.isFinite(from) || from <= 0) {
      throw new ProjectError('需要 --from <snapshot seq>', 400, 'MISSING_FROM');
    }
    const to = !toRaw || toRaw === 'current' ? 'current' : Number(toRaw);
    print({ ok: true, ...registry.diff(target, from, to) });
    return;
  }

  if (action === 'rollback') {
    const seq = Number(flag(argv, 'seq'));
    if (!Number.isFinite(seq) || seq <= 0) {
      throw new ProjectError('需要 --seq <snapshot seq>', 400, 'MISSING_SEQ');
    }
    const lock = registry.readLock(target);
    if (lock) {
      throw new ProjectError(
        `项目正在被任务 ${lock.taskId || '?'} 占用，禁止回退`,
        409,
        'PROJECT_LOCKED',
      );
    }
    print({ ok: true, ...registry.rollback(target, seq) });
    return;
  }

  throw new ProjectError(`未知操作: ${action}`, 400, 'UNKNOWN_ACTION');
}

main().catch((error) => fail(error));

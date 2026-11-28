'use strict';

/**
 * ARM64 / Linux 运行配置解析（B19）。
 *
 * 目标：
 *  - 受控的低内存浏览器参数：只允许白名单；明确拒绝任何关闭 sandbox 或削弱
 *    web 安全的参数；不接受任意环境变量透传。
 *  - 可配置快照上限：保留 projects.cjs 的活跃租约保护与并发一致性。
 *  - POSIX umask：默认 0o027，避免日志/证据默认 world-readable。
 *  - 进程组选项：POSIX 子进程 detached，便于用 kill(-pid) 清理整棵树。
 */

const BROWSER_ARG_EXACT = new Set([
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-background-networking',
  '--disable-extensions',
  '--mute-audio',
  '--hide-scrollbars',
]);

const BROWSER_ARG_PATTERNS = [
  /^--renderer-process-limit=[1-4]$/,
  /^--js-flags=--max-old-space-size=(256|384|512|768|1024|1536|2048)$/,
];

// C18 P-1：受限模式只读工具白名单（执行层由 CLI --core-tools 过滤）。
const RESTRICTED_CORE_TOOLS = Object.freeze([
  'read_file',
  'read_many_files',
  'grep_search',
  'glob',
  'list_directory',
]);
const RESTRICTED_EXCLUDED_TOOLS = Object.freeze([
  'run_shell_command',
  'edit',
  'write_file',
  'web_fetch',
  'web_search',
  'task',
  'skill',
  'generate_game_assets',
  'generate_tilemap',
  'generate_gdd',
  'exit_plan_mode',
  'save_memory',
]);

function restrictedCliArgs() {
  return [
    '--core-tools',
    RESTRICTED_CORE_TOOLS.join(','),
    '--exclude-tools',
    RESTRICTED_EXCLUDED_TOOLS.join(','),
  ];
}

const FORBIDDEN_BROWSER_ARG = /--no-sandbox|--disable-setuid-sandbox|--single-process|--disable-web-security|--allow-running-insecure-content|--remote-debugging|--disable-features=.*(site-per-process|IsolateOrigins)|--no-zygote/i;

class BrowserArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserArgsError';
    this.code = 'VPLAY_BROWSER_ARGS_REJECTED';
  }
}

/**
 * 解析 VPLAY_BROWSER_ARGS。
 * 任何未知/禁止参数都失败关闭，不静默丢弃（避免"以为加上了"的误配置）。
 */
function parseBrowserArgs(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const args = [];
  for (const token of raw.split(/\s+/)) {
    if (!token) continue;
    if (FORBIDDEN_BROWSER_ARG.test(token)) {
      throw new BrowserArgsError(`browser argument is forbidden (sandbox/security weakening): ${token}`);
    }
    const allowed = BROWSER_ARG_EXACT.has(token) || BROWSER_ARG_PATTERNS.some((re) => re.test(token));
    if (!allowed) {
      throw new BrowserArgsError(`browser argument is not in the allowlist: ${token}`);
    }
    if (!args.includes(token)) args.push(token);
  }
  return args;
}

/** 快照上限：2..200；非法值回退默认，不放大到无上限。 */
function parseMaxSnapshots(value, fallback = 200) {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  if (!Number.isFinite(base)) return fallback;
  return Math.min(200, Math.max(2, base));
}

/** POSIX umask：接受八进制字符串（如 027/0o027）或数字；范围 0..0o777。 */
function parseUmask(value, fallback = 0o027) {
  if (value === undefined || value === null || value === '') return fallback;
  let parsed;
  if (typeof value === 'number') parsed = value;
  else {
    const text = String(value).trim();
    parsed = text.startsWith('0o') || text.startsWith('0O')
      ? Number.parseInt(text.slice(2), 8)
      : Number.parseInt(text, 8);
  }
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0o777) return fallback;
  return parsed;
}

/** POSIX 子进程 detached；Windows 保持原有行为。 */
function spawnDetachedOptions(extra = {}, platform = process.platform) {
  return { ...extra, detached: platform !== 'win32' };
}

/**
 * 终止 POSIX 进程组（子进程需以 detached 启动）。
 * 返回是否发出了信号；Windows 由调用方继续使用 taskkill。
 */
function killProcessGroup(pid, options = {}) {
  const platform = options.platform || process.platform;
  const kill = options.kill || process.kill;
  if (platform === 'win32' || !pid) return false;
  try {
    kill(-Number(pid), 'SIGKILL');
    return true;
  } catch {
    try {
      kill(Number(pid), 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = {
  BrowserArgsError,
  parseBrowserArgs,
  parseMaxSnapshots,
  parseUmask,
  spawnDetachedOptions,
  killProcessGroup,
  RESTRICTED_CORE_TOOLS,
  RESTRICTED_EXCLUDED_TOOLS,
  restrictedCliArgs,
};

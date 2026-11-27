'use strict';

/**
 * E2 独立宿主记录器（不属于 Vplay 代码）。
 * 周期性采样：项目树摘要、git 状态、锁文件、进程表、监听端口。
 * 输出 append-only JSONL（带 prevHash/hash 链），供 verify-run 第 6/7 步交叉核对。
 *
 * 用法：
 *   node recorder/host-recorder.cjs --src=<项目src> --out=<证据包目录> --home=<VPLAY_HOME> \
 *        [--interval=2000] [--seconds=0] [--with-procs=1] [--project-id=...]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function parse(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function digestTree(dir) {
  const files = [];
  for (const file of walk(dir)) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    if (rel.split('/').some((segment) => segment.startsWith('.'))) continue;
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    files.push({ rel, size: buf.length, sha256: sha256(buf) });
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return {
    digest: sha256(files.map((file) => `${file.rel}\0${file.sha256}`).join('\n')),
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

function psJson(script) {
  try {
    const text = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${script} | ConvertTo-Json -Compress -Depth 3`],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    ).trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function gitInfo(repo) {
  try {
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    return { head, statusHash: sha256(status), dirty: status ? status.split(/\r?\n/).length : 0 };
  } catch {
    return null;
  }
}

function lockSnapshot(home) {
  const locksDir = path.join(home, 'runtime', 'locks');
  if (!fs.existsSync(locksDir)) return [];
  return fs
    .readdirSync(locksDir)
    .filter((name) => name.endsWith('.lock'))
    .map((name) => {
      const file = path.join(locksDir, name);
      try {
        return { name, bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) };
      } catch {
        return { name, error: 'unreadable' };
      }
    });
}

function main() {
  const args = parse(process.argv.slice(2));
  const src = args.src ? path.resolve(args.src) : '';
  const outDir = args.out ? path.resolve(args.out) : '';
  const home = args.home ? path.resolve(args.home) : '';
  const repo = args.repo ? path.resolve(args.repo) : '';
  const interval = Number(args.interval || 2000);
  const seconds = Number(args.seconds || 0);
  const withProcs = args['with-procs'] !== '0';
  if (!src || !outDir) {
    console.error('usage: host-recorder.cjs --src=<dir> --out=<evidence dir> [--home=] [--repo=] [--interval=2000] [--seconds=0]');
    process.exit(64);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, '03-host-recorder.jsonl');
  const fd = fs.openSync(file, 'a');
  let seq = 0;
  let prevHash = '';
  // 续写时对齐已有链
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.seq >= seq) {
          seq = record.seq;
          prevHash = record.hash || '';
        }
      } catch {
        /* ignore */
      }
    }
  }

  let timer = null;
  const sample = () => {
    seq += 1;
    let tree = null;
    try {
      tree = digestTree(src);
    } catch (error) {
      tree = { error: String(error.message || error) };
    }
    const payload = {
      at: new Date().toISOString(),
      tree,
      git: repo ? gitInfo(repo) : null,
      locks: home ? lockSnapshot(home) : [],
      ports: withProcs
        ? psJson('Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 8787,8788 } | Select-Object LocalAddress,LocalPort,OwningProcess')
        : [],
      procs: withProcs
        ? psJson("Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'node|msedge|chrome|npm' } | Select-Object ProcessId,ParentProcessId,Name,CreationDate")
        : [],
    };
    const body = { seq, prevHash, ...payload };
    const hash = sha256(stableStringify(body));
    const record = { ...body, hash };
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    prevHash = hash;
    process.stdout.write(`sample seq=${seq} files=${payload.tree.count || '?'} digest=${String(payload.tree.digest || '').slice(0, 12)}\n`);
  };

  sample();
  timer = setInterval(sample, interval);
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (seconds > 0) setTimeout(stop, seconds * 1000);
  if (seconds === 0) process.stdout.write('recorder running; Ctrl+C to stop\n');
}

main();

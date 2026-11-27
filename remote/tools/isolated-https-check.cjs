'use strict';

/**
 * B11 / C：独立、无凭据、无工程数据的 HTTPS 测试服务（准备件）。
 *
 * 目的：在 Tailscale 双设备可用后，先用一个**不接触任何工程/凭据**的服务验证
 * HTTPS 终止、跨网络可达性与 Host 行为；验证通过且 Qoder 门禁通过前，**不发布真实 Runtime**。
 *
 * 本脚本只监听 127.0.0.1，不读取 VPLAY_HOME、不读任何 token/key、不写盘。
 *
 * 用法：
 *   node remote/tools/isolated-https-check.cjs --port=8899
 *   # 由用户手动执行（B11 不自动启用）：
 *   tailscale serve --bg --https=9443 http://127.0.0.1:8899
 *   # 验证后停止：
 *   tailscale serve --https=9443 off
 *
 * 安全约束：
 *   - 只允许 127.0.0.1 / ::1；
 *   - 禁用 Funnel（本脚本不会执行任何 tailscale 命令）；
 *   - 响应中不含任何工程/设备/凭据信息。
 */

const http = require('http');

const args = {};
for (const item of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(item);
  if (match) args[match[1]] = match[2];
}

const PORT = Number(args.port || 8899);
const HOST = args.host || '127.0.0.1';

if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
  console.error('[isolated] refuse to bind non-loopback host:', HOST);
  process.exit(2);
}

const BODY = `Vplay isolated HTTPS check\n` +
  `service=isolated-https-check\n` +
  `data=no-credentials-no-project-data\n`;

const server = http.createServer((req, res) => {
  const url = String(req.url || '/').split('?')[0];
  if (url === '/health') {
    const payload = JSON.stringify({
      ok: true,
      service: 'vplay-isolated-https-check',
      data: 'none',
      auth: 'none',
      at: new Date().toISOString(),
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(payload);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(BODY),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(BODY);
});

server.listen(PORT, HOST, () => {
  console.log(`[isolated] listening on http://${HOST}:${PORT} (loopback only, no data)`);
  console.log(`[isolated] next (manual, not executed by this tool):`);
  console.log(`[isolated]   tailscale serve --bg --https=9443 http://127.0.0.1:${PORT}`);
  console.log(`[isolated]   tailscale serve status`);
  console.log(`[isolated]   tailscale funnel status   # must stay empty`);
  console.log(`[isolated] stop:`);
  console.log(`[isolated]   tailscale serve --https=9443 off`);
});

function stop() {
  console.log('[isolated] shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

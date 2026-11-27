# Connect L2 验收准备（B11）

> 原则：Runtime 只监听回环；HTTPS 由 `tailscale serve` 终止；不启用 Funnel / Exit Node / 子网路由；
> 不开放公网端口；**B11 未启用真实 Runtime 的 Serve**，本文件是精确操作与门禁设计。

## 1. 实际 Tailscale 状态（2026-11-27 只读实测）

```text
tailscale 1.104.7 (tfb3b9b296, go1.27.4)
100.78.136.34    timer009              windows  online
100.118.137.100  iphone197             iOS      offline (last seen 57m ago)
100.75.200.83    oppo-find-x8-ultra    android  online
MagicDNS: timer009.tail199672.ts.net.
BackendState: Running
tailscale serve status  -> No serve config
tailscale funnel status -> No serve config
8787/8788 -> 未监听
防火墙：node.exe 仍有 4 条 Public Allow 入站规则（B11 不修改，见 §7）
```

## 2. 拓扑（仅回环）

```text
iPhone/OPPO (tailnet)
   |  https://timer009.tail199672.ts.net/            -> tailscaled -> 127.0.0.1:8787  控制面
   |  https://timer009.tail199672.ts.net:8443/       -> tailscaled -> 127.0.0.1:8788  预览面
   |  https://timer009.tail199672.ts.net:9443/       -> tailscaled -> 127.0.0.1:8899  隔离测试（先验）
```

独立 origin：

- 控制面：`https://timer009.tail199672.ts.net`（443）
- 预览面：`https://timer009.tail199672.ts.net:8443`（端口参与 Origin，不参与 Cookie scope）
- 因此控制面写接口必须继续做 `Origin.host === Host`（含端口）校验；预览页不能代发写请求。
- 预览票据 `vplay_preview` 只作用于 `/p/<projectId>/`，不设置 `Domain`，不复用全局静态 hash。

## 3. 隔离 HTTPS 测试（先做，不接触真实 Runtime）

```powershell
# 1) 启动无凭据、无工程数据的回环测试服务（B11 提供脚本）
node G:\...\OpenGame\remote\tools\isolated-https-check.cjs --port=8899

# 2) 用户手动启用（B11 未执行；不使用 Funnel）
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg --https=9443 http://127.0.0.1:8899
& 'C:\Program Files\Tailscale\tailscale.exe' serve status
& 'C:\Program Files\Tailscale\tailscale.exe' funnel status   # 必须仍为空

# 3) 手机访问 https://timer009.tail199672.ts.net:9443/health
#    通过标准：证书有效、返回 service=vplay-isolated-https-check、无工程/凭据字段

# 4) 停止（验证完立即回收）
& 'C:\Program Files\Tailscale\tailscale.exe' serve --https=9443 off
```

> iPhone 当前 offline；需用户解锁/联网后再做手机侧验证。未打 tag / 未授权设备必须不可达。

## 4. 正式 Runtime 启动命令（Qoder 门禁通过后才执行）

```powershell
$env:VPLAY_HOME='C:\vplay-connect\home'
$env:REMOTE_HOST='127.0.0.1'
$env:REMOTE_PORT='8787'
$env:PREVIEW_PORT='8788'
$env:VPLAY_PUBLIC_MODE='1'            # Serve 暴露 → 强制 publicMode，yolo 不可开启
$env:REMOTE_TRUST_PROXY='1'           # 仅回环代理；不要在直连场景开启
$env:REMOTE_ALLOWED_HOSTS='timer009.tail199672.ts.net,localhost,127.0.0.1'
$env:PREVIEW_ACCESS_KEY='<随机 32B>'
$env:EVIDENCE_HMAC_KEY='<随机 32B>'   # 不写入 Agent 子进程环境
# 禁止设置：REMOTE_ALLOW_TEST_SEAM / REMOTE_EXECUTOR_CMD / VPLAY_ALLOW_YOLO / NODE_ENV=test
node remote/server.cjs

# 仅两条 Serve
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg --https=443  http://127.0.0.1:8787
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg --https=8443 http://127.0.0.1:8788
& 'C:\Program Files\Tailscale\tailscale.exe' serve status
& 'C:\Program Files\Tailscale\tailscale.exe' funnel status   # 空
```

停止：

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' serve --https=443 off
& 'C:\Program Files\Tailscale\tailscale.exe' serve --https=8443 off
Get-Process node | Where-Object { $_.Path -like '*fnm*' } | Stop-Process   # 确认后执行
```

恢复：直接重启 `node remote/server.cjs`；启动流程会：

1. 隔离孤儿快照；
2. 按 rollback journal 恢复；
3. 复核 Vision apply journal（needs-review / completed-unverified）；
4. 把运行中任务标记 `interrupted`（不自动重跑）；
5. 回收过期租约与孤儿 CLI；
6. 只绑定 `127.0.0.1`，拒绝 wildcard / Serve 模式下 seam。

## 5. Cookie / Host / Origin / SSE / 票据策略

| 面             | 策略                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------- |
| Session Cookie | `HttpOnly; SameSite=Strict; Path=/`；`REMOTE_TRUST_PROXY=1` 且 XFP=https 才加 `Secure`        |
| 预览票据       | 随机 32B，服务端内存，会话/设备绑定，4h TTL；Vision 任务用 5min 最小权限票据；`Path=/p/<id>/` |
| 登出/吊销      | 删 session + 绑定票据；设备吊销后 Session/SSE/预览立即失效                                    |
| Host           | `localhost/127.0.0.1/::1 + REMOTE_HOST + REMOTE_ALLOWED_HOSTS`；Serve 必须写入 MagicDNS 名    |
| 写接口 Origin  | `new URL(origin).host === Host`（含端口）；不得改成忽略端口                                   |
| SSE            | `/events` 需鉴权；按项目过滤；每 15s 重验会话；`Last-Event-ID` 补发；窗口截断发送 `gap` 事件  |
| 预览完整性     | 每个响应文件与 `.publish-manifest.json` 哈希一致，否则 503                                    |

## 6. ACL 建议（默认拒绝；由用户在管理台执行）

```json
{
  "tagOwners": {
    "tag:vplay-host": ["autogroup:admin"],
    "tag:vplay-phone": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["tag:vplay-phone"],
      "dst": ["tag:vplay-host:443", "tag:vplay-host:8443"]
    }
  ],
  "ssh": [],
  "autoApprovers": {},
  "nodeAttrs": []
}
```

- 不写 `"*"` 源；不开放 22/3389；无 `attr:["funnel"]`；保持 key expiry；
- 验证：未打 tag 设备访问 443/8443 不可达；`http://100.78.136.34:8787` 不可达（只开 Serve）。

## 7. 防火墙（本机现状，B11 不改）

```text
node.exe 入站 Allow 规则 4 条（Public，Any/Any）
```

- Serve 模式不需要 node 入站规则（入站由 tailscaled 处理）；
- 收敛这些规则会影响其他 Agent/用户服务，**必须由用户批准并单独执行**；
- B11 仅记录，不删除、不修改。

## 8. 手机验收清单（T-1..T-10，待用户执行）

1. `tailscale status`：三端在线；
2. 隔离 9443 `/health` 证书有效；
3. 控制面 443 登录后 Cookie 为 `Secure; HttpOnly; SameSite=Strict`；
4. 手机提交一次写操作 200（若 403 记录 Host/Origin，不放宽 Origin）；
5. 预览 8443 未登录 401，登录后 200；
6. 未授权设备访问 443/8443 不可达；
7. 直连 `100.78.136.34:8787` 不可达；
8. 手机侧无明文 HTTP、无 Funnel 域名；
9. `serve status` 仅 443/8443；`funnel status` 空；
10. 预览内嵌外部资源被 CSP 阻断。

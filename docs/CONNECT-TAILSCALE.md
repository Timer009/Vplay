# Connect L2 · Tailscale 私有接入（准备稿）

> 原则：回环 Runtime + `tailscale serve` 私有 HTTPS；禁止 Funnel、端口映射、0.0.0.0。
> 在 C08 网络复验通过前，**不得**对 tailnet 发布真实 Runtime。

## 1. 当前状态（2026-11-27）

| 项                         | 值                                                        |
| -------------------------- | --------------------------------------------------------- |
| Tailscale 版本             | `1.104.7`（Windows 服务 Running/Automatic）               |
| 登录状态                   | **Logged out / NeedsLogin**（等待用户完成身份认证）       |
| MagicDNS 名称              | 登录后由 `tailscale status --json` 的 `Self.DNSName` 获取 |
| 8787/8788                  | 未监听（B06 实例已按 C07 要求停止）                       |
| Serve/Funnel/SSH/Exit Node | 均未启用                                                  |

## 2. 拓扑（方案 A）

```text
手机(Tailscale) --WireGuard--> Windows(100.x)
  tailscale serve --bg --https=443  http://127.0.0.1:8787   # 控制面
  tailscale serve --bg --https=8443 http://127.0.0.1:8788   # 预览面
```

- 控制面与预览面都只监听 `127.0.0.1`；由 tailscaled 终止 TLS。
- Host 白名单加入 MagicDNS 名称（不含端口），保留 `localhost/127.0.0.1`。
- **必须设置 `REMOTE_TRUST_PROXY=1`** 才接受 `X-Forwarded-Proto: https`；否则直连回环伪造该头无效。
- `X-Forwarded-For` 只记录，不用于鉴权。
- 预览鉴权：设置 `PREVIEW_ACCESS_KEY` 作为启用开关；登录后下发**短期、会话绑定、可吊销**的
  `vplay_preview` 票据（不再是静态哈希）。登出、`/auth/revoke-all`、设备吊销立即失效。
- Serve/代理模式（`VPLAY_PUBLIC_MODE=1` 或 `REMOTE_TRUST_PROXY=1`）下：
  - 强制 `publicMode`，yolo 永远不可开启；
  - 拒绝 `REMOTE_ALLOW_TEST_SEAM=1` 启动（即使 HOST 是回环）。

## 3. ACL（默认拒绝；只放行两台手机）

```json
{
  "tagOwners": {
    "tag:vplay-host": ["autogroup:admin"],
    "tag:phone-a": ["autogroup:admin"],
    "tag:phone-b": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["tag:phone-a", "tag:phone-b"],
      "dst": ["tag:vplay-host:443", "tag:vplay-host:8443"]
    }
  ]
}
```

- 开启 Device approval 与 key expiry；
- 禁止 Funnel / 子网路由 / Exit Node；
- 不删除其他 Agent 的防火墙规则。

## 4. 启用顺序（用户完成登录后）

```powershell
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
& $ts status
$ip = (& $ts ip -4).Trim()
$dns = ((& $ts status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
"ip=$ip dns=$dns"

# 1) 启动回环 Runtime（示例，token 不落盘）
$env:VPLAY_HOME='C:\vplay-connect\home'
$env:REMOTE_HOST='127.0.0.1'
$env:REMOTE_PORT='8787'
$env:PREVIEW_PORT='8788'
$env:REMOTE_ALLOWED_HOSTS="$dns,localhost,127.0.0.1"
$env:PREVIEW_ACCESS_KEY='<随机长串>'
$env:REMOTE_TRUST_PROXY='1'      # 仅 Tailscale Serve 回环代理；不得在直连场景开启
# 不要设置：VPLAY_PUBLIC_MODE、VPLAY_ALLOW_YOLO、REMOTE_ALLOW_TEST_SEAM、REMOTE_EXECUTOR_CMD
node remote/server.cjs

# 2) Serve（只映射回环）
& $ts serve --bg --https=443  http://127.0.0.1:8787
& $ts serve --bg --https=8443 http://127.0.0.1:8788
& $ts serve status
```

## 5. 复验清单（未通过前不发布）

1. `https://<dns>/health` 仅 tailnet 可达；非授权设备 ACL 拒绝；
2. Host 白名单（MagicDNS）200；伪 Host 400；
3. Cookie 带 `Secure; HttpOnly; SameSite=Strict`；
4. 预览未登录 401，登录后 200；跨站 GET 403；
5. 8787/8788 只监听 `127.0.0.1`（`Get-NetTCPConnection`）；
6. `tailscale serve status` 只有两条本地映射；无 Funnel；
7. 隔离空工程验证 SSE/任务/回退（无真实工程数据）。

> 未完成上述 7 项前，只能使用回环或隔离测试服务，不向 tailnet 发布。

## 6. B10 状态（2026-11-27）

- 用户已注册 Tailscale 账号，正在添加 Windows 与 iPhone 设备；**登录由用户本人完成**。
- 两台设备在线后，允许先用「无凭据、无工程数据」的隔离测试服务验证 HTTPS 与跨网络通信。
- 正式 Runtime 继续只监听回环；**待 Qoder 独立安全门禁通过后**才启用私有 Serve。
- 不启用 Funnel、Exit Node、子网路由，不开放公网端口。
- 复核要点：`tailscale serve status` 仅 443/8443；`tailscale funnel status` 为空；
  `Get-NetTCPConnection` 中 8787/8788 仅绑定 `127.0.0.1`。

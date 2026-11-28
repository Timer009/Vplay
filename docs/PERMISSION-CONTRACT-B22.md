# B22 权限契约：控制面 / 执行器 / 代理 / 证据服务

> 适用：`sprint-03-b22-safety`（基于 `sprint-03-b21-forced-restricted` @ `c159f40`）。
> 本文是产品层契约；3 UID / 3 systemd unit / bwrap / tailnet 由 Harness + RP03-B 落地。
> **同 UID 会直接击穿审批防伪**：Agent 若能读取控制面环境或 `tasks.json`，即可伪造审批。

## 1. 角色与信任边界

| 角色                    | 运行体                                                                      | 职责                                                     | 不得持有                                     |
| ----------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| 控制面（Control Plane） | `remote/server.cjs`（UID `vplay`）                                          | HTTP API、任务队列、审批签名、策略判定、证据写入 staging | 真实模型 Key                                 |
| 执行器（Executor）      | `remote/lib/worker.cjs` + `dist/cli.js`（**独立 UID `vplay-agent`**，建议） | 受限工具执行、Vision 浏览器                              | 审批 HMAC 密钥、真实模型 Key、`REMOTE_TOKEN` |
| 模型代理（Proxy）       | Harness 部署，UID `vplay-proxy`                                             | 唯一出网端，持有真实模型 Key                             | 审批密钥、证据密钥                           |
| 证据服务（Evidence）    | `remote/tools/seal-evidence.cjs` + oneshot/timer，UID `vplay-evidence`      | staging → sealed、外部锚点                               | 审批密钥                                     |

> 当前代码里 worker 与控制面同进程（`vplay`）。产品层已把“审批签名校验 + 消费”
> 放进 worker，但**真正的不可伪造性依赖 OS 分离**：Agent 进程（CLI/浏览器）必须是
> 不同 UID，且不可读控制面 env / tasks.json / 审批密钥文件。

## 2. 密钥与凭据

| 名称                      | 存放                          | 谁能读                  | 用途                   |
| ------------------------- | ----------------------------- | ----------------------- | ---------------------- |
| `REMOTE_TOKEN`            | 控制面 env（0600）            | 仅控制面                | 管理员 HTTP 鉴权       |
| `VPLAY_APPROVAL_HMAC_KEY` | 控制面 env（0600，≥32 字符）  | 仅控制面/worker 父进程  | 审批签名与验签         |
| `EVIDENCE_HMAC_KEY`       | 控制面 + evidence oneshot env | 控制面、evidence        | 证据 HMAC 与封条       |
| `VPLAY_MODEL_PROXY_TOKEN` | 控制面 env → 注入受限子进程   | 控制面、Agent（任务级） | 代理鉴权（非真实 Key） |
| 真实模型 Key              | proxy 服务 UID（0600）        | 仅 proxy                | 上游调用               |

- `buildChildEnv` 对受限任务剥离所有 `*_API_KEY` / `*_BASE_URL` / `*_MODEL`、
  `VPLAY_*`、`APPROVAL_*`、`EVIDENCE_*`，只注入 `OPENAI_BASE_URL=代理` 与
  `OPENAI_API_KEY=代理 token`。
- 受限任务的 `HOME` / `XDG_*`（Windows 的 `APPDATA`/`LOCALAPPDATA`）指向
  `<runtime>/restricted-home/<taskId>`，隔离用户级 `.qwen` 与凭据。
- 审批密钥只在 `approve` 时使用；proof 随任务持久化，但密钥不落盘、不进子进程。

## 3. 审批契约（防伪造）

审批 proof（`remote/lib/approval.cjs`）签名覆盖：

```text
taskId, projectId, kind, visionMode, allowedFiles, contentHash,
model, baseVersionId, codeChange{baseHash,diffSha256,files[]},
issuedAt, expiresAt, maxRuns, runs, nonce
```

- 控制面 `POST /tasks/:id/approve` 生成 signed proof；
- worker 在 spawn 前验签并消费一次（`runs+1` 后重新签名），失败即 `failed`；
- 篡改 `tasks.json` 任一字段（文本、范围、模型、基线、次数）→ 验签失败；
- 无 `VPLAY_APPROVAL_HMAC_KEY` 时受限部署拒绝启动；完整模式 approve 返回 500。

**同 UID 限制（必须由 Harness 消除）**：若 Agent 与 worker 同为 `vplay`，Agent 理论上
可读 `/proc/<pid>/environ` 或运行时目录，从而获得审批密钥并伪造 proof。RP03-B 必须：

1. Agent 使用独立 UID（如 `vplay-agent`），不能读控制面 env、`tasks.json`、`leases/`；
2. 控制面 runtime 目录 0700，Agent 只对项目目录有受控写权限（bwrap bind）；
3. 审批密钥文件 0600 且不与 Agent 共享挂载；
4. 证据 staging 可由 Agent/worker 写，sealed 仅 `vplay-evidence` 可写。

## 4. 执行器契约

- 仅接受 `status=queued` + 已验签审批的任务；
- 受限任务：`--core-tools` 只读五件套、`--exclude-tools`、`--allowed-mcp-server-names=`、
  `--extensions=none`、`--approval-mode default`；禁止 `--continue` / `--chat-recording`；
- 工作区存在 `.qwen` → 直接 `WORKSPACE_CONFIG_PRESENT`（不解析、不执行）；
- 模型端点必须是 loopback 代理；缺失/非 loopback → `MODEL_PROXY_REQUIRED` /
  `MODEL_PROXY_INVALID`；
- 取消/超时：worker 读 lease 的 `childPid`，按进程组杀 CLI 树；runner 自身也做
  SIGTERM→SIGKILL 与父进程消失看门狗。

## 5. 代理契约

见 `docs/RESTRICTED-DEPLOYMENT-B21.md` §6。补充权限要求：

- 仅 `vplay-proxy` UID 可读真实 Key；
- 仅监听 `127.0.0.1:<port>`，`IPAddressDeny=any` + `Allow 127.0.0.1`（systemd）；
- 任务级 token 由 proxy 校验/限额；Agent 不得访问代理配置或密钥文件；
- 代理不得透传任意 Host，避免 Agent 借代理访问内网。

## 6. 证据契约

- staging：`<VPLAY_HOME>/evidence-staging/<project>/<task>/`（worker 可写）；
- sealed：`<VPLAY_HOME>/evidence/<project>/<task>/`（`vplay-evidence` 拥有，Agent 不可写）；
- `seal-evidence.cjs` 生成全量清单 + HMAC 封条 + 外部锚点；
- 运行时校验：`GET /tasks/:id/evidence/verify`（admin，requireHmac=true）；
- 离线校验：`verifyEvidence` / `verifySeal` 在无密钥时必须失败。

## 7. Harness 协调清单

| 项       | 要求                                                                            |
| -------- | ------------------------------------------------------------------------------- |
| UID      | `vplay` / `vplay-agent` / `vplay-proxy` / `vplay-evidence` 分离                 |
| unit     | server、agent-worker（或 server 内 worker 但 Agent 降权）、proxy、evidence-seal |
| 文件权限 | runtime 0700；密钥 0600；sealed 0700 归 evidence                                |
| bwrap    | 项目 ro/rw bind；隐藏宿主 `$HOME/.qwen`、`.gitconfig`、密钥目录                 |
| 网络     | 控制面 loopback；唯一出网 = 代理；禁 DNS/直连                                   |
| 验收     | 跨 UID 读 env/tasks.json/密钥必须失败；伪造 approval 必须验签失败               |

## 8. 未完成与阻断

- OS 级 UID/unit/bwrap：**未实现**（RP03-B），当前同 UID 仍可能击穿审批防伪；
- 真实代理与任务级凭据：由 Harness 部署；
- Pi memory cgroup：BLOCKED（RP02 DTB），本契约不声称资源隔离成立。

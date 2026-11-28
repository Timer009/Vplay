# B23 P0：控制面 / 执行器分离与 IPC 契约

> 适用：`sprint-03-b23-ipc`（基于 `311f014` 安全基线）。
> 目标态：五 UID（vplay-control / vplay-agent / vplay-relay / vplay-proxy / vplay-evidence）。
> 本文件是产品侧契约；3/5 UID 与 unit 由 Harness + RP03-B 落地。

## 1. 角色分离

| 角色   | UID              | 运行体                          | 职责                                                          |
| ------ | ---------------- | ------------------------------- | ------------------------------------------------------------- |
| 控制面 | `vplay-control`  | `remote/server.cjs`             | HTTP、审批签名/验签、任务状态、可信调度、快照/发布            |
| 执行器 | `vplay-agent`    | `remote/agent/agent-daemon.cjs` | 受限 CLI、受控构建、浏览器任务；写 workspace/evidence-staging |
| 代理   | `vplay-proxy`    | Harness                         | 唯一出网，持真实 Key                                          |
| Relay  | `vplay-relay`    | Harness                         | agent netns 内 loopback → 代理 UDS                            |
| 证据   | `vplay-evidence` | `seal-evidence.cjs`             | staging → sealed + 外部锚点                                   |

控制面**不再 spawn CLI**：`VPLAY_AGENT_SOCKET` 设置后，worker 只走 IPC；
`REMOTE_EXECUTOR_CMD` / `REMOTE_ALLOW_TEST_SEAM` 与 IPC 同时出现会拒绝启动。

## 2. 传输与身份

| 项           | 值                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Linux socket | `/run/vplay/agent.sock`                                                                                                      |
| 目录         | `/run/vplay` `vplay-agent:vplay-control` `0750`                                                                              |
| socket       | `0660 vplay-agent:vplay-control`（`chmod` 由 daemon 设置）                                                                   |
| Windows 测试 | 命名管道 `\\.\pipe\vplay-b23-*`（无文件权限语义）                                                                            |
| 对端身份     | socket 权限（内核）+ 独立 `VPLAY_IPC_HMAC_KEY`（≥32）+ 时间窗 + nonce/runId 防重放                                           |
| SO_PEERCRED  | Node 核心不暴露；由 Harness native shim 或 systemd `SocketMode` 保证。当前用 FS 权限 + HMAC，报告不得宣称 SO_PEERCRED 已实现 |

`VPLAY_IPC_HMAC_KEY` **必须不同于** `VPLAY_APPROVAL_HMAC_KEY` / `EVIDENCE_HMAC_KEY`。

## 3. 协议（一行一个 JSON，UTF-8）

所有消息：`{ v:1, type, nonce(hex16+), ts(ms), hmac }`，`hmac = HMAC-SHA256(key, canonicalJson(不含 hmac))`。
时间偏差 >60s、nonce 重放、HMAC 不符 → 错误并断开。

### 3.1 握手

```json
{"v":1,"type":"hello","role":"control","clientPid":123,"nonce":"…","ts":…,"hmac":"…"}
{"v":1,"type":"ready","agentVersion":"b23-1","pid":456,"platform":"linux","allowedRoot":"/srv/vplay-lab","capabilities":["restricted-cli","cancel","deadline"],"nonce":"…","ts":…,"hmac":"…"}
```

### 3.2 运行（控制面 → agent）

```json
{
  "v":1,"type":"run",
  "runId":"run_xxx","taskId":"task_xxx",
  "prompt":"…","restricted":true,
  "cwd":"/srv/vplay-lab/workspace/…",
  "deadlineMs":600000,
  "env":{"PATH":"…","HOME":"…","OPENAI_BASE_URL":"http://127.0.0.1:18790/v1","OPENAI_API_KEY":"vplay-proxy-placeholder","OPENAI_MODEL":"…"},
  "model":"qwen3-coder-plus",
  "approvalDigest":"<sha256(approval.proof)>",
  "payloadHash":"<sha256(taskId\\nrunId\\nprompt)>",
  "nonce":"…","ts":…,"hmac":"…"
}
```

- `restricted` 必须为 `true`；否则 `RESTRICTED_REQUIRED`。
- `cwd` 必须是 `--allowed-root` 内绝对路径；`payloadHash` 必须匹配。
- `env` 只允许白名单键；`APPROVAL_/EVIDENCE_/REMOTE_/VPLAY_` 前缀直接拒绝；
  `OPENAI_BASE_URL` 必须是 loopback。
- 同一 `runId` 一生只能执行一次（`RUN_REPLAYED`）；同一 `taskId` 只能绑定一个 run
  （`TASK_REBOUND`）；agent 同时只执行一个 run（`AGENT_BUSY`）。

### 3.3 流式回传（agent → 控制面）

```json
{"type":"started","runId":"…","pid":456,"startedAt":"…","approvalDigest":"…"}
{"type":"stdout","runId":"…","data":"…"}
{"type":"stderr","runId":"…","data":"…"}
{"type":"exit","runId":"…","code":0,"signal":null}
{"type":"done","runId":"…","taskId":"…","exitCode":0,"signal":null,"startedAt":"…","endedAt":"…","spawnPid":456,"cancelled":false,"timedOut":false}
```

错误：`{"type":"error","runId":"…","code":"RUN_TIMEOUT|RUN_CANCELLED|IPC_ENV_FORBIDDEN|…","message":"…"}`。
输出上限 2 MB，超出丢弃并提示。

### 3.4 取消

```json
{"v":1,"type":"cancel","runId":"…","nonce":"…","ts":…,"hmac":"…"}
```

找不到 / 不匹配 → `RUN_NOT_FOUND`。连接断开同样触发 agent 杀 CLI 树。

## 4. 失败与超时

| 情况               | 行为                                                         |
| ------------------ | ------------------------------------------------------------ |
| connect/hello 超时 | 控制面任务 `AGENT_IPC_FAILED`，不 spawn                      |
| deadline           | agent 先 SIGTERM 组，2s 后 SIGKILL；`RUN_TIMEOUT`            |
| 控制面取消/停止    | `RUN_CANCELLED`，agent 杀树                                  |
| 控制面断开         | agent 杀树并退出 run                                         |
| 重放/篡改          | `RUN_REPLAYED` / `IPC_HMAC_INVALID` / `IPC_PAYLOAD_MISMATCH` |
| agent 不可达       | server 启动即拒绝（fail-closed）                             |

## 5. 可信写入 / 快照 / 发布 / 回滚的 UID

| 操作                         | UID                          | 说明                                                            |
| ---------------------------- | ---------------------------- | --------------------------------------------------------------- |
| Agent 文件写入（CLI/Vision） | `vplay-agent`                | 唯一写 workspace                                                |
| 任务状态 / 审批 / 事件       | `vplay-control`              | `state/` 0700                                                   |
| 快照                         | `vplay-control`              | 只读 workspace，写 `state/snapshots`                            |
| 发布（preview build）        | `vplay-control`              | 只读 workspace，写 `state/preview`                              |
| 回滚（写 workspace）         | `vplay-control` **临时例外** | 建议改为 root oneshot `vplay-rollback@.service`；B23 声明该例外 |
| 证据统计/封存                | `vplay-evidence`             | staging 只读，sealed 0700                                       |

> 控制面无 workspace 写权限时，回滚必须走独立 root oneshot；在落地前报告必须写
> `ROLLBACK_UID=control (temporary exception)`，不得声称完全分离。

## 6. 环境变量

| 变量                             | 归属              | 说明                                    |
| -------------------------------- | ----------------- | --------------------------------------- |
| `VPLAY_AGENT_SOCKET`             | control/agent     | `/run/vplay/agent.sock`；设置即启用 IPC |
| `VPLAY_IPC_HMAC_KEY`             | control/agent     | ≥32，独立于审批/证据密钥                |
| `VPLAY_AGENT_VERSION`            | agent             | 回显版本                                |
| `VPLAY_AGENT_CONNECT_TIMEOUT_MS` | control           | 默认 5000                               |
| `VPLAY_APPROVAL_HMAC_KEY`        | **仅 control**    | 绝不进入 agent/CLI                      |
| `VPLAY_MODEL_PROXY_URL/TOKEN`    | control → run env | agent 只见任务级占位                    |

## 7. Harness 交付物

```text
OpenGame/remote/agent/agent-daemon.cjs          # agent 入口
OpenGame/remote/tools/agent-probe.cjs           # 控制面健康探测
OpenGame/remote/tools/linux/units/vplay-agent.service
OpenGame/remote/tools/linux/units/vplay-control.service
OpenGame/remote/tools/linux/b23-ipc-acceptance.sh
OpenGame/remote/tools/linux/vplay.env.example
```

部署要求：

1. `vplay-agent` 与 `vplay-control` 不同 UID；agent 不能读 `state/`、`vplay.env`、
   审批密钥；control 不能读 proxy key / sealed。
2. `/run/vplay` 与 socket 权限按 §2；`systemctl show -p User` 校验。
3. 五 UID + relay/proxy/seal 按 RP03-B `01-SUDO-OPERATIONS.md` 执行（需授权）。
4. 验收：`b23-ipc-acceptance.sh`（root 时含跨 UID 负对照）。

## 8. 测试证据（Windows 定点）

`node --test remote/test/b23-ipc.test.cjs`：6/6

- 正常受限运行；agent 环境无审批/IPC/证据/控制面密钥；
- 错误 IPC key 拒绝；
- 非 restricted、环境注入（非 loopback）、runId 重放拒绝；
- deadline 杀 CLI 树；cancel 停止；
- server + worker 经 IPC 执行受限任务，日志/结果/pid 正确。

## 9. 未完成 / 阻断

- 真实五 UID、systemd、bwrap、netns：**未在 Pi 执行**（禁止修改 Pi）；仅 unit/脚本/契约。
- SO_PEERCRED：Node 核心不支持，当前以 FS 权限 + HMAC 代替；需 native shim 才可宣称。
- 回滚写 workspace 仍属 control 临时例外。
- Vision 0.2.3：等待 E16-HASH 权威确认，未集成。

## 10. B23-FINAL 加固（已实现）

### 10.1 防重放跨重启

- agent 新增 `--state-dir`（必填，agent 专属 0700），持久化
  `<state-dir>/replay-state.json`（0600）：
  `{runs:{runId:ts}, taskRuns:{taskId:runId}, nonces:{nonce:ts}}`。
- 启动装载并清洗：runId 默认保留 7 天（`VPLAY_AGENT_REPLAY_TTL_MS`），
  nonce 保留 10 分钟；每次 run / 每条消息原子落盘。
- 重启后同一 `runId` 仍 `RUN_REPLAYED`；跨连接 nonce 重放 `IPC_NONCE_REPLAYED`。

### 10.2 socket 目录与权限

- agent 启动检查 socket 目录不是 symlink 且无 world 权限（`mode & 0o007 == 0`）。
- listen 后 `chmod 0660` 并复核，失败即退出。
- 控制面仍以 `probeAgent` 启动探测；不可达拒绝启动。

### 10.3 路径穿越

- `cwd` 先 `path.resolve` 再 `realpathSync`，必须落在 `--allowed-root` 的 realpath 内；
  junction/symlink 指向外部 → `IPC_CWD_ESCAPE`。
- 帧缓冲 >1 MB 直接失败（`IPC_MESSAGE_TOO_LARGE`）；单帧上限 512 KB。

### 10.4 回滚写入权限

- 分离模式（`VPLAY_AGENT_SOCKET`）下 `POST /projects/:id/rollback` 返回
  `409 ROLLBACK_OPERATOR_REQUIRED`；control/agent 都不长期持有 workspace 写权限。
- 回滚由 root oneshot `vplay-rollback@<project>.service` 执行
  `remote/tools/rollback-operator.cjs`，需要 `VPLAY_ROLLBACK_OPERATOR=1` 与
  `/srv/vplay-lab/state/rollback-request-<project>.json`（operator 创建）。
- 该操作是一次性、显式授权，不改变 server/agent 的长期 unit 权限。

### 10.5 code_change 与隔离浏览器

- 分离模式下 `POST /projects/:id/code-change` 返回
  `409 CODE_CHANGE_REQUIRES_AGENT_APPLY`：在 agent 提供受审批的 apply 操作前，
  不允许 control 直接写 workspace。
- 浏览器验证必须在隔离环境（agent netns/UID + `chromiumSandbox:true`）执行；
  当前受限部署的 code_change 浏览器门禁代码在 control 路径，**分离模式不启用**。
- 真实模型 change-set 仍由 Harness 代理产生并调用管理员 API；产品不直接调用模型。

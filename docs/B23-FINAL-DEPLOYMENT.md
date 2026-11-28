# B23-FINAL 可部署候选与 Harness 部署说明

> 唯一最终候选：`sprint-03-b23-final`。
> 基线：`ce30c65`（含 IPC `39e513b` 全部安全改动）+ Vision 0.2.3（`415cae0e…`，E16-B23-HANDOFF）。
> 本候选只做集成与收敛，不扩展功能。

## 1. 候选身份

| 项             | 值                                                                 |
| -------------- | ------------------------------------------------------------------ |
| 分支           | `sprint-03-b23-final`                                              |
| 提交           | 见报告（`git rev-parse HEAD`）                                     |
| Vision tgz     | `415cae0ec26687f2c2804a4f0954ce9ac0affd581aa33c9a8efca2903d17d91d` |
| Vision source  | `ad49563c768d8de254d5e08c808639df3675d983a0be47b4df5443c386cd5a44` |
| 0.2.2 冻结 tgz | `c7679c02…`（未变）                                                |

## 2. 部署清单（Harness）

### 2.1 账户 / 目录 / 权限

| 路径                              | 属主:组                         | 模式 | 说明                                 |
| --------------------------------- | ------------------------------- | ---- | ------------------------------------ |
| `/srv/vplay-lab/state`            | `vplay-control:vplay-control`   | 0700 | 任务/审批/事件/快照/预览             |
| `/srv/vplay-lab/workspace`        | `vplay-agent:vplay-agent`       | 0700 | Agent 项目写面                       |
| `/srv/vplay-lab/home`             | `vplay-agent:vplay-agent`       | 0700 | 项目 registry                        |
| `/srv/vplay-lab/agent-state`      | `vplay-agent:vplay-agent`       | 0700 | 防重放状态（replay-state.json 0600） |
| `/run/vplay`                      | `vplay-agent:vplay-control`     | 0750 | agent.sock 目录（非 symlink）        |
| `/run/vplay/agent.sock`           | `vplay-agent:vplay-control`     | 0660 | 受限 IPC                             |
| `/srv/vplay-lab/evidence-staging` | `vplay-agent:vplay-handoff`     | 0750 | Agent 写、evidence 只读              |
| `/srv/vplay-lab/evidence`         | `vplay-evidence:vplay-evidence` | 0700 | sealed                               |
| `/srv/vplay-lab/proxy`            | `vplay-proxy:vplay-proxy`       | 0700 | key 0600                             |

### 2.2 systemd

| 单元                      | User            | 关键点                                                                    |
| ------------------------- | --------------- | ------------------------------------------------------------------------- |
| `vplay-control.service`   | `vplay-control` | 只写 `state/`；loopback；读 repo/workspace                                |
| `vplay-agent.service`     | `vplay-agent`   | `RuntimeDirectory=vplay` 0750；`--state-dir agent-state`；netns + sandbox |
| `vplay-rollback@.service` | root oneshot    | 仅显式 operator 请求时回滚；不常驻                                        |
| `vplay-relay/proxy/seal`  | RP03-B          | 按既有清单                                                                |

### 2.3 环境变量

```text
VPLAY_RESTRICTED_DEPLOYMENT=1
VPLAY_APPROVAL_HMAC_KEY=<>=32，仅 control>
VPLAY_AGENT_SOCKET=/run/vplay/agent.sock
VPLAY_IPC_HMAC_KEY=<>=32，control+agent，独立于审批/证据密钥>
VPLAY_AGENT_CONNECT_TIMEOUT_MS=5000
VPLAY_AGENT_REPLAY_TTL_MS=604800000
VPLAY_MODEL_PROXY_URL=http://127.0.0.1:18790/v1
VPLAY_MODEL_PROXY_TOKEN=<proxy scoped>
VPLAY_VISION_VERSION=0.2.3
VPLAY_BROWSER_EXECUTABLE=/usr/bin/chromium
VPLAY_BROWSER_ARGS=--disable-dev-shm-usage --disable-gpu --renderer-process-limit=2
EVIDENCE_HMAC_KEY=<>=32>
```

### 2.4 启动顺序

1. `vplay-relay` / `vplay-proxy`（dummy 上游）
2. `vplay-agent`（创建 socket 0660 / state-dir）
3. `vplay-control`（启动 probe agent；失败即拒绝启动）
4. `vplay-seal`（oneshot）与 `vplay-rollback@`（按需）

## 3. 关键契约

- 控制面/执行器：只经 socket + HMAC；Agent 无审批/证据/REMOTE 密钥；
- 审批：HMAC proof 绑定 task/project/content/model/base/expiry/runs；
- 防重放：runId/nonce 持久化，重启后仍拒绝；
- 路径：`cwd` realpath 必须在 allowed-root；junction 穿越拒绝；
- 取消/超时：SIGTERM→SIGKILL，按进程组清理；
- 回滚：control/agent 无长期 workspace 写权限，root oneshot 执行；
- code_change：分离模式关闭（`CODE_CHANGE_REQUIRES_AGENT_APPLY`），等待 agent apply 操作；
  浏览器验证必须在隔离环境；
- Vision：默认 0.2.3，tgz 哈希不匹配失败关闭；0.2.2 冻结保留。

## 4. 验收

```bash
bash remote/tools/linux/run-linux-smoke.sh
sudo bash remote/tools/linux/b23-ipc-acceptance.sh
```

验收应覆盖：socket 权限/所有者、目录 0750、agent-state 0700/0600、control probe、
跨 UID 不可读 state/审批密钥/proxy key、不可写 sealed、回滚单元存在。

## 5. 未通过门禁（不得写 PASS）

| 门禁                                                      | 状态                          |
| --------------------------------------------------------- | ----------------------------- |
| Pi Chromium 156 + Vision 0.2.3 实际启动/argv/sandbox/截图 | NOT_RUN（E17 阶段 B）         |
| 预览鉴权/跨源/strict/回滚的 Pi 集成                       | NOT_RUN（阶段 C）             |
| 五 UID/bwrap/netns 实机                                   | NOT_RUN（Harness）            |
| code_change 隔离浏览器/agent apply                        | 未实现（分离模式关闭）        |
| SO_PEERCRED                                               | 未实现（FS 权限 + HMAC 代替） |

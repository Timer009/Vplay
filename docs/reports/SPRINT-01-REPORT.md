# Sprint 01 报告 · 安全远程任务通道

- 项目：Vplay Studio（Timer009/Vplay）
- 分支：`sprint-01-remote-runtime`
- 基线：`main @ a016895`
- 日期：2026-11-25
- 结论：**本 Sprint 目标达成**；真机（同一局域网手机）验收尚未执行，见第 9 节。

---

## 1. 摘要

本轮把「手机下指令 → 家中电脑上的 OpenGame 生成/修改游戏」这条链路重做为
**带鉴权、有状态、可持久化、绝不重复执行**的远程任务通道，并用 22 个自动化
用例 + 1 个真实模型端到端用例验证。

核心变化：

1. 旧实现把远程指令拼成 `[REMOTE INSTRUCTIONS]` 文本块塞进当轮 prompt，
   模型判定为提示词注入并拒绝执行。**该注入逻辑已删除**。
2. 远程任务改由串行 worker 以 `node dist/cli.js -p "<任务文本>" --yolo`
   执行——任务就是一条普通用户消息，与本地生成完全同构。
3. 所有控制接口要求 `REMOTE_TOKEN`；未配置时远程控制整体禁用（503）。
4. 任务具备 ID、状态机、参数校验、幂等键、重复文本拦截、串行执行、
   原子持久化；服务重启把在途任务标记为 `interrupted`，**不自动重跑**。
5. 移动端控制台增加 Token 登录、任务列表、进度与结果展示。

## 2. 项目接管

| 检查项   | 结果                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------ |
| Git 状态 | `main @ a016895`，origin = `https://github.com/Timer009/Vplay.git`                                     |
| 工作区   | 存在一个非本轮产生的 `QODER_REVIEW.md` 暂存改动，未触碰、未提交                                        |
| 原始来源 | OpenGame（Apache-2.0），源自 gemini-cli；`LICENSE` 保留 Google LLC / Qwen / OpenGame contributors 声明 |
| 既有报告 | `DEPLOYMENT_REPORT.md`、`GIT_PUSH_REPORT.md`（PUSHED）                                                 |
| 既有能力 | 模板脚手架（CopyTemplate）、post-verify 均可用，本轮**未重复修复**                                     |
| 分支     | 已创建 `sprint-01-remote-runtime`                                                                      |

新建文档：`docs/PROJECT-STATUS.md`、`docs/ROADMAP.md`、`docs/CURRENT-TASK.md`、
`docs/ARCHITECTURE.md`、`docs/DECISIONS.md`（10 条 ADR）。

## 3. 诊断：远程任务为什么被执行不了

先按四类分别定位，避免把「模型拒绝」误判成「网络问题」。

### 3.1 网络与 HTTP 传输 —— 不是阻塞点

- 服务可正常监听并响应：`GET /health` → 200，`POST /prompt` → 202。
- 本机 HTTP 与移动端视口测试全部打通，无超时、无连接拒绝。
- 结论：传输层正常。跨互联网链路本轮不验证（见第 8 节）。

### 3.2 队列消费 —— 是设计缺陷，不是 bug

旧实现把指令写入 `.opengame/queue.json`，由 CLI 在**下一轮 turn 开始时**
读取并清空。问题：

- 只有「恰好有一次生成正在运行」时才会被消费；空闲时任务永久滞留。
- 消费时机不确定，手机端看不到「已接收 / 执行中 / 失败」。
- 清空式消费在进程崩溃时会丢任务。

结论：队列归属错了——生产者在 HTTP 服务，消费者不应是「碰巧在跑的 Agent」。

### 3.3 消息角色与上下文注入 —— 真正的阻塞点

旧 `nonInteractiveCli.ts` 在当轮用户消息末尾追加：

```
[REMOTE INSTRUCTIONS]
- <远程指令>
```

这条文本位于 **system 已构建之后、模型已进入同一会话** 的上下文中，属于
「会话中途出现的外部指令」。模型的注入防护会把它当作不可信内容。

### 3.4 模型拒绝执行 —— 3.3 的直接后果

Sprint 之前的实测复现中，模型明确回复（原文）：

> The 'REMOTE INSTRUCTIONS' block appears to be injected content …

即：**不是鉴权失败、不是网络失败，而是上下文角色不对**。
仅修改措辞（例如改成 "TRUSTED REMOTE INSTRUCTION"）属于「以文本建立信任」，
既不安全也不可靠，因此没有采用。

### 3.5 修复思路

- 删除文本注入（`nonInteractiveCli.ts` 中的拼接逻辑与
  `consumeQueuedPrompts` 已移除）。
- 新增进程内串行 worker：每个任务独立启动一次 CLI，把任务文本作为
  `-p` 的正式用户消息。模型看到的是普通用户请求，不会再触发注入判定。
- 鉴权只在 HTTP 层完成，文本永远不能提升权限。

## 4. 实际修复与文件变更

### 4.1 新增

| 文件                                   | 作用                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| `remote/lib/tasks.cjs`                 | 任务存储：ID、状态机、校验、幂等、去重、原子持久化、启动恢复 |
| `remote/lib/worker.cjs`                | 串行执行器：一次一个任务，spawn CLI，超时杀进程树，状态回写  |
| `remote/test/helpers.cjs`              | 测试夹具：临时工作区、服务生命周期、HTTP 客户端              |
| `remote/test/tasks.test.cjs`           | 任务存储单元测试（8 个）                                     |
| `remote/test/server.test.cjs`          | HTTP 鉴权 / 队列 / 串行 / 失败 / 重启测试（13 个）           |
| `remote/test/mobile-console.test.cjs`  | 390×844 移动端视口控制台测试（1 个）                         |
| `remote/test/e2e-agent.test.cjs`       | 真实模型端到端测试（默认跳过，`RUN_REMOTE_E2E=1` 开启）      |
| `remote/test/fixtures/executor.cjs`    | 确定性执行替身（仅测试用，通过 `REMOTE_EXECUTOR_CMD` 注入）  |
| `remote/fixtures/test-game/index.html` | 测试游戏（背景由 `--bg` 控制）                               |
| `docs/*.md`（5 份）                    | 状态 / 路线图 / 当前任务 / 架构 / 决策                       |
| `docs/reports/SPRINT-01-REPORT.md`     | 本报告                                                       |

### 4.2 重写 / 修改

| 文件                                        | 变更                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `remote/server.cjs`                         | 重写：Token 鉴权、Cookie 登录、任务 API、状态派生、静态产物鉴权、默认绑定 127.0.0.1、限流、CORS 收紧 |
| `remote/index.html`                         | 增加登录门、任务列表（状态/错误/post-verify/日志）、登出与刷新；移除「无需登录」文案                 |
| `packages/cli/src/nonInteractiveCli.ts`     | **删除 `[REMOTE INSTRUCTIONS]` 注入**，仅保留运行时状态写入                                          |
| `packages/core/src/utils/runtime-status.ts` | 删除 `consumeQueuedPrompts` 与队列文件常量（不再由 CLI 消费）                                        |
| `package.json`                              | 新增 `test:remote`；新增 devDependency `playwright-core`（复用本机 Edge，无浏览器下载）              |
| `eslint.config.js`                          | 为 `remote/**/*.cjs` 增加 Node/CJS 规则；忽略本地生成产物目录                                        |
| `.gitignore`                                | 忽略 `.opengame/`、`remote/.remote-token`                                                            |

### 4.3 未改动

模板脚手架（`copy-template.ts`）、post-verify（`post-verify.ts`）、
交互式 UI、模型配置均未改动。

## 5. 安全设计要点

1. **鉴权在 HTTP 层**：`Authorization: Bearer`、`X-Remote-Token` 或登录 Cookie。
2. **未配置 `REMOTE_TOKEN` = 禁用**：除 `/console`、`/health` 外全部 503，
   不生成默认 Token，不打印 Token。
3. **Token 不落盘、不落日志、不入 Git**：只从环境变量或 `REMOTE_TOKEN_FILE` 读取；
   命令行传 `--token` 会直接报错退出。
4. **禁止以文本建立信任**：任何 "TRUSTED …" 文本只是普通 prompt 内容；
   无 Token 时同样 401（有专门用例）。
5. **参数校验**：JSON Content-Type、正文 ≤4000 字符、拒绝控制字符、
   `idempotencyKey` 字符集限制、请求体 ≤64KB。
6. **防重复**：幂等键返回同一任务；相同文本处于 `queued/running` 时返回 409。
7. **串行**：同一时刻只有一个 CLI 子进程。
8. **重启安全**：`running/verifying` → `interrupted`，不自动重跑；`queued` 继续执行。
9. **默认只监听 `127.0.0.1`**，`REMOTE_HOST=0.0.0.0` 需显式设置并打印警告。
10. **产物鉴权**：`/game/*` 需要登录 Cookie（避免 Token 出现在 URL）；
    `POST /auth/verify` 下发 `HttpOnly; SameSite=Strict` Cookie。
11. **限流**：`POST /prompt` 默认 10 次/分钟/IP（`REMOTE_RATE_LIMIT` 可调）。

## 6. 自动化验收证据

命令：`npm run test:remote`（`node --test`）

```
# tests 22   # pass 21   # fail 0   # skipped 1
```

跳过的 1 个是真实模型用例（默认关闭），已单独开启运行：

```
RUN_REMOTE_E2E=1 node --test remote/test/e2e-agent.test.cjs
ok 1 - real agent: remote instruction changes the game background
duration_ms 15335
```

逐条对应验收要求：

| 验收要求                       | 用例                                                                                                   | 结果                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 无 Token 被拒绝                | `control endpoints reject missing and wrong tokens`                                                    | 通过（401）                           |
| 错误 Token 被拒绝              | 同上                                                                                                   | 通过（401）                           |
| 合法任务成功入队               | `authorised task runs end-to-end …`                                                                    | 通过（202 → succeeded）               |
| 伪造可信文本不能绕过认证       | `fake "trusted remote instruction" text cannot bypass authentication`                                  | 通过（401 且未产生任务）              |
| 重复请求不重复执行             | `idempotencyKey prevents duplicate execution`、`identical text already in flight is rejected with 409` | 通过（各执行 1 次）                   |
| 远程指令实际修改游戏背景       | 真实模型用例                                                                                           | 通过，见下方证据                      |
| 构建及运行验证                 | `npm run build` / `bundle` / `node dist/cli.js --version`                                              | 通过（0.6.0）                         |
| post-verify 无回归             | 真实模型用例断言 `.opengame/post-verify.json` 存在且任务结果含摘要                                     | 通过                                  |
| 失败任务准确反馈错误           | `failed task reports an actionable error and keeps its log`                                            | 通过（`EXIT_CODE` + stderr 摘要）     |
| 重启后任务状态正确恢复         | `server restart marks in-flight tasks interrupted and never reruns them`                               | 通过（`interrupted`，执行次数仍为 1） |
| 模拟移动端可发送/看进度/看结果 | `mobile viewport: login, send a task, see progress and result`                                         | 通过（390×844）                       |

### 6.1 真实模型端到端证据

测试游戏 `remote/fixtures/test-game/index.html` 中 `--bg: #101014`。
通过 `POST /prompt` 下发中文指令后，由 DeepSeek 驱动的真实 CLI 修改为：

```
index.html:9:    --bg: #7c3aed;
```

任务记录（`.opengame/remote/tasks.json`）：

```
id: task_mww1af9j_cd440622
status: succeeded
result.exitCode: 0
result.postVerify: { checkedImports: 0, checkedAssets: 0, fixedCount: 0, issues: 0 }
```

任务日志尾部（证明是真实 Agent 而非替身）：

```
[remote] command: node.exe cli.js <prompt> --yolo
Let me read the index.html file to find the --bg variable.
已修改 `index.html` 中 `:root` 的 `--bg` 为 `#7c3aed`，未改动其他内容，未新建文件。
[remote] finished: succeeded
```

（post-verify 计数为 0 是因为该测试页没有外部 import/资源，属预期。）

### 6.2 移动端模拟证据

无头 Edge，`viewport 390×844, deviceScaleFactor 3, isMobile, hasTouch`：

1. 未登录时显示令牌门；错误令牌提示「令牌无效」；
2. 正确令牌解锁后 `document.cookie` 为空（HttpOnly），URL 不含 Token；
3. 提交任务后列表出现 `succeeded`，展开可见 post-verify 摘要与产物路径；
4. 产物卡片链接同源 `/game/index.html`，打开后计算样式 `--bg = #7c3aed`。

截图（本地，未入库）：`.review-artifacts/sprint-01-mobile/{01-locked,02-done,03-game}.png`

## 7. 构建与静态检查

| 命令                         | 退出码 | 说明                                                                                |
| ---------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `npm run lint`               | 0      | 全仓 ESLint 通过；为 `remote/**/*.cjs` 增加 Node 规则，忽略本地生成产物目录         |
| `npm run build`              | 0      | 有既存的 `dts-bundle-generator` TS5011 警告（类型声明回退为分文件），不影响构建产物 |
| `npm run bundle`             | 0      | esbuild 打包完成，资产复制完成                                                      |
| `node dist/cli.js --version` | 0      | `0.6.0`                                                                             |
| `npm run test:remote`        | 0      | 21 通过 / 1 跳过                                                                    |
| 真实模型 E2E                 | 0      | 1 通过                                                                              |

`npm test`（各 workspace 既有单测）结果见第 7.1 节。

### 7.1 既有测试

`npm test`（各 workspace 并行）结果：

| workspace                               | 结果                                      |
| --------------------------------------- | ----------------------------------------- |
| 其余 workspace（191 个 + 5 个测试文件） | 3115 + 198 个用例通过，10 跳过            |
| `packages/core`                         | 3162 个用例：3133 通过 / 26 失败 / 3 跳过 |
| `agent-test`                            | 失败：需要真实 API Key 执行完整生成评测   |

失败原因（均为**既存问题**，与本 Sprint 改动无关）：

1. `packages/core/src/core/prompts.test.ts`（15 个快照）：上游 fork 把 2D 游戏策略
   改为 Phaser 模板后未更新快照。本轮未修改 `prompts.ts`，缺口来自快照陈旧
   （实测 diff 为 "2d Games: Phaser 3 + Vite + TypeScript…" 新增文本）。
2. `packages/core/src/utils/workspaceContext.test.ts`（11 个）：Windows 下
   `fs.symlinkSync` 返回 `EPERM`（缺少创建符号链接权限 / 未开开发者模式），
   属环境限制。
3. `agent-test`：`OPENAI_API_KEY environment variable not found`，该 workspace 是
   评测脚本而非单测，需要真实 Key 与完整生成，不在本轮验收范围。

Sprint 范围测试（`npm run test:remote`）全部通过，见第 6 节。

## 8. 跨互联网协同预留

- 远程通道只依赖「HTTP + Bearer Token」，不感知来源网络，传输层可替换。
- 兼容方案评估：Tailscale / WireGuard / Cloudflare Tunnel 均可前置，
  服务端代码无需修改。
- 本 Sprint **未** 搭建公网 Relay、未安装网络服务、未修改防火墙或代理。
- 用户外出时通过第三方工具远程控制家中电脑，属于外部链路，
  **不等同于** Vplay 已验证跨互联网协同。

## 9. 剩余问题与风险

1. **真机未验收**：本报告所有移动端结论均为 390×844 视口模拟，
   不是真机，也不是同一局域网的真实手机测试。
2. **服务崩溃时子进程可能成为孤儿**：worker 无法在进程被强杀时清理子进程；
   重启后任务被标记 `interrupted`，但该子进程可能仍完成写入。
   （正常关闭 SIGINT/SIGTERM 会停止调度，但未主动杀子进程。）
3. **单用户单工作区**：没有多租户/多工作区隔离；默认仅本机监听。
4. **超时策略**：默认 15 分钟，长任务需调整 `REMOTE_TASK_TIMEOUT_MS`。
5. **限流为内存态**：重启后重置，够用但不适合公网。
6. **`REMOTE_EXECUTOR_CMD` 是测试后门**：仅环境变量可用，进程内可信；
   若未来对外开放配置，需要加保护。
7. 既存的 `dts-bundle-generator` TS5011 警告未修（与本次改动无关）。
8. 工作区存在历史遗留的 `QODER_REVIEW.md` 暂存改动，未纳入本次提交。

## 10. 手机验收步骤（用户在家时执行）

1. 在电脑上设置 Token（不要写进仓库）：
   PowerShell：`$env:REMOTE_TOKEN = "<随机长字符串>"`
2. 启动服务（默认只监听本机）：
   `$env:REMOTE_HOST = "0.0.0.0"; npm run remote`
3. 查看电脑局域网 IP：`ipconfig`（例如 `192.168.1.23`）。
4. 手机与电脑连同一 Wi-Fi，浏览器打开：`http://192.168.1.23:8787/console`。
5. 输入 Token → 解锁 → 发送「把背景改成紫色」之类指令。
6. 预期：任务状态 `queued → running → succeeded`；产物卡片可打开游戏。
7. 验收后恢复默认：不设置 `REMOTE_HOST`，仅本机可访问。
8. 若失败：查看电脑终端日志与 `.opengame/remote/logs/<taskId>.log`。

> 注意：`0.0.0.0` 会暴露到局域网，请仅在可信网络短时开启。

## 11. 后续建议

1. **Sprint 02**：生成过程结构化事件（planning / coding / verifying），
   让手机端看到阶段而不是一坨日志。
2. **失败重试策略**：仅对网络类错误自动重试 1 次，并记录尝试次数。
3. **多工作区**：任务记录增加 `workspace` 字段，支持切换项目。
4. **PostVerify 规则扩充**：`assets/` 约定、`gameConfig.json` schema。
5. **跨互联网**：先做传输层抽象与文档，不在仓库内自建 Relay。
6. **可观测性**：为任务增加耗时、token 用量、模型名等指标。

## 12. 提交

- 实现提交：`cfec53c`（分支 `sprint-01-remote-runtime`；本文件所在提交可能还包含随后的文档格式更新）
- 分支：`sprint-01-remote-runtime`（已推送；未合并 main，未 force push）
- 基线：`a016895`

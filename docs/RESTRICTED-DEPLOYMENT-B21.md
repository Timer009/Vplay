# B21 受限部署强制策略与集成接口

> 基线：`sprint-03-b20-restricted` @ `907de55`。
> 分支：`sprint-03-b21-forced-restricted`。
> 本文是**产品层**安全缺口补齐说明；OS 隔离、真实模型代理部署、真实 Pi 验收分别由
> RP02 / Harness / 后续轮次负责。

## 1. 部署级策略（服务端强制，默认 fail-closed）

服务端读取 `VPLAY_RESTRICTED_DEPLOYMENT`：

| 取值                                     | 判定                                   |
| ---------------------------------------- | -------------------------------------- |
| 未设置 / 空 / 未知值                     | **受限部署（B22 起默认 fail-closed）** |
| 显式 `0` `false` `off` `no` `full` `dev` | 完整开发模式（仅可信操作员）           |

受限部署下：

1. `POST /prompt`：无视请求体的 `restricted` 字段（省略或 `false` 都强制 `true`），
   任务直接进入 `awaiting_approval`；`allowYolo` 一律为 `false`。
2. `POST /projects/:id/vision`：任务强制 `restricted=true`（`repair` 写入同样需要审批）；
   `allowedFiles` 必须非空且仅 `.html/.css`，否则 400。
3. worker 在 **spawn 前**再次校验（见 §3），不信任 HTTP 层或 `tasks.json`。
4. 已鉴权的 `GET /status` 返回 `restrictedDeployment: true`，启动日志明确打印模式；
   公开 `/health` 保持最小信息（不新增字段）。

### 判定函数

`remote/lib/linux-config.cjs`：

- `parseRestrictedDeployment(value)`：未知值 → `true`（fail-closed）；
- `evaluateSpawnPolicy(task, { restrictedDeployment })`：纯函数，返回
  `{ ok }` 或 `{ ok:false, code, message }`。

## 2. 任务入口审计矩阵

| 入口                                                 | 位置                               | 受限部署下的行为                                             | 结论                                                         |
| ---------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------ |
| `POST /prompt`                                       | `remote/server.cjs`                | 强制 `restricted:true` → `awaiting_approval`                 | 已强制                                                       |
| `POST /projects/:id/vision`（analyze/verify/repair） | 同上                               | 强制 `restricted:true`；scope 非空且仅 HTML/CSS              | 已强制                                                       |
| `POST /tasks/:id/approve                             | reject`                            | 同上                                                         | 仅 admin token；`restricted` 且 `awaiting_approval` 才可转移 | 已限制 |
| 设备 token / 会话                                    | `authState()`                      | `kind!=='admin'` → 403，不能自批                             | 已限制                                                       |
| worker `tick()` → `run()`                            | `remote/lib/worker.cjs`            | spawn 前 `evaluateSpawnPolicy`，违规任务 `failed`            | 已强制                                                       |
| 旧任务 / 恢复任务                                    | `store.nextQueued()`               | 非 restricted 或审批未 approved → 拦截，不 spawn             | 已强制                                                       |
| `recoverOnStartup`                                   | `remote/lib/tasks.cjs`             | 运行中任务一律 `interrupted`，从不自动恢复                   | 已限制                                                       |
| rejected 任务                                        | `TRANSITIONS`                      | `rejected` 为终态，无 requeue/retry 路由                     | 已限制                                                       |
| CLI 工具注册                                         | `--core-tools` / `--exclude-tools` | 只读五件套；写/执行/网络/生成工具排除                        | B20 已实现                                                   |
| MCP server                                           | `--allowed-mcp-server-names=`      | 空 allowlist → 不加载任何 MCP server                         | **B21 新增**                                                 |
| 扩展工具                                             | `--extensions=none`                | 不加载任何扩展及其 MCP/工具                                  | **B21 新增**                                                 |
| 配置覆盖                                             | CLI `config.ts`                    | `argv.coreTools` 优先于 settings；exclude 为并集（只能更严） | 已核实                                                       |
| 单工作区/项目模式                                    | `resolveTarget()`                  | 仍受项目锁/公开模式约束                                      | 不变                                                         |
| Serve/Funnel                                         | `SERVE_MODE` 检查                  | 本部署不启用；loopback only                                  | 未启用                                                       |

### 配置覆盖结论（静态证据）

- `packages/cli/src/config/config.ts`：`coreTools: argv.coreTools || settings.tools?.core`，
  argv 优先，工作区 settings 不能把白名单改宽。
- `mergeExcludeTools()` 对 CLI、settings、扩展的排除项取并集，只能增加排除。
- `isToolEnabled()`（`packages/core/src/utils/tool-utils.ts`）：core 非空时“未列出即禁用”，
  exclude 最终否决。
- MCP/扩展工具在注册表之外单独发现，必须依赖上表的两个显式关闭参数。

## 3. spawn 前 fail-closed 守卫

`evaluateSpawnPolicy` 依次检查：

1. 任务必须存在且 `status==='queued'`；
2. 受限部署下必须 `task.restricted===true`（否则 `RESTRICTED_DEPLOYMENT_REQUIRED`）；
3. restricted 任务必须 `approval.state==='approved'`（否则 `APPROVAL_REQUIRED`）；
4. Vision 任务必须有非空 `allowedFiles`，且与审批固化的
   `approval.scope.allowedFiles` **逐项一致**（否则 `VISION_SCOPE_REQUIRED` /
   `VISION_SCOPE_MISMATCH`）。

拦截后任务直接 `failed`，写日志与 `task.blocked` 事件，**不会 spawn**，也不会被重试。

### 审批 scope 固化

`POST /tasks/:id/approve` 写入：

```json
{
  "state": "approved",
  "approvedAt": "…",
  "approvedBy": "admin",
  "scope": {
    "projectId": "spacer-lab",
    "kind": "vision",
    "visionMode": "repair",
    "allowedFiles": ["vector-lander/index.html"]
  }
}
```

审批后 API 没有修改任务字段的入口，范围不能被悄悄扩大。

## 4. Vision 写入：独立审批与不可绕过范围

- 受限部署下，`analyze/verify/repair` 全部进入 `awaiting_approval`，与 prompt 任务
  同一套审批队列；`repair` 不再有“直接入队”的旁路。
- `allowedFiles` 由宿主归一化并校验：只允许 `.html/.css`、最多 5 个、项目内路径、
  拒绝 `..`/绝对路径/symlink（`vision-policy.cjs`、`vision-service.cjs`）。
- 受限部署下省略 `allowedFiles` 时，服务端用项目入口（必须是 HTML/CSS）补齐，
  保证审批范围非空；混入 JS 的请求直接 400，不静默替换。
- Vision 0.2.2 的 strict-repair 判定保持不变（不放宽）。

## 5. prepare-lab：完整文件清单与保真

`remote/tools/prepare-lab.cjs` 新增 `--all-tracked`：

```bash
node remote/tools/prepare-lab.cjs \
  --source /srv/spacer-official \
  --lab-root /srv/vplay-lab/workspace/spacer-lab \
  --all-tracked \
  --entry vector-lander/index.html \
  --project spacer-lab --register --home /srv/vplay-lab/home
```

- 用 `git ls-tree -r -z HEAD` 取 **HEAD 全部 tracked 文件**；拒绝 symlink（120000）与
  submodule（160000）。
- `git cat-file --batch` 一次读取全部 blob，按官方 LF 内容写入 labRoot。
- 每个文件记录 `blobSha256`（官方）、`worktreeSha256`（平台工作树，可空）、
  `copiedSha256`；写入后逐一复核 `copiedSha256===blobSha256`。
- 完成后递归扫描 labRoot，文件集合必须与 tracked 清单完全一致（`manifest.json` 除外）。
- labRoot 不得位于 source 内，source 也不得位于 labRoot 内；非空 labRoot 拒绝覆盖。
- manifest `schemaVersion:2`，含 `mode`、`fileCount`、`totalBytes`、`fidelity.verified`、
  `files[]`；入口字段保持 B20 兼容。

## 6. OpenAI 兼容 SSE 代理接入契约（Harness 负责真实部署）

Vplay 侧**只做客户端**，不实现代理。CLI 读取：

- `OPENAI_BASE_URL`（或 config `baseUrl`）→ 指向本机代理，例如
  `http://127.0.0.1:18900/v1`；
- `OPENAI_API_KEY` → 一次性/受限 proxy token（不是真实模型 key）；
- 客户端默认 `stream:true`（`packages/core/src/core/openaiContentGenerator/pipeline.ts`）。

代理必须满足：

### 6.1 请求

| 项        | 要求                                                                         |
| --------- | ---------------------------------------------------------------------------- |
| 方法/路径 | `POST /v1/chat/completions`                                                  |
| 鉴权      | `Authorization: Bearer <proxy-token>`；token 存 0600 文件，仅 loopback 可用  |
| 绑定      | 仅 `127.0.0.1:18900`；不启用 Serve/Funnel/公网监听                           |
| Body      | 原样接受 `model/messages/tools/tool_choice/stream/temperature/max_tokens` 等 |
| 限额      | 请求体上限、模型白名单、单任务请求数/token 预算；超限返回 4xx                |

### 6.2 工具调用

- 必须透传 `tools`（JSON Schema）与 `tool_choice`，不得改写或裁剪；
- 流式响应按 OpenAI 格式返回 `choices[0].delta.tool_calls[]`
  （`index`/`id`/`type`/`function.name`/`function.arguments` 分片）；
- 代理**不执行工具**；工具执行发生在 Agent 客户端，结果由下一次请求带回；
- 非流式 `stream:false` 可支持，但流式是硬要求。

### 6.3 流式响应

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"id":"...","object":"chat.completion.chunk", ...}

data: {"choices":[{"delta":{"content":"..."}}]}

data: [DONE]
```

- 每个事件以空行结束；不得缓冲整段后再发；建议 keep-alive 注释帧；
- 结束必须发送 `data: [DONE]`；
- `usage`（若提供）放在最后一个 chunk。

### 6.4 错误

- HTTP 状态码 + OpenAI 错误对象：
  `{"error":{"message":"...","type":"invalid_request_error","code":"..."}}`；
- 流开始前的错误用非 200；流中途错误发送 `data: {"error":{...}}` 后关闭连接，
  不得以 200 + 空流伪装成功；
- 上游超时/限额/鉴权失败需可区分（`type`/`code`）。

### 6.5 取消

- 客户端断开（任务 stop/timeout）时，代理必须中止上游请求，停止继续计费/生成；
- 取消不得触发自动重试或重放已执行工具；
- 代理需在取消后尽快关闭 SSE 连接。

### 6.6 与非流式/旧客户端

- 若收到 `stream:false`，返回普通 JSON `chat.completion`；
- 不得要求客户端改写 base URL 之外的任何代码。

> B21 只核实并文档化契约；真实代理部署、密钥托管、systemd 单元由 Harness 负责。

## 7. 受限 Vision 修复 vs 新增 JavaScript 游戏功能

| 维度         | 受限 Vision 修复（现有 0.2.2） | 新增 JavaScript 游戏功能（本轮不实现）       |
| ------------ | ------------------------------ | -------------------------------------------- |
| 写入范围     | `allowedFiles` 内 `.html/.css` | 项目内 `.js/.html/.css` 等（需显式清单）     |
| 变更来源     | Vision strict-repair 补丁      | 结构化 change-set（diff/manifest）           |
| 审批         | 任务级 admin 审批 + scope      | 独立审批：文件清单 + diff 哈希 + 基线 commit |
| 验证         | 截图/断言 + strict-repair      | 构建/静态检查/定点测试 + 预览校验            |
| 回滚         | 项目快照 + 原子 apply          | 快照 + journal + 原子 apply + 失败还原       |
| 工具         | 只读五件套                     | 仍不放开 shell/网络；由宿主应用补丁          |
| Vision 0.2.2 | 不放宽                         | 不用于 JS 语义修改                           |

### 结构化代码变更方案（设计，未实现）

1. 新任务类型 `kind='code_change'`，请求体只接受：
   `{ projectId, baseCommit, files:[{path, sha256}], diff, summary }`；
2. 服务端校验路径（项目内、非 symlink、非 `.git`/vendor）、扩展名白名单、
   diff 大小上限、禁止 `eval`/动态网络/依赖安装等模式；
3. 任务强制 `awaiting_approval`，审批 scope 固化 `baseCommit + files[] + diffSha256`；
4. worker apply 前复核基线 commit 与文件哈希，持项目锁、先快照、写 journal，
   原子写入；失败按 journal 还原；
5. 变更后运行构建/定点测试与预览校验，失败不发布；结果写入证据链；
6. rejected/超时/校验失败一律不落地；不支持“重试即恢复”。

### 安全门禁

- 统一审批队列（与 B21 相同），设备不得自批；
- 文件清单不可在审批后修改；diff 哈希不一致直接失败；
- 禁止 shell、MCP、扩展、依赖安装、vendor 修改；
- 陆地回收等玩法变更必须走该通道，**不得**通过放宽 Vision 白名单实现；
- 本轮只交付方案，不实现、不启用、不 land-pin。

## 8. 已知阻断（B21 不解决）

| 项                                        | 状态                               |
| ----------------------------------------- | ---------------------------------- |
| Playwright 默认 `--no-sandbox`（E15）     | **BLOCKED**，不改 vendor，等待 E16 |
| Pi memory cgroup 被 bootargs 禁用（RP02） | BLOCKED，OS 隔离 `NOT_IMPLEMENTED` |
| 真实代理/密钥托管/外部锚点                | Harness / C18 负责                 |
| 真实 ARM64 全量测试                       | 仅定点 Windows；Linux 脚本已附     |

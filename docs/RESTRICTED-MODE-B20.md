# 受限执行模式（B20 / C18 前置）

> 适用：`sprint-03-b20-restricted`（基于 B19 ARM64 适配）。
> 本文区分 **受限修复模式** 与 **完整游戏开发模式**；不代表 OS 隔离或真实 Agent 已验收。

## 1. 两种模式

| 模式                 | 入口                               | 工具                                                                                                                                             | 用途                                               |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 完整游戏开发（现有） | `POST /prompt`（默认）             | 原有 CLI 工具集（含 shell/edit/write/web，受 approval-mode 控制）                                                                                | 正常 Create/Adopt 开发                             |
| **受限修复模式**     | `POST /prompt` + `restricted:true` | 仅 `read_file/read_many_files/grep_search/glob/list_directory`；显式排除 shell/edit/write/web/task/skill/generate\_\*/save_memory/exit_plan_mode | 真实模型只读分析 + Vision 单一写通道；需管理员批准 |

受限任务创建后状态为 `awaiting_approval`，**不会 spawn CLI**；管理员调用：

```http
POST /tasks/<id>/approve   Authorization: Bearer <REMOTE_TOKEN>
POST /tasks/<id>/reject    Authorization: Bearer <REMOTE_TOKEN>
```

设备 token/会话 **不能** 自批；approve 后状态转 `queued`，worker 才 spawn。reject 为终态 `rejected`。

## 2. 工具白名单交付

`remote/lib/linux-config.cjs` 定义：

- `RESTRICTED_CORE_TOOLS`：只读五件套；
- `RESTRICTED_EXCLUDED_TOOLS`：shell/edit/write/web/task/skill/generate\_\*/save_memory/exit_plan_mode；
- `restrictedCliArgs()`：生成 `--core-tools=... --exclude-tools=...`。

`worker.cjs` 仅在 `task.restricted===true` 时追加参数。CLI 执行层由
`packages/core/src/config/config.ts` 的 `getCoreTools()/getExcludeTools()` +
`isToolEnabled()` 在工具注册时过滤（argv 不是唯一防线）。

> 未在 Linux/真实 CLI 上跑完整工具拒绝矩阵；该验证列入 C19/RP02。Windows 单元测试只验证参数与任务门禁。

## 3. 独立实验副本（P-3）

`remote/tools/prepare-lab.cjs`：

```bash
node remote/tools/prepare-lab.cjs \
  --source /srv/spacer-official \
  --lab-root /srv/vplay-lab/workspace/spacer-lab \
  --entry vector-lander/index.html \
  --project spacer-lab \
  --register --home /srv/vplay-lab/home
```

- 双哈希：`source.blobSha256`（git blob，官方）与 `source.worktreeSha256`（平台换行）；
- `manifest.json`：commit、入口、字节、双哈希、文件清单；
- labRoot 不得位于 source 内部；拒绝 symlink 入口；
- 注册独立 project（只注册该副本，不碰正式仓库）；
- 不覆盖非空 labRoot（可逆）。

Spacer 官方目标：commit `2bc027d`，blob `e228afc7…`（200,534 B）。

## 4. P-5 模型代理客户端核实

| 项        | 结论                                                                                             | 证据                                                            |
| --------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Base URL  | 支持 `OPENAI_BASE_URL`（也可用 config `baseUrl`）                                                | `packages/core/src/core/contentGenerator.ts:105-107`            |
| 鉴权      | `OPENAI_API_KEY`（代理可发一次性 dummy token）                                                   | 同上 `:104,:110-112`                                            |
| 模型      | `OPENAI_MODEL` 可覆盖；OpenAI 兼容端点                                                           | `:107`                                                          |
| 流式      | **客户端实际使用 streaming（`stream:true`）**                                                    | `packages/core/src/core/openaiContentGenerator/pipeline.ts:241` |
| Mock 实测 | 本地 mock 收到 `POST /v1/chat/completions` + `Bearer dummy-proxy-token`；客户端 exit 0 输出 `OK` | `G:\AI_GAME\VPLAY-B20-MOCK\client-check.cjs`                    |
| 非流式    | 客户端未暴露非流式开关；代理程序支持非流式直连，但 CLI 正常路径走流式                            | 缺口                                                            |
| 代理要求  | 代理必须支持 OpenAI **SSE 流式**响应；仅实现 `stream:false` 不兼容                               | 结论                                                            |

### 4.1 实际代理程序

`remote/tools/model-proxy.cjs`：

- 默认 `127.0.0.1:18790`（统一 B19 的 18900 示例，唯一配置来源 `OPENAI_BASE_URL`）；
- 真实 key 只从 0600 `--key-file`（或 `VPLAY_PROXY_REAL_KEY`）读取；客户端只持有 `--token-file` run token；
- 仅允许 `POST /v1/chat/completions` / `/chat/completions`；模型白名单；
- 限制请求次数、请求体、非流式 usage tokens（`--max-requests/--max-body-bytes/--max-tokens`）；
- 流式 SSE 透传；非流式 JSON 透传；不记录 body/key/token。
- 测试：`B20-P5` 覆盖正确/错误 token、未知模型、超大 body、请求次数、非流式上游。

## 5. P-6 证据封存接口 + 实际程序

`remote/tools/seal-evidence.cjs`：

```bash
node remote/tools/seal-evidence.cjs \
  --staging /srv/vplay-lab/evidence-staging \
  --sealed /srv/vplay-lab/evidence \
  --anchor-out /srv/vplay-lab/seal/anchor.json \
  --key-file /srv/vplay-lab/operator-hmac.key
```

- 逐文件 sha256 + `manifest.json`；`seal.json` 使用外部 HMAC key 覆盖 manifest；
- `--anchor-out` 供操作员 scp 到 Pi 之外；拒绝 symlink/非空 sealed/staging 内嵌；
- 测试 `B20-P2 evidence seal` 覆盖 manifest、复制、HMAC、非空与 symlink；
- 未实现：`vplay-evidence` UID/systemd oneshot 部署层，需 C18/RP02 落地。

## 6. 状态矩阵

| 能力                                                | 状态                                            |
| --------------------------------------------------- | ----------------------------------------------- |
| P-1 受限工具白名单（argv + CLI 注册过滤路径）       | 已实现（Linux 真实 CLI 拒绝矩阵待验）           |
| P-2 awaiting_approval + approve/reject + 管理员审批 | 已实现（Windows API 测试通过）                  |
| P-3 独立副本/双哈希/manifest/注册                   | 已实现（Windows 临时 git 仓库测试通过）         |
| P-4 Linux 进程树终止                                | 已在 B19 实现                                   |
| P-5 代理客户端 base URL/鉴权/流式                   | 已实测（mock 上游）；客户端流式、非流式开关缺失 |
| P-5 代理程序                                        | 已实现（18790；token/模型/次数/大小/tokens）    |
| P-6 证据封存/外部锚点                               | 已实现程序 + 测试；UID/systemd 待部署           |
| OS 隔离/Tailnet/真实模型                            | 未实现/未执行，仍 DENIED                        |

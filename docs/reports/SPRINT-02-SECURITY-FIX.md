# Sprint 02 · 安全加固补充报告

- 对应审计：`G:\AI_GAME\VPLAY-SPRINT-01-SECURITY-AUDIT.md`（审计基线 `8058e67`）
- 修复分支：`sprint-02-project-adoption`（未合并 main）
- 修复前基线：`87ba24f`（Sprint 02 功能提交）
- 日期：2026-11-26
- 结论：**P0 四项全部关闭，P1 六项全部处理，P2 八项已修 8 项**；真机功能未回退，
  Spacer 的 localStorage / 关卡 / 触控 / 横屏未被破坏。
- 本报告**不宣称安全审计通过**，等待 Qoder 独立复审。

---

## 0. 一句话说明

审计指出的最高危链路是「环境变量全量继承 → 日志落盘 → `/game` 静态可读 → 预览同源」
四段组合。本轮把这条链路逐段切断：

1. CLI 子进程只拿最小环境变量，**不再继承 `REMOTE_TOKEN`**；
2. 日志写入前脱敏，单任务上限 5 MB；
3. 静态预览改读**独立预览产物目录**，只放行扩展名白名单，拒绝点文件与穿越；
4. 预览独立端口 + 写接口 `Origin` 校验，且预览页无任何管理接口。

## 1. P0 修复状态

| ID   | 问题                                     | 状态                     | 代码位置                                                                                                  | 证据                                                                                        |
| ---- | ---------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| P0-1 | 静态服务可读 `.env` / `.git` / 日志      | **已关闭**               | `remote/lib/paths.cjs` `resolveStaticFile` + `copyPreviewTree`；`remote/lib/projects.cjs` `buildPreview`  | 探针 B1–B5、H1 全部 404；`security.test.cjs` P0-1 用例                                      |
| P0-2 | 路径穿越 / 前缀绕过 / junction 逃逸      | **已关闭**               | 同上：点段拒绝 + `path.relative` 边界 + `realpath` 二次校验                                               | 探针 C1–C6 全部 404/403；`preview.test.cjs` junction 用例；`security.test.cjs` 兄弟目录用例 |
| P0-3 | 预览与控制台同源，游戏脚本可调管理 API   | **已关闭**               | `remote/lib/preview.cjs`（独立端口、无管理路由）；`remote/server.cjs` `originAllowed` + 写接口校验        | `server.test.cjs` 跨源写 403；预览端口 `POST /prompt` 405；探针 E2 无 ACAO                  |
| P0-4 | 环境变量继承 → 日志 → 静态读取，凭据泄露 | **已关闭（含残余限制）** | `remote/lib/worker.cjs` `buildChildEnv` / `scrub`；`remote/lib/tasks.cjs` `redact` / 5 MB 上限 / 尾部读取 | `security.test.cjs` P0-4 用例；探针 F3 `hasRemoteToken=false`、`hasOpenAiKey=false`；F4 404 |

### 1.1 预览产物目录（新增）

- 预览不再直接读 `src`，而是由 `copyPreviewTree` 生成 `<project>/.preview`
  （单工作区模式为 `<runtime>/.preview-legacy`）。
- 只复制扩展名白名单内的文件，跳过所有点文件、`node_modules`、symlink/junction。
- 每次任务结束、每次回退后自动重建预览。

## 2. P1 修复状态

| ID   | 问题                             | 状态       | 处理方式                                                                                                                 |
| ---- | -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| P1-1 | 登录限流失效、与任务共桶         | **已关闭** | 登录/任务独立桶；先判后记；失败 10 次/分钟后 429                                                                         |
| P1-2 | Cookie 值 = 长期 Token、不可吊销 | **已关闭** | 随机 32B Session，服务端 `Map<sha256(id)>`；TTL 4h、空闲 2h；登出即删除；Cookie 名 `vplay_session`                       |
| P1-3 | 无 Host/Origin 校验；登出无鉴权  | **已关闭** | Host 白名单（loopback + 绑定 IP + `REMOTE_ALLOWED_HOSTS`）；写接口 Origin 同源；登出要求鉴权                             |
| P1-4 | `succeeded` 掩盖真实失败         | **已关闭** | 前后哈希/快照 diff；`noChanges` → `outcome=no_changes`、`verified=false`；post-verify 增加 `taskId` 且只接受本次任务结果 |
| P1-5 | 孤儿进程 / 重启并发写            | **已关闭** | `cli-runner` 父进程看门狗 + 启动租约回收 + `stop()` 杀当前子进程；项目锁                                                 |
| P1-6 | 无工作区互斥                     | **已关闭** | `<runtime>/server.lock`（O_EXCL，含 pid/port）；同工作区第二个实例拒绝启动                                               |

### 2.1 会话与 Cookie 细节

- `POST /auth/verify` 成功返回 `Set-Cookie: vplay_session=<random>; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`。
- Cookie 值不等于 `REMOTE_TOKEN`；`Authorization: Bearer` 仍可直接使用主 Token。
- HTTPS 前置（`X-Forwarded-Proto: https`）时自动追加 `Secure`；纯局域网 HTTP 无法强制 `Secure`，列为残余风险。
- `POST /auth/logout` 需鉴权，并删除服务端会话（可吊销）。

## 3. P2 修复状态

| ID   | 问题                                  | 状态 | 处理                                                                        |
| ---- | ------------------------------------- | ---- | --------------------------------------------------------------------------- |
| P2-1 | `/health` 泄露 workspace/ tokenSource | 已修 | 只返回 `{ok, service, version, remoteEnabled}`                              |
| P2-2 | 返回绝对路径                          | 已修 | `/artifact` 只返回 `previewPath/previewPort`；任务结果用相对 `artifactPath` |
| P2-3 | 控制台允许同源 iframe                 | 已修 | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`                      |
| P2-4 | 限流 Map 无上限                       | 已修 | 过期清理 + 超过 5000 条时清理                                               |
| P2-5 | `REMOTE_EXECUTOR_CMD` 后门            | 已修 | 仅 `NODE_ENV=test` 或 `REMOTE_ALLOW_TEST_SEAM=1` 时生效                     |
| P2-6 | 日志无上限、读取整文件                | 已修 | 单任务 5 MB 截断；`readLog` 只读尾部                                        |
| P2-7 | 控制台无 CSP                          | 已修 | `/console` 下发 `default-src 'self'` 等                                     |
| P2-8 | 错误详情含绝对路径                    | 已修 | `scrub()` 把工作区路径替换为 `<workspace>`，并脱敏凭据                      |

## 4. 凭据策略与明确限制

**已做：**

- 子进程环境变量改为「白名单放行」：只保留系统运行必需项与模型调用必需项；
  `REMOTE_TOKEN`、`REMOTE_TOKEN_FILE`、`REMOTE_EXECUTOR_CMD`、`VPLAY_*` 一律不传。
- 日志与错误回传双重脱敏：主 Token、`sk-*`、`*_API_KEY=`、`vplay_session=`。
- 公开模式（`VPLAY_PUBLIC_MODE=1` 或绑定 `0.0.0.0/::`）自动降级 `--approval-mode auto-edit`，
  且只允许对受控（导入）项目执行任务。

**明确限制（本轮不假装解决）：**

1. **模型 Key 仍在 CLI 进程环境里**：CLI 需要它调用模型。`--yolo/auto-edit` 下 CLI 的 Shell
   工具理论上能读取该环境变量。完整解决需要「凭据代理 + OS 级沙箱（容器/低权限用户）」，
   本轮未建立。
2. 因此：**禁止把远程控制服务开放到公网**；默认只监听 `127.0.0.1`，局域网使用需显式绑定
   具体网卡 IP，并在可控时间内关闭。
3. 纯 HTTP 局域网无法加 `Secure` Cookie；如需跨不可信网络，必须由 HTTPS 反向代理终止。

## 5. 复用 Qoder 独立探针的结果

探针源码复用自 `G:\AI_GAME\.audit-s1-verify\`，仅把 `SRC_REMOTE` 指向本仓库
`remote/`（其余逻辑未改），在工作区 `vplay-security-probe/` 运行，全部使用虚拟凭据。

| 探针                     | 审计时（8058e67）                          | 本轮修复后                                                                    |
| ------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------- |
| A1/A2 `/game/index.html` | 401 / 200                                  | 404 / 404（路由已移除）                                                       |
| B1 `.env`                | 200，泄露假 Key                            | **404**                                                                       |
| B2 `.git/config`         | 200                                        | **404**                                                                       |
| B3 `.git/credentials`    | 200                                        | **404**                                                                       |
| B4 `notes.log`           | 200                                        | **404**                                                                       |
| B5 / H1 `tasks.json`     | 200，泄露历史指令                          | **404**                                                                       |
| C1–C3 编码斜杠穿越       | 200 `SIBLING_PREFIX_ESCAPE_OK`             | **404**                                                                       |
| C4 junction 兄弟目录     | 200                                        | **404**                                                                       |
| C5 junction 系统目录     | 200，读到 hosts                            | **404**                                                                       |
| D1 Cookie                | 值 = 原始 Token，无 Secure                 | 随机 Session，`valueIsRawToken=false`，`hasSecure=false`（HTTP）              |
| E1 Host 伪造             | 200，泄露 workspace                        | **400**，无泄露                                                               |
| F3 日志凭据              | `hasRemoteToken=true`、`hasOpenAiKey=true` | **均为 false**                                                                |
| F4 日志经静态路由        | 200                                        | **404**                                                                       |
| G1 空任务                | `succeeded` + 旧产物                       | `succeeded` 但 `verified=false`、`outcome=no_changes`、`changedFiles={0,0,0}` |
| D2 连续 15 次错误登录    | 全 401；随后正常任务 429                   | **第 10 次起 429**；正常任务 **202**                                          |
| J1–J7 孤儿探针           | Windows 未观测孤儿                         | 父进程崩溃后子进程停止写入；重启标记 `interrupted`；无残留                    |

## 6. 自动化测试证据

| 命令                               | 结果                                              |
| ---------------------------------- | ------------------------------------------------- |
| `npm run lint`                     | 退出码 0                                          |
| `npm run build`                    | 退出码 0（既有 dts TS5011 警告不变）              |
| `npm run bundle`                   | 退出码 0                                          |
| `node dist/cli.js --version`       | `0.6.0`                                           |
| `npm run test:remote`              | **43 用例：42 通过 / 0 失败 / 1 跳过**            |
| 真实模型 E2E（`RUN_REMOTE_E2E=1`） | 1 通过（15.3s），post-verify 新 `taskId` 校验生效 |

新增 `remote/test/security.test.cjs`（9 个用例）覆盖：

- P0-4 最小环境变量 + 日志脱敏；
- P1-4 空修改与陈旧 post-verify；
- P1-2 Session 唯一性、不可读 Token、服务端吊销；
- P1-1 登录限流与任务桶隔离；
- P1-3 Host 伪造；
- P0-1/P0-2 白名单、点文件、兄弟目录穿越；
- P1-6 同工作区第二实例拒绝启动；
- P2-2 无绝对路径。

### 6.1 Core 基线失败分类（不掩盖）

| 组                         | 数量 | 结论                                                                                                       |
| -------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `prompts.test.ts` 快照     | 15   | **基线代码债**：fork 改了提示词未更新快照，任何平台必失败；本轮未修，建议单独提交 `vitest -u` 或回退提示词 |
| `workspaceContext.test.ts` | 11   | **本机环境限制**：Windows `symlinkSync` EPERM；Linux/开发者模式可通过                                      |
| `agent-test`               | —    | 评测脚本缺 `OPENAI_API_KEY`，不属于单测                                                                    |

本轮新增代码未引入任何新的基线失败。

## 7. 兼容性验证

- Sprint 01 真机功能：远程任务、去重、任务同步、Cookie 登录全部保留（43 个用例覆盖）。
- Spacer 兼容性：预览改为独立产物目录后，`/p/spacer/` 返回 200（182,644 字节）；
  响应头**没有** CSP `sandbox`，因此 `localStorage`、关卡解锁、设置保存、触控与横屏逻辑不受影响。
- Spacer 页面中仍可检索到 `localStorage` 引用，说明脚本原样下发。

## 8. 残余风险

1. 模型 Key 仍在 CLI 子进程环境中（无凭据代理 / OS 沙箱）——禁止公网执行。
2. HTTP 局域网 Cookie 无 `Secure`，同网段嗅探仍有理论风险。
3. 预览面无鉴权：同网段拿到预览 URL 即可只读查看游戏（无管理能力）。
4. `session` 存在内存中，重启即失效（用户需重新登录），这是安全与可用性的取舍。
5. `post-verify` 的 `taskId` 依赖 CLI 已重新构建；旧 `dist` 需执行 `npm run build && npm run bundle`。
6. Linux/macOS 的孤儿回收依赖 `cli-runner` 看门狗与租约，本轮仅在 Windows 实测。

## 9. 提交

- 安全修复提交：`<!-- COMMIT_SHA -->`
- 分支：`sprint-02-project-adoption`（推送，不合并 main，不 force push）
- 未使用真实密钥做探针，未开放公网远程控制。

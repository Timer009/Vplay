# Vplay Studio · 项目状态

> 最后更新：Sprint 03C（B12，2026-11-28）｜分支 `sprint-03-b12-candidate`
> 已验收基线：`sprint-01-accepted` → `8058e67`（Sprint 01 真机 13/13 通过）
> Sprint 02：`sprint-02-c05-fix` @ `fcfd880`（C06 通过，未合并 main）
> Sprint 03A：`abc8e24`（C07 P0 安全基础）
> Sprint 03B：`455a187`（Connect L2 候选，C09 复审提出 P0）
> Sprint 03C：B10 `33523cd` → B11 候选（Vision 0.2.1 + C10 收口）

## 1. 项目定位

Vplay Studio 以 OpenGame（Apache-2.0，源自 gemini-cli）为内核，目标是最佳 AI 原生
游戏创作工具（NVIDIA DGX Spark）：一句话生成可玩网页游戏，并能接管已有工程、
在手机上持续下达增量修改。

## 2. 当前能力

| 能力                                                            | 状态                     | 证据                                             |
| --------------------------------------------------------------- | ------------------------ | ------------------------------------------------ |
| Create Mode：从零生成（模板脚手架 + post-verify）               | 可用                     | Sprint 01 报告                                   |
| Remote：Token 鉴权、任务状态机、去重、串行、持久化              | 可用                     | 33 个 remote 测试                                |
| 真机：iPhone Safari + OPPO Android                              | 已验收                   | Sprint 01 报告第 13 节                           |
| **Adopt Mode：导入已有工程（静态 / 子目录入口 / Vite）**        | Sprint 02 新增           | `remote/lib/projects.cjs`                        |
| **项目预览独立源（预览面 ≠ 控制面）**                           | Sprint 02 新增           | `remote/lib/preview.cjs`                         |
| **修改前快照 / 差异 / 回退（含备份）**                          | Sprint 02 新增           | `remote/lib/projects.cjs` + 测试                 |
| **孤儿 CLI 进程收敛**                                           | Sprint 02 新增           | `cli-runner.cjs` + `leases.cjs`                  |
| 项目记忆与连续多轮                                              | Sprint 02 新增（P1）     | `memory.json` + `-c` 续接                        |
| **SSE 任务事件流（持久化 / 补发 / 心跳 / 去重）**               | Sprint 03B 新增          | `remote/lib/events.cjs` + 测试                   |
| **设备身份 / 项目授权 / 任务 owner 过滤**                       | Sprint 03B 新增          | `remote/lib/devices.cjs` + CLI                   |
| **统一 versionId / artifactId / 项目外证据 + HMAC**             | Sprint 03B 新增          | `remote/lib/evidence.cjs`                        |
| **Vision 0.2.0 集成（analyze / verify / 受限 repair）**         | Sprint 03B 新增          | `remote/lib/vision-service.cjs`                  |
| **注册表锁/快照一致性（C09 B-01）**                             | Sprint 03C 修复          | `remote/lib/projects.cjs` + B10 测试             |
| **预览 staging 校验后原子发布（C09 B-02）**                     | Sprint 03C 修复          | `copyPreviewTreeStaged` + B10 测试               |
| **Vite 构建摘要绑定源码（C09 B-03）**                           | Sprint 03C 修复          | `.build-stamp.json` + `srcDigest`                |
| **回退持项目锁 + 异步构建（C09 B-04）**                         | Sprint 03C 修复          | `projects.rollback`(async)                       |
| **Vision 增量校验 / 预览票据 / verify 语义**                    | Sprint 03C 修复          | `vision-policy.cjs`、`vision-service.cjs`        |
| **Connect 共享可见性 + 即时吊销**                               | Sprint 03C 修复          | `server.cjs`、`devices.cjs`                      |
| **证据 manifest/HMAC/链校验 + Qoder 契约适配**                  | Sprint 03C 新增          | `remote/lib/evidence.cjs`、`qoder-evidence.cjs`  |
| **Vision 0.2.1 + 精确 delta + 严格 verified**                   | Sprint 03C（B11）        | `vendor/vision` 0.2.1、`vision-policy-delta.cjs` |
| **C10 收口：/status、幂等作用域、证据 owner、设备 fail-closed** | Sprint 03C（B11）        | `server.cjs`、`tasks.cjs`、`devices.cjs`         |
| **事件 seq 入哈希 + anchor 尾删检测 + 跨进程追加**              | Sprint 03C（B11）        | `remote/lib/events.cjs`                          |
| **非入口预览资源完整性校验**                                    | Sprint 03C（B11）        | `preview.cjs` + manifest                         |
| 跨互联网协同（Tailscale）                                       | 三端已接入，未启用 Serve | 见 `docs/CONNECT-L2-ACCEPTANCE.md`               |

## 3. 安全加固状态（Qoder 审计 8058e67）

| 级别                     | 状态                                                                    |
| ------------------------ | ----------------------------------------------------------------------- |
| P0-1 敏感文件泄露        | 已关闭（独立预览产物目录 + 扩展名白名单）                               |
| P0-2 穿越/前缀/junction  | 已关闭（点段拒绝 + path.relative + realpath）                           |
| P0-3 预览/控制面同源     | 已关闭（独立端口 + Origin 校验）                                        |
| P0-4 凭据经环境/日志泄露 | 已关闭（最小环境变量 + 日志脱敏 + 5MB 上限），模型 Key 隔离仍有残余限制 |
| P1-1 登录限流            | 已关闭（独立桶）                                                        |
| P1-2 会话 Cookie         | 已关闭（随机短期 Session，可吊销）                                      |
| P1-3 Host/Origin         | 已关闭                                                                  |
| P1-4 succeeded 语义      | 已关闭（no_changes / verified / post-verify taskId）                    |
| P1-5 孤儿进程            | 已关闭（runner 看门狗 + 租约回收 + stop 杀子进程）                      |
| P1-6 工作区互斥          | 已关闭（server.lock）                                                   |
| P2-1～P2-8               | 全部处理                                                                |

详见 `docs/reports/SPRINT-02-SECURITY-FIX.md`。独立复审仍由 Qoder 进行。

### 3.2 Sprint 03C（B11：C10 收口 + E07 集成）

| C10 编号                   | 状态       | 实现要点                                                            |
| -------------------------- | ---------- | ------------------------------------------------------------------- |
| C10-01 SSE 跨项目/吊销     | 已关闭     | 项目过滤 + 每次发送/心跳重验 + 连接上限 + `gap` 截断提示            |
| C10-02 `/status` 泄漏      | 已关闭     | 按 auth 过滤项目/任务；非管理员不回显 prompt                        |
| C10-03 幂等跨用户          | 已关闭     | 作用域 `(createdBy, projectId)`；跨域 409 且不回显任务              |
| C10-04 Vision 证据越权     | 已关闭     | 报告/截图仅创建者或管理员                                           |
| C10-05 allowedFiles 穿越   | 已关闭     | `assertSafeRelPath` 归一化后才读取                                  |
| C10-06 设备 lastSeen 竞态  | 已关闭     | 鉴权只读；写操作加锁；revoke 不被覆盖                               |
| C10-07 seq 未入哈希/尾删   | 已关闭     | `hashAlg=seq-in-body-v2` + anchor(count/lastId/head) + `verify()`   |
| C10-08 证据与 C08 契约     | 部分       | 可移植 Qoder 校验器/记录器 + 合成包契约测试；真实 12 文件包仍未产出 |
| C10-09 设备默认 `*`        | 已关闭     | 无 projects 拒绝创建；显式 `*` 才全项目                             |
| C10-10 Spacer 合法补丁被拒 | 已关闭     | delta operation 重放 + 新增片段/窗口扫描；真实 Spacer 正负对照通过  |
| C10-11 预览认证截图 401    | 已关闭     | Vision 0.2.1 `previewAuth` + 项目级路径                             |
| E07 严格 verified          | 已关闭     | `confirmed` + 宿主硬门禁：必须有缺陷专属断言                        |
| B-11 防火墙                | **未关闭** | 4 条 node Any/Any 仍在；按用户要求未修改                            |
| B-15 OS 隔离               | **未实现** | 见 `docs/TRUST-BOUNDARY-B11.md`                                     |

### 3.3 Sprint 03C（B12：C11 收口 + 可信实验准备）

| C11 编号                                                | 状态                 | 实现要点                                                                                             |
| ------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| C11-01 快照 200 上限裁剪竞态                            | 已关闭               | 先提交注册表、再入 GC 队列；宽限期后回收；租约保护 diff/rollback；提交后不再直接 `rmSync` 被引用目录 |
| C11-02 运行时孤儿回收                                   | 已关闭               | 启动 + 60s 周期 reaper；`.writing` 标记/活 pid 保护；未知目录只隔离不删除；幂等；配额统计            |
| C11 压测（跨 200 / 10 进程 / diff+rollback / 崩溃残留） | 已覆盖               | `b12-snapshot-gc.test.cjs`：4/4；每条保留记录校验目录/manifest/uid/文件哈希/可回退                   |
| Serve/代理 fail-closed                                  | 已关闭               | 缺 `PREVIEW_ACCESS_KEY`/`EVIDENCE_HMAC_KEY`/外部 Host/非回环 → 拒绝启动（`b12-deploy`）              |
| Secure Cookie                                           | 已关闭               | `REMOTE_TRUST_PROXY=1` 时强制 `Secure`，不依赖客户端 XFP                                             |
| 事件 anchor 兼容 / HMAC 降级                            | 已关闭               | 旧 v1 链自动建立 anchor 并继续校验；`verifyEvidence(requireHmac)` 拒降级                             |
| 可信实验环境                                            | 准备完成，能力未实现 | `remote/tools/trusted-lab/*`；本机不具 Sandbox/Hyper-V/WSL/容器（需提权/未安装）                     |
| 真实 Spacer 实验                                        | 准备完成             | 基线哈希 `4babef02…`；副本/配置/F1–F10/证据流程文档；未执行真实模型                                  |

### 3.1 Sprint 03C 收口（C09 → B10）

| C09 编号                        | 状态             | 实现要点                                                                                      |
| ------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| B-01 并发丢快照                 | 已关闭（本机）   | 锁 stale 判定要求「存在 + 稳定 + pid 死/超硬上限」；回收按 token 比对，误抢放回；写后单调校验 |
| B-02 先发布后校验               | 已关闭           | staging 内完成 manifest + 全量哈希校验后才切换；失败恢复旧目录与旧 manifest                   |
| B-03 Vite dist 新鲜度           | 已关闭           | `.build-stamp.json` 记录构建输入摘要；发布前必须匹配当前源码                                  |
| B-04 回退无锁/阻塞              | 已关闭           | `rollback` 获取项目锁（或校验调用方 token）；`buildProjectAsync` 不阻塞事件循环               |
| B-05 settle 非异常安全          | 已关闭           | settle 整体 try/catch/finally，异常也 finish + releaseLock                                    |
| B-06 Serve 下 yolo              | 已关闭           | `VPLAY_PUBLIC_MODE`/`REMOTE_TRUST_PROXY` 均强制 publicMode                                    |
| B-07 seam 与 Serve 共存         | 已关闭           | Serve/代理/通配模式下一律拒绝启动 seam                                                        |
| B-08 凭据继承过宽               | 已关闭           | 显式 key 名单；移除 `NODE_OPTIONS`；`EVIDENCE_*` 不透传                                       |
| B-09 预览 cookie 静态且不可吊销 | 已关闭           | 会话绑定的短期票据；登出/revoke-all/设备吊销立即 401；按项目授权                              |
| B-10 证据可降级                 | 已关闭（宿主侧） | anchor 记录 alg/密钥指纹/chainHead + 全量 manifest；`verifyEvidence(requireHmac)` 负对照      |
| B-14 宿主白名单弱于 E05         | 已关闭           | 宿主独立结构化**增量**校验（仅扫描新增行），真实 Spacer 基线不误报                            |
| B-15 OS 隔离                    | **未完成**       | 无 Job/AppContainer/独立账号；不宣称不可篡改                                                  |

## 4. 已知限制

1. **Sprint 02 未经真机验收**：只提供手机验收地址与步骤，真机结论待产品负责人执行。
2. **独立安全审计仍在进行**（Qoder）：本仓库不宣称审计通过。
3. 图像 / 视频 / 音频模态未启用（只有 DeepSeek Key），生成物走占位。
4. Vite 项目回退后会**强制重建**（`npm run build`），构建失败即回退失败（fail closed）。
5. 快照不包含 `dist/`、`node_modules/`、`.git/`；回退通过重建恢复产物。
6. 默认只监听 `127.0.0.1`；网络模式必须显式指定本机接口地址，禁止 `0.0.0.0`。
7. 公开模式（`VPLAY_PUBLIC_MODE=1`）会禁用 `--yolo` 并拒绝非受控工作区。
8. Vision 需要 `VISION_DATA_CONSENT=1` 且只允许 HTML/CSS；真实模型调用需预算授权。
9. 证据链 HMAC 只证明“由持钥宿主生成”，不是 OS 级不可篡改存储。
10. **无 OS 沙箱/独立账号隔离**：预览与控制面同进程，模型可写 `VPLAY_HOME`（B-15 未关闭）。
11. Vision 真实模型调用仍需授权与预算；本轮只验证离线契约与真实 Spacer 文件策略。
12. 预览鉴权仅在设置 `PREVIEW_ACCESS_KEY` 时启用；tailnet 模式必须开启并配置 `REMOTE_TRUST_PROXY=1`。
13. **OS 隔离未实现**：模型进程与宿主同账号同权限；环境白名单/浏览器守卫不是沙箱
    （`docs/TRUST-BOUNDARY-B11.md`）。
14. **防火墙未收敛**：node.exe 仍有 4 条 Public Any/Any 入站规则；B11 按用户要求未修改。
15. **C10-08 部分**：Qoder 校验器/记录器已可移植并有合成包负对照，但真实 12 文件证据包未产出。
16. **Tailscale Serve 未启用**：三端已接入，但正式 Runtime 发布需 Qoder 门禁与用户确认。

## 5. 风险登记

| 风险                                  | 影响 | 处置                                                   |
| ------------------------------------- | ---- | ------------------------------------------------------ |
| 无 Token 误暴露控制面                 | 高   | 未配置 `REMOTE_TOKEN` → 控制接口 503                   |
| 游戏脚本借 Cookie 调管理 API          | 高   | 预览独立端口 + 写接口 Origin 校验                      |
| 预览路径穿越 / 点文件 / junction 逃逸 | 高   | 统一 `resolveStaticFile`（realpath + 边界 + 点段拒绝） |
| Worker 崩溃留孤儿 CLI 进程            | 高   | cli-runner 父进程看门狗 + 启动时租约收敛               |
| 旧任务与新任务同写一个工作区          | 高   | 项目锁 + 全局串行 worker                               |
| 回退误伤用户工程                      | 中   | 回退前自动备份；禁止 git reset --hard / clean -fd      |
| 不同项目上下文串扰                    | 中   | projectId 隔离 + 每项目 memory + 独立 cwd 会话         |

## 5. 里程碑

- M0 部署与最小生成（完成）
- M1 Sprint 01：安全远程任务通道 + 真机验收（完成，13/13）
- M2 Sprint 02：接管模式、预览隔离、快照回退、孤儿收敛（代码完成，待真机与安全审计）
- M3 Sprint 03：Connect L2 + Vision 集成（B10 收口候选，待 Qoder 独立门禁与真机 HTTPS）
- M4 跨互联网协同（外部组网评估，不在仓库内自建 Relay）

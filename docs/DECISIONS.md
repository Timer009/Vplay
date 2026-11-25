# Vplay Studio · 决策记录（ADR）

格式：编号 / 日期 / 状态 / 决策 / 理由 / 后果。

## ADR-001 以 OpenGame 为内核，Apache-2.0 继承

- 日期：Sprint 01
- 状态：已采纳
- 决策：保留上游 `LICENSE`（Apache-2.0，含 Google LLC / Qwen / OpenGame contributors
  版权声明）与原始来源说明，不更换许可证。
- 理由：合规、可审计，便于后续开源协作。
- 后果：所有新增文件不带冲突许可证；发布时保留 NOTICE 链。

## ADR-002 远程任务不再「注入文本」，改走正式用户消息入口

- 日期：Sprint 01
- 状态：已采纳
- 背景：旧实现由 `nonInteractiveCli.ts` 在当轮 prompt 末尾拼接
  `[REMOTE INSTRUCTIONS]` 文本块。实测模型把它识别为提示词注入并拒绝执行。
- 决策：删除该注入逻辑。远程任务由独立 worker 以
  `dist/cli.js -p "<task>" --yolo` 子进程执行，任务文本就是普通用户消息。
- 理由：模型拒绝的根因是「角色与上下文不可信」，不是网络或队列；
  只有走正式入口才能获得一致的 Agent 行为与工具权限。
- 后果：远程任务与本地 `-p` 生成完全同构；代价是每个任务启动一次 CLI 进程。

## ADR-003 鉴权在 HTTP 层，文本永远不能建立信任

- 日期：Sprint 01
- 状态：已采纳
- 决策：所有控制接口要求 `Authorization: Bearer <REMOTE_TOKEN>`（或等价 Header /
  登录 Cookie）。任何形如「TRUSTED REMOTE INSTRUCTION」的正文都只是普通 prompt
  内容，不具备任何权限含义。
- 后果：伪造文本无法绕过认证；测试用例覆盖该场景。

## ADR-004 未配置 Token 时禁用，而不是降级

- 日期：Sprint 01
- 状态：已采纳
- 决策：`REMOTE_TOKEN` 缺失/为空时，服务只提供 `/console` 与 `/health`，
  其余接口返回 503 并说明原因；不生成默认 Token，不打印 Token。
- 理由：默认安全。避免「忘了配」变成「公网裸奔」。
- 后果：首次使用需显式设置环境变量。

## ADR-005 默认只监听 127.0.0.1

- 日期：Sprint 01
- 状态：已采纳
- 决策：默认 `REMOTE_HOST=127.0.0.1`；`0.0.0.0` 必须显式设置并打印警告。
- 理由：减少暴露面，符合「不开放公网端口」。
- 后果：手机同网段访问需用户临时显式开启，并在报告中说明。

## ADR-006 任务持久化与重启语义

- 日期：Sprint 01
- 状态：已采纳
- 决策：任务存于 `.opengame/remote/tasks.json`，写入采用「临时文件 + rename」原子替换。
  服务启动时把 `running/verifying` 就地改为 `interrupted`，**不自动重跑**；
  `queued` 任务保留并继续按序执行（它们从未执行过）。
- 理由：避免重启后重复修改游戏文件或重复计费。
- 后果：需要用户显式重发中断的任务。

## ADR-007 串行执行，不并发

- 日期：Sprint 01
- 状态：已采纳
- 决策：同一时间只运行一个 CLI 子进程。
- 理由：生成会写入同一工作区，并发会产生文件竞争；也便于手机端理解进度。
- 后果：长任务会排队；状态机中体现 `queued`。

## ADR-008 传输层可替换，不自建公网 Relay

- 日期：Sprint 01
- 状态：已采纳
- 决策：远程通道只依赖 HTTP + Bearer Token；跨互联网场景评估成熟安全组网方案，
  本项目不安装网络服务、不改防火墙/代理。
- 后果：未来接入 Tailscale 等只需换前置链路。

## ADR-009 静态产物鉴权采用登录 Cookie

- 日期：Sprint 01
- 状态：已采纳
- 决策：`POST /auth/verify` 校验 Token 后下发 `HttpOnly; SameSite=Strict` Cookie；
  静态文件与产物页面用 Cookie 鉴权，避免把 Token 放进 URL（防止日志/Referer 泄露）。
- 后果：不同浏览器需各自登录一次；Token 本身仍可放在 Header 中供脚本使用。

## ADR-010 验收口径：模拟 ≠ 真机

- 日期：Sprint 01
- 状态：已采纳
- 决策：本 Sprint 只用本机 HTTP、移动端视口模拟与自动化测试验收，
  报告中明确标注「未做真机局域网验收」。
- 理由：用户不在家，不能执行真实手机测试；不得虚构证据。
- 后续：Sprint 01 真机验收已于 2026-11-26 完成（13/13），见 Sprint 01 报告第 13 节。

## ADR-011 预览面必须是独立源 + 写接口 Origin 校验

- 日期：Sprint 02
- 状态：已采纳
- 背景：Cookie 不区分端口。仅把游戏放到 `:8788`，页面仍能对 `:8787` 发起同站请求。
- 决策：预览独立进程/端口，只读、无管理接口；控制面所有写操作校验 `Origin`
  必须与 `Host` 同源（无 Origin 的脚本请求放行）。
- 后果：游戏页无法借登录 Cookie 调管理 API；控制台仍同源可用。

## ADR-012 Adopt Mode 只接受 projectId，导入只能本机执行

- 日期：Sprint 02
- 状态：已采纳
- 决策：`VPLAY_HOME/projects.json` 保存受控映射；HTTP 只接受 `projectId`，
  `/projects/import` 永远 403；导入通过 `node remote/cli.cjs project import`。
- 理由：避免远程调用方指定任意系统路径。
- 后果：新增项目需要本机操作；远程只能对已注册项目下指令。

## ADR-013 导入以复制为准，原始工程零改动

- 日期：Sprint 02
- 状态：已采纳
- 决策：导入前哈希原始工程 → 复制到 `projects/<id>/src` → 再哈希；
  两次必须一致，且导入后原始工程哈希不变（`originalUnchanged=true`）。
- 后果：AI 只改副本；用户原工程永远不被 Vplay 触碰。

## ADR-014 快照排除构建产物，回退不依赖 git

- 日期：Sprint 02
- 状态：已采纳
- 决策：快照排除 `.git`、`node_modules`、`.opengame`、`dist`；回退前自动备份；
  回退恢复新增/修改/删除文件并校验哈希；禁止 `git reset --hard` / `git clean -fd`。
- 理由：用户工程可能不是 git 仓库，且构建产物不应被回退。
- 后果：Vite 项目回退后需要重新构建 dist（本 Sprint 不自动构建）。

## ADR-015 孤儿进程用「看门狗 + 租约」而非平台特性

- 日期：Sprint 02
- 状态：已采纳
- 决策：CLI 包一层 `cli-runner`，子进程随父进程消失而自杀；服务启动时回收
  过期租约，且只在命令行匹配 runner/taskId 时才杀进程。
- 理由：Windows Job Object 需要原生依赖；纯 Node 方案更可移植。
- 后果：极端情况下（runner 也被强杀）依赖下次启动回收。

## ADR-016 公开模式禁用无约束 --yolo

- 日期：Sprint 02
- 状态：已采纳
- 决策：`VPLAY_PUBLIC_MODE=1` 时批准模式降为 `auto-edit`，且只允许对受控
  （导入）项目执行任务；非受控工作区直接 `POLICY_VIOLATION`。
- 后果：家庭局域网验收默认非公开模式，仍可使用 yolo。

## ADR-017 连续开发：会话续接 + 项目记忆双保险

- 日期：Sprint 02
- 状态：已采纳
- 决策：同一项目第二轮起追加 `--continue --chat-recording` 复用 OpenGame 会话；
  同时把最近 3 轮摘要写入任务上下文，避免会话不可用时丢失连续性。
- 理由：不同项目的 cwd 不同，会话天然按项目隔离，不会串扰。
- 后果：会话损坏时仍能靠记忆上下文继续；成功率更高但多一次上下文开销。

## ADR-018 子进程最小环境变量 + 日志脱敏（P0-4）

- 日期：Sprint 02 安全加固
- 状态：已采纳
- 决策：CLI 子进程环境变量改为白名单放行；`REMOTE_TOKEN`、`REMOTE_TOKEN_FILE`、
  `REMOTE_EXECUTOR_CMD`、`VPLAY_*` 一律不继承。日志写入前对 Token、`sk-*`、
  `*_API_KEY=`、`vplay_session=` 脱敏，单任务上限 5 MB。
- 理由：审计实测「Token 进环境 → 进日志 → 被 `/game` 读走」可直达主机 RCE。
- 后果：模型 Key 仍在 CLI 进程中（调用模型必需），完整隔离需要凭据代理 + OS 沙箱，
  本轮未建立；因此禁止公网执行。

## ADR-019 短期 Session + Host/Origin 校验（P1-1/2/3）

- 日期：Sprint 02 安全加固
- 状态：已采纳
- 决策：登录下发随机 Session（服务端 `Map<sha256(id)>`，TTL 4h / 空闲 2h，可吊销）；
  Cookie 值不再等于主 Token；登录与任务使用独立限流桶；Host 白名单 + 写接口 Origin 同源；
  登出要求鉴权。
- 后果：泄露 Cookie 不再等于泄露主密钥；HTTP 下无法加 `Secure`，需 HTTPS 前置。

## ADR-020 独立预览产物目录 + 扩展名白名单（P0-1/2/3）

- 日期：Sprint 02 安全加固
- 状态：已采纳
- 决策：预览只读 `<project>/.preview`（单工作区为 `<runtime>/.preview-legacy`），由
  `copyPreviewTree` 生成：跳过点文件 / node_modules / 链接，只复制扩展名白名单。
  预览在独立端口且无管理接口，写接口再加 Origin 校验。
- 理由：既隔离敏感文件，又不影响游戏运行；**不使用 CSP `sandbox`**，避免破坏
  localStorage / 关卡解锁 / 触控 / 横屏。
- 后果：Vite 项目需先构建 dist；每次任务与回退后需重建预览（已自动化）。

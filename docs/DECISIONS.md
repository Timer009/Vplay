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

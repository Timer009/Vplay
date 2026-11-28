# 可信实验环境（B12 准备件 / B14 加固）

> 本目录只包含**可审阅**的检查/启动/停止/清理/恢复脚本与配置样例。
> B12/B14 **未执行**任何管理员操作、账号创建、ACL/防火墙修改、系统组件安装或 Serve/Funnel。
> 当前隔离状态：**NOT_IMPLEMENTED**（见 `docs/TRUST-BOUNDARY-B11.md`）。

## B14 变更（C13 L-1/L-2）

- `cleanup-lab.ps1` 只允许清理 `lab-config.json` 中**精确声明的 `labRoot`**；必须存在
  `.vplay-lab-marker`（由 `start-lab.ps1` 创建，含 schemaVersion/labRoot），路径会规范化；
  根目录、父目录链或实验树内出现任何重解析点（symlink/junction）一律拒绝。
  默认 DryRun，`-Approve` 才删除。
- `lab-config.example.json` 的 `publicMode` 改为 `false`，与 `start-lab.ps1`
  （`VPLAY_PUBLIC_MODE=0`）一致；不再提供无法启动的配置样例。
- 未创建真实 lab、未执行真实清理；负对照只用 G 盘临时虚拟目录验证。

## B16 变更（C15 P3-01/P3-02 + G1 工具面）

- 修复 `isolation-check.ps1` / `recover-lab.ps1` 的 `$home` 与只读自动变量 `$HOME`
  冲突：改用 `$vplayHome = <labRoot>\home`，检查/恢复对象不再误指向用户主目录。
- 默认 lab 根移出正式工作区：`G:\vplay-lab`（Spacer 副本 `G:\vplay-lab\spacer`）。
- `cleanup-lab.ps1` 增加拒绝：正式工程及其子目录、`G:\AI_GAME` 及其子目录、
  用户主目录及其子目录、磁盘根、路径穿越段（`..`）、父链/树内重解析点；
  仍要求配置精确 `labRoot` + marker，默认 DryRun。
- 未改变隔离状态：`OS_ISOLATION=NOT_IMPLEMENTED`；未创建账号/ACL/防火墙规则。

## 文件

| 文件                      | 作用                                                                      | 是否修改系统 |
| ------------------------- | ------------------------------------------------------------------------- | ------------ |
| `isolation-check.ps1`     | 只读检查：账号/管理员状态、OS、可选功能、ACL、端口、Tailscale、防火墙计数 | 否           |
| `lab-config.example.json` | 实验配置样例（路径/端口/预算；无密钥）                                    | 否           |
| `start-lab.ps1`           | 默认 DryRun；仅在 `-Approve` 时创建 lab 目录并打印启动命令                | 仅 lab 目录  |
| `stop-lab.ps1`            | 只停止 PID 文件中记录的进程                                               | 否（仅进程） |
| `cleanup-lab.ps1`         | 默认 DryRun；仅清理 `labRoot` 内文件                                      | lab 目录     |
| `recover-lab.ps1`         | 打印恢复检查命令（journal、锁、事件 anchor）                              | 否           |

## 设计边界

1. **不创建系统账号、不改 ACL、不改防火墙、不装组件、不启用 Serve**；这些动作必须在用户/管理员批准后单独执行。
2. 实验目录与正式工程/凭据分离：
   - 正式工程：`C:\Users\<user>\Documents\...`（不入 lab）
   - 实验工作区：`<labRoot>\workspace`
   - 模型执行进程：建议使用独立低权限账号（**未实现**）
   - 证据目录：`<labRoot>\home\evidence`
   - 模型 API 凭据：仅一次性注入执行器环境；不写入 lab 配置文件
   - 预算：`maxRequestsPerTask` / `maxTokensPerTask`（由外层 provider 限额；**未实现**）
   - 网络：默认只允许回环 + 模型端点；**未实现**命名空间/防火墙隔离
3. `start-lab.ps1` 默认 `-DryRun`；`-Approve` 只创建目录与写 PID 文件，不启动真实模型（`REMOTE_AUTORUN=0`、`PREVIEW_ACCESS_KEY` 必填）。
4. 任何“OS 隔离已启用”的声明必须有本目录检查脚本 + 负对照证据；否则保持 `NOT_IMPLEMENTED`。

## 推荐审批顺序（用户）

```text
1) 管理员批准创建低权限账号与 ACL（本文档不执行）
2) isolation-check.ps1 -LabRoot <path> -User <agentUser> 留证
3) start-lab.ps1 -Approve -LabRoot <path>（仅目录/PID）
4) 以 agentUser 启动模型执行器（另行配置凭据与预算）
5) 负对照：模型进程不可读 EVIDENCE_HMAC_KEY、不可写 evidence、不可访问正式工程
6) 任一失败 → stop-lab.ps1 / cleanup-lab.ps1，并标记 NOT_IMPLEMENTED
```

## 最小隔离实施方案（B14 提案，未执行）

阶段 0（当前，零系统改动）：仅回环、无真实模型、无 Serve/Funnel；证据用 HMAC 链 +
外部保存的 anchor 副本证明未被改写；隔离状态保持 `NOT_IMPLEMENTED`。

阶段 1（需管理员）：创建标准本地用户 `vplay-lab`（不加 Administrators/Remote Desktop Users）；
实验根放在仓库之外（例如 `C:\vplay-lab`）；ACL 只授予该用户 lab 根，拒绝读取正式工程与
操作员目录；`cleanup-lab.ps1` 已按精确 `labRoot` + marker + 重解析点拒绝执行。

阶段 2（进程与凭据）：整个 lab 以 `vplay-lab` 启动；`EVIDENCE_HMAC_KEY` 只在 lab 会话内
一次性注入并在启动后移除；操作员账号不设置该 key；`node` 使用绝对路径 + 版本断言；
PID 文件记录 `{pid, startedAt, exePath}`，停止时校验后再 `taskkill /T`；
进程约束使用 Job Object kill-on-close、单任务墙钟上限、并发 1、`REMOTE_AUTORUN=0`。

阶段 3（网络）：优先把模型调用放到另一台机器/Windows Sandbox/VM（NAT 仅放行模型端点），
本机 lab 保持离线；若必须本机联网，只能经本地审计代理并记录目的域名/IP，
在报告中继续标注「出站隔离 NOT_IMPLEMENTED」，不得声称已隔离。

阶段 4（证据）：证据目录由 lab 身份可写，封存副本写到操作员目录并对 lab 身份拒绝写入；
运行结束生成递归哈希清单 + `events.verify()`（持 key）+ anchor 副本 + seal.json 签名；
负对照至少各一条：lab 身份读正式工程被拒、写封存目录被拒、读操作员目录被拒、
`whoami /groups` 不含 S-1-5-32-544。

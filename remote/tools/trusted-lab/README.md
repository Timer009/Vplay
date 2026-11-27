# 可信实验环境（B12 准备件）

> 本目录只包含**可审阅**的检查/启动/停止/清理/恢复脚本与配置样例。
> B12 **未执行**任何管理员操作、账号创建、ACL/防火墙修改、系统组件安装或 Serve/Funnel。
> 当前隔离状态：**NOT_IMPLEMENTED**（见 `docs/TRUST-BOUNDARY-B11.md`）。

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

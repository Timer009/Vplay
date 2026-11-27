# Vplay Studio · 当前任务

> Sprint 03C — Vision 最终集成与 Connect L2 验收准备（B11）
> 分支：`sprint-03-b11-candidate`　基线：`33523cd`（B10 候选）
> 负责人：唯一开发 Agent（Trae）

## 1. 本轮目标

对比 E07 v0.2.1 与 B10 实际实现，在不覆盖 B10 能力的前提下完成 Vision 最终接线；
逐项核对 C10-01..C10-11 与 C09 B-01..B-15；准备 Connect L2 私有 HTTPS 验收；
评估可信实验隔离并如实标注；不扩展产品功能。

## 2. 任务清单

| #   | 任务                                                                               | 状态                      |
| --- | ---------------------------------------------------------------------------------- | ------------------------- |
| 1   | 采用 `@vplay/vision` 0.2.1（vendored，无宿主补丁），保留 B10 票据/锁/hashTree/回退 | ✅                        |
| 2   | 宿主 delta：精确 operation 重放 + 前后 digest + 上下文窗口扫描                     | ✅                        |
| 3   | 预览认证：0.2.1 `previewAuth` + 项目级 `/p/<id>/` 路径                             | ✅                        |
| 4   | 严格 verified：无缺陷专属断言时仅截图变化不算修复                                  | ✅                        |
| 5   | C10-01 SSE 过滤/吊销/连接上限/截断提示                                             | ✅（B10 已做 + B11 补强） |
| 6   | C10-02 `/status` 作用域与 prompt 回显                                              | ✅                        |
| 7   | C10-03 幂等作用域 `(createdBy, projectId)`                                         | ✅                        |
| 8   | C10-04 Vision 证据 owner 权限                                                      | ✅                        |
| 9   | C10-05 allowedFiles 路径归一化                                                     | ✅                        |
| 10  | C10-06 / C10-09 设备存储竞态与 fail-closed                                         | ✅                        |
| 11  | C10-07 事件 seq 入哈希 / anchor 尾删检测 / 跨进程追加                              | ✅                        |
| 12  | 非入口预览资源完整性（manifest 逐文件）                                            | ✅                        |
| 13  | 可移植 Qoder 校验器/记录器 + SKIP 不计 PASS                                        | ✅                        |
| 14  | Tailscale 只读状态、HTTPS 拓扑、启动/停止/恢复、ACL 建议                           | ✅（文档/脚本）           |
| 15  | 隔离 HTTPS 测试服务                                                                | ✅ 准备（未启用 Serve）   |
| 16  | 可信实验隔离评估                                                                   | ✅ 文档，能力未实现       |
| 17  | 真实模型 / 真机 T-1..T-10 / Qoder 门禁                                             | ⏳ 未授权/待用户          |

## 3. 验收边界（如实说明）

- 未调用真实模型；Vision 使用离线假模块 + 真实 Spacer 独立副本策略测试。
- 未启用 Tailscale Serve/Funnel，未修改 Tailnet ACL/防火墙；正式 Runtime 仍只监听回环。
- **OS 隔离未实现**：环境白名单不是沙箱，不宣称证据不可篡改。
- 未修改 Spacer 正式仓库，未提前实现陆地回收。

## 4. 完成后

见 `G:\AI_GAME\VPLAY-SPRINT03-B11-REPORT.md`。停止，等待用户/ChatGPT 审核。

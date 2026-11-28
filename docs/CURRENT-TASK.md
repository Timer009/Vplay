# Vplay Studio · 当前任务

> Sprint 03C — 最终定点修复与发布候选冻结（B16）
> 分支：`sprint-03-b16-candidate`　基线：`792d11c`（B14 冻结运行代码）
> 负责人：唯一开发 Agent（Trae）

## 1. 本轮目标

读取 B15 / C15 / E12 / D19，仅修复 C15 唯一阻塞 G1（S06/S14）与最小实验工具缺陷
（`$home`、默认 labRoot、cleanup 授权范围），纳入 B15 发布文档。不修改
vendor/vision、guard、strict-repair、模型协议与控制面功能；不新增功能、不实现 land-pin。

## 2. 任务清单

| #   | 任务                                                                   | 状态        |
| --- | ---------------------------------------------------------------------- | ----------- |
| 1   | 复现 S06/S14（B14 基线）并保留修复前证据                               | ✅          |
| 2   | S06：活进程长租约不因 >10min 被判定失效；死 pid 才失效                 | ✅          |
| 3   | S14：旧版活 pid 标记有界回收；新标记用 owner + 心跳 + 目录年龄区分     | ✅          |
| 4   | 保留 owner token、原子写、OCC、journal、恢复与并发保护                 | ✅          |
| 5   | S24 released 后写入 <1000ms                                            | ✅（103ms） |
| 6   | 专项测试：长租约、死进程、PID 复用、并发回收、异常退出                 | ✅          |
| 7   | 修复 isolation-check/recover-lab `$home` 冲突；默认 labRoot 移出工作区 | ✅          |
| 8   | cleanup 精确授权 labRoot，拒绝正式工程/用户目录/磁盘根/穿越/reparse    | ✅          |
| 9   | 纳入 B15 ATTRIBUTION、README 指引、修改声明；更新清单                  | ✅          |
| 10  | 全量 remote、lint/build/bundle、S06/S14/S24、推送与报告                | ✅          |

## 3. 验收边界

- 冻结：vendor/vision、guard、strict-repair、模型协议、控制面功能未改。
- 未调用真实模型；未启用 Serve/Funnel；未安装组件；未修改系统权限/账号/ACL/防火墙。
- 未合并 main、未打正式 tag；`OS_ISOLATION=NOT_IMPLEMENTED`。
- 未修复 C15 其他 P2/P3；未实现 land-pin。

## 4. 完成后

见 `G:\AI_GAME\VPLAY-SPRINT03-B16-REPORT.md`。停止，等待 C16/E13 独立复验。

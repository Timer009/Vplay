# Vplay Studio · 当前任务

> Sprint 03C — Vision 0.2.2 集成与最终演示门禁收口（B14）
> 分支：`sprint-03-b14-candidate`　基线：`65d4875`（B13 候选）
> 负责人：唯一开发 Agent（Trae）

## 1. 本轮目标

以 B13 候选为唯一基线，读取 B13 / C13 / E10 与 E10 `B13-INTEGRATION-GUIDE.md`：
采用 `@vplay/vision@0.2.2`，统一 strict-repair 语义；关闭 C13-P1-01..05 与
trusted-lab L-1/L-2；完成演示前开发方预检。不新增产品功能、不调用真实模型。

## 2. 任务清单

| #   | 任务                                                                                                             | 状态 |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | 校验 0.2.2 tgz/source 哈希，vendor 0.2.2 并保留 0.2.1 回退                                                       | ✅   |
| 2   | 对照 B13 补丁：compare 删除（原生）、guard 统一为 CDP 全资源类型补丁                                             | ✅   |
| 3   | 统一 strict-repair / defectAssertionIds / missingAssertions / newFailures / repair_verified / repair_unconfirmed | ✅   |
| 4   | 删除宿主第二套修复判定 `strictRepairVerification`                                                                | ✅   |
| 5   | 保留独立宿主安全校验、operations/digest/path、锁/快照/journal/原子发布/回退                                      | ✅   |
| 6   | 保留服务端项目绑定与非 admin Vision 票据                                                                         | ✅   |
| 7   | 重定向矩阵：document / 子资源 / fetch / 同源跨项目 / 跨源多跳                                                    | ✅   |
| 8   | C13-P1-01 锁活锁与 deadline（S24 106ms）                                                                         | ✅   |
| 9   | C13-P1-02/03/04 证据链 anchor 收养/算法降级/缺失签名/无 key                                                      | ✅   |
| 10  | C13-P1-05 独立预检（B34/B35b/E09 B-1）                                                                           | ✅   |
| 11  | trusted-lab L-1/L-2：cleanup 精确 labRoot/marker/重解析点；配置一致                                              | ✅   |
| 12  | 最小隔离实施方案（文档提案，未执行）                                                                             | ✅   |

## 3. 验收边界

- 未调用真实模型；未启用 Serve/Funnel；未合并 main；未修改系统权限/防火墙。
- 隔离状态仍为 `NOT_IMPLEMENTED`；0.2.2 不是沙箱。
- 所有新增大型数据与预检沙箱位于 G 盘。

## 4. 完成后

见 `G:\AI_GAME\VPLAY-SPRINT03-B14-REPORT.md`。停止，等待 Qoder 独立验收。

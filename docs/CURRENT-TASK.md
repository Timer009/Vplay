# Vplay Studio · 当前任务

> Sprint 03C — 参赛候选定向收口（B13）
> 分支：`sprint-03-b13-candidate`　基线：`64cc53c`（B12 候选）
> 负责人：唯一开发 Agent（Trae）

## 1. 本轮目标

以 B12 候选为唯一基线，读取 B12 / C12 / E09，仅关闭比赛前阻断项：
Vision 增量校验改为结构化语义比较、修复判定绑定缺陷断言、verify 语义澄清、
Vision 票据项目绑定、跨源重定向请求前拦截、HMAC 强制验证。不实施新功能。

## 2. 任务清单

| #   | 任务                                                                                     | 状态 |
| --- | ---------------------------------------------------------------------------------------- | ---- |
| 1   | 关闭 C12-P1-01..07（跨行标签/协议、结构删除、缺陷绑定、compare、HMAC）                   | ✅   |
| 2   | 结构化解析 + before/after 语义差分，保留 operations/digest/path 精确检查                 | ✅   |
| 3   | 修复成功绑定 `defectId` + 断言 `before=false/after=true`；删除/缺失/新增 critical 均拒绝 | ✅   |
| 4   | `mode:verify` 改为 `verify_passed/verify_failed`，禁止 `repair_verified` 混用            | ✅   |
| 5   | Vision 票据服务端项目绑定；内部 runner 票据 `admin:false`                                | ✅   |
| 6   | 跨源重定向：`route.fetch({maxRedirects:0})` 逐跳检查、请求前 abort                       | ✅   |
| 7   | HMAC：链含 hmac/anchor 时无 key 必须失败；`requireHmac` 构造即拒绝                       | ✅   |
| 8   | 复用现有实验准备脚本；不预制 Spacer 陆地回收                                             | ✅   |

## 3. 验收边界

- 未调用真实模型；未启用 Serve/Funnel；未合并 main；未移动正式工程。
- 临时工作区与依赖优先 G 盘（`G:\AI_GAME\VPLAY-B13-REPRO`）。
- 未新增游戏功能；未修改系统级配置。

## 4. 完成后

见 `G:\AI_GAME\VPLAY-SPRINT03-B13-REPORT.md`。停止，等待用户/ChatGPT 审核。

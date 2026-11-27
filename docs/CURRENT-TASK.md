# Vplay Studio · 当前任务

> Sprint 03B — Connect L2 + Vision 主工程集成
> 分支：`sprint-03-connected-agent`　基线：`abc8e24`（Sprint03A 安全基础）
> 负责人：唯一开发 Agent（Trae）

## 1. 本轮目标

实现手机/电脑双向任务协同（持久 SSE、统一 ID、设备授权），以及 Vision 0.2.0
与真实工程 Agent 的统一运行闭环（analyze / verify / 受限 repair）。

## 2. 任务清单

| #   | 任务                                                     | 状态                |
| --- | -------------------------------------------------------- | ------------------- |
| 1   | 持久化 SSE 事件流（seq/Last-Event-ID/心跳/去重）         | ✅                  |
| 2   | 统一 taskId / projectId / versionId / artifactId         | ✅                  |
| 3   | 设备身份、项目授权、任务 owner 过滤（P1-04）             | ✅                  |
| 4   | Console：SSE 实时刷新、版本/产物 ID、Vision 报告与截图   | ✅                  |
| 5   | Vision 0.2.0 vendoring（相对路径，无绝对路径）           | ✅                  |
| 6   | vision-service：analyze / verify / 受限 repair、skipLock | ✅                  |
| 7   | 原子 apply + journal + 全量 manifest + 失败回退          | ✅                  |
| 8   | 预览 CSP、同源浏览器守卫（E05）、截图/源码脱敏、同意门禁 | ✅                  |
| 9   | 项目外 evidence + 事件哈希链 + HMAC 锚定（P1-11）        | ✅                  |
| 10  | C08 X-01..X-05 契约回归                                  | ✅                  |
| 11  | Tailscale 真实登录 / MagicDNS / HTTPS Serve              | ⏳ 等待用户认证     |
| 12  | C08 40 项全量验收（网络 7 项 + 真实模型）                | ⏳ 待网络与预算授权 |
| 13  | Sprint02 合并 main（ff-only）                            | ⏳ 待用户授权       |

## 3. 验收边界（必须如实说明）

- Tailscale 已安装但**未登录**；未启用 Serve/Funnel，未向 tailnet 发布 Runtime。
- 未进行真实模型调用（无 API Key 授权）；Vision 闭环使用注入的离线假模块验证。
- 证据链为宿主 HMAC + 哈希链，**不是** OS 级不可篡改存储；不宣称证据不可篡改。
- 未修改 Spacer 正式仓库，未提前实现陆地回收。

## 4. 完成后

见 `G:\AI_GAME\VPLAY-SPRINT03-B09-REPORT.md`。停止，等待用户/ChatGPT 审核。

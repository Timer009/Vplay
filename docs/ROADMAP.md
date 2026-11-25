# Vplay Studio · 路线图

目标：NVIDIA DGX Spark「最佳 AI 原生游戏创作工具」。
排序原则：优先做**不需要图像/视频 Key** 也能提升体验的部分。

## Sprint 01（当前）— 安全远程任务通道

- [x] 项目接管、分支与文档基线
- [x] 诊断远程任务阻塞的四类原因并留证据
- [x] `REMOTE_TOKEN` 鉴权；未配置即禁用远程控制
- [x] 任务 ID / 状态机 / 参数校验 / 去重 / 串行 / 持久化
- [x] 重启不重放历史任务（running → interrupted）
- [x] 移动端控制台适配鉴权与任务状态
- [x] 本机 HTTP + 移动端视口模拟验收（非真机）
- [ ] 真机局域网验收（阻塞：用户不在家，需人工执行）

## Sprint 02（建议）— 生成质量与可解释性

- 生成过程结构化事件（planning → coding → verifying），供手机端逐步展示
- 失败任务的自动重试策略（仅对可重试错误，例如网络 5xx）
- PostVerify 规则扩充：`assets/` 目录约定、`gameConfig.json` schema 校验
- 生成产物截图（无图像 Key 时用 Canvas 占位渲染）

## Sprint 03（建议）— 模板与 Skill 生态

- 模板库扩充（平台跳跃、塔防、解谜），每个模板附最小可玩 demo
- Debug Skill 规则库与 PostVerify 共用一份 `protocol.json`
- Game Skill 的自动评测：可玩性/帧率/输入响应

## Sprint 04（建议）— 跨互联网协同（评估为主）

- 评估成熟安全组网（Tailscale / Cloudflare Tunnel / WireGuard）作为传输层
- 传输层可替换：远程通道只依赖「带 Bearer Token 的 HTTP」，不绑定局域网
- **不在仓库内自建公网 Relay，不修改防火墙/代理**

## 非目标

- 不做多租户 SaaS
- 不内置公网暴露
- 不伪造图像/音频能力

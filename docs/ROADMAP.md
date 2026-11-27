# Vplay Studio · 路线图

目标：NVIDIA DGX Spark「最佳 AI 原生游戏创作工具」。
排序原则：优先做不需要图像/视频 Key 也能提升体验的部分。

## Sprint 01（已完成，真机 13/13）

- [x] 远程任务通道：Token 鉴权、任务 ID/状态机/去重/串行/持久化
- [x] 删除 `[REMOTE INSTRUCTIONS]` 文本注入，改走正式 `-p` 用户消息入口
- [x] iPhone Safari + OPPO Android 真机验收（2026-11-26）
- [x] 独立安全审计启动（进行中）

## Sprint 02（当前）— Project Adoption & Continuity

- [x] 基线归档：tag `sprint-01-accepted`，Sprint 01 真机结论入档
- [x] 孤儿 CLI 进程收敛（runner 看门狗 + 租约回收）
- [x] 项目锁，防止旧任务与新任务同写一个工作区
- [x] 工作区隔离：游戏工作区 / Vplay 源码 / 系统目录
- [x] 预览硬化：点文件、路径穿越、symlink/junction 逃逸
- [x] 预览面与控制面分源，写接口 Origin 校验
- [x] 禁止公开模式无约束 `--yolo`
- [x] Adopt Mode：导入静态 / 子目录入口 / Vite 工程，禁止 HTTP 传路径
- [x] 快照 / 差异 / 回退（回退前备份，不碰 git reset --hard）
- [x] 项目画像、项目记忆、连续多轮
- [x] Spacer 实战：两轮真实修改 + 两轮回退 + 哈希还原
- [x] Vite 最小工程：真实构建 + dist 预览
- [ ] Sprint 02 真机验收（待产品负责人执行，步骤见报告）
- [ ] 独立安全审计结论合并（Qoder，进行中）

## Sprint 03（建议）

1. **生成过程结构化事件**：把 planning / coding / verifying 作为事件流推给手机端。
2. **Vite 构建托管**：在受控沙箱内执行 `npm run build`，避免在用户工程直接跑脚本。
3. **多模态接入**：图像/音频 Key 就绪后接回素材生成（其他 Agent 独立研究）。
4. **扩散式回退**：支持按文件回退，而不只是整快照回退。
5. **跨互联网**：接入成熟组网方案（Tailscale / Cloudflare Tunnel），本仓库不自建 Relay。

## Sprint 03B — Connect L2 + Vision 集成（B09）

- [x] 持久化 SSE 事件流（seq / Last-Event-ID / 心跳 / 客户端去重）
- [x] 统一 taskId / projectId / versionId / artifactId
- [x] 设备身份、项目授权、任务 owner 过滤
- [x] 项目外 evidence + 事件哈希链 + HMAC 锚定
- [x] Vision 0.2.0 vendoring 与 host 契约（锁/原子写/全量 manifest/回退）
- [x] 预览 CSP、浏览器同源守卫、截图/源码脱敏、同意门禁
- [x] Console：SSE、版本/产物 ID、Vision 报告与截图
- [ ] Tailscale 登录 → Serve HTTPS → C08 网络 7 项复验
- [ ] 真实模型 Vision 闭环（预算授权后）
- [ ] C08 40 项全量验收与独立复审

## Sprint 03C（当前）— 安全与集成收口（B10）

- [x] 复现 C09 P0：455a187 并发丢快照（独立 worktree 20 轮命中 4 次）
- [x] 注册表锁所有权/活锁不可回收/崩溃恢复/提交原子性
- [x] 预览 staging 全量校验后原子发布；失败保持旧版本
- [x] Vite 构建摘要绑定源码；改源码未构建拒绝发布
- [x] 回退全程持项目锁；异步构建不阻塞 SSE/心跳
- [x] Worker settle 异常安全；journal 恢复与失败回退复核
- [x] Vision 宿主结构化增量校验（真实 Spacer 不再误报）
- [x] 禁止客户端 prevalidated 绕过；最终文件一致性校验
- [x] Vision `verify` 独立功能复验（不调用模型）
- [x] 短期预览票据注入浏览器 context；登出/吊销即时失效
- [x] 授权设备共享工程可见性；未授权无元数据
- [x] 证据 HMAC/指纹/全量 manifest/链校验 + 负对照
- [x] Qoder `verify-run.cjs` 契约适配器（合成包 PASS，篡改/降级 FAIL）
- [ ] Tailscale 双设备 HTTPS 验证（用户负责登录）
- [ ] Qoder 独立安全门禁；通过后才考虑私有 Serve
- [ ] 真实模型 Vision 闭环（预算授权后）

## Sprint 03D / B11（当前）— Vision 最终集成与 Connect L2 验收准备

- [x] 采用 Vision 0.2.1（vendored，无宿主补丁），保留短期票据/锁/hashTree/回退
- [x] 宿主 delta：精确 operation 重放 + 前后 digest + 上下文窗口扫描
- [x] 预览认证：`previewAuth` + 项目级 `/p/<id>/` 路径
- [x] 严格 verified：必须有缺陷专属功能断言
- [x] C10-01..C10-07、C10-09..C10-11 关闭；C10-08 部分（可移植工具 + 合成包）
- [x] 非入口预览资源完整性校验
- [x] 事件 seq 入哈希 + anchor 尾删检测 + 跨进程追加
- [x] Tailscale 三端接入状态、HTTPS 拓扑、启动/停止/恢复、ACL 建议
- [x] 隔离 HTTPS 测试服务（准备，未启用 Serve）
- [x] 可信实验隔离评估（能力未实现，如实标注）
- [ ] 真实模型 Vision 闭环（预算授权后）
- [ ] 手机端 T-1..T-10 与 Qoder 门禁
- [ ] 防火墙收敛（需用户批准）

## Sprint 03E / B12（当前）— 最终工程收口与可信实验准备

- [x] C11-01：快照 200 上限裁剪事务分序 + 读者租约
- [x] C11-02：运行时安全孤儿回收（写入标记/宽限期/只隔离/幂等/配额）
- [x] 跨 200 压测：10 进程 + 服务侧、diff/rollback、崩溃残留
- [x] Serve/代理 fail-closed（预览鉴权、HMAC、Host、回环）+ Secure Cookie
- [x] 事件 anchor 旧链兼容；HMAC 降级/独立验证器测试
- [x] 可信实验环境只读检查与启动/停止/清理/恢复脚本
- [x] 真实 Spacer 实验准备（副本/基线哈希/模型配置/F1–F10/证据流程）
- [ ] 真实模型 Vision 闭环（预算授权）
- [ ] 手机 T-1..T-10 与 Qoder 门禁
- [ ] 防火墙收敛 / 低权限账号或容器隔离（需批准）

## 非目标

- 不做多租户 SaaS
- 不内置公网暴露
- 不伪造图像 / 音频能力
- 不在用户工程里执行 `git reset --hard` / `git clean -fd`

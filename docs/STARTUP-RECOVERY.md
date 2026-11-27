# 启动与崩溃恢复

本文说明 Vplay Runtime 在不同崩溃阶段如何恢复，以及运维必须检查的目录。
所有恢复都是**失败关闭**：校验不通过时保留证据，不静默接受。

## 1. 启动顺序（`remote/server.cjs`）

1. 读取 `VPLAY_HOME/projects.json` 注册表；
2. 隔离未登记的快照目录 → `projects/<id>/.snapshot-orphans/`（`recoverOrphanSnapshots`）；
3. 回退 journal 恢复（`recoverInterruptedRollbacks`）：
   - 只有回退后完整校验通过才删除 `.rollback-journal.json`；
   - 失败保留 journal 并追加 `.rollback-recovery.log`；
4. 任务状态机：运行中/校验中的任务标记 `interrupted`，**不自动重跑**；
   同时写入 `task.interrupted` 事件；
5. 回收过期租约与孤儿 CLI 进程（`leases.cjs`）；
6. 预检监听地址（只允许回环或本机接口地址，禁止 `0.0.0.0`）；
7. 启动控制面、预览面与 SSE（`/events`）。

## 2. 关键文件

| 文件                                   | 作用                                             | 恢复策略                         |
| -------------------------------------- | ------------------------------------------------ | -------------------------------- |
| `projects/<id>/.rollback-journal.json` | 回退应用阶段                                     | 启动时按备份校验并恢复；失败保留 |
| `projects/<id>/.rollback-recovery.log` | 恢复失败证据                                     | 只追加，不删除                   |
| `projects/<id>/.snapshots/`            | 快照目录与 `<uid>.manifest.json`                 | 未登记目录隔离，不删除           |
| `runtime/locks/<id>.lock`              | 项目锁（owner token + heartbeat）                | pid 死亡或 10 分钟 TTL 后回收    |
| `.opengame/registry.lock`              | 跨进程注册表锁                                   | 仅「存在且稳定」的陈旧锁可回收   |
| `projects/<id>/.build-stamp.json`      | 最近一次成功 Vite 构建的输入摘要                 | 与当前源码不一致则拒绝发布       |
| `projects/<id>/.preview-stale.json`    | 最近一次发布失败原因                             | 只写证据，不自动删除业务数据     |
| `.opengame/leases/*.json`              | CLI 子进程租约                                   | 启动时回收孤儿进程               |
| `evidence/<project>/<task>/`           | 项目外证据（meta/events/report/anchor/manifest） | 只读校验；HMAC 仅证明宿主生成    |
| `evidence/**/apply-journal*.json`      | Vision 写入 journal                              | 启动时复核，标记 needs-review    |
| `events/events.jsonl`                  | SSE 事件哈希链                                   | 追加；损坏行跳过，不影响新事件   |

## 2.1 锁恢复语义（B10 / C09 B-01）

- **空文件或读不到 ≠ 陈旧**：只有两次读取内容一致、文件确实存在，且
  「空文件持续 >5s」或「损坏内容持续 >5min」才允许回收；
- 持有者 pid 不存在可立即回收；活进程超过 5 分钟硬上限才回收；
- 回收前 rename 到 `.stale-<pid>-<rand>`，再按观察到的 token 逐字比对，
  不一致或对方仍存活则放回，绝不删除；
- 释放只删除自己 token 的锁。

## 2.2 预览发布 / 回退（B10 / C09 B-02/B-03/B-04）

- 发布顺序：staging 构建 → staging 全量哈希校验 → 写临时 manifest →
  原子切换 `.preview` → 原子替换 manifest → `verifyPreview`；任一失败恢复旧版本；
- Vite 发布要求 `.build-stamp.json.srcDigest === 当前源码摘要`，否则拒绝；
- `rollback` 获取项目锁（worker/Vision 已持锁时传 `lockToken`），构建使用异步
  `spawn`，回退期间 SSE 心跳不受阻塞；journal 只有全部校验通过才删除。

## 3. Vision 任务崩溃

- apply 前写 `evidence/<project>/<task>/apply-journal.json`（含 root 与 before/after 摘要）；
- 写入使用临时文件 + fsync + rename，崩溃不会留下半写目标文件；
- 失败/异常必须调用 `registry.rollback` 并检查 `verified/previewReady`；
- 启动时 `recoverVisionApplies` 复核 journal：内容与 after 摘要一致 →
  `apply-journal.completed-unverified.json`；否则 → `apply-journal.needs-review.json`；
  **不自动改写源码**，交给快照与人工；
- Vision 不另行实现快照/回退系统。

## 4. 人工检查清单

```powershell
# 端口与进程
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 8787,8788 }
# 锁
Get-ChildItem "$env:VPLAY_HOME\runtime\locks"
# journal / 恢复日志
Get-ChildItem "$env:VPLAY_HOME\projects" -Recurse -Filter .rollback-journal.json
Get-ChildItem "$env:VPLAY_HOME\projects" -Recurse -Filter .rollback-recovery.log
Get-ChildItem "$env:VPLAY_HOME\projects" -Recurse -Filter .preview-stale.json
Get-ChildItem "$env:VPLAY_HOME\projects" -Recurse -Filter .build-stamp.json
Get-ChildItem "$env:VPLAY_HOME\evidence" -Recurse -Filter apply-journal*.json
# 证据
Get-ChildItem "$env:VPLAY_HOME\evidence" -Recurse -Filter anchor.json
Get-ChildItem "$env:VPLAY_HOME\evidence" -Recurse -Filter manifest.json
```

> `seq` 单调递增但允许空洞；调用方必须按注册表条目遍历，不得假设 `1..seq` 连续。
> 高并发可能残留 `registry.lock.stale-*`，不影响一致性，可在维护窗口清理。

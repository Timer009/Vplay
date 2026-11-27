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

| 文件                                   | 作用                                    | 恢复策略                         |
| -------------------------------------- | --------------------------------------- | -------------------------------- |
| `projects/<id>/.rollback-journal.json` | 回退应用阶段                            | 启动时按备份校验并恢复；失败保留 |
| `projects/<id>/.rollback-recovery.log` | 恢复失败证据                            | 只追加，不删除                   |
| `projects/<id>/.snapshots/`            | 快照目录与 `<uid>.manifest.json`        | 未登记目录隔离，不删除           |
| `runtime/locks/<id>.lock`              | 项目锁（owner token + heartbeat）       | pid 死亡或 10 分钟 TTL 后回收    |
| `.opengame/leases/*.json`              | CLI 子进程租约                          | 启动时回收孤儿进程               |
| `evidence/<project>/<task>/`           | 项目外证据（meta/events/report/anchor） | 只读校验；HMAC 仅证明宿主生成    |
| `events/events.jsonl`                  | SSE 事件哈希链                          | 追加；损坏行跳过，不影响新事件   |

## 3. Vision 任务崩溃

- apply 前写 `evidence/<project>/<task>/apply-journal.json`；
- 写入使用 staging + rename，崩溃不会留下半写目标文件；
- 失败/异常必须调用 `registry.rollback` 并检查 `verified/previewReady`；
- 若回退未通过：停止任务，保留 journal，标记失败并等待人工处理；
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
# 证据
Get-ChildItem "$env:VPLAY_HOME\evidence" -Recurse -Filter anchor.json
```

> `seq` 单调递增但允许空洞；调用方必须按注册表条目遍历，不得假设 `1..seq` 连续。
> 高并发可能残留 `registry.lock.stale-*`，不影响一致性，可在维护窗口清理。

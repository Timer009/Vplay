# Sprint 02 · B04 最终一致性修复报告

- 审计来源：`G:\AI_GAME\VPLAY-SECURITY-C04-REPORT.md`
- 审计基线：`sprint-02-project-adoption` @ `9c2a2315a89d6d4a83727a5a7d4d503ad9bb653a`
- 修复分支：`sprint-02-project-adoption`
- 日期：2026-11-26
- 结论：**NEW-C04-02（注册表并发一致性）、NEW-C04-01（正常资源误伤）、OBS-C04-01（恢复日志）全部修复**；
  新增 6 项定向回归，`npm run test:remote` 共 **55 项（54 通过 / 0 失败 / 1 跳过）**。
  仍**不宣称安全审计通过**，等待 Qoder 定向复审。

---

## 1. P0 · NEW-C04-02 注册表并发一致

### 1.1 根因（与 C04 判定一致）

| #   | 缺陷                                                                     | 修复                                                                                                                |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Windows 下 `openSync('wx')` 抛 `EPERM/EACCES` 被当作致命错误上抛         | 一律视为「抢锁失败」，退避重试                                                                                      |
| 2   | 陈旧锁回收时读到空/变化内容即 `rmSync`，会删掉别人刚建立的新锁（TOCTOU） | **只**在「pid 已死」或「5 分钟硬上限」时回收；空文件必须超过 5 秒才判定残留；不再因内容变化回收                     |
| 3   | `finally` 无条件删锁                                                     | 读回锁内容，**token 匹配才删除**；被他人接管时保留                                                                  |
| 4   | 清单按 `seq` 命名，重复 seq 会互相覆盖                                   | 清单改为 **`<uid>.manifest.json`**（全局唯一）；兼容读取旧的 `<seq>.manifest.json`                                  |
| 5   | 并发重叠时静默丢条目 / 产生「不可回退的成功快照」                        | 写入改为 **OCC 合并写**：写前重读合并、写后两次确认 uid；缺失即抛 `LOCK_LOST` 并重试；登记后立即 `validateSnapshot` |
| 6   | 序号冲突导致 `mkdir EEXIST`                                              | 分配序号时同时扫描注册表与已有目录；冲突则换号并改名目录                                                            |
| 7   | 崩溃残留的未登记目录                                                     | 启动时 `recoverOrphanSnapshots()` 隔离到 `<project>/.snapshot-orphans/`（不删除）                                   |

### 1.2 关键实现点

- `withHomeLock()`：token 化锁文件、`EPERM/EACCES/ENOENT/EBUSY` 退避、双读判定、rename 抢占后**归属复核**（误抢活锁则放回）。
- `snapshotInternal()`：序号唯一 → 目录非递归创建 → 清单以 uid 命名 → OCC 合并写 → 双确认 → 以 **uid** 校验快照完整性。
- 失败清理：任何异常删除本次目录与清单；`LOCK_LOST/EEXIST` 由 `snapshot()` 重试（最多 6 次）。

### 1.3 验收证据（本机，虚拟工程）

| 场景                                                    | 结果                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 5 路进程 × 连续 10 次                                   | 注册表 **51** 条 = 目录 **51** 个，seq 唯一，全部 `validateSnapshot` 通过，可回退 |
| 10 路进程 × 连续 10 次                                  | 注册表 **101** 条 = 目录 **101** 个，同上                                         |
| 10 路并发重复 5 轮                                      | **5/5 全部通过**（无失败、无重复 seq、无孤儿目录）                                |
| CLI 与 Server 混合（15 次 CLI 快照 + 并发 diff + 回退） | 注册表 **16** 条 = 目录 **16** 个，回退 `verified=true`                           |
| 持锁进程被 SIGKILL 后                                   | 下一次快照自动回收，耗时 < 10s，无人工干预                                        |
| 活锁（当前进程持有）                                    | 外部 acquire 超时 `REGISTRY_LOCKED`，**锁文件未被删除**，token 不变               |

> 说明：文件锁在极端时序下仍可能出现「短暂双持有」，因此一致性**不再只依赖锁**：
> OCC 合并 + 写后双确认 + uid 校验保证「已成功的快照一定可校验、可回退」。
> 这是本轮对 C04「不要只靠重试掩盖竞态」的正面回应。

## 2. P1 · NEW-C04-01 正常资源误伤

- 根因：名字级敏感规则不区分扩展名，`token.png` / `secret-door.png` / `credentials-ui.json` 在导入阶段被丢弃。
- 修复（`remote/lib/paths.cjs`）：
  - 名字级规则**只对配置类扩展名**生效（`.json/.js/.ts/.env/.yaml/.yml/.ini/.cfg/.conf/.properties/.txt/.toml/.xml/.pem/...`）；
  - 资产扩展名（`.png/.jpg/.webp/.gif/.svg/.mp3/.ogg/.wav/.woff2/.glb/.atlas` 等）**不做名字级判断**；
  - 真实凭据仍拦截：`credentials.json`、`token.json`、`service-account.json`、`firebase-config.js`、`id_rsa`、`.env`、`*.pem`；
  - 预览阶段保留内容特征扫描（`sk-*` / 私钥 / `AKIA*` / `AIza*` / `client_secret`）兜底。
- 证据（`concurrency.test.cjs`）：
  - `assets/token.png`、`assets/token-icon.png`、`assets/secret-door.png`、`data/credentials-ui.json` 导入后存在且预览 **200**；
  - `credentials.json` 仍被排除（预览 403/404）；
  - 既有 `C04-06`/`C04-09` 对应能力由 `security.test.cjs`、`hardening.test.cjs` 全绿保证。

## 3. P1 · OBS-C04-01 恢复日志与 journal

- `recoverInterruptedRollbacks()` 改为：
  - 只有 `applied.equal === true`（完整校验通过）才删除 journal；
  - 失败时**保留 journal**，并向 `<project>/.rollback-recovery.log` 追加
    `{event:'rollback-recovery-failed', reason, journalKept:true}`；
  - 返回 `{recovered:false, journalKept:true}`。
- 证据：注入无效 `backupSeq` → 首次恢复失败且 journal/日志保留；修正后再次恢复成功、journal 删除、工作区摘要等于快照 #1。
- 附带修复 OBS-C04-04：`skippedLinks` 统一为相对路径（不再出现 `//?/G:/...`）。

## 4. 并发一致性设计说明（回应「不要只靠延迟/重试」）

1. **互斥**：`withHomeLock` 提供跨进程串行；错误码按竞争处理，不把 EPERM 当致命。
2. **回收安全**：只回收「pid 已死」或「超硬上限」的锁；空文件有 5 秒宽限期；rename 抢占后复核归属。
3. **提交安全**：即使互斥短暂失效，写入采用「重读-合并-写-双确认-uid 校验」，冲突方检测到 uid 丢失就重试，**不会把丢失更新报告为成功**。
4. **命名安全**：清单按 uid 命名，彻底消除 seq 竞争导致的清单覆盖。
5. **失败安全**：失败清理目录/清单；孤儿目录启动时隔离；恢复失败保留 journal。

## 5. 测试与构建

| 命令                               | 结果                                   |
| ---------------------------------- | -------------------------------------- |
| `npm run test:remote`              | **55 用例：54 通过 / 0 失败 / 1 跳过** |
| `remote/test/concurrency.test.cjs` | 6 项全绿，连续 5 轮均为 6/6            |
| `npm run lint`                     | 退出码 0                               |
| `npm run build`                    | 退出码 0                               |
| `npm run bundle`                   | 退出码 0                               |
| `node dist/cli.js --version`       | `0.6.0`                                |

新增：`remote/test/concurrency.test.cjs`、`remote/test/fixtures/lock-holder.cjs`。

基线失败未变化（既存 26 项：15 项提示词快照 + 11 项 Windows symlink EPERM），本轮未新增。

## 6. 已知限制与残余风险（已更正此前表述）

1. **此前 `SPRINT-02-FINAL-HARDENING.md` §2 NEW-06 的「并发安全」结论过度乐观**：
   当时只有 2 路串行用例。现已补 5 路/10 路 × 10 次与 CLI+Server 混合测试，并改为
   「互斥 + OCC 提交」双保险；该文档结论已同步更正。
2. 文件锁仍是「应用层互斥」：极端时序下可能出现短暂双持有；一致性由 OCC 提交保证，
   但不是内核级锁。后续可替换为 OS 原生锁/单写入者服务。
3. **无 OS 沙箱 / 无凭据代理**：模型 Key 仍在 CLI 子进程环境中 → **禁止公网**。
4. HTTP 明文，Cookie 无 `Secure`；预览面无鉴权（只读）。
5. 仅内容命中的凭据（如 `config.json`）会留在本地工作副本与快照（明文），依赖 `VPLAY_HOME` ACL。
6. 含 symlink/junction 的工程仍**导入前拒绝**（明确产品限制）。
7. 仅 Windows 实测；Linux/macOS 需重跑并发与链接用例。
8. 单用户单实例，多租户/RBAC 未实现。

## 7. Qoder 定向复审入口

```powershell
$repo = 'C:\Users\54167\Documents\Trae-CN\default\OpenGame'
git -C $repo rev-parse HEAD       # 见文末 SHA
cd $repo
npm run test:remote
node --test remote/test/concurrency.test.cjs
# 连续 5 轮（复现 C04-11 强度）
for ($i=1; $i -le 5; $i++) { node --test remote/test/concurrency.test.cjs }
```

期望：每轮 `# pass 6 / # fail 0`；`test:remote` 55 项中 54 通过、1 跳过。

## 8. 提交

- 最终完整 SHA：`<!-- SHA -->`
- 分支：`sprint-02-project-adoption`（推送，不合并 main，不 force push）
- 未使用真实模型/真实密钥，未开放公网。

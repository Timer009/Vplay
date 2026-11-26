# Sprint 02 · 最终安全与数据完整性收尾（Task B03-S）

- 对应复审：`G:\AI_GAME\VPLAY-SECURITY-C03-REPORT.md`（审计基线 `90842ce`）
- 修复分支：`sprint-02-project-adoption`
- 修复前 HEAD：`340a51955245a697b1b0ef697f3c2061d0fc4646`
- 安全修复基线：`90842ce5eccaa5228b436e19f7a30cdf16db6029`
- 日期：2026-11-26
- 结论：C03 的 **6 项 FAIL（NEW-01～NEW-06）全部修复**，新增 6 个自动化回归用例；
  未降低任何既有断言。仍**不宣称安全审计通过**，等待 C04。

---

## 1. 基线核对

| 项           | 值                                                                                 |
| ------------ | ---------------------------------------------------------------------------------- |
| 分支         | `sprint-02-project-adoption`                                                       |
| 修复前 HEAD  | `340a519`（C03 复核时分支 tip）                                                    |
| 本轮改动范围 | `remote/lib/*.cjs`、`remote/server.cjs`、`remote/test/*`、`package.json`、`docs/*` |
| 未改动       | `packages/**` 业务代码、`main` 分支、Spacer 正式工程                               |
| 凭据         | 全部虚拟；未调用真实模型；未开放公网                                               |

## 2. 六项修复

### NEW-01 · 畸形 Host 击穿控制面/预览面（P1 局域网 / P0 公网）

- 根因：`new URL(req.url, 'http://' + req.headers.host)` 在 `try` 之外，且早于 Host 白名单；
  `attacker.example.127.0.0.1` 触发 WHATWG IPv4 解析失败 → 未捕获 `ERR_INVALID_URL` → 进程退出。
- 修复：
  - `server.cjs` / `preview.cjs` 不再用 Host 构造 URL；路径改为
    `req.url.split('?')[0]` + `URLSearchParams`，解析异常返回 400。
  - **预览面补 Host 白名单**（与控制面共用 `ALLOWED_HOSTS`，OBS-01 一并关闭）。
  - 两个 server 都注册 `clientError` → 返回 400 并关闭连接。
  - `process.on('uncaughtException')` 记录后清理 `server.lock` 并退出，避免半死状态。
- 现场复验（`vplay-verification/host-probe.cjs`）：

```json
{
  "before": 200,
  "attack": 400,
  "attackPreview": 400,
  "after": 200,
  "emptyHostRaw": "HTTP/1.1 400 Bad Request",
  "afterAll": 200
}
```

- 正向控制组仍在：`/health` 200、`/legacy/index.html` 200。

### NEW-02 · 损坏注册表让回退清空工作区（P1）

- 根因：`snapshotPath` 直接 `join(dir)`；`manifestOf` 缺文件返回 `{}` → 判定「所有文件都应删除」。
- 修复（`remote/lib/projects.cjs`）：
  1. `snapshotPath` 校验 `dir` 必须匹配 `^\d{3,}-[a-z0-9-]+$` 且 `isInside(.snapshots)`；
  2. `manifestOf` 缺失/损坏/空对象一律抛 `SNAPSHOT_*`（409），**不再回退为 `{}`**；
  3. `validateSnapshot()` 预验证：目录存在、清单可读、`entry.digest` 与清单一致、
     `hashTree(dir)` 与清单一致；
  4. 回退流程改为：**预验证 → 备份并验证备份 → 复制到临时 staging → 校验 staging → 写 journal →
     应用 → 全量哈希校验**；
  5. 任一步失败：用刚建立的 `pre-rollback` 备份自动还原，失败则保留 journal；
  6. 服务启动时 `recoverInterruptedRollbacks()` 按 journal 还原上次中途崩溃的回退。
- 证据（`hardening.test.cjs`）：越界 `dir`、清单缺失、快照内容被篡改三种情况均返回 4xx，
  且**工作区哈希前后完全一致**、`index.html` 仍在。

### NEW-03 · 含 junction/symlink 的工程无法快照（P1）

- 修复：
  - 导入前 `findLinks()` 扫描；存在链接 → 直接 `SYMLINK_UNSUPPORTED`，**不创建项目目录、不复制**；
  - `copyTree` 过滤链接（`lstat().isSymbolicLink()`），`walkFiles/hashTree` 不跟随链接；
  - 快照完成后对链接做「只删链接、不跟随」兜底（`unlink`/`rmdir`），记录 `skippedLinks`；
  - 快照失败自动清理半成品目录与清单。
- 证据：导入含 junction 的工程被拒且原工程哈希不变；导入后再加 junction，
  `snapshot` 成功且 `skippedLinks=['outlink']`，`rollback` 返回 `verified=true`，链接本身保留。

### NEW-04 · 预览发布带凭据的 JSON/JS（公网 P1 / 局域网 P2）

- 修复（`remote/lib/paths.cjs` + `projects.buildPreview`）：
  - 文件名级 deny：`service-account`、`firebase-config`、`*credential*`、`*secret*`、
    `*token*`、`*apikey*`、`.pem/.key/.p12/.crt/.log/.db` 等；
  - 内容级过滤：私钥头、`AKIA*`、`sk-*`（≥20）、`AIza*`、`client_secret`、`private_key`、
    `ghp_*`、`xox*-`；
  - 生成 `<project>/.publish-manifest.json`，逐条记录 `published / skipped(reason)`。
- 证据：`gameConfig.json` 200（正常配置可用）；`config.json`（含 `sk-`）403/404；
  `firebase-config.js`、`service-account.json` 在导入阶段即被排除（404）；
  清单中 `config.json` 标记为 `secret-content`。

### NEW-05 · 敏感文件被复制进快照（P2）

- 修复：导入、快照、Diff、预览共享同一套 `isSensitivePath()`；
  `walkFiles/hashTree/copyTree` 默认排除点文件、凭据名、`.log/.pem/.key` 等；
  导入结果返回 `import.skippedSensitive`。
- 关键一致性：回退只删除「当前清单里存在、目标清单里不存在」的文件；
  敏感文件不在任何清单中 → **回退永远不会删除用户后来放入的 `.env` 等配置**。
- 证据：导入后工作副本无 `.env/notes.log/secret.pem`；快照目录仅含 `game.js/index.html`；
  手工放入 `.env` 后回退，`.env` 内容原样保留。

### NEW-06 · 并发快照丢更新（P2）

- 修复：`import / snapshot / rollback / registerWorkspace / removeProject` 统一走
  `withRegistryLock()`（`<VPLAY_HOME>/.opengame/registry.lock`，O_EXCL + pid 存活/超时回收）；
  注册表与清单仍是「临时文件 + rename」原子写；seq 取 `max(state.seq, 已有 seq)+1`。
- 证据：两个进程各并发 5 次快照 → 注册表 **11 条**（initial + 10）、目录 **11 个**、seq 无重复。

## 3. 测试与构建

| 命令                         | 结果                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| `npm run test:remote`        | **49 用例：48 通过 / 0 失败 / 1 跳过**（新增 6 项 hardening） |
| `npm run lint`               | 退出码 0                                                      |
| `npm run build`              | 退出码 0                                                      |
| `npm run bundle`             | 退出码 0                                                      |
| `node dist/cli.js --version` | `0.6.0`                                                       |

新增 `remote/test/hardening.test.cjs`（6 用例）与
`remote/test/fixtures/snapshot-worker.cjs`（并发快照夹具）。

### 3.1 基线失败（未掩盖）

仍为既存的 26 项，与本轮无关：
`prompts.test.ts` 15 项（fork 改提示词未更新快照）、
`workspaceContext.test.ts` 11 项（Windows `symlinkSync` EPERM）；
`agent-test` 缺 Key 不计入单测。本轮**未新增**基线失败。

## 4. 兼容性

- Sprint 01 真机功能：Token/Session 登录、任务、去重、串行、状态恢复全部保留。
- Spacer：`/p/spacer/` 仍 200；预览无 CSP `sandbox`，localStorage/关卡/触控/横屏不受影响。
- Create Mode（单工作区）与 Projects Mode（`VPLAY_HOME`）都走同一套预览发布与回退校验。

## 5. Qoder 可复审入口

```powershell
$repo = 'C:\Users\54167\Documents\Trae-CN\default\OpenGame'
git -C $repo rev-parse HEAD                      # 见文末最终 SHA
git -C $repo log --oneline -3

cd $repo
npm run test:remote                              # 49 用例
node --test remote/test/hardening.test.cjs       # 六项专项
```

现场复验 NEW-01（需先启动一个测试实例）：

```powershell
$env:REMOTE_TOKEN='host-probe-token'; $env:REMOTE_AUTORUN='0'
$env:REMOTE_HOST='127.0.0.1'; $env:REMOTE_PORT='8891'; $env:PREVIEW_PORT='8892'
$env:OPENGAME_WORKSPACE='<临时游戏目录>'
node $repo\remote\server.cjs
node C:\Users\54167\Documents\Trae-CN\default\vplay-verification\host-probe.cjs
# 期望：before=200 attack=400 attackPreview=400 after=200 emptyHost=400 afterAll=200
```

新增证据文件：

| 内容            | 位置                                                |
| --------------- | --------------------------------------------------- |
| 六项回归测试    | `remote/test/hardening.test.cjs`                    |
| 并发快照夹具    | `remote/test/fixtures/snapshot-worker.cjs`          |
| NEW-01 现场输出 | `vplay-verification/host-probe.cjs`                 |
| 发布清单示例    | `<VPLAY_HOME>/projects/<id>/.publish-manifest.json` |

## 6. 残余风险与限制（未变，仍需声明）

1. **无 OS 沙箱 / 无凭据代理**：模型 Key 仍在 CLI 子进程环境中，agent shell 可读工作区外文件。
   → **禁止公网部署**；仅在可信局域网、可信工程下使用。
2. HTTP 明文：Cookie 无 `Secure`，需 HTTPS 反代。
3. 预览面仍无鉴权（只读、无管理接口）。
4. `VPLAY_HOME` 仍为本地明文状态；本轮加了锁与原子写，但未收紧 ACL。
5. 仅 Windows 实测；Linux/macOS 的链接、看门狗、租约需重跑。
6. 仅单用户单实例；多租户/RBAC 未实现。

## 7. 提交

- 最终完整 SHA：`<!-- FINAL_SHA -->`
- 分支：`sprint-02-project-adoption`（推送，不合并 main，不 force push）
- 未使用真实密钥，未开放公网。

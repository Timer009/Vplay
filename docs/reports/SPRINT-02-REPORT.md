# Sprint 02 报告 · Project Adoption & Continuity

- 项目：Vplay Studio（Timer009/Vplay）
- 分支：`sprint-02-project-adoption`
- 基线：`sprint-01-accepted` @ `8058e67`（Sprint 01 真机 13/13 通过）
- 日期：2026-11-26
- 结论：**Sprint 02 代码与自动化验收完成**；真机验收与独立安全审计待产品负责人执行（本文不宣称审计通过）。

---

## 1. 本轮做了什么

在已验收的远程通道之上，补齐两类能力：

1. **P0 安全与执行可靠性**：孤儿进程收敛、项目锁、工作区隔离、预览硬化、
   预览面/控制面分源、公开模式禁用无约束 `--yolo`。
2. **Adopt Mode + 可回退的连续修改**：导入已有工程（静态 / 子目录入口 / Vite）、
   受控 projectId、修改前快照、差异、回退、项目记忆与多轮续接。

## 2. 基线归档

| 项                 | 值                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| 验收基线 tag       | `sprint-01-accepted` → `8058e67`                                                                   |
| Sprint 01 真机结论 | 已写入 `docs/reports/SPRINT-01-REPORT.md` 第 13 节                                                 |
| 项目管理文件       | `PROJECT-STATUS.md` / `ROADMAP.md` / `CURRENT-TASK.md` / `ARCHITECTURE.md` / `DECISIONS.md` 已更新 |
| main               | 未合并，未 force push                                                                              |

> 说明：Sprint 01 报告的「真机未验收」条目已改写为已完成，并保留原有模拟测试
> 口径，避免把模拟说成真机。

## 3. 安全与执行可靠性（P0）

### 3.1 孤儿 CLI 进程

- 新增 `remote/lib/cli-runner.cjs`：CLI 外再包一层进程。
  - 每 2s 写租约心跳（`taskId / runnerPid / childPid / updatedAt`）。
  - 每 2s 探测父进程；父进程消失立即 `taskkill /T /F` 杀掉 CLI 进程树。
- 新增 `remote/lib/leases.cjs`：服务启动时回收过期租约。
  - 只有在**命令行匹配** `cli-runner.cjs` 或 `taskId` 时才杀进程，避免误杀。
  - 不匹配的进程只清理租约文件。
- 证据：`remote/test/leases.test.cjs` 两个用例通过（真实拉起进程并断言被杀）。

### 3.2 同一工作区并发写入

- 全局串行 worker + **项目锁**（`locks/<projectId>.lock`，含 pid / taskId）。
- 锁存活判断基于 `process.kill(pid, 0)`；持有者退出后自动视为过期。
- 证据：`project lock: second acquire fails while the first is held` 通过。

### 3.3 工作区隔离

- 项目模式（`VPLAY_HOME`）下，任务只能写入 `projects/<id>/src`。
- 预览面不再暴露 `legacy` 根（防止把仓库或用户目录当静态目录）。
- 公开模式（`VPLAY_PUBLIC_MODE=1`）拒绝非受控工作区：`POLICY_VIOLATION`。

### 3.4 预览硬化

统一走 `remote/lib/paths.cjs#resolveStaticFile`：

- 拒绝任何以 `.` 开头的路径段（`.env` / `.git` / `.opengame`）。
- 拒绝 `../`、`%2e%2e`、`%2f`、`..%5c` 等穿越形式。
- `realpath` 后再做边界判断，挡住 symlink / junction。
- 边界判断用 `path.relative`，不会把 `ws` 与 `ws-evil` 误判为同一目录。

证据（`preview.test.cjs`）：`/legacy/.env`、`/legacy/.git/config`、
`/legacy/.opengame/remote/tasks.json` 均为 403；穿越与 junction 均不可读；
`/game/*` 在控制面已不存在（404）。

### 3.5 预览面与控制面分离

- 预览独立进程/端口（`PREVIEW_PORT`，默认控制端口 +1），只读、无管理接口。
- 控制面所有写接口（`/auth/verify`、`/prompt`、`/rollback`）校验 `Origin`，
  必须与 `Host` 同源；无 Origin 的脚本请求放行。
- 证据：`cross-origin writes are rejected…` 通过——已登录 Cookie +
  预览端口 Origin 的 `POST /prompt` 返回 403，任务数为 0。

### 3.6 `--yolo` 策略

- 默认（家庭/本机）：允许 `--approval-mode yolo`。
- 公开模式：降级为 `auto-edit`，且只允许受控项目。

## 4. Adopt Mode

新增 `remote/lib/projects.cjs` 与 `remote/cli.cjs`：

- 导入命令（仅本机）：
  `node remote/cli.cjs project import <path> --id <id> [--entry <rel>]`
- 识别：
  - 零依赖 HTML/JS → `static`
  - 子目录入口（如 `vector-lander/index.html`）→ `static` + 入口路径
  - `vite.config.*` 或 vite 依赖 → `vite`，预览走 `dist/`
- 复制语义：导入前后对原始工程做 SHA-256 清单，导入后仍需一致；
  `import.originalUnchanged=true` 才会注册成功。
- 受控映射：`projects.json` 保存 `projectId → srcDir`；HTTP 只接受 projectId，
  `/projects/import` 永远 403。
- 复用：任务队列、鉴权、provider、worker 全部复用 Sprint 01 实现。

## 5. 预览与版本管理

- 预览：
  - 静态项目：以入口所在目录为根（支持 `vector-lander/index.html`）。
  - Vite 项目：优先 `dist/`；无 dist 时返回 409 并提示先构建。
- 快照：每次 AI 修改前自动 `pre-task-<taskId>`；排除 `.git`/`node_modules`/`dist`/`.opengame`。
- 差异：`GET /projects/:id/diff?from=<seq>&to=current`
  - 返回文件级 added/modified/removed + unified diff。
  - 修改用 `git diff --no-index`（cwd 为共同祖先，不出现绝对路径）；
    新增/删除由服务端直接生成，不往用户工程塞临时文件。
- 回退：`POST /projects/:id/rollback { seq }`
  - 先自动创建 `pre-rollback-<n>` 备份；
  - 恢复新增/修改/删除全部文件；
  - 回退后重新哈希校验；
  - 任务运行中拒绝回退（409）；
  - 全程不使用 `git reset --hard` / `git clean -fd`。

## 6. 项目记忆与连续开发

- `profile.json`：入口、类型、框架、关键文件、构建方式。
- `memory.json`：最近 20 轮（任务、改动文件数、是否验证）。
- 第二轮起追加 `--continue --chat-recording` 复用该项目会话（cwd 隔离，不会串项目）；
  同时把最近 3 轮摘要写进任务上下文作为兜底。
- 大文件提示：任务上下文要求「先搜索定位、再分段读取」，避免整文件重写。
- **执行成功 ≠ 验证成功**：`result.verified` 独立计算（入口存在 + 预览就绪 +
  post-verify 无 issue），控制台对 `succeeded` 但未验证的任务显示 `unverified`。

## 7. Spacer 实战验证

- 参考仓库：`https://github.com/Timer009/Spacer`
- 固定提交：`951d13b58e4800d0f9afa57bf362d2b15a186aac`（v2.0.14，2026-11-24）
- 使用独立克隆（`vplay-spacer-validation/repo`），未修改其正式工程/发布分支。
- 导入入口：`vector-lander/index.html`（子目录入口）。
- 导入结果：
  - 文件数 9，SHA-256 清单摘要 `bb9790eaddb390b6f23970b7dac9e37734c95cd03c945b419febadc4d978a711`
  - `originalUnchanged = true`；导入后再哈希仍为同一摘要。

### 7.1 两轮真实修改（DeepSeek）

| 轮次 | 任务 ID                  | 快照 | 改动     | 验证 | 内容                                      |
| ---- | ------------------------ | ---- | -------- | ---- | ----------------------------------------- |
| 1    | `task_mwwgrwvh_9515eb1c` | #2   | +0 ~1 -0 | 通过 | `.iconBtn` 边框 `#ff7ac6`、图标 `#ffe0f2` |
| 2    | `task_mwwgtowu_921449dd` | #3   | +0 ~1 -0 | 通过 | `.tbtn.active` 背景 `#235892 → #7c3aed`   |

- 两轮 post-verify 均为 0 issue。
- 真实模型调用控制：**共 2 次**（每轮 1 次）；单任务超时 300s；**无自动重试**。
- 第一轮差异（节选）：

```diff
diff --git a/vector-lander/index.html b/vector-lander/index.html
@@ -24,7 +24,7 @@
-    border:1px solid rgba(120,220,255,.65);background:rgba(8,20,38,.92);color:#bfe9ff;
+    border:1px solid #ff7ac6;background:rgba(8,20,38,.92);color:#ffe0f2;
```

- 第二轮差异（节选）：

```diff
diff --git a/vector-lander/index.html b/vector-lander/index.html
@@ -30,7 +30,7 @@
-  .tbtn.active{background:#235892}
+  .tbtn.active{background:#7c3aed}
```

两轮均只改样式，未触碰 canvas、物理参数、关卡数据。

### 7.2 回退验证

| 操作                    | 结果                                                         |
| ----------------------- | ------------------------------------------------------------ |
| 回退到 #3（撤销第二轮） | `verified=true`，自动备份 #4；`#7c3aed` 消失，第一轮粉色仍在 |
| 回退到 #2（撤销第一轮） | `verified=true`，自动备份 #5；粉色消失                       |
| 回退后工作副本哈希      | `bb9790ea…`（与初始一致）                                    |
| 原始克隆哈希            | `bb9790ea…`（全程未变）                                      |

预览复验：回退后 `/p/spacer/` 仍返回 200（182 KB），页面中不再含 `ff7ac6`。

## 8. Vite 最小工程

- 工程：`vite-min`（`index.html` + `src/main.js` + `package.json`）。
- 构建：使用仓库内 vite（v7.3.2）执行 `vite build`，3 modules，产出
  `dist/index.html`（0.30 kB）与 `dist/assets/index-UtV_dVKi.js`（0.85 kB）。
- 导入：`kind=vite`，导入摘要 `2a51ef34…`，`originalUnchanged=true`。
- 预览：`/p/vite-min/` 返回构建后的 HTML，引用 `/assets/index-*.js`，
  不再出现 `/src/main.js`；资源文件可读且包含应用文本。

## 9. 测试与构建证据

| 命令                         | 结果                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `npm run lint`               | 退出码 0                                                            |
| `npm run build`              | 退出码 0（既有 `dts-bundle-generator` TS5011 警告仍在，与本轮无关） |
| `npm run bundle`             | 退出码 0，资产复制完成                                              |
| `node dist/cli.js --version` | `0.6.0`                                                             |
| `npm run test:remote`        | **34 个用例：33 通过 / 0 失败 / 1 跳过**（真实模型用例默认关闭）    |
| `npm test`（workspace 基线） | 见 9.1                                                              |

新增测试文件：

- `remote/test/projects.test.cjs`（导入 / 检测 / 快照 / 差异 / 回退 / 锁 / 项目模式端到端）
- `remote/test/preview.test.cjs`（点文件 / 穿越 / junction / 控制面隔离 / Vite dist）
- `remote/test/leases.test.cjs`（孤儿收敛与误杀保护）
- `remote/test/mobile-console.test.cjs` 新增「项目模式移动端」用例：
  登录 → 选择项目 → 下发任务 → 看到 `succeeded` 与验证信息 →
  产物链接指向独立预览源 → 打开后背景已改。
- Sprint 01 原有 `tasks/server/mobile` 测试全部保留并通过。

### 9.1 基线测试

与 Sprint 01 完全一致的**既存失败**，本轮没有引入新的失败：

| workspace         | 结果                                                  |
| ----------------- | ----------------------------------------------------- |
| 191 个测试文件    | 全部通过                                              |
| `packages/core`   | 147 个文件通过 / 2 个文件失败（26 个用例失败）        |
| 其余 5 个测试文件 | 全部通过                                              |
| `agent-test`      | 失败：`OPENAI_API_KEY environment variable not found` |

`packages/core` 的 26 个失败仍来自：
`prompts.test.ts`（fork 改过提示词但未更新快照）与
`workspaceContext.test.ts`（Windows 下 `fs.symlinkSync` EPERM）。
两者都与本 Sprint 改动无关，详见 Sprint 01 报告 7.1。

## 10. 已知问题

1. **Sprint 02 真机未验收**：只提供地址与步骤，未做真机结论。
2. **独立安全审计未完成**（Qoder），本报告不宣称审计通过。
   审计发现项的修复记录见 `docs/reports/SPRINT-02-SECURITY-FIX.md`（P0 全部关闭）。
3. Vite 项目需已有 `dist/`；系统不会在用户工程里自动执行构建。
4. 回退只覆盖源码（不含 `dist`/`node_modules`）；Vite 回退后需重新构建预览。
5. 单独大文件（182 KB HTML）的 diff 依赖 `git`；无 git 时降级为文件清单（当前机器有 git）。
6. 预览面无鉴权：同局域网任何人拿到预览 URL 都能看游戏（只读、无管理能力）。
7. 项目注册表为单机文件（`~/.vplay/projects.json`），未做多用户隔离。
8. 关闭浏览器 ≠ 关闭服务；Sprint 01 验收后发现遗留进程，本轮已在启动阶段回收租约，
   但服务本身的长期守护（Windows 服务/计划任务）不在本 Sprint 范围。

## 11. 手机真机验收地址与步骤

> 安全加固后的完整版本见第 14.8 节；第 14 节还包含本轮补做的交付核对证据。

1. 准备：把要验收的工程导入本机（示例）：
   ```powershell
   $env:VPLAY_HOME="$env:USERPROFILE\.vplay"
   node remote/cli.cjs project import "C:\path\to\your-game" --id my-game --name "My Game"
   ```
2. 生成令牌（不要写进仓库）并启动：
   ```powershell
   $env:REMOTE_TOKEN="<随机长字符串>"
   $env:REMOTE_HOST="192.168.x.x"     # 本机 WLAN 地址
   $env:REMOTE_PORT="8787"
   $env:PREVIEW_PORT="8788"
   npm run remote
   ```
3. 手机（同一 Wi-Fi）打开：`http://192.168.x.x:8787/console`，输入令牌。
4. 控制台顶部选择项目 → 下发指令 → 观察 `queued → running → succeeded`。
5. 「最新产物」链接会打开 `http://192.168.x.x:8788/p/<projectId>/`（独立源预览）。
6. 展开任务可看「验证」「变更文件数」；点击「查看差异」「回退到本次之前」。
7. 验收后关闭：Ctrl+C 或结束监听 8787/8788 的 node 进程。

> 注意：`0.0.0.0` 会暴露到局域网；只在可信网络短时开启。

## 12. 后续集成建议

1. **受控构建**：在沙箱内执行 `npm run build`，让 Vite 项目回退后自动重建预览。
2. **结构化事件流**：把 planning / coding / verifying 推给手机端，替代日志截断。
3. **文件级回退**：支持只回退某个文件，减少大工程整快照复制。
4. **预览访问控制**：可选给预览端口加一次性签名链接。
5. **多模态**：图像/音频 Key 就绪后接回素材生成（其他 Agent 研究）。
6. **跨互联网**：接入成熟组网方案，本仓库继续不自建 Relay。

## 13. 提交

- 实现提交：`02206de`（分支 `sprint-02-project-adoption`；本文件所在提交可能还包含随后的文档格式更新）
- 基线：`sprint-01-accepted` @ `8058e67`
- 未合并 main，未 force push，未提交任何密钥。
- 安全加固提交：`90842ce`（详见 `docs/reports/SPRINT-02-SECURITY-FIX.md`）

---

# 14. 交付核对（Task B02，纯文档补证）

> 本节为产品负责人验收补齐证据。**本轮未修改任何源码**：
> `git diff --stat 90842ce..HEAD -- remote packages package.json` 输出为空。

## 14.1 仓库状态

| 项               | 值                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------- |
| 分支             | `sprint-02-project-adoption`                                                          |
| HEAD（完整 SHA） | `9d3d5f0ad185ef807beb7a73fd0575265dd65405`                                            |
| 上游             | `origin/sprint-02-project-adoption`，ahead/behind = `0 / 0`                           |
| 安全修复提交     | `90842ce`                                                                             |
| main             | `a01689500e8991fcd7defe2b175afa21ef9ed202`（未合并、未改动）                          |
| 可回退基线       | tag `sprint-01-accepted` → `8058e67`                                                  |
| 工作区           | 仅两项既有遗留：`QODER_REVIEW.md`（暂存，非本轮产生）、`GIT_PUSH_REPORT.md`（未跟踪） |
| 服务进程         | 验收/验证服务均已停止；8787/8788/8791/8792/8795/8796/8805/8806/8807/8808 均无监听     |

> 说明：`9d3d5f0` 是本次补证前的代码/安全提交；补证文档本身提交为 `230b8e8`
> （仅文档，不含源码改动）。

## 14.2 Adopt Mode：已有工程导入

- 入口：仅本机 `node remote/cli.cjs project import <path> --id <id> [--entry <rel>]`。
- HTTP `/projects/import` 永远 403，远程无法指定系统路径；任务只接受 `projectId`。
- 导入 = 哈希原始工程 → 复制到 `projects/<id>/src` → 再哈希比对；写入 `profile.json`、
  `memory.json`、初始快照。
- 已注册项目（本地验证环境）：

| projectId  | 类型   | 入口                       | 说明                           |
| ---------- | ------ | -------------------------- | ------------------------------ |
| `spacer`   | static | `vector-lander/index.html` | Spacer v2.0.14，9 文件         |
| `vite-min` | vite   | `index.html`               | 真实 `vite build` 后导入       |
| `demo`     | static | `index.html`               | 交付验证工程（预览→修改→回退） |

## 14.3 静态 HTML/JS 与 Vite

- 静态：自动识别深度 ≤3 的 `index.html`；可用 `--entry` 显式指定子目录入口；
  保留原目录结构与相对引用；预览由 `.preview` 白名单产物目录提供。
- Vite：识别 `vite.config.*` 或 vite 依赖；记录 `npm run build`；预览只服务 `dist/`
  （无 dist 返回 409 并给出提示），不会直接跑用户构建脚本。
- `vite-min` 实测：vite v7.3.2 构建 3 modules，产出 `dist/index.html` +
  `dist/assets/index-UtV_dVKi.js`；`/p/vite-min/` 返回构建产物，不出现 `/src/main.js`。

## 14.4 Spacer 实际导入 / 理解 / 修改 / 预览

- 固定提交：`951d13b58e4800d0f9afa57bf362d2b15a186aac`（v2.0.14）。
- 导入：9 文件，SHA-256 清单摘要 `bb9790eaddb390b6f23970b7dac9e37734c95cd03c945b419febadc4d978a711`，
  `originalUnchanged=true`。
- 两轮真实 DeepSeek 修改（详见第 7 节）：`.iconBtn` 边框/图标色、`.tbtn.active` 背景色；
  两轮各改 1 个文件，post-verify 0 issue，均未触碰物理引擎。
- 预览：`/p/spacer/` 返回 200（182,644 字节），canvas 正常。
- **新预览 Origin 兼容性实测**（390×844 移动视口 + 触控，无头 Edge）：

| 检查                   | 结果                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| HTTP / CSP             | 200；`Content-Security-Policy: frame-ancestors 'self'`（无 `sandbox`）           |
| 页面                   | 标题「矢量着陆 · Vector Lander — 太阳系航线」，canvas 存在                       |
| localStorage 写入/读取 | 成功                                                                             |
| 刷新后存档             | 仍在（`vplay_compat_probe=ok`）                                                  |
| 触控                   | `ontouchstart=true`，`navigator.maxTouchPoints=1`                                |
| 横屏                   | `screen.orientation` 可用；`body.class="touch-ui rotate-hint"`，旋转提示逻辑生效 |
| 设置/暂停入口          | 页面保留 `touch-ui`、`rotateHint` 与设置相关逻辑；面板实际点击需真机确认         |
| 截图                   | `vplay-spacer-validation/compat-preview.png`                                     |

> 说明：预览 Origin 一直是 `http://<host>:<PREVIEW_PORT>`，安全加固只把**目录**从
> `src` 换成 `.preview`，Origin 未变、路径不参与 localStorage 作用域，因此存档不受影响。

## 14.5 快照 / Diff / 回退 / 失败恢复

- 快照：任务前自动 `pre-task-<id>`；回退前自动 `pre-rollback-<n>`。
  Spacer 现有快照：`#1 initial`、`#2 pre-task-1`、`#3 pre-task-2`、`#4 pre-rollback-3`、`#5 pre-rollback-2`。
- Diff：文件级 added/modified/removed + unified diff（大 HTML 也能出差异，上限 512 KB/文件）。
- 回退：恢复新增/修改/删除，哈希校验；不依赖 git，不使用 `git reset --hard` / `git clean -fd`。
- 失败恢复：服务重启把 in-flight 任务标 `interrupted` 且不重跑；过期租约回收孤儿；
  同工作区第二个实例拒绝启动（`server.lock`）。

**本轮实测（`demo` 工程，桩执行器，不调模型）**：

```
preview-before  status=200 bg101014=true
task=succeeded outcome=verified snapshot=2
preview-after   status=200 bg7c3aed=true
diff={"added":0,"removed":0,"modified":1} files=modified:index.html
rollback status=200 verified=true previewReady=true backup=3
preview-restored status=200 bg101014=true bg7c3aed=false
artifact previewPath=/p/demo/ previewPort=8806
```

即：**回退后无需重启，预览自动刷新为回退前内容**。

## 14.6 原始工程是否保持不变

- 导入前后原始工程哈希一致（`originalUnchanged=true`）。
- Spacer 两轮修改 + 两轮回退后：工作副本摘要回到 `bb9790ea…`；
  独立克隆 `vplay-spacer-validation/repo` 摘要始终为 `bb9790ea…`（未被 Vplay 改动）。
- 正式工程 `github.com/Timer009/Spacer` 与其发布分支从未被写入。

## 14.7 多项目隔离 / 工作区锁 / 任务状态

- 每个 `projectId` 独立目录 `<VPLAY_HOME>/projects/<id>/src`；任务与日志按 `projectId` 归属。
- 项目锁：同一项目同一时间仅一个任务；`locked:false` 表示空闲（当前 spacer / vite-min 均空闲）。
- 工作区锁：同一 workspace 只能启动一个 server；第二个实例退出码 1。
- 任务状态机：`queued → running → verifying → succeeded/failed`；重启时 in-flight → `interrupted`。
- 自动化覆盖：`projects.test.cjs`（项目模式端到端）、`security.test.cjs`（锁/隔离）、
  `leases.test.cjs`（孤儿）。

## 14.8 安全加固后的双设备操作流程与新预览端口

| 端点   | 默认                            | 说明                        |
| ------ | ------------------------------- | --------------------------- |
| 控制面 | `REMOTE_PORT`（8787）           | 登录、任务、项目、Diff/回退 |
| 预览面 | `PREVIEW_PORT`（8787+1 = 8788） | 只读游戏，无管理接口        |

1. 电脑：`$env:VPLAY_HOME="$env:USERPROFILE\.vplay"`；
   导入工程：`node remote/cli.cjs project import <path> --id <id>`。
2. 电脑：`$env:REMOTE_TOKEN="<随机长串>"`；`$env:REMOTE_HOST="192.168.x.x"`；
   `$env:REMOTE_PORT="8787"`；`$env:PREVIEW_PORT="8788"`；`npm run remote`。
3. 手机 A/B 连同一 Wi-Fi，打开 `http://192.168.x.x:8787/console`，各自输入 Token
   （服务端下发 4 小时随机 Session，登出即吊销）。
4. 手机 A 选择项目 → 下发指令；电脑自动串行执行；手机 B 自动看到同一条任务与状态。
5. 任务完成后点「最新产物」→ 打开 `http://192.168.x.x:8788/p/<projectId>/`（独立源）。
6. 预览页**不能**调用 `/prompt`：写接口校验 Origin，跨源请求 403（已自动化验证）。
7. 验收结束：Ctrl+C 或结束 8787/8788 的 node 进程。

## 14.9 实际模型调用与测试证据

- 真实模型调用：**共 4 次**——Spacer 两轮各 1 次；两次自动化 E2E 各 1 次。
  单任务超时 300s / 900s（按场景），**无自动重试**。
- `npm run test:remote`：**43 用例 / 42 通过 / 0 失败 / 1 跳过**（真实模型用例默认关闭）。
- 真实模型 E2E：通过（15.3s），post-verify `taskId` 校验生效。
- `lint` / `build` / `bundle`：退出码 0；CLI `0.6.0`。
- 基线 26 项失败分类（与 Sprint 01 一致，非本轮引入）：
  15 项 = `prompts` 快照代码债（fork 改提示词未更新快照，任何平台必失败）；
  11 项 = Windows `symlinkSync` EPERM（环境限制）；
  `agent-test` = 评测脚本缺 Key，不属于单测。

## 14.10 尚未实现 / 已知问题 / 残余风险

**尚未实现**

1. 图像 / 视频 / 音频模态（无对应 Key）。
2. Vite 自动构建（当前只消费已有 `dist`）。
3. 多用户 / 多租户与 RBAC。
4. 公网 Relay / 跨互联网协同（保持传输层可替换，不自建）。
5. 凭据代理 + OS 级沙箱。
6. 文件级回退（当前为快照级）。

**已知问题**

- 大工程快照为整目录复制，体积与耗时随工程增长。
- Diff 依赖本机 `git`；无 git 时退化为文件清单。
- 预览面无鉴权（只读）。

**残余风险**

- 模型 Key 仍在 CLI 子进程环境中（调用模型必需）；**禁止公网开放**。
- 纯 HTTP 下 Cookie 无 `Secure`。
- Session 存于内存，重启需重新登录。
- Linux/macOS 孤儿回收仅在 Windows 实测。

## 14.11 产品负责人真机验收步骤（可直接执行）

**准备**

1. 电脑导入工程并启动（端口按 14.8）。
2. 两台手机连同一 Wi-Fi，记录电脑 WLAN IP。

**A. 鉴权与共享** 3. 手机 A：错误 Token → 应提示「令牌无效」；正确 Token → 「已连接」。4. 手机 B：登录后应看到手机 A 刚才产生的任务记录。

**B. 手机发起、电脑执行、另一台手机试玩** 5. 手机 A 选择项目，发送：「把 HUD 主色改成 #7c3aed，只改样式，不改物理参数」。6. 观察 `queued → running → succeeded`；电脑终端可见任务开始/结束。7. 手机 B 点「最新产物」→ 打开 8788 预览，确认改色生效。

**C. Spacer 存档 / 横屏 / 触控 / 设置** 8. 在手机上把手机横过来：应出现旋转提示/横屏布局；触控方向键可用。9. 修改一项设置（如音量/皮肤），刷新页面，设置应保留（localStorage 持久化）。

**D. Diff 与回退** 10. 任务详情点「查看差异」：应显示 `modified: vector-lander/index.html` 与颜色行。11. 点「回退到本次之前」：应提示备份快照号；**不刷新页面**，直接看预览应恢复旧颜色。12. 再回退上一轮，确认工程回到初始状态。

**E. 鲁棒性** 13. 任务执行中重复发送同一句 → 第二次应提示「相同指令已在队列或执行中」。14. 手机 Wi-Fi 断开重连 / 浏览器退出重进 → 任务与产物状态应恢复。15. 验收结束关闭服务；确认 8787/8788 不再监听。

> 上述步骤中，第 5–12 项已在本地用桩执行器 + 移动视口模拟验证；
> **真实双手机操作仍需产品负责人执行**，本报告不将其表述为已完成。

## 14.12 证据文件索引

| 证据                         | 位置                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| 交付流验证输出               | `vplay-verification/result.json`                                 |
| Spacer 兼容性截图            | `vplay-spacer-validation/compat-preview.png`                     |
| Qoder 服务探针结果（修复后） | `vplay-security-probe/probe-server-result.json`                  |
| Qoder 孤儿探针结果（修复后） | `vplay-security-probe/probe-orphan-result.json`                  |
| 安全修复说明                 | `docs/reports/SPRINT-02-SECURITY-FIX.md`                         |
| Spacer 两轮 diff             | `vplay-spacer-validation/diff-round1.patch`、`diff-round2.patch` |

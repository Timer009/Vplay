# 真实实验准备：Spacer 独立副本 / 模型配置 / F1–F10 / 证据包（B12）

> B12 **未调用真实模型**、未修改 Spacer 正式仓库、未实现陆地定点回收。
> 本文是可执行的准备方案与门禁，不是 F1–F10 通过结论。

## 1. 官方 Spacer（只读基线）

| 项       | 值                                                                 |
| -------- | ------------------------------------------------------------------ |
| 本地副本 | `G:\AI_GAME\Vplay-Vision-POC\e05\spacer-latest`                    |
| Commit   | `2bc027d55f49efeee10364d84e364976ab9abd4a`（v2.0.15，干净）        |
| 入口     | `vector-lander/index.html`，204,802 B                              |
| SHA256   | `4babef022f7ad5fef42a346cb1f0af3dfcbe63d22e895a83eb19192491511064` |
| 约束     | 只读；不得提交、不得打标签、不得就地运行真实模型                   |

## 2. 独立实验副本导入

脚本：`remote/tools/trusted-lab/prepare-spacer-lab.ps1`（默认 DryRun）

```powershell
# 1) 预览计划（不复制）
powershell -File remote\tools\trusted-lab\prepare-spacer-lab.ps1

# 2) 经用户批准后复制到独立实验目录（不修改官方副本）
powershell -File remote\tools\trusted-lab\prepare-spacer-lab.ps1 `
  -Source 'G:\AI_GAME\Vplay-Vision-POC\e05\spacer-latest' `
  -LabRoot 'G:\AI_GAME\vplay-labs\b12-spacer' -Approve
```

要求：

- 复制前后对 `vector-lander/index.html` 计算 SHA256，必须仍是 `4babef02…`；
- 实验目录与正式工程/凭据分离；
- 不复制 `.git`、`node_modules`；
- 实验目录只作为 `VPLAY_HOME/projects/<id>/src` 的导入源，不直接对官方目录执行任务。

## 3. 真实模型配置检查（不调用）

| 项       | 要求                                                     | B12 状态                      |
| -------- | -------------------------------------------------------- | ----------------------------- |
| Key      | 使用限额子 key；仅注入执行器进程                         | NOT_RUN（无授权）             |
| 预算     | 每任务请求数/token 上限；provider 侧限额                 | NOT_IMPLEMENTED（需外层网关） |
| 数据同意 | `VISION_DATA_CONSENT=1`                                  | 未设置                        |
| 端点     | HTTPS；可选 allowlist                                    | 由 CLI 配置决定               |
| 凭据边界 | `EVIDENCE_HMAC_KEY` 不进子进程；模型 key 不写入 lab 配置 | ✅（代码/脚本）               |
| 日志     | 不含 key/ticket                                          | ✅（既有测试）                |

最小检查命令（只打印是否存在，不输出值）：

```powershell
foreach ($k in 'DASHSCOPE_API_KEY','OPENAI_API_KEY','DEEPSEEK_API_KEY') {
  $v = [Environment]::GetEnvironmentVariable($k)
  "{0}: {1}" -f $k, $(if ($v) { "present(len=$($v.Length))" } else { "missing" })
}
```

## 4. F1–F10 验收适配器接入方案

E08 已交付适配器与清单（未进主工程）：

- `G:\AI_GAME\Vplay-Vision-POC\e08\delivery\spacer-acceptance.mjs`
- `G:\AI_GAME\Vplay-Vision-POC\e08\delivery\verify-gate.mjs`
- `G:\AI_GAME\Vplay-Vision-POC\e08\docs\F1-F10-ACCEPTANCE.md`

接入方式（后续任务，不在 B12 实现）：

1. 将适配器放入 `remote/lib/vision-adapters/spacer-acceptance.mjs`（ESM），由 `vision-service` 通过 `deps.adapter` 注入；
2. 场景 ID：`title`、`campaign`、`free`、`recovery-falcon9`、`recovery-superheavy`、`land-pin`；
3. `land-pin` 必须 `LAND_PIN_NOT_IMPLEMENTED` 失败关闭，不提供预制补丁；
4. 缺陷断言 ID 必须稳定（例如 `outcome`、`hud-visible`、`touch-thrust`），供 `compareVerification` 对齐 before/after；
5. 发布门：`verify-gate` 等价的宿主硬门禁（B11 `strictRepairVerification`）：
   - before 缺陷断言失败；
   - after 全部通过；
   - 无新增失败（critical 或非 critical）；
   - 截图变化 **不单独** 作为成功依据；
6. F1–F10 结果写入任务结果与 `vision-report.json`，截图/证据落到项目外 evidence。

## 5. 真实产品证据包生成流程（当前部分未实现）

目标：从一次真实任务生成可由独立校验器核验的包。

```text
任务创建
  → 快照（pre-task）
  → Agent/Vision 执行（真实模型，需授权）
  → diff / 变更文件
  → buildPreview + verifyPreview（全量 manifest）
  → evidence/<project>/<task>/
       meta.json
       events.jsonl（seq 入哈希 + anchor）
       task.log（已脱敏）
       report.json（结果子集）
       anchor.json（artifactId + HMAC + alg + keyFingerprint + chainHead）
       manifest.json（全量文件哈希）
  → Qoder 13 文件导出（C10-08，未实现）
       00-manifest.json / 01-baseline.json / 02-server-chain.jsonl /
       03-host-recorder.jsonl / 04-tasks.json / 05-task.log /
       06-vision-artifact.json / 07-screenshots / 08-diff.patch /
       09-preview-manifest.json / 10-provider-usage.csv / 11-anchors / 13-report.md
  → verify-run + negatives（可移植副本：remote/tools/qoder/）
```

当前差距（如实标记）：

- 产品事件链与 C08 13 文件契约的映射/重算未实现（C10-08 PARTIAL）；
- 独立记录器与 provider usage 导出需要真实运行与外部数据；
- 证据目录与模型进程仍同权限域（B-15 OPEN），不能宣称不可篡改。

在上述缺口关闭前，**不得**把本机产品证据包当作独立验收证据。

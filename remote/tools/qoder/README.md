# Qoder 独立证据校验工具（vendored）

来源：`G:\AI_GAME\VPLAY-SECURITY-C08\evidence\verify-run.cjs` 与 `negatives.cjs`。

目的：让 B11 的独立校验**可移植**，不再依赖 `G:\AI_GAME` 绝对路径。

- `verify-run.cjs`：C07 §6.5 的 12 步离线证据包校验器（只读）。
- `negatives.cjs`：NC-1..NC-8 合成负对照（读取同目录 `verify-run.cjs`）。

使用：

```powershell
node remote/tools/qoder/verify-run.cjs <evidenceDir> --json
node remote/tools/qoder/negatives.cjs --json
```

约定：

- 不改动 Qoder 原报告与冻结副本；本目录仅为可移植副本；
- `remote/lib/qoder-evidence.cjs` 默认加载本目录，可用 `QODER_VERIFY_RUN` 覆盖；
- 本副本不修改校验逻辑；B11 的 `requireHmac` 与「SKIP 不计 PASS」由宿主适配器/门禁聚合器实现。

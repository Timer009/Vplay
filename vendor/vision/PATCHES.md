# Vendored `@vplay/vision` — 版本与宿主说明

## 当前使用版本：0.2.2（B14）

| 交付物                                   | SHA256                                                             |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `vplay-vision-0.2.2.tgz`                 | `c7679c021082824bb30f6fe7a06573d83ead945361efd60c37ac2bff10b5f74e` |
| `vplay-vision-0.2.2-source.tgz`          | `a74a6c7b3841f1c23b4faedaabd693f13dff66406cc34ef2b1d7c28c86280bc8` |
| `vplay-vision-0.2.1.tgz`（回退保留）     | `d463ba3fdb40883bf19f3c406122546fffe73b19427b3a2e8ba227f6415499d4` |
| `vplay-vision-0.2.1-source.tgz`（回退）  | `302659f52fc0b2ec813365d63c8bd68c4add8dd19a33729cf56352837a889dcd` |
| `vplay-vision-0.2.0.tgz`（历史，仅溯源） | `96795b68b38355b4ad6f05c3af2e802c673bd810093ff3683a3fc661da355ca7` |

来源：ZCode E10 候选包（`G:\AI_GAME\Vplay-Vision-POC\e10\dist\`）。

## B14 采用方式

- `src/` 使用 0.2.2 上游源码，叠加 **1 个最小宿主补丁**（见下表）；
- 0.2.1 的 tgz/source 仍保留在 vendor 目录，可按 `PATCHES.md` 回退；
- B13 的两处本地补丁处理：
  - `src/verification/compare.mjs`：**删除宿主补丁**，改用 0.2.2 上游实现
    （`missingAssertions`、`newFailures` 分类、`defectKeyOf` 已原生提供）；
  - `src/browser/guard.mjs`：0.2.2 原生 `enableRedirectGuard(cdp)` 只暂停
    `Document`，B13 的逐跳 route 逻辑无法覆盖 Document 以外的重定向；B14 用
    **一个 CDP 补丁扩展全部资源类型**，而不是保留两套重定向实现。

## 与上游 0.2.2 的差异

| 文件                    | 补丁                                                                                                                                                                                                                                               | 原因                                                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/browser/guard.mjs` | `Fetch.enable` 由 `resourceType: 'Document'` 扩展为全部请求；`Fetch.requestPaused` 对 Document 额外要求 `previewPath` 前缀，对子资源要求预览 origin；外部目标 `failRequest('BlockedByClient')` 并记录 `redirect-document` / `redirect-subresource` | 真实 Edge 矩阵显示：仅 Document 时 `<img>/<script>/<link>/fetch/XHR` 的 302 → 外部 origin **实际发出请求**（各 1 次，`evilHits=5`）；B13 的 route 逐跳检查可拦截这些请求。B14 在 0.2.2 上恢复该请求前边界，并让同源跨项目 document 跳转也在请求前被拒（`otherProjectHits=0`） |

除上述补丁外，其余 `src/`、`docs/`、`examples/`、`scripts/` 与 0.2.2 包一致；
`package.json` 版本为 `0.2.2`。升级上游 0.2.3+ 时必须重新评估该补丁是否已原生修复。

## 宿主对接

- `remote/lib/vision-service.cjs`：`verificationPolicy: 'strict-repair'`，
  透传 `defectAssertionIds` 与 `defectKey`（宿主 `defectId`）；不再保留 B13
  `strictRepairVerification` 的第二套判定。
- `remote/lib/vision-structure.cjs` + `remote/lib/vision-policy-delta.cjs`：
  宿主 delta 使用与 0.2.2 相同的结构/差分规则（CJS 参考），保留 operations 精确重放、
  before/after digest、路径边界、journal 与原子写。

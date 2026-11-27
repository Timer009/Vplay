# Vendored `@vplay/vision` — 版本与宿主说明

## 当前使用版本：0.2.1（B11）

| 交付物                                   | SHA256                                                             |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `vplay-vision-0.2.1.tgz`                 | `d463ba3fdb40883bf19f3c406122546fffe73b19427b3a2e8ba227f6415499d4` |
| `vplay-vision-0.2.1-source.tgz`          | `302659f52fc0b2ec813365d63c8bd68c4add8dd19a33729cf56352837a889dcd` |
| `vplay-vision-0.2.0.tgz`（历史，仅溯源） | `96795b68b38355b4ad6f05c3af2e802c673bd810093ff3683a3fc661da355ca7` |

来源：ZCode E07 候选包（`G:\AI_GAME\Vplay-Vision-POC\e07\dist\`）。

## B11 采用方式

- `src/` 直接使用 0.2.1 上游源码，**不再打宿主补丁**；
- B10 对 0.2.0 的本地 `cookies` 补丁已删除：0.2.1 原生提供
  `createBrowserRunner({ previewAuth })`（单 Cookie、origin+path 作用域、值不回显）；
- 宿主继续保留自己的能力：短期可吊销预览票据、项目锁、全工程 hashTree、
  快照/回退、evidence、journal 复核；
- 未把短期票据退回静态全局 hash；未引入客户端跳过校验的参数。

## 与上游的差异

无源码差异。`vendor/vision/src` 与 0.2.1 候选包 `src/` 逐文件一致。
若未来需要宿主补丁，必须在本文件记录并同时更新 `SHA256SUMS` 与报告。

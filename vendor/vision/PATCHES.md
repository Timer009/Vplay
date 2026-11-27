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

B11 时：无源码差异（按语义；6 个文件存在 CRLF/LF 行尾差异）。

B13 起有 **2 个最小宿主补丁**（tgz 哈希不变，仅本地 src 修改）：

| 文件                           | 补丁                                                                                                                                               | 原因                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/verification/compare.mjs` | 仅 after 存在且失败的断言计入 `newFailures`，不再归入 `persistingFailures`                                                                         | C12-P1-05：新增 critical 失败必须阻断                                        |
| `src/browser/guard.mjs`        | 预览源请求先用 `route.fetch({maxRedirects:0})` 检查每一跳；外部 Location 在请求前 abort；`framenavigated` 越界关闭页面；summary 增加 redirect 计数 | C12/E09：服务端 302 可绕过 Playwright route；最终 URL 检查不能替代预请求边界 |

除上述补丁外，其余源码与 0.2.1 候选一致（语义）。
若升级上游，必须重新评估这两个补丁（上游 0.2.2+ 可能已修复）。

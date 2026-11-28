# ATTRIBUTION / 修改声明

本仓库 **Timer009/Vplay（Vplay Studio）** 是开源项目 **OpenGame** 的衍生修改版，
依据 Apache License 2.0 分发。本文件用于满足 Apache-2.0 §4(b) 的“修改声明”义务，
并说明上游、版权、第三方组件与本次参赛候选的边界。

## 1. 上游项目

| 项       | 内容                                                                            |
| -------- | ------------------------------------------------------------------------------- |
| 项目     | **OpenGame — Open Agentic Coding for Games**                                    |
| 上游仓库 | https://github.com/leigest519/OpenGame                                          |
| 上游基线 | `@opengame/opengame@0.6.0`（本仓库 `package.json` 的 name/version 与上游一致）  |
| 许可证   | **Apache License 2.0**（上游 `LICENSE` 全文，本仓库原样保留于根目录 `LICENSE`） |
| NOTICE   | 上游仓库**没有** `NOTICE` 文件，因此不产生 Apache-2.0 §4(d) 的附加 NOTICE 义务  |
| 上游版权 | 归 OpenGame 作者与贡献者所有（见上游 README 作者列表与 `LICENSE`）              |

本仓库与 OpenGame 上游维护者**无隶属、背书或赞助关系**。Apache-2.0 不授予
“OpenGame”名称、标识或商标的使用权。

## 2. 本仓库的修改

- 修改方：**Timer009 / Vplay Studio**
- 修改时间：2026-11 起持续开发
- 修改范围（相对本仓库初始脚手架 `a016895`，该提交承载 OpenGame 0.6.0 基线）：
  - `remote/**`：远程控制面、预览面、项目导入/快照/回退、设备与项目 ACL、
    事件链与 HMAC 证据、任务 worker、Vision 宿主适配、可信实验脚本；
  - `vendor/vision/**`：独立候选 `@vplay/vision@0.2.2` 的 vendored 副本
    （含一个本地 `guard.mjs` 重定向边界补丁，详见 `vendor/vision/PATCHES.md`）；
  - `vendor/vision-0.2.3/**`：E16 最终产物 `@vplay/vision@0.2.3`
    （SHA256 `415cae0e…`，未改源码；默认版本，0.2.2 保留回退）；
  - `docs/**`：运行、恢复、边界、实验与状态文档；
  - `remote/test/**`：宿主安全与回归测试；
  - 根目录构建/工作区元数据（`package.json`、`package-lock.json`、`eslint.config.js`、
    `.gitignore`）。
- 逐文件变更清单：`docs/UPSTREAM-MODIFICATIONS.md`（由 `git diff --name-status`
  生成，共 133 个文件；相对初始脚手架，不声称是上游逐文件差异全集）。

> 说明：本轮发布准备**未重新克隆上游 OpenGame 做逐文件对比**；上游身份依据
> D18 报告中的 GitHub API 核实结果（`license=Apache-2.0`、`package.json`
> name/version 与上游 0.6.0 一致）以及本仓库 `README`/`package.json` 原文。
> 若评审要求严格的上游 diff，可在授权后以 `git remote add upstream` 方式补做，
> 不改动本候选分支。

## 3. 第三方组件

| 组件              | 版本/来源                                                | 许可证                            | 说明                                                                            |
| ----------------- | -------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| `@vplay/vision`   | 0.2.2（冻结回退）/ 0.2.3（默认），ZCode E10/E16 独立候选 | Apache-2.0（包内 `package.json`） | 0.2.2 vendored 于 `vendor/vision/`；0.2.3 于 `vendor/vision-0.2.3/`（未改源码） |
| `playwright-core` | 可选 peer 依赖                                           | Apache-2.0                        | 仅本机浏览器验证使用，不随仓库分发浏览器                                        |
| 其他 npm 依赖     | 见 `package-lock.json`                                   | 各自许可证                        | 未修改上游依赖清单以外的授权文件                                                |

游戏作品 **Spacer** 为独立仓库（https://github.com/Timer009/Spacer，Apache-2.0），
本仓库不包含其游戏源码；真实实验只在独立副本上进行。

## 4. AI 辅助声明

本项目的开发、测试与文档整理使用了 AI 编程工具辅助。所有提交由项目维护者审核，
AI 工具不构成上游 OpenGame 的作者或背书方。

## 5. 许可证全文

Apache License 2.0 全文见根目录 [`LICENSE`](LICENSE)。任何再分发必须保留
`LICENSE` 与本 `ATTRIBUTION.md`，并对修改过的文件作出与本文件同等显著的声明。

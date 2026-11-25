# Vplay Studio · 项目状态

> 最后更新：Sprint 02（2026-11-26）｜分支 `sprint-02-project-adoption`
> 已验收基线：`sprint-01-accepted` → `8058e67`（Sprint 01 真机 13/13 通过）

## 1. 项目定位

Vplay Studio 以 OpenGame（Apache-2.0，源自 gemini-cli）为内核，目标是最佳 AI 原生
游戏创作工具（NVIDIA DGX Spark）：一句话生成可玩网页游戏，并能接管已有工程、
在手机上持续下达增量修改。

## 2. 当前能力

| 能力                                                     | 状态                 | 证据                             |
| -------------------------------------------------------- | -------------------- | -------------------------------- |
| Create Mode：从零生成（模板脚手架 + post-verify）        | 可用                 | Sprint 01 报告                   |
| Remote：Token 鉴权、任务状态机、去重、串行、持久化       | 可用                 | 33 个 remote 测试                |
| 真机：iPhone Safari + OPPO Android                       | 已验收               | Sprint 01 报告第 13 节           |
| **Adopt Mode：导入已有工程（静态 / 子目录入口 / Vite）** | Sprint 02 新增       | `remote/lib/projects.cjs`        |
| **项目预览独立源（预览面 ≠ 控制面）**                    | Sprint 02 新增       | `remote/lib/preview.cjs`         |
| **修改前快照 / 差异 / 回退（含备份）**                   | Sprint 02 新增       | `remote/lib/projects.cjs` + 测试 |
| **孤儿 CLI 进程收敛**                                    | Sprint 02 新增       | `cli-runner.cjs` + `leases.cjs`  |
| 项目记忆与连续多轮                                       | Sprint 02 新增（P1） | `memory.json` + `-c` 续接        |
| 跨互联网协同                                             | **未验证**           | 仅保留传输层可替换性             |

## 3. 已知限制

1. **Sprint 02 未经真机验收**：本轮只提供手机验收地址与步骤，真机结论待产品负责人执行。
2. **独立安全审计仍在进行**（Qoder）：本仓库不宣称审计通过。
3. 图像 / 视频 / 音频模态未启用（只有 DeepSeek Key），生成物走占位。
4. Vite 项目需要**已构建的 dist**；系统不会自动执行 `npm run build`（避免在用户工程里跑脚本）。
5. 快照不包含 `dist/`、`node_modules/`、`.git/`：回退只回退源码，不负责重建产物。
6. 默认只监听 `127.0.0.1`；开放局域网需显式 `REMOTE_HOST`。
7. 公开模式（`VPLAY_PUBLIC_MODE=1`）会禁用 `--yolo` 并拒绝非受控工作区。

## 4. 风险登记

| 风险                                  | 影响 | 处置                                                   |
| ------------------------------------- | ---- | ------------------------------------------------------ |
| 无 Token 误暴露控制面                 | 高   | 未配置 `REMOTE_TOKEN` → 控制接口 503                   |
| 游戏脚本借 Cookie 调管理 API          | 高   | 预览独立端口 + 写接口 Origin 校验                      |
| 预览路径穿越 / 点文件 / junction 逃逸 | 高   | 统一 `resolveStaticFile`（realpath + 边界 + 点段拒绝） |
| Worker 崩溃留孤儿 CLI 进程            | 高   | cli-runner 父进程看门狗 + 启动时租约收敛               |
| 旧任务与新任务同写一个工作区          | 高   | 项目锁 + 全局串行 worker                               |
| 回退误伤用户工程                      | 中   | 回退前自动备份；禁止 git reset --hard / clean -fd      |
| 不同项目上下文串扰                    | 中   | projectId 隔离 + 每项目 memory + 独立 cwd 会话         |

## 5. 里程碑

- M0 部署与最小生成（完成）
- M1 Sprint 01：安全远程任务通道 + 真机验收（完成，13/13）
- M2 Sprint 02：接管模式、预览隔离、快照回退、孤儿收敛（代码完成，待真机与安全审计）
- M3 跨互联网协同（外部组网评估，不在仓库内自建 Relay）

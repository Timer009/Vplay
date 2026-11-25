# Vplay Studio · 架构

## 1. 总体结构

```
┌───────────────┐   Bearer Token   ┌──────────────────────────────┐
│ 手机 / 浏览器  │ ───────────────▶ │ 控制面  server.cjs :8787      │
│  /console     │ ◀─────────────── │  · 鉴权 / Origin 校验          │
└───────────────┘  状态/任务/项目   │  · 任务队列 + 状态机           │
                                   │  · 串行 worker                 │
                                   └───────────┬──────────────────┘
                                               │ cli-runner（看门狗 + 租约）
                                               ▼
                                   ┌──────────────────────────────┐
                                   │ OpenGame CLI（正式用户消息）   │
                                   │  -p "<prompt>" --approval-mode│
                                   └───────────┬──────────────────┘
                                               ▼
                                   ┌──────────────────────────────┐
                                   │ 项目工作副本 src/             │
                                   │  .snapshots/  profile/memory │
                                   └───────────┬──────────────────┘
                                               │ 只读静态
┌───────────────┐   无鉴权 / 只读  ┌────────────▼─────────────────┐
│ 游戏预览      │ ◀─────────────── │ 预览面  preview.cjs :8788     │
│ （独立源）     │                 │  · 点文件/穿越/junction 拦截   │
└───────────────┘                 └──────────────────────────────┘
```

**控制面与预览面必须不同源。** 浏览器 Cookie 不区分端口，因此仅靠换端口不足以
防 CSRF；控制面的写接口（/prompt、/rollback、/auth/verify）额外做 Origin 校验，
预览页即使带着同站 Cookie 也无法调用管理 API。

## 2. 代码分层

| 层       | 路径                                      | 职责                                     |
| -------- | ----------------------------------------- | ---------------------------------------- |
| CLI      | `packages/cli/src/`                       | 交互/非交互入口、参数解析、UI            |
| Core     | `packages/core/src/`                      | Agent 配置、工具实现、模型调用           |
| 工具     | `packages/core/src/tools/`                | CopyTemplate、PostVerify                 |
| 控制面   | `remote/server.cjs`                       | HTTP 路由、鉴权、Origin、任务与项目 API  |
| 预览面   | `remote/lib/preview.cjs`                  | 独立端口只读静态服务                     |
| 任务     | `remote/lib/tasks.cjs`                    | 任务 ID、状态机、去重、持久化            |
| 执行     | `remote/lib/worker.cjs`                   | 串行执行、快照、记忆、验证               |
| 进程     | `remote/lib/cli-runner.cjs`、`leases.cjs` | 父进程看门狗、孤儿收敛                   |
| 项目     | `remote/lib/projects.cjs`                 | 注册表、导入、画像、快照、差异、回退、锁 |
| 路径安全 | `remote/lib/paths.cjs`                    | 边界判定、realpath、哈希、diff           |
| 管理 CLI | `remote/cli.cjs`                          | 本机导入 / 列表 / 快照 / 差异 / 回退     |

## 3. 两种模式

### 单工作区（默认，兼容 Sprint 01）

- 未设置 `VPLAY_HOME`。
- 任务写入 `OPENGAME_WORKSPACE`；预览为 `http://host:<port+1>/legacy/`。
- 运行时状态在 `<workspace>/.opengame/`。

### 项目模式（Adopt Mode）

- 设置 `VPLAY_HOME`（默认 `~/.vplay`）。
- `projects.json` 保存 `projectId → srcDir` 映射；HTTP 只接受 projectId。
- 目录：`projects/<id>/src`、`.snapshots/`、`profile.json`、`memory.json`。
- 运行时状态在 `<VPLAY_HOME>/.opengame/`（任务、日志、租约、锁）。
- 预览为 `http://host:<port+1>/p/<id>/`。

## 4. 导入流程（Adopt Mode）

1. 本地 CLI：`node remote/cli.cjs project import <path> --id <id> [--entry ...]`。
2. 对原始工程做 SHA-256 清单（排除 `.git`/`node_modules`/`dist`）。
3. 复制到 `projects/<id>/src`（包含 dist，供预览）；再次哈希，必须与原始一致。
4. 识别类型：`static`（零依赖 HTML/JS、子目录入口）或 `vite`（依赖/vite.config）。
5. 写画像与初始快照；**原始工程哈希在导入后必须不变**。
6. HTTP 的 `/projects/import` 永远 403——导入只能在本机执行。

## 5. 任务执行与验证

```
queued → running → verifying → succeeded
                    └────────→ failed
重启时 running/verifying → interrupted（不自动重跑）
```

- 执行前：项目锁 → 快照 `pre-task-<id>` → 组合项目上下文与记忆。
- 执行：`cli-runner` 启动 CLI，`--approval-mode yolo`（公开模式降为 `auto-edit`）。
- 完成后：
  - 计算与快照的差异（added/modified/removed）；
  - `verified` = 入口存在 && 预览就绪 && post-verify 无 issue；
  - 写入项目记忆（最近 20 轮）；
  - 释放锁。
- **执行成功 ≠ 验证成功**：`result.verified` 单独标记，控制台显示「未验证」。

## 6. 快照与回退

- 快照 = `src` 的完整复制（排除 `.git`/`node_modules`/`.opengame`/`dist`），附 SHA-256 清单。
- 差异 = 文件级 added/modified/removed + 文本 unified diff（新增/删除由服务端生成，
  修改交给 `git diff --no-index`，不改用户工程）。
- 回退：先创建 `pre-rollback-<n>` 备份，再删除多余文件、写回快照文件，最后校验哈希。
- **禁止** `git reset --hard` / `git clean -fd`；回退不依赖用户工程是否 git 仓库。

## 7. 进程与锁

- `cli-runner` 每 2s 写租约心跳，并探测父进程；父进程消失即杀 CLI 进程树。
- 服务启动时扫描 `.opengame/leases/*.json`：心跳过期且命令行匹配 runner/taskId
  才杀进程；不匹配则只清理租约，避免误杀。
- 项目锁：`<VPLAY_HOME>/.opengame/locks/<id>.lock`，含 pid 与 taskId；
  进程不存活时视为过期锁。

## 8. 传输层可替换性

远程通道只依赖「HTTP + Bearer Token」，不感知来源网络；未来可放在 Tailscale /
Cloudflare Tunnel / WireGuard 之后。本仓库不自建公网 Relay，不改防火墙/代理。

# Vplay Studio · 架构

## 1. 总体结构

```
┌──────────────┐   一句话 prompt    ┌─────────────────────────────┐
│  手机浏览器   │ ───────────────▶ │ remote/server.cjs           │
│  /console    │ ◀─────────────── │ · REMOTE_TOKEN 鉴权          │
└──────────────┘   状态/任务/产物   │ · 任务队列 + 状态机           │
                                   │ · 串行 worker（子进程）       │
                                   └──────────────┬──────────────┘
                                                  │ spawn（正式用户消息入口）
                                                  ▼
                                   ┌─────────────────────────────┐
                                   │ dist/cli.js -p "<task>" -y   │
                                   │  packages/cli + packages/core│
                                   │  · Agent 循环 / 工具调用      │
                                   │  · CopyTemplate 模板脚手架    │
                                   │  · PostVerify 静态校验        │
                                   └──────────────┬──────────────┘
                                                  ▼
                                   ┌─────────────────────────────┐
                                   │ 游戏工作区 workspace/         │
                                   │  index.html / src/ / assets/ │
                                   │  .opengame/ 运行时状态与队列   │
                                   └─────────────────────────────┘
```

## 2. 代码分层

| 层         | 路径                                                 | 职责                                           |
| ---------- | ---------------------------------------------------- | ---------------------------------------------- |
| CLI        | `packages/cli/src/`                                  | 交互/非交互入口、参数解析、UI                  |
| Core       | `packages/core/src/`                                 | Agent 配置、工具实现、模型调用                 |
| 工具       | `packages/core/src/tools/`                           | CopyTemplate、PostVerify 等                    |
| 运行时状态 | `packages/core/src/utils/runtime-status.ts`          | `.opengame/runtime-status.json` 读写           |
| 远程通道   | `remote/`                                            | HTTP 服务、任务存储、串行 worker、移动端控制台 |
| 调试规则   | `agent-test/debug-skill/seed-protocol/protocol.json` | 错误模式 → 根因 → 修复建议                     |

## 3. 远程任务数据流（Sprint 01）

1. 手机 `POST /prompt`，携带 `Authorization: Bearer <REMOTE_TOKEN>`。
2. 服务端校验 Token、Content-Type、正文长度、`idempotencyKey`；
   写任务记录到 `.opengame/remote/tasks.json`（原子写），状态 `queued`。
3. 串行 worker 取最早 `queued` 任务 → `running`，`spawn` 子进程：
   `node dist/cli.js -p "<text>" --yolo`，cwd 为目标游戏工作区。
4. 子进程运行时，worker 每秒读 `.opengame/runtime-status.json`，
   映射 `generating` / `verifying` 到任务状态。
5. 子进程退出：
   - 退出码 0 → `succeeded`，记录产物路径与 post-verify 摘要；
   - 非 0 → `failed`，记录退出码、stderr 尾部；
   - 超时 → 杀进程树 → `failed`。
6. 手机轮询 `GET /status`、`GET /tasks/:id` 查看进度与结果。

## 4. 状态机

```
queued ──▶ running ──▶ verifying ──▶ succeeded
   │          │            │
   └──────────┴────────────┴──────▶ failed
   （服务重启时 running/verifying ──▶ interrupted，绝不自动重跑）
```

- 校验失败不进入队列（直接 400/401/409）。
- `idempotencyKey` 相同的重复提交返回同一任务（200，不新建）。
- 相同文本且已有 `queued/running` 任务时返回 409。

## 5. 安全边界

- **鉴权只在 HTTP 层**：`REMOTE_TOKEN` 缺失 → 所有控制接口 503。
  不识别任何「TRUSTED REMOTE INSTRUCTION」之类的文本标记。
- Token 只从环境变量（或 `REMOTE_TOKEN_FILE`）读取，不落日志、不入 Git。
- 默认绑定 `127.0.0.1`；`REMOTE_HOST=0.0.0.0` 需显式开启并会打印警告。
- 静态产物同样需要 Token（Header / Cookie），Cookie 由 `POST /auth/verify` 下发。
- 请求体上限 64 KB，prompt 长度上限 4000 字符，`POST /prompt` 有频率限制。

## 6. 传输层可替换性

远程通道只依赖「HTTP + Bearer Token」，不感知来源网络。因此未来可放在
Tailscale / Cloudflare Tunnel / WireGuard 之后，无需改动业务代码；
Sprint 01 不搭建公网 Relay，也不修改防火墙或代理配置。

## 7. 关键文件

- `remote/server.cjs` — HTTP 服务与鉴权
- `remote/lib/tasks.cjs` — 任务存储、状态机、去重、恢复
- `remote/lib/worker.cjs` — 串行执行器
- `remote/index.html` — 移动端控制台
- `packages/core/src/utils/runtime-status.ts` — 运行时状态
- `packages/core/src/tools/post-verify.ts` — 生成后校验
- `packages/core/src/tools/copy-template.ts` — 模板脚手架

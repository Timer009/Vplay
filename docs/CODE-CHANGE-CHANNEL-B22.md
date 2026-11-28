# B22-C 受控代码变更通道（code_change）

> 独立功能候选：`sprint-03-b22-code-change`（基于安全候选 `sprint-03-b22-safety`）。
> 本轮只实现最小通用通道，不实现 Spacer 陆地回收、不预制目标补丁、不放宽 Vision。

## 1. 能力与边界

| 允许                                                                               | 禁止                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 已授权隔离实验项目内的 `.js/.mjs/.cjs/.html/.htm/.css` 语义变更（含 HTML 内嵌 JS） | 任意 shell、依赖安装、外部网络                                |
| 完整文件内容的 change-set（≤20 文件、单文件 ≤256 KB、合计 ≤1 MB）                  | `vendor/`、`node_modules/`、`.git`、`.qwen`、`.env`、隐藏路径 |
| 管理员审批 + 基线/diff/文件哈希复核                                                | `package.json`/锁文件/系统文件/凭据                           |
| 原子写入 + journal 回滚                                                            | Agent 直接调用；仅管理员 HTTP 入口                            |

项目白名单：`VPLAY_CODE_CHANGE_PROJECTS`（逗号分隔）。为空 = 通道关闭。

## 2. 流程

```text
真实模型 → 结构化 change-set（POST /projects/:id/code-change，管理员）
        → 服务端计算 baseHash + 展示 diff + diffSha256
        → 任务 awaiting_approval（restricted=true）
        → 管理员独立审批（HMAC proof 绑定 codeChange）
        → worker：基线树哈希 → 文件哈希 → diff 哈希 三重复核
        → 原子写入 + journal → 固定检查（node --check/存在性）
        → 失败回滚；成功发布预览（manifest 级）
        → 浏览器验证：等待 E16 0.2.3（当前 BLOCKED）
```

### API

```http
POST /projects/<id>/code-change
Authorization: Bearer <REMOTE_TOKEN>
Content-Type: application/json

{
  "summary": "generic dummy feature",
  "files": [
    { "path": "game.js", "content": "window.score = 10;\n" },
    { "path": "index.html", "content": "<!doctype html>..." }
  ]
}
```

返回 `202` + `task`（`kind=code_change`, `status=awaiting_approval`, `codeChange.diff`）。
管理员 `POST /tasks/:id/approve` 后 worker 执行；`GET /tasks/:id` 可查看 diff 与结果。

## 3. 安全门禁

1. **管理员专属**：创建与审批均要求 admin token；设备/会话 403。
2. **审批绑定**：proof 覆盖 `baseHash`、`diffSha256`、每文件 `sha256`、模型、有效期、次数；
   审批后改动 content/diff/基线 → 验签或复核失败，不写入。
3. **基线复核**：执行前重算项目树哈希，必须等于创建时基线（`CODE_CHANGE_BASE_MISMATCH`）。
4. **内容复核**：每个文件内容哈希必须等于审批签名中的哈希（`CODE_CHANGE_CONTENT_MISMATCH`）。
5. **diff 复核**：重新渲染 diff 并比对 `diffSha256`（`CODE_CHANGE_DIFF_MISMATCH`）。
6. **原子写入**：临时文件 + rename；失败按 journal 恢复；成功也保留 journal。
7. **固定检查**：JS `node --check`，HTML/CSS 存在性；不执行项目代码、不装依赖、不联网。
8. **隔离项目**：仅 `VPLAY_CODE_CHANGE_PROJECTS` 白名单中的导入项目；拒绝 symlink 路径。
9. **无放宽 Vision**：通道独立于 Vision 0.2.2；不使用 Vision allowedFiles 扩大写入范围。

## 4. 结果语义

- `status=succeeded` 仅代表“已应用 + 静态检查通过”；
- `result.verified=false`、`outcome=code_change_unverified`；
- `result.codeChange.browserVerification = BLOCKED_E16_SANDBOX`；
- 浏览器验证必须在 0.2.3 接入后补做，通过后才可声明 `verified`；
- 检查失败或哈希不符：`failed`，并回滚（`rolledBack=true`）。

## 5. 本轮不实现

- Spacer 陆地回收或任何特定玩法补丁；
- 依赖安装、构建系统改造、vendor 变更；
- 真实模型调用；change-set 由外部 Harness/模型产生，本轮只用通用 dummy 测试；
- 浏览器自动化验证（E16 0.2.3 集成前，禁止用 no-sandbox 0.2.2 替代）。

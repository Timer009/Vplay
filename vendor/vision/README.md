# @vplay/vision 0.2.0 — E05 security candidate

> 独立候选包：结构化补丁白名单、浏览器出站限制、截图/源码脱敏、宿主锁/原子 apply 契约。E03-H 的 0.1.0 保持不变。

Vplay Studio 的可移植视觉验证模块包。它把 E02 已验证的真实双模型闭环整理为可集成组件：

- Qwen 视觉分析（已验证 `qwen4-max`）
- DeepSeek 精确补丁生成（已验证 `deepseek-v4-flash`）
- Playwright 浏览器截图与功能断言
- 游戏验证适配器（Spacer + 通用 DOM 示例）
- 纯补丁安全校验/物化（不写文件、不做快照/回退）
- 结构化任务事件
- 宿主驱动的验证闭环

**不包含**：项目管理、任务队列、快照、回退。这些由 Vplay Sprint 02 的 `remote/lib/projects.cjs` / `remote/lib/tasks.cjs` 提供；本包通过 `host` 回调使用它们。

## 运行环境

- Node.js **>=20**（已在标准 Node **v24.22.3** 下测试，非 ZCode/Electron）
- `playwright-core`（peerDependency，可选；浏览器需系统 Chromium/Edge 或显式安装）
- 浏览器路径：`VPLAY_BROWSER_EXECUTABLE` / `BROWSER_EXECUTABLE`
- 不引用 `ZCode.exe`、`ELECTRON_RUN_AS_NODE` 或 POC 绝对路径

## 安装/使用

```bash
npm install @vplay/vision
npm install playwright-core   # 若尚未安装
```

```js
import {
  createModelGateway,
  createBrowserRunner,
  createSpacerAdapter,
  createEventSink,
  runVisionTask,
  loadConfig,
} from '@vplay/vision';

const config = loadConfig(process.env);
const gateway = createModelGateway({ config });
const browser = createBrowserRunner({
  executablePath: process.env.VPLAY_BROWSER_EXECUTABLE,
});
const events = createEventSink({
  taskId: 'task_123',
  projectId: 'spacer',
  onEvent: (event) => console.log(JSON.stringify(event)),
});

const result = await runVisionTask({
  taskId: 'task_123',
  projectId: 'spacer',
  root: '/path/to/projects/spacer/src',
  previewUrl: 'http://127.0.0.1:8788/p/spacer/',
  adapter: createSpacerAdapter({ overlaySelector: '#optional-overlay' }),
  browserRunner: browser,
  gateway,
  events,
  mode: 'analyze', // 或 'repair'
  outDir: '/path/to/artifacts/vision/task_123',
});
```

`repair` 模式需要宿主提供快照/应用/diff/回退：

```js
const host = {
  snapshot: (label) => projects.snapshot(projectId, label), // { seq }
  applyFiles: async (files) => writeFiles(project.srcDir, files), // 宿主写文件
  diff: (seq) => projects.diff(projectId, seq, 'current'),
  rollback: (seq) => projects.rollback(projectId, seq),
};
```

本包**不会**自己创建快照、写回退记录或管理任务。`sourceProvider` 也由宿主提供（决定读取哪些源码片段）。

## 配置

| 变量                                              | 默认                                                | 说明                      |
| ------------------------------------------------- | --------------------------------------------------- | ------------------------- |
| `VPLAY_VISION_MODEL` / `VISION_MODEL`             | `qwen4-max`                                         | E02 真实请求验证          |
| `VPLAY_VISION_BASE_URL` / `VISION_BASE_URL`       | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容               |
| `VPLAY_VISION_API_KEY` / `DASHSCOPE_API_KEY`      | 无                                                  | 只走环境变量              |
| `VPLAY_VISION_TIMEOUT_MS`                         | 180000                                              | 视觉请求超时              |
| `VPLAY_VISION_MAX_TOKENS`                         | 6000                                                | E02 截断后验证值          |
| `VPLAY_VISION_STRUCTURED_OUTPUT`                  | `prompt`                                            | `prompt` 或 `json_object` |
| `VPLAY_TEXT_MODEL` / `DEEPSEEK_MODEL`             | `deepseek-v4-flash`                                 | 代码补丁                  |
| `VPLAY_TEXT_BASE_URL` / `DEEPSEEK_BASE_URL`       | `https://api.deepseek.com`                          |                           |
| `VPLAY_TEXT_API_KEY` / `DEEPSEEK_API_KEY`         | 无                                                  |                           |
| `VPLAY_TEXT_TIMEOUT_MS`                           | 120000                                              |                           |
| `VPLAY_TEXT_MAX_TOKENS`                           | 4096                                                |                           |
| `VPLAY_MAX_VISION_CALLS`                          | 12                                                  | 预算                      |
| `VPLAY_MAX_TEXT_CALLS`                            | 4                                                   | 预算                      |
| `VPLAY_BROWSER_EXECUTABLE` / `BROWSER_EXECUTABLE` | 自动发现                                            | Chromium/Edge             |
| `VPLAY_BROWSER_HEADLESS`                          | true                                                |                           |

价格不硬编码；`Budget` 只在宿主提供 `VPLAY_*_PRICE_PER_MTOK` 时估算费用。

## 错误分类（401/403 不重试）

`VisionError.category`：

| 类别               | 触发                   | 自动重试                             |
| ------------------ | ---------------------- | ------------------------------------ |
| `auth`             | 401                    | 否                                   |
| `permission`       | 403                    | 否                                   |
| `quota`            | 402 / 429 quota-like   | 否                                   |
| `rate_limit`       | 429 非 quota           | 默认否（可配置）                     |
| `network`          | fetch 失败             | 是（最多 maxAttempts）               |
| `timeout`          | Abort/Timeout          | 否                                   |
| `server`           | 5xx                    | 是（可关闭）                         |
| `output_truncated` | `finish_reason=length` | 否；调用方显式提高 max tokens 后重试 |
| `invalid_json`     | JSON 解析失败          | 否                                   |
| `schema`           | 结构校验失败           | 否                                   |
| `budget`           | 预算耗尽               | 否                                   |

## 浏览器隔离

- `createBrowserRunner` 不接收模型配置。
- 启动浏览器时使用 `sanitizeBrowserEnv`：只保留 PATH/HOME/DISPLAY/字体/库路径等非敏感变量；`*_API_KEY`、`*TOKEN*`、`*SECRET*`、`DASHSCOPE`、`DEEPSEEK`、`OPENAI` 全部剥离。
- 模型 HTTP 调用发生在 Node 进程；浏览器进程拿不到 Key。

## 适配器

- `createSpacerAdapter()`：Spacer 专用（`window.game`、`#btnT`、燃料）。这是唯一包含 Spacer 规则的文件。
- `createDomAdapter()`：通用 selector + 点击/文案断言；测试里用它验证“非 Spacer 游戏”也能工作。
- 新游戏只需实现 `{ id, viewports, ready, setup, assert }`；通用 runner 不包含任何 `btnT`/燃料逻辑。

验收语义：**可见性 + 命中测试 + 交互/功能结果**。`display:none` 的覆盖层只要不可见、不拦截命中，即通过；不要求 DOM 元素不存在。

## 事件

`createEventSink` 生成：

```json
{
  "schemaVersion": 1,
  "eventId": "…",
  "taskId": "task_123",
  "projectId": "spacer",
  "seq": 4,
  "type": "vision.verification.completed",
  "at": "2026-11-26T…",
  "payload": { "verified": true, "changes": 1 },
  "artifacts": [{ "path": "…/spacer-mobile-after.png", "sha256": "…" }]
}
```

事件只回调给宿主，不落库、不排队；Vplay 可写任务日志/结果。

## 测试

```bash
# 标准 Node（本 POC 内置的便携 Node）
NODE_PATH=<vplay>/node_modules \
  node --test test/*.test.mjs
```

- 59 个测试：配置/错误/HTTP 重试/真实 E02 响应回放/补丁纯校验/事件/浏览器环境/两个适配器/宿主闭环/可移植性。
- 浏览器测试真实启动 Edge，验证 `display:none` 覆盖层通过、可见遮挡失败。
- 无新增真实模型调用；视觉/文本测试使用 E02 已保存响应 + 本地 HTTP stub。

## E05 安全候选新增

- 结构化 HTML/CSS allowlist（拒绝 C07 的 9 类绕过与动态脚本/外链/路径逃逸/symlink）。
- 浏览器出站白名单、禁新窗口/下载/弹窗、service worker 阻断、跨源导航阻断。
- 截图 selector/region 遮罩 + 源码 secret 扫描/脱敏。
- 模型端点 HTTPS/主机 allowlist、8MB 响应上限。
- 宿主锁所有权/`skipLock`/原子 apply/journal/全量 manifest/回退契约：`docs/HOST-CONTRACT.md`。
- 测试：59/59（标准 Node v24.22.3）。

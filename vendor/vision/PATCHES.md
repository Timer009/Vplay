# Vendored `@vplay/vision` 0.2.0 — 宿主补丁说明（B10）

- 交付包：`vplay-vision-0.2.0.tgz`
- SHA256：`96795b68b38355b4ad6f05c3af2e802c673bd810093ff3683a3fc661da355ca7`
- 上游源码包：`d7c01ab9d9e979ddeedc2c4b0ae5ad415d55d4d96959cf987192ce2021f40470`

## 唯一补丁

文件：`src/browser/runner.mjs`

- `createBrowserRunner({ ..., cookies = [] })`
- `browser.newContext(...)` 之后：`if (cookies.length) await context.addCookies(cookies)`

原因（E06 §9 B2）：受保护预览（`PREVIEW_ACCESS_KEY`）下，Vision 截图需要把短期票据注入
独立浏览器 context；0.2.0 公开 API 没有 Cookie 注入点，导致 capture 全部 401。

约束：

- Cookie 只存在于宿主内存与本进程浏览器 context，**不落盘、不进入截图、不进入模型上下文**；
- 票据由宿主 `previewTicketProvider` 生成，5 分钟最小权限，任务结束即失效；
- 未修改 Vision 的补丁白名单、网络守卫、脱敏或模型契约。

> 该补丁只作用于本仓库 vendored 副本；上游包哈希不变，升级 0.2.1 时应移除本补丁并以
> 上游 `cookies/storageState` 能力替代。

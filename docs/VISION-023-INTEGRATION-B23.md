# B23-ADD：Vision 0.2.3 集成（哈希解阻后的候选）

> 依据：`VPLAY-VISION-E16-HASH-REPORT.md`、`VPLAY-VISION-E16-B23-HANDOFF.md`、
> `VPLAY-VISION-E16-HASH-MANIFEST.json`（`0e2fa17b…`）。
> 本集成只解除**产物身份/哈希**阻断；ARM64/Pi 浏览器验收仍为 **NOT_RUN**（E17 阶段 B/C）。

## 1. 权威身份

| 产物                            | SHA256                                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| `vplay-vision-0.2.3.tgz`        | `415cae0ec26687f2c2804a4f0954ce9ac0affd581aa33c9a8efca2903d17d91d` |
| `vplay-vision-0.2.3-source.tgz` | `ad49563c768d8de254d5e08c808639df3675d983a0be47b4df5443c386cd5a44` |
| 旧错误值 `64c8fdb2…`            | **废弃**，不得使用                                                 |

## 2. vendor 布局

```text
vendor/vision/            0.2.2 冻结证据（未改动）
  vplay-vision-0.2.2.tgz  c7679c02…
vendor/vision-0.2.3/      0.2.3 候选（官方 tgz 解包 + 原始 tgz/source）
  vplay-vision-0.2.3.tgz  415cae0e…
  src/browser/runner.mjs  13426252…（chromiumSandbox: true）
```

- 0.2.3 目录未重新打包、未修改源码；`SHA256SUMS`/`PATCHES.md` 记录身份。
- 0.2.2 目录逐字节保留。

## 3. 宿主切换与失败关闭

`remote/lib/vision-service.cjs`：

- `VPLAY_VISION_VERSION`：默认 `0.2.3`；显式 `0.2.2` 可回退；其它值 →
  `VISION_VERSION_UNSUPPORTED`，拒绝加载。
- 加载前校验 `vendor tgz` 的 SHA256；不匹配 → `VISION_VENDOR_INTEGRITY`。
- 保留 B19/B22 `VPLAY_BROWSER_ARGS` 白名单 + `launchArgs` 传参；不新增 sandbox 开关。
- `BROWSER_SANDBOX_BYPASS` 由 0.2.3 构造期抛出；宿主按失败关闭处理，不重试、不降级。
- guard/strict-repair/delta/structure/auth/rollback 未改；land-pin 未实现。

## 4. 测试

`node --test remote/test/b23-vision.test.cjs`：

- 0.2.3/0.2.2 tgz 哈希；
- 默认版本、回退版本、未知版本失败关闭；
- vendor 完整性校验（篡改 expected hash → 拒绝）；
- 0.2.3 `runner.mjs` 硬编码 `chromiumSandbox: true`、包含 `BROWSER_SANDBOX_BYPASS`；
- 0.2.2 runner 保持冻结（不含该硬编码）。

## 5. 未完成（不得计 PASS）

| 项                                                 | 状态                     |
| -------------------------------------------------- | ------------------------ |
| Pi Chromium 156 + 0.2.3 实际启动/argv/sandbox/截图 | **NOT_RUN**（阶段 B）    |
| 预览鉴权/跨源/结构/strict/回滚 Pi 集成             | **NOT_RUN**（阶段 C）    |
| RP_VISION_GATE / land-pin                          | **NOT_RUN / 未实现**     |
| Windows Edge 证据                                  | 沿用 E16，不可替代 ARM64 |

## 6. 验收脚本（Pi 侧，未执行）

```bash
E16_CANDIDATE_ROOT=/srv/vplay-lab/e15-package/vendor/vision-0.2.3 \
E16_BROWSER_EXECUTABLE=/usr/bin/chromium \
E16_PLAYWRIGHT_CORE=/srv/vplay-lab/e15-package/node_modules/playwright-core \
E16_OUT_DIR=artifacts/pi-v023 \
node scripts/pi-accept-0.2.3.mjs
```

或：

```bash
cd /srv/vplay-lab/e15-package
E16_BROWSER_EXECUTABLE=/usr/bin/chromium E15_OUT_DIR=artifacts/run-v023 \
node scripts/v023-sandbox.mjs
```

# Vendored `@vplay/vision` 0.2.3（B23-ADD）

来源：ZCode E16 最终产物，E17 阶段 A 哈希确认；**未重新打包、未修改源码**。

| 文件 | SHA256 |
| --- | --- |
| `vplay-vision-0.2.3.tgz` | `415cae0ec26687f2c2804a4f0954ce9ac0affd581aa33c9a8efca2903d17d91d` |
| `vplay-vision-0.2.3-source.tgz` | `ad49563c768d8de254d5e08c808639df3675d983a0be47b4df5443c386cd5a44` |

- 目录内容由官方 tgz 解包得到（38 个发布文件），`src/browser/runner.mjs` 保持
  `13426252470d182e67cd9da7e39cb7a051b16e826f9dabd12fda4cf574deddbd`。
- 0.2.2 冻结证据保留在 `vendor/vision/`，未改动。
- 宿主选择：`VPLAY_VISION_VERSION`（默认 `0.2.3`；可显式回退 `0.2.2`）；
  加载前校验 tgz SHA256，不匹配即失败关闭。
- 不提供 sandbox 开关；`chromiumSandbox: true` 为硬编码；`BROWSER_SANDBOX_BYPASS`
  按失败关闭处理。

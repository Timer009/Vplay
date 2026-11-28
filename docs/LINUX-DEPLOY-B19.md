# ARM64 Linux 最小部署（B19）

> 适用：Raspberry Pi 5 / 4GB / 64-bit Debian/Ubuntu；冻结源码 `sprint-03-b16-candidate` @ `7d38f8e…` + B19 适配提交。
> 本文件是部署与接口说明，不代表真实 Agent/OS 隔离已验收。

## 1. 当前实现状态

| 能力                                        | 状态                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| Linux 进程组终止（worker/cli-runner/build） | **已实现**（B19；POSIX detached + kill(-pid)）                             |
| 受控浏览器低内存参数（白名单）              | **已实现**（`VPLAY_BROWSER_ARGS`；拒绝 `--no-sandbox` 等）                 |
| 可配置快照上限                              | **已实现**（`VPLAY_MAX_SNAPSHOTS`，2–200）                                 |
| POSIX umask                                 | **已实现**（`VPLAY_UMASK`，默认 027）                                      |
| 单任务/单浏览器                             | **已实现（设计约束）**：server 串行 worker；Vision 每个 capture 一个浏览器 |
| 模型凭据代理                                | **仅接口**（`OPENAI_BASE_URL` + dummy key；代理进程需按 C18 部署）         |
| 证据独立身份/封存                           | **仅接口**（staging/sealed 目录；`vplay-evidence` 与 oneshot seal 待部署） |
| 网络出口限制                                | **待部署**（cgroup/eBPF 或 bwrap；RP01 memory cgroup 当前不可用）          |
| Linux 全量测试                              | **待独立验收**（RP01 就绪后执行；Windows 结果不能替代）                    |

## 2. 安装（可逆）

```bash
# 1) Node 24 ARM64（官方二进制 + SHA256SUMS）
# 2) 系统依赖：build-essential python3 pkg-config git
#    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2
#    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
#    libpango-1.0-0 libcairo2 chromium fonts-liberation fonts-noto-cjk
# 3) 源码归档（RP01 GitHub DNS 不可用，使用 Harness 传输）
tar -xzf VPLAY-B19-SOURCE-<sha>.tar.gz -C /srv
cd /srv/VPLAY-B19
npm ci || npm ci --ignore-scripts
# 完整 Agent 需要：npm rebuild node-pty
npm run build
```

可逆：删除 `/srv/vplay-lab`、Node 安装目录与归档即可；不修改系统 Node/包管理器。

## 3. 运行（loopback + mock）

```bash
cp remote/tools/linux/vplay.env.example /srv/vplay-lab/vplay.env
chmod 600 /srv/vplay-lab/vplay.env
set -a; . /srv/vplay-lab/vplay.env; set +a
node remote/server.cjs
```

- `REMOTE_HOST=127.0.0.1`；不设置 `VPLAY_PUBLIC_MODE`/`REMOTE_TRUST_PROXY`。
- 单任务：server 串行 worker；不要并行 Vision verify/repair。
- 浏览器：`VPLAY_BROWSER_EXECUTABLE` 指向系统 ARM64 Chromium；`VPLAY_BROWSER_ARGS` 仅允许：
  `--disable-dev-shm-usage`、`--disable-gpu`、`--disable-software-rasterizer`、
  `--disable-background-networking`、`--disable-extensions`、`--mute-audio`、
  `--hide-scrollbars`、`--renderer-process-limit=1..4`、`--js-flags=--max-old-space-size=...`。
  **禁止** `--no-sandbox`、`--disable-setuid-sandbox`、`--single-process`、`--disable-web-security` 等。
- 快照：`VPLAY_MAX_SNAPSHOTS=20`；活跃租约保护、回退与并发一致性由 projects.cjs 保留。

## 4. systemd（部署模板，未执行）

`vplay.service` 关键项：

```ini
[Service]
User=vplay
Group=vplay
EnvironmentFile=/srv/vplay-lab/vplay.env
WorkingDirectory=/srv/vplay-studio
ExecStart=/usr/local/bin/node remote/server.cjs
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/srv/vplay-lab
RestrictAddressFamilies=AF_UNIX AF_INET
IPAddressAllow=127.0.0.1
MemoryMax=3G
MemoryHigh=2500M
CPUQuota=300%
TasksMax=256
KillMode=control-group
```

> RP01 报告：memory cgroup 被内核参数禁用；上述 `MemoryMax` 在修复 cgroup 前**不可执行**，不得声称已生效。

## 5. 模型凭据代理（对齐 C18）

- 代理进程 `vplay-proxy`（独立 UID，唯一可读真实 Key）；只允许白名单模型端点/路径。
- Vplay 环境只设置：
  `OPENAI_BASE_URL=http://127.0.0.1:18790/v1`、`OPENAI_API_KEY=<dummy>`。
- 当前代码已支持自定义 `OPENAI_BASE_URL`（C18 P-5 结论）；**无需改产品代码**。
- 未部署代理前，不要把真实 key 放进 Vplay/Agent 环境；真实 Agent 仍 DENIED。

## 6. 独立证据（对齐 C18）

```text
vplay (UID) ──写──> /srv/vplay-lab/evidence-staging (0750, 可篡改)
                         │ vplay-seal.service (User=vplay-evidence, oneshot)
                         ▼
                   /srv/vplay-lab/evidence (0700, Agent 不可读写)
                         │ 操作员 scp + HMAC 锚点
                         ▼
                   G:\AI_GAME\VPLAY-RP-EVIDENCE\<runId>\
```

- staging 与 sealed 分离；seal 生成 `manifest.json`（逐文件 sha256）与账本。
- 现有 `events.cjs` 的 HMAC/anchor 继续使用；封存由 OS/独立身份完成。
- 声明口径：`EVIDENCE_TAMPER_EVIDENT=true`；`EVIDENCE_IMMUTABLE_FOR_AGENT` 仅对 sealed 成立。

## 7. 测试

```bash
bash remote/tools/linux/run-linux-smoke.sh
# 可选：FULL_REMOTE=1 bash remote/tools/linux/run-linux-smoke.sh
```

Windows 侧仅做变更相关定点回归（B19 报告）；Linux 全量等待 RP01 就绪并由独立复验执行。

## 8. 未实现 / 未验收

- `vplay-proxy`、`vplay-seal.service`、`vplay-evidence` UID/ACL：需部署。
- cgroup/eBPF 出口限制：RP01 memory cgroup 不可用，需先修复内核/启动参数。
- Tailnet/Serve/公网：未启用；真实模型：未调用。
- `OS_ISOLATION=NOT_IMPLEMENTED` 保持不变，直到 C18 门禁独立通过。

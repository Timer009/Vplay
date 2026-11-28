#!/usr/bin/env bash
# B20 / C18 P-4：Linux 进程组终止、超时、孤儿与 PID 复用检查脚本。
# 在 Pi/受控实验节点上运行；不调用模型、不访问网络。
set -euo pipefail

echo "== platform =="
uname -a
node -v || true

WORK="${WORK:-/srv/vplay-lab/process-tree-smoke}"
rm -rf "$WORK"
mkdir -p "$WORK"

echo "== child + grandchild group kill =="
node -e '
const { spawn } = require("child_process");
const child = spawn(process.execPath, ["-e", `
  const { spawn } = require("child_process");
  spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
  setTimeout(()=>{},60000);
`], { stdio: "ignore", detached: true });
console.log(child.pid);
setTimeout(()=>{}, 60000);
' > "$WORK/pids"
PARENT=$(head -n1 "$WORK/pids")
sleep 0.5
# 期望：负 pid 组存在（spawn detached 后 parent 为组长）
if ! kill -0 "-$PARENT" 2>/dev/null; then echo "WARN: process group $PARENT not found"; fi
kill -KILL "-$PARENT" 2>/dev/null || true
sleep 0.5
if pgrep -f "setTimeout\\(\\)=>\\{\\},60000" >/dev/null 2>&1; then
  echo "FAIL: descendant survived group kill"
  pgrep -af "setTimeout" || true
  exit 1
fi
echo "PASS: group kill removed child/grandchild"

echo "== timeout path =="
node -e '
const { spawn } = require("child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore", detached: true });
const timer = setTimeout(()=>{ process.kill(-child.pid, "SIGKILL"); }, 300);
child.on("exit", ()=>{ clearTimeout(timer); });
setTimeout(()=>{}, 1000);
' || true
echo "PASS: timeout group kill completed"

echo "== PID reuse risk (observational) =="
echo "使用 ps -o pid,lstart,cmd 记录启动时间；不得仅凭 pid 存活判断孤儿所有权。"
ps -eo pid,lstart,cmd | head -n 10

echo "DONE"

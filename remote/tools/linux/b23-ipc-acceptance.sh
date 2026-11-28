#!/usr/bin/env bash
# B23 P0：control ↔ agent 分离验收（只读/探测；不调用真实模型、不修改系统）。
# 在 Pi 上以 root 运行可获得完整的跨 UID 负对照；以普通用户运行只做 socket/健康检查。
set -euo pipefail

REPO="${REPO:-/srv/vplay-lab/repo}"
LAB="${LAB:-/srv/vplay-lab}"
SOCK="${VPLAY_AGENT_SOCKET:-/run/vplay/agent.sock}"
STATE="${LAB}/state"
EVIDENCE="${LAB}/evidence"
PROXY="${LAB}/proxy"

pass=0
fail=0
ok() { echo "PASS  $*"; pass=$((pass + 1)); }
bad() { echo "FAIL  $*"; fail=$((fail + 1)); }

echo "== identity =="
id
node -v

echo "== socket =="
if [ -S "$SOCK" ]; then ok "socket exists: $SOCK"; else bad "socket missing: $SOCK"; fi
MODE=$(stat -c '%a %U %G' "$SOCK" 2>/dev/null || true)
echo "socket mode/owner: ${MODE:-n/a}"
case "$MODE" in
  "660 vplay-agent vplay-control") ok "socket mode/owner correct" ;;
  *) bad "socket must be 660 vplay-agent:vplay-control (got ${MODE:-n/a})" ;;
esac
DIRMODE=$(stat -c '%a %U %G' "$(dirname "$SOCK")" 2>/dev/null || true)
echo "socket dir: ${DIRMODE:-n/a}"
case "$DIRMODE" in
  "750 vplay-agent vplay-control") ok "socket dir mode/owner correct" ;;
  *) bad "socket dir must be 750 vplay-agent:vplay-control (got ${DIRMODE:-n/a})" ;;
esac

echo "== listener =="
if ss -xl 2>/dev/null | grep -q "agent.sock"; then ok "unix listener present"; else bad "agent.sock listener missing"; fi

echo "== units =="
for unit in vplay-control.service vplay-agent.service; do
  if systemctl is-active --quiet "$unit"; then ok "$unit active"; else bad "$unit not active"; fi
done
echo "control User: $(systemctl show -p User --value vplay-control.service 2>/dev/null || true)"
echo "agent User:   $(systemctl show -p User --value vplay-agent.service 2>/dev/null || true)"

echo "== agent replay state =="
AGENT_STATE="${LAB}/agent-state"
if [ -d "$AGENT_STATE" ]; then
  MODE=$(stat -c '%a %U %G' "$AGENT_STATE" 2>/dev/null || true)
  case "$MODE" in
    "700 vplay-agent vplay-agent") ok "agent-state mode/owner correct" ;;
    *) bad "agent-state must be 700 vplay-agent:vplay-agent (got ${MODE:-n/a})" ;;
  esac
  if [ -f "$AGENT_STATE/replay-state.json" ]; then
    MODE=$(stat -c '%a %U %G' "$AGENT_STATE/replay-state.json" 2>/dev/null || true)
    case "$MODE" in
      "600 vplay-agent vplay-agent") ok "replay-state 0600" ;;
      *) bad "replay-state must be 600 (got ${MODE:-n/a})" ;;
    esac
  else
    bad "replay-state.json missing (start agent once)"
  fi
else
  bad "agent-state directory missing"
fi

echo "== rollback operator unit =="
if [ -f /etc/systemd/system/vplay-rollback@.service ]; then
  ok "vplay-rollback@.service installed"
else
  bad "vplay-rollback@.service missing"
fi

echo "== IPC probe (control identity) =="
if runuser -u vplay-control -- env \
  VPLAY_AGENT_SOCKET="$SOCK" \
  VPLAY_IPC_HMAC_KEY="$(grep -E '^VPLAY_IPC_HMAC_KEY=' "$LAB/vplay.env" | cut -d= -f2-)" \
  node "$REPO/remote/tools/agent-probe.cjs" >/tmp/b23-probe.json 2>&1; then
  ok "control can probe agent"
  cat /tmp/b23-probe.json
else
  bad "control probe failed"; cat /tmp/b23-probe.json || true
fi

echo "== cross-UID secret isolation =="
if [ "$(id -u)" -eq 0 ]; then
  if runuser -u vplay-agent -- test -r "$STATE/remote/tasks.json"; then
    bad "vplay-agent can read control task state"
  else
    ok "vplay-agent cannot read control task state"
  fi
  if runuser -u vplay-agent -- test -r "$LAB/vplay.env"; then
    bad "vplay-agent can read control env (approval/IPC keys)"
  else
    ok "vplay-agent cannot read control env"
  fi
  if runuser -u vplay-control -- test -r "$PROXY/model.key"; then
    bad "vplay-control can read proxy key"
  else
    ok "vplay-control cannot read proxy key"
  fi
  if runuser -u vplay-agent -- test -w "$EVIDENCE"; then
    bad "vplay-agent can write sealed evidence"
  else
    ok "vplay-agent cannot write sealed evidence"
  fi
else
  echo "SKIP  cross-UID checks require root"
fi

echo "== result: pass=$pass fail=$fail =="
test "$fail" -eq 0

#!/usr/bin/env bash
# B19 ARM64 Linux smoke / targeted regression.
# Run inside the Pi lab after copying the B19 source archive.
# Does NOT call a real model. Uses loopback + mock only.
set -euo pipefail

REPO="${REPO:-/srv/vplay-studio}"
EXPECTED_SHA="${EXPECTED_SHA:-$(git -C "$REPO" rev-parse HEAD)}"
LAB="${LAB:-/srv/vplay-lab}"
PORT="${REMOTE_PORT:-18787}"
PREVIEW_PORT="${PREVIEW_PORT:-18788}"

echo "== versions =="
node -v
npm -v
uname -m
sha256sum "$REPO/vendor/vision/vplay-vision-0.2.2.tgz" "$REPO/vendor/vision/vplay-vision-0.2.2-source.tgz"

echo "== repo identity =="
git -C "$REPO" rev-parse HEAD
echo "expected: $EXPECTED_SHA"
test "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_SHA"
test -z "$(git -C "$REPO" status --porcelain)"

echo "== browser =="
test -x "${VPLAY_BROWSER_EXECUTABLE:-/usr/bin/chromium}" || { echo "Chromium missing"; exit 1; }
"${VPLAY_BROWSER_EXECUTABLE:-/usr/bin/chromium}" --version

echo "== build =="
cd "$REPO"
npm run build

echo "== targeted tests =="
node --test remote/test/b16-lock-writer.test.cjs
node --test remote/test/b14-vision-022.test.cjs
node --test remote/test/b19-linux-config.test.cjs
node --test remote/test/b20-restricted.test.cjs
node --test remote/test/b21-restricted-deployment.test.cjs
node --test remote/test/b22-safety.test.cjs
node --test remote/test/b22-code-change.test.cjs
node --test remote/test/b23-ipc.test.cjs
node --test remote/test/b23-code-change.test.cjs
node --test remote/test/b23-vision.test.cjs
node --test remote/test/b10-correctness.test.cjs
node --test remote/test/b12-snapshot-gc.test.cjs

if [ "${FULL_REMOTE:-0}" = "1" ]; then
  echo "== full remote suite (optional) =="
  npm run test:remote
fi

echo "== loopback health =="
mkdir -p "$LAB/home" "$LAB/workspace" "$LAB/evidence-staging"
export VPLAY_HOME="$LAB/home"
export OPENGAME_WORKSPACE="$LAB/workspace"
export REMOTE_HOST=127.0.0.1
export REMOTE_PORT="$PORT"
export PREVIEW_PORT="$PREVIEW_PORT"
export REMOTE_AUTORUN=0
export VPLAY_MAX_SNAPSHOTS=20
export VPLAY_UMASK=027
export VPLAY_RESTRICTED_DEPLOYMENT=1
export VPLAY_APPROVAL_HMAC_KEY="${VPLAY_APPROVAL_HMAC_KEY:-smoke-approval-key-0123456789abcdef}"
export VPLAY_MODEL_PROXY_URL="${VPLAY_MODEL_PROXY_URL:-http://127.0.0.1:18900/v1}"
export VPLAY_MODEL_PROXY_TOKEN="${VPLAY_MODEL_PROXY_TOKEN:-smoke-proxy-token}"
export PREVIEW_ACCESS_KEY="${PREVIEW_ACCESS_KEY:-smoke-preview-key-0123456789}"
export EVIDENCE_HMAC_KEY="${EVIDENCE_HMAC_KEY:-smoke-hmac-key-0123456789}"
export VPLAY_BROWSER_HEADLESS=true
node remote/server.cjs >"$LAB/smoke-server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/health"
echo
grep -q 'restricted deployment: yes' "$LAB/smoke-server.log" \
  || { echo "restricted deployment flag not enforced"; exit 1; }
curl -fsS "http://127.0.0.1:$PORT/status" -H "Authorization: Bearer smoke" >/dev/null 2>&1 && {
  echo "unexpected: /status accepted smoke token"; exit 1; } || true
echo "loopback health OK; server log: $LAB/smoke-server.log"

#!/usr/bin/env bash
# Push main and trigger a manual Render deploy of atlas-a2a-daemon.
#
# render.yaml sets autoDeploy:false on purpose (surprise restarts flap the agent's
# online status), so a push alone deploys NOTHING. This script does both halves.
#
# Credential — set ONE of these in your shell (never commit either):
#   RENDER_DEPLOY_HOOK  Render dashboard > atlas-a2a-daemon > Settings > Deploy Hook
#                       (looks like https://api.render.com/deploy/srv-xxxx?key=yyyy)
#   RENDER_API_KEY      an API key, used with RENDER_SERVICE_ID (srv-xxxx)
#
# Usage:  bash deploy/redeploy.sh
set -euo pipefail

BRANCH="${BRANCH:-main}"

echo "[redeploy] pushing $BRANCH"
if [ -n "$(git status --porcelain)" ]; then
  echo "[redeploy] ERROR: working tree is dirty — commit or stash first" >&2
  git status --short >&2
  exit 1
fi
git push origin "$BRANCH"

# Render builds whatever main points at, so record what we expect to see deployed.
SHA="$(git rev-parse --short HEAD)"
echo "[redeploy] main is at $SHA — this is the commit Render should check out"

if [ -n "${RENDER_DEPLOY_HOOK:-}" ]; then
  echo "[redeploy] triggering deploy via deploy hook"
  curl -fsS -X POST "$RENDER_DEPLOY_HOOK" >/dev/null
  echo "[redeploy] deploy triggered"
elif [ -n "${RENDER_API_KEY:-}" ] && [ -n "${RENDER_SERVICE_ID:-}" ]; then
  echo "[redeploy] triggering deploy via API for $RENDER_SERVICE_ID"
  # clearCache=do_not_clear keeps the build fast; the fix is in startCommand, not the build.
  curl -fsS -X POST \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"clearCache":"do_not_clear"}' \
    "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys" >/dev/null
  echo "[redeploy] deploy triggered"
else
  echo "[redeploy] no RENDER_DEPLOY_HOOK / RENDER_API_KEY set — push done, deploy NOT triggered."
  echo "[redeploy] Trigger it manually: Render dashboard > atlas-a2a-daemon > Manual Deploy > Deploy latest commit"
  exit 0
fi

cat <<'EOF'

[redeploy] Now watch the boot log. The line that matters:
    started pid=<n>          <- listener genuinely launched (fix worked)
    already running pid=<n>  <- still the phantom lock (fix did NOT take)
  Expect also: "purging stale daemon lock/pid" and "listener verified up".
EOF

#!/usr/bin/env bash
# Runtime entrypoint for the Render worker. Keeps agent #6991 online 24/7.
#
# Evidence-based design: OKX saw the agent online only when the BACKGROUND daemon
# reported `ready` (pid=..., ready). So we explicitly start that daemon and then
# stay in the foreground supervising it — restarting it if it ever dies — because
# a Render worker's container is killed the moment its foreground process exits.
set -u

echo "[run-daemon] restoring identity"
bash deploy/restore-identity.sh || echo "[run-daemon] WARN restore returned non-zero"

echo "[run-daemon] best-effort onchainos install"
bash deploy/install-onchainos.sh || true
export PATH="$HOME/.local/bin:$PATH"

echo "[run-daemon] binding AI provider"
okx-a2a config provider --provider claude || echo "[run-daemon] WARN provider bind failed"

echo "[run-daemon] doctor --fix (starts + readies the background daemon)"
okx-a2a doctor --fix --non-interactive || echo "[run-daemon] doctor reported issues (may be non-blocking)"

# Ensure the daemon is actually started (doctor should have, but be explicit).
okx-a2a daemon start || echo "[run-daemon] daemon start returned non-zero (may already be running)"

echo "[run-daemon] entering supervision loop"
# Foreground supervision: keep the container alive and the daemon up. If the
# daemon process dies, restart it. Check every 30s.
while true; do
  if ! okx-a2a status 2>/dev/null | grep -q "running"; then
    echo "[run-daemon] daemon not running — restarting"
    okx-a2a daemon restart || okx-a2a daemon start || true
  fi
  sleep 30
done

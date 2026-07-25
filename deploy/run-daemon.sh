#!/usr/bin/env bash
# Runtime entrypoint for the Render worker. Keeps agent #6991 online 24/7.
#
# Root cause of earlier failures (from the logs):
#   1. A systemd --user autostart unit got recorded ON THE PERSISTENT DISK by a
#      prior deploy. Its mere presence makes `daemon start/restart` REFUSE to run
#      ("autostart already installed; refusing to start a second manual daemon").
#   2. Render containers have no systemd user bus, so the autostart daemon can't
#      actually run either ("Failed to connect to bus: No medium found").
#   => deadlock: autostart can't run, and its record blocks manual start.
#
# Fix: purge the stale autostart record first, then start the daemon WITHOUT
# autostart (--no-autostart) so it never touches systemd again. Then supervise.
set -u

echo "[run-daemon] restoring identity"
bash deploy/restore-identity.sh || echo "[run-daemon] WARN restore returned non-zero"

echo "[run-daemon] best-effort onchainos install"
bash deploy/install-onchainos.sh || true
export PATH="$HOME/.local/bin:$PATH"

echo "[run-daemon] binding AI provider"
okx-a2a config provider --provider claude || echo "[run-daemon] WARN provider bind failed"

# CRITICAL: clear any stale autostart record left on the persistent disk by a
# previous deploy. Without this, every daemon start is refused. Ignore errors
# (nothing to uninstall on a clean disk).
echo "[run-daemon] purging any stale autostart record (systemd unavailable in container)"
okx-a2a daemon autostart uninstall 2>/dev/null || true

start_daemon() {
  # Start WITHOUT autostart so it never tries to touch the (absent) systemd bus.
  okx-a2a daemon start --no-autostart
}

echo "[run-daemon] starting daemon (no autostart)"
start_daemon || echo "[run-daemon] initial start returned non-zero — supervision loop will retry"

echo "[run-daemon] entering supervision loop"
# Keep the container alive (a worker dies when its foreground process exits) and
# keep the daemon up. Only act when it is actually down.
while true; do
  if ! okx-a2a status 2>/dev/null | grep -q "running"; then
    echo "[run-daemon] daemon not running — (re)starting"
    okx-a2a daemon autostart uninstall 2>/dev/null || true
    start_daemon || true
  fi
  sleep 30
done

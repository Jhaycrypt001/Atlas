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

# REQUIRED: install the onchainos skills so Claude knows the A2A task protocol.
# Without them the daemon's "Read the okx-agent-task skill" tip resolves to nothing
# and the agent never replies -> OKX task times out (the review failure we're fixing).
echo "[run-daemon] installing onchainos skills (required for A2A replies)"
bash deploy/install-skills.sh || echo "[run-daemon] WARN skills install returned non-zero"

echo "[run-daemon] binding AI provider"
okx-a2a config provider --provider claude || echo "[run-daemon] WARN provider bind failed"

# REQUIRED: force the AI subsession to bypass permissions. In headless `claude
# --print` there is no human to approve tool calls; in the default "auto" preset
# the daemon's onchainos/Bash tool calls are BLOCKED ("AI tool was blocked by
# permissions") and the task produces no reply -> timeout. The env var
# OKX_A2A_AI_PERMISSION_PRESET=bypass (set in render.yaml) is the primary control;
# this persists the same preset to the on-disk config as a belt-and-suspenders.
echo "[run-daemon] forcing AI permission preset = bypass"
okx-a2a config permissions --preset bypass || echo "[run-daemon] WARN could not persist bypass preset (env var still applies)"

# CRITICAL: clear any stale autostart record left on the persistent disk by a
# previous deploy. Without this, every daemon start is refused. Ignore errors
# (nothing to uninstall on a clean disk).
echo "[run-daemon] purging any stale autostart record (systemd unavailable in container)"
okx-a2a daemon autostart uninstall 2>/dev/null || true

start_daemon() {
  # Start WITHOUT autostart so it never tries to touch the (absent) systemd bus.
  okx-a2a daemon start --no-autostart
}

daemon_up() {
  # Robust liveness: status must report an ACTIVE pid, i.e. "running pid=<n>".
  # (status exits 0 even when stale, and prints "stale pid=..." when down, so we
  # must match the exact healthy form — not just the substring "running" and not
  # the exit code.)
  okx-a2a status 2>/dev/null | grep -Eq "running pid=[0-9]+"
}

echo "[run-daemon] starting daemon (no autostart)"
start_daemon || echo "[run-daemon] initial start returned non-zero — supervision loop will retry"

# Let the daemon settle before the first health check so we don't restart a
# perfectly healthy daemon that's still finishing startup (the earlier flap).
sleep 10

echo "[run-daemon] entering supervision loop"
# Keep the container alive (a worker dies when its foreground process exits) and
# keep the daemon up. Only (re)start when it is genuinely down.
while true; do
  if daemon_up; then
    :   # healthy — do nothing (no flapping)
  else
    echo "[run-daemon] daemon not running — (re)starting"
    okx-a2a daemon autostart uninstall 2>/dev/null || true
    start_daemon || true
    sleep 10   # give it time to come up before re-checking
  fi
  sleep 30
done

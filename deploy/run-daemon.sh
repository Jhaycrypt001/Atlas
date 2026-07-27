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

# REQUIRED: restore the onchainos WALLET SESSION ($HOME/.onchainos), which is a
# different directory from the a2a identity handled above. The daemon's XMTP layer
# shells out to `onchainos agent get` to enumerate agents; with no session that
# fails, initXmtpInstall fails, and the daemon comes up with clients=0 — listening
# to nothing while `agent refresh` still reports the agent ONLINE. Hard-fail here:
# a daemon with no session cannot receive a single task, so booting on is pointless.
echo "[run-daemon] restoring onchainos wallet session"
if ! bash deploy/restore-onchainos-session.sh; then
  echo "[run-daemon] FATAL: no usable onchainos session — the daemon would run with clients=0" >&2
  exit 1
fi

# Prove the session actually authenticates before we build anything on top of it.
echo "[run-daemon] verifying onchainos session"
if onchainos agent get --page 1 --page-size 50 >/dev/null 2>&1; then
  echo "[run-daemon] onchainos session OK"
else
  echo "[run-daemon] FATAL: onchainos session present but not accepted by the backend." >&2
  echo "[run-daemon]        Re-run 'onchainos wallet login' locally, re-pack, update OKX_ONCHAINOS_SESSION_B64." >&2
  exit 1
fi

# REQUIRED: install the onchainos skills so Claude knows the A2A task protocol.
# Without them the daemon's "Read the okx-agent-task skill" tip resolves to nothing
# and the agent never replies -> OKX task times out (the review failure we're fixing).
echo "[run-daemon] installing onchainos skills (required for A2A replies)"
bash deploy/install-skills.sh || echo "[run-daemon] WARN skills install returned non-zero"

# Install the agent brief where the AI subsession will actually read it.
# The daemon's default AI cwd is $TASK_HOME/workspace, which ensureAiWorkspace()
# rm -rf's on EVERY daemon start — a CLAUDE.md there would not survive. So we point
# the subsession at a persistent dir via OKX_A2A_AI_CWD (the daemon checks that env
# override BEFORE the workspace setting) and drop the brief in it.
#
# Without this the subsession has no idea what Atlas is and improvises from the raw
# job text: it declined its own advertised escrow service on the false premise that
# it was being asked to front the buyer's funds, and left the job at `created`.
export OKX_A2A_AI_CWD="${OKX_A2A_AI_CWD:-$HOME/atlas-ai}"
echo "[run-daemon] installing agent brief into $OKX_A2A_AI_CWD"
mkdir -p "$OKX_A2A_AI_CWD"
cp deploy/agent/CLAUDE.md "$OKX_A2A_AI_CWD/CLAUDE.md"
echo "[run-daemon] agent brief installed ($(wc -c < "$OKX_A2A_AI_CWD/CLAUDE.md") bytes)"

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

# CRITICAL: purge the daemon lock/pid records left on the PERSISTENT DISK by the
# previous container. The daemon's liveness test (dist/cli.js isProcessAlive) is a
# bare `process.kill(pid, 0)` — it never verifies the pid actually belongs to the
# daemon. run/daemon.lock/owner.json and run/listener.pid survive container
# replacement carrying the OLD container's pid (e.g. 100), and in a fresh container
# that low pid is virtually always taken by some unrelated process. So
# `daemon start` reports "already running pid=100", returns started=false, and the
# XMTP LISTENER NEVER LAUNCHES. `agent refresh` still succeeds (it's a plain backend
# call), so the agent heartbeats ONLINE while replying to nothing — exactly the
# "unable to receive a response from your Agent / task timed out" review failure.
#
# Unconditionally safe here: this runs once per container boot, before we have
# started any daemon, so no live daemon of ours can own these records.
TASK_HOME="${OKX_AGENT_TASK_HOME:-$HOME/.okx-agent-task}"
echo "[run-daemon] purging stale daemon lock/pid from persistent disk ($TASK_HOME/run)"
rm -rf "$TASK_HOME/run/daemon.lock" "$TASK_HOME/run/listener.pid"

start_daemon() {
  # Start WITHOUT autostart so it never tries to touch the (absent) systemd bus.
  okx-a2a daemon start --no-autostart
}

daemon_up() {
  # Robust liveness: status must report an ACTIVE pid, i.e. "running pid=<n>".
  # (status exits 0 even when stale, and prints "stale pid=..." when down, so we
  # must match the exact healthy form — not just the substring "running" and not
  # the exit code.)
  #
  # NOT sufficient on its own: `status` trusts the disk-resident lock pid and only
  # checks that *some* process holds it (see the purge note above), so a recycled
  # pid reads as healthy. Verify the pid's actual command line really is the a2a
  # daemon before believing it — otherwise the loop happily supervises a phantom
  # and never restarts the listener.
  local pid
  pid="$(okx-a2a status 2>/dev/null | sed -nE 's/.*running pid=([0-9]+).*/\1/p' | head -n1)"
  [ -n "$pid" ] || return 1
  # /proc is authoritative in the container; if it's unreadable fall back to
  # trusting status rather than restart-looping a daemon that is actually fine.
  [ -r "/proc/$pid/cmdline" ] || return 0
  tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Eq "okx-a2a|a2a-node|cli\.js"
}

refresh_agent() {
  # CRITICAL for OKX online status. The daemon LISTENING is not enough: every
  # (re)start mints a fresh XMTP session/installation, and OKX keeps routing tasks
  # to the PREVIOUS installation until we re-announce. Without this the agent shows
  # onlineStatus=offline (stale lastOnlineTime) and OKX's routing hits
  # `endpoint_not_found` -> task times out (the exact review failure). `agent
  # refresh` re-registers the current installation with OKX; it needs the daemon
  # and self-times-out at 60s, but we still cap it so a bad run can't wedge the loop.
  echo "[run-daemon] announcing presence to OKX (agent refresh)"
  if timeout -k 10 90 okx-a2a agent refresh >/dev/null 2>&1; then
    echo "[run-daemon] agent refresh OK — agent announced online"
  else
    echo "[run-daemon] WARN agent refresh failed/timed out — will retry in supervision loop"
  fi
}

echo "[run-daemon] starting daemon (no autostart)"
start_daemon || echo "[run-daemon] initial start returned non-zero — supervision loop will retry"

# Let the daemon settle before the first health check so we don't restart a
# perfectly healthy daemon that's still finishing startup (the earlier flap).
sleep 10

# Assert the LISTENER is genuinely up before announcing online. Announcing while
# the listener is dead is what produced an agent that looks online and answers
# nothing. If the phantom-lock case slipped through, purge and start once more.
if daemon_up; then
  echo "[run-daemon] listener verified up"
else
  echo "[run-daemon] WARN listener NOT up after start — purging lock/pid and retrying once"
  rm -rf "$TASK_HOME/run/daemon.lock" "$TASK_HOME/run/listener.pid"
  start_daemon || true
  sleep 10
  daemon_up && echo "[run-daemon] listener verified up on retry" \
            || echo "[run-daemon] ERROR listener still down — see $TASK_HOME/logs/listener.log"
fi

# A live process is NOT the same as a working agent. The failure that cost us the
# review was `initialized=false, clients=0` — daemon up, XMTP clients zero, so no
# task could ever arrive while `agent refresh` still reported ONLINE. Assert on the
# client count explicitly so this can never again hide behind a green boot log.
check_clients() {
  local line
  line="$(grep -a -o 'init done: initialized=[a-z]*, clients=[0-9]*, failures=[0-9]*' \
            "$TASK_HOME/logs/listener.log" 2>/dev/null | tail -n1)"
  if [ -z "$line" ]; then
    echo "[run-daemon] WARN could not find XMTP init line in listener log yet"
    return 0
  fi
  echo "[run-daemon] xmtp $line"
  case "$line" in
    *clients=0,*)
      echo "[run-daemon] ERROR XMTP clients=0 — the agent is listening to NOTHING." >&2
      echo "[run-daemon]       Almost always an expired/absent onchainos session." >&2
      return 1 ;;
  esac
  return 0
}
check_clients || true

# Surface the LISTENER log into Render's log stream. Without this the only thing
# Render shows is this script's own echoes, so inbound A2A events, the AI subsession
# and any handler errors are completely invisible — every diagnosis becomes guesswork.
# Backgrounded `tail -F` (capital F: survives the file being rotated/recreated).
echo "[run-daemon] tailing listener log into Render stream"
touch "$TASK_HOME/logs/listener.log" 2>/dev/null || true
tail -F -n 50 "$TASK_HOME/logs/listener.log" 2>/dev/null | sed -u 's/^/[listener] /' &
TAIL_PID=$!
# Don't let the tail outlive us if the container is signalled.
trap 'kill "$TAIL_PID" 2>/dev/null || true' EXIT INT TERM

# Announce online to OKX now that the daemon is up (see refresh_agent).
refresh_agent

echo "[run-daemon] entering supervision loop"
# Keep the container alive (a worker dies when its foreground process exits) and
# keep the daemon up. Only (re)start when it is genuinely down. Re-announce
# presence periodically and after every (re)start so OKX's online status and XMTP
# routing never go stale.
ticks=0
while true; do
  if daemon_up; then
    ticks=$((ticks + 1))
    # Re-announce every ~5 min (10 * 30s) so lastOnlineTime/onlineStatus stay fresh.
    if [ "$((ticks % 10))" -eq 0 ]; then
      refresh_agent
    fi
  else
    echo "[run-daemon] daemon not running — (re)starting"
    okx-a2a daemon autostart uninstall 2>/dev/null || true
    start_daemon || true
    sleep 10   # give it time to come up before re-checking
    refresh_agent   # new XMTP session after restart -> must re-announce
    ticks=0
  fi
  sleep 30
done

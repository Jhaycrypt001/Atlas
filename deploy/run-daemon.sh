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
#
# OKX_A2A_AI_CWD DOES NOT WORK for this. Verified in a2a-node@0.1.10 dist/cli.js:
# startDaemon() (:1940) calls ensureAiWorkspace() (:1869) which rm -rf's
# $TASK_HOME/workspace, then spawns the listener with `OKX_A2A_AI_CWD: aiWorkingDir`
# HARD-INJECTED into the child env (:1974) — clobbering whatever we exported. So the
# AI subsession ALWAYS runs in $TASK_HOME/workspace, and that dir is wiped on every
# daemon start. Render logs confirmed it: `AI session start ... cwd=/var/okx-home/
# .okx-agent-task/workspace` while our brief sat unread in /var/okx-home/atlas-ai.
#
# The reliable channel is the USER-level memory file $HOME/.claude/CLAUDE.md, which
# Claude Code loads for every session regardless of cwd. We write that as the primary,
# and also drop a copy into the workspace AFTER daemon start (see install_brief below)
# as a belt-and-suspenders for the project-level load.
#
# Without the brief the subsession has no idea what Atlas is and improvises from the raw
# job text: it declined its own advertised escrow service on the false premise that
# it was being asked to front the buyer's funds, and left the job at `created`.
BRIEF_SRC="deploy/agent/CLAUDE.md"
echo "[run-daemon] installing agent brief into $HOME/.claude/CLAUDE.md (user-level, cwd-independent)"
mkdir -p "$HOME/.claude"
cp "$BRIEF_SRC" "$HOME/.claude/CLAUDE.md"
echo "[run-daemon] agent brief installed ($(wc -c < "$HOME/.claude/CLAUDE.md") bytes)"

# Copy the brief into the daemon's real AI cwd. MUST be called AFTER `daemon start`,
# because ensureAiWorkspace() wipes that dir as part of starting. Re-call after every
# restart in the supervision loop for the same reason.
install_brief_into_workspace() {
  local ws="${OKX_AGENT_TASK_HOME:-$HOME/.okx-agent-task}/workspace"
  if [ -d "$ws" ]; then
    cp "$BRIEF_SRC" "$ws/CLAUDE.md" 2>/dev/null \
      && echo "[run-daemon] agent brief copied into AI workspace ($ws)" \
      || echo "[run-daemon] WARN could not copy brief into $ws"
  else
    echo "[run-daemon] WARN AI workspace $ws not present yet — user-level brief still applies"
  fi
}

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

# The workspace only exists once the daemon has started (start wipes and recreates it).
install_brief_into_workspace

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

# ---------------------------------------------------------------------------
# Missed-designation reconciler.
#
# `JobAspSelected` is a LIVE, FIRE-ONCE XMTP event. If the daemon is down,
# restarting, or mid-deploy at the moment a User Agent designates us, that event
# is gone for good: startup replay reports `replayed=0`, and the `wakeup_notify`
# burst OKX sends on boot only covers jobs that ALREADY have a session — i.e.
# jobs we have talked on. A designation we never answered has no session, so it
# is never re-delivered. The job sits at `created` forever while the agent
# heartbeats ONLINE, and the buyer sees an unresponsive listing.
#
# Observed for real: job 0x9b3e…7c46 (User Agent #8234, Escrow Payment
# Settlement, 0.1 USDT) sat untouched while the daemon was healthy, alongside 9
# older `created` jobs from OKX's review harness.
#
# Fix: on boot and periodically, enumerate our ASP jobs still at `created` and
# re-inject them via `okx-a2a session dispatch`, which runs the daemon's normal
# AI session for that job. We deliberately do NOT `apply` from bash: dispatch
# routes through `next-action`, so the capability/price judgement stays with the
# LLM exactly as it would have on the live event.
#
# Two constraints this must respect:
#   1. ONE JOB PER TICK. Every dispatch spawns a `claude --print` subsession
#      (hundreds of MB). Firing all stale jobs at once is how you OOM a starter
#      worker and get the container restarted mid-flight.
#   2. DISPATCH EACH JOB ONCE, EVER. `apply` does NOT advance the status — an
#      applied job legitimately stays at `created` until the buyer runs
#      confirm-accept. Without a persisted marker this loop would re-dispatch
#      and re-apply the same job forever.
# ---------------------------------------------------------------------------
# Credit-exhaustion detector.
#
# This is the failure that cost us the first OKX review, and it is invisible from
# every health signal we have: `claude --print` exits 1 in ~3s with
# `result=stdout="Credit balance is too low"`, the daemon has nothing to send, and
# OKX's task clock expires. Meanwhile the listener is fine (`clients=1`), the
# heartbeat keeps landing, and the registry cheerfully reports `onlineStatus:1`.
# A dead agent that looks perfectly healthy.
#
# A billing alert on the Anthropic account is the other half of this, but that is
# a human email that can be missed. This is the half that lives with the daemon:
# the signature is exact, so watch for it and shout.
#
# Alert on a RISING count against a SEEDED baseline — never on presence. Both
# halves are load-bearing and the first version shipped only the first half, which
# false-alarmed immediately on deploy 9b7b372: listener.log is on the persistent
# disk, so it still held 11 failures from the 2026-07-27 exhaustion, and the very
# first tick compared 11 against a stored 0 and cried wolf about a problem fixed
# the day before — while that same boot ran three subsessions at exitCode=0.
CREDIT_ALERT_STATE="$TASK_HOME/credit-alert.count"

count_credit_failures() {
  local hits
  hits="$(grep -a -c 'Credit balance is too low' "$TASK_HOME/logs/listener.log" 2>/dev/null)" || true
  case "${hits:-}" in ''|*[!0-9]*) hits=0 ;; esac
  echo "$hits"
}

# One-time baseline, same idea as the reconciler's. listener.log lives on the
# PERSISTENT DISK, so on the first run of this detector it is already full of
# historical failures from the 2026-07-27 exhaustion. Without seeding, the very
# first tick compares 11 against 0 and screams about a problem that was fixed
# yesterday — which is exactly what happened on the 9b7b372 deploy. Record what is
# already there and alert only on what comes after.
#
# Seeding cannot mask a genuine ongoing outage: if credit really is dry, every new
# inbound task adds another failure, so the count climbs past the baseline within a
# tick or two and alerts normally.
seed_credit_baseline() {
  [ -e "$CREDIT_ALERT_STATE" ] && return 0
  local hits
  hits="$(count_credit_failures)"
  echo "$hits" > "$CREDIT_ALERT_STATE" 2>/dev/null || true
  if [ "$hits" -gt 0 ]; then
    echo "[run-daemon] credit detector: baseline seeded at $hits historical failure(s) already on the persistent log — NOT current, will alert only on new ones"
  fi
  return 0
}

check_ai_credit() {
  [ -r "$TASK_HOME/logs/listener.log" ] || return 0

  local hits prev
  hits="$(count_credit_failures)"
  prev="$(cat "$CREDIT_ALERT_STATE" 2>/dev/null)" || true
  case "${prev:-}" in ''|*[!0-9]*) prev=0 ;; esac

  # Log rotated or truncated: the stored high-water mark now refers to lines that
  # no longer exist. Re-baseline downward, otherwise a stale prev of 11 would
  # SUPPRESS a real alert until failures climbed past 11 all over again — the
  # detector failing silently in precisely the situation it exists for.
  if [ "$hits" -lt "$prev" ]; then
    echo "$hits" > "$CREDIT_ALERT_STATE" 2>/dev/null || true
    echo "[run-daemon] credit detector: listener log rotated (count $prev -> $hits), re-baselined"
    return 0
  fi

  [ "$hits" -gt "$prev" ] || return 0
  echo "$hits" > "$CREDIT_ALERT_STATE" 2>/dev/null || true

  echo "[run-daemon] ==================== ALERT ===================="
  echo "[run-daemon] ANTHROPIC API CREDIT IS EXHAUSTED ($hits failed subsession(s))."
  echo "[run-daemon] Every inbound task will now time out while the agent still"
  echo "[run-daemon] reports onlineStatus=1. Top up at console.anthropic.com/settings/billing"
  echo "[run-daemon] (a Claude.ai subscription does NOT bill headless \`claude --print\`)."
  echo "[run-daemon] ==============================================="

  # Push it somewhere the operator actually looks, not just the Render stream.
  timeout -k 5 30 onchainos agent user-notify --content \
    "[Atlas #6991] Anthropic API credit exhausted — every inbound A2A task is timing out even though the agent reports online. Top up at console.anthropic.com/settings/billing to restore service." \
    >/dev/null 2>&1 \
    && echo "[run-daemon] credit alert pushed via user-notify" \
    || echo "[run-daemon] WARN could not push credit alert (Render log above is the record)"
}

RECONCILE_STATE="$TASK_HOME/reconciled-jobs.txt"

list_created_asp_jobs() {
  onchainos agent active-tasks 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const tasks = (JSON.parse(s) || {}).data?.tasks || [];
        for (const t of tasks) {
          if (t.myRole === "asp" && t.status === "created") console.log(t.jobId);
        }
      } catch (e) { /* no output -> nothing to reconcile */ }
    });' 2>/dev/null
}

# One-time baseline. On a disk that has never run the reconciler, mark every job
# that is ALREADY stale as seen instead of dispatching it. Two reasons: the 9
# `created` jobs left over from OKX's review harness are dead test traffic we do
# not want to spend gas applying to, and job 0x9b3e…7c46 was applied to by hand —
# re-dispatching it would double-apply, because apply leaves the status at
# `created` (Gate 1). From here on the reconciler only sees genuinely NEW misses.
seed_reconcile_baseline() {
  [ -e "$RECONCILE_STATE" ] && return 0
  local seeded
  seeded="$(list_created_asp_jobs)"
  printf '%s\n' "$seeded" > "$RECONCILE_STATE" 2>/dev/null || return 0
  echo "[run-daemon] reconciler: seeded baseline with $(grep -c . "$RECONCILE_STATE" 2>/dev/null || echo 0) pre-existing 'created' job(s) — these will NOT be auto-dispatched"
}

reconcile_one_stale_job() {
  touch "$RECONCILE_STATE" 2>/dev/null || return 0

  local candidates job
  candidates="$(list_created_asp_jobs)" || return 0

  [ -n "$candidates" ] || return 0

  for job in $candidates; do
    grep -qxF "$job" "$RECONCILE_STATE" 2>/dev/null && continue
    echo "[run-daemon] reconciler: job ${job:0:10}… is still 'created' and was never dispatched — re-injecting"
    # Record BEFORE dispatching: a dispatch that crashes the box must not be
    # retried on the next boot, or a poison job becomes a restart loop.
    echo "$job" >> "$RECONCILE_STATE"
    if timeout -k 10 120 okx-a2a session dispatch --job-id "$job" >/dev/null 2>&1; then
      echo "[run-daemon] reconciler: dispatched ${job:0:10}… — AI session will run next-action"
    else
      echo "[run-daemon] WARN reconciler: dispatch failed for ${job:0:10}… (marked; will not retry)"
    fi
    return 0   # one per tick, on purpose
  done
}

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

# Establish both baselines before the loop can dispatch or alert on anything.
seed_reconcile_baseline
seed_credit_baseline

echo "[run-daemon] entering supervision loop"
# Keep the container alive (a worker dies when its foreground process exits) and
# keep the daemon up. Only (re)start when it is genuinely down. Re-announce
# presence periodically and after every (re)start so OKX's online status and XMTP
# routing never go stale.
ticks=0
while true; do
  if daemon_up; then
    ticks=$((ticks + 1))
    # Cheap (one grep) and the failure is urgent, so check every 30s tick rather
    # than on the 5-minute cadence.
    check_ai_credit
    # Re-announce every ~5 min (10 * 30s) so lastOnlineTime/onlineStatus stay fresh.
    if [ "$((ticks % 10))" -eq 0 ]; then
      refresh_agent
      # Same cadence: catch at most one designation we missed while down. Runs
      # after refresh so the dispatch happens on a freshly announced session.
      reconcile_one_stale_job
    fi
  else
    echo "[run-daemon] daemon not running — (re)starting"
    okx-a2a daemon autostart uninstall 2>/dev/null || true
    start_daemon || true
    sleep 10   # give it time to come up before re-checking
    install_brief_into_workspace   # start wiped the workspace -> re-drop the brief
    refresh_agent   # new XMTP session after restart -> must re-announce
    ticks=0
  fi
  sleep 30
done

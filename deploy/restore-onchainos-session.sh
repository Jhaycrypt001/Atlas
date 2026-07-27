#!/usr/bin/env bash
# Restore the onchainos WALLET SESSION onto the Render persistent disk.
#
# WHY THIS EXISTS
# ---------------
# The a2a daemon's XMTP layer shells out to the `onchainos` CLI (`agent get`,
# `agent system-config`, `agent sensitive-words`) to enumerate agents and build its
# XMTP clients. Those calls need an onchainos WALLET SESSION, which lives in
# $HOME/.onchainos — a DIFFERENT directory from $HOME/.okx-agent-task that
# restore-identity.sh handles. It was never shipped, so on Render every call
# returned:
#     {"ok":false,"error":"session expired, please login again: onchainos wallet login"}
# which made initXmtpInstall fail -> "init done: initialized=false, clients=0" ->
# the daemon listened to NOTHING. Meanwhile `okx-a2a agent refresh` uses its own
# credentials in .okx-agent-task and kept succeeding, so the OKX registry happily
# reported onlineStatus=1 for an agent with zero XMTP clients. That is the real
# cause of "we were unable to receive a response from your Agent".
#
# WHY AN ENV VAR AND NOT A COMMITTED FILE
# ---------------------------------------
# This bundle contains keyring.enc (private keys for the owner wallet) and a live
# session credential. github.com/Jhaycrypt001/Atlas is PUBLIC — committing it would
# publish the ciphertext permanently, into history and every fork. So it travels as
# a dashboard-only Render env var instead. NEVER commit the bundle or the passphrase.
#
# SETUP (one time, from the machine with a working `onchainos wallet login`):
#   bash deploy/pack-onchainos-session.sh     # writes the base64 to a local file
#   Render dashboard > atlas-a2a-daemon > Environment > add:
#     OKX_ONCHAINOS_SESSION_B64 = <contents of that file>
#
# The session expires (sessionKeyExpireAt in session.json). On expiry, re-run
# `onchainos wallet login` locally, re-pack, and update the env var.
set -uo pipefail

ONCHAINOS_DIR="${HOME}/.onchainos"
SESSION_FILE="${ONCHAINOS_DIR}/session.json"

# Is there already a session on the disk that has NOT expired? If so leave it be —
# the live state is authoritative (same rule as restore-identity.sh).
if [ -f "$SESSION_FILE" ]; then
  exp="$(sed -nE 's/.*"sessionKeyExpireAt"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$SESSION_FILE" | head -n1)"
  now="$(date +%s)"
  if [ -n "$exp" ] && [ "$exp" -gt "$now" ]; then
    days=$(( (exp - now) / 86400 ))
    echo "[onchainos-session] session on disk is valid for ${days} more day(s) — leaving it untouched."
    if [ "$days" -lt 7 ]; then
      echo "[onchainos-session] WARN session expires in ${days} day(s) — replace OKX_ONCHAINOS_SESSION_B64 soon:"
      echo "[onchainos-session]      onchainos wallet login && bash deploy/pack-onchainos-session.sh"
    fi
    exit 0
  fi
  echo "[onchainos-session] session on disk is EXPIRED — replacing from OKX_ONCHAINOS_SESSION_B64"
fi

if [ -z "${OKX_ONCHAINOS_SESSION_B64:-}" ]; then
  echo "[onchainos-session] ERROR: no valid session on disk and OKX_ONCHAINOS_SESSION_B64 is not set." >&2
  echo "[onchainos-session] The daemon will start with clients=0 and will NOT receive any A2A task." >&2
  echo "[onchainos-session] Fix: run 'bash deploy/pack-onchainos-session.sh' locally and set the env var in Render." >&2
  exit 1
fi

echo "[onchainos-session] restoring onchainos session into $ONCHAINOS_DIR"
mkdir -p "$ONCHAINOS_DIR"
# base64 -d tolerates the wrapped/unwrapped forms the dashboard may hand us.
if ! printf '%s' "$OKX_ONCHAINOS_SESSION_B64" | tr -d '\n\r ' | base64 -d | tar -xzf - -C "$ONCHAINOS_DIR"; then
  echo "[onchainos-session] ERROR: failed to decode/extract the session bundle." >&2
  exit 1
fi
# Session material must not be world-readable on a shared disk.
chmod 700 "$ONCHAINOS_DIR" 2>/dev/null || true
find "$ONCHAINOS_DIR" -maxdepth 1 -type f -exec chmod 600 {} + 2>/dev/null || true

echo "[onchainos-session] restore complete:"
ls -la "$ONCHAINOS_DIR" | sed 's/^/[onchainos-session]   /'

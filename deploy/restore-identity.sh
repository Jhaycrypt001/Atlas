#!/usr/bin/env bash
# Restore the OKX A2A identity onto the Render persistent disk — ONCE.
#
# HOME points at the persistent disk (see render.yaml). On the very first boot
# the disk is empty, so we decrypt deploy/okx-identity.tgz.enc into
# $HOME/.okx-agent-task. On every subsequent boot the identity already exists on
# the disk, so we DO NOTHING — the live state is authoritative and must never be
# clobbered by the (now-stale) committed bundle.
#
# Requires env: OKX_IDENTITY_PASSPHRASE (set as a Render secret, never committed).
set -euo pipefail

STATE_DIR="${HOME}/.okx-agent-task"
XMTP_MARKER="${STATE_DIR}/xmtp"
ENC_FILE="$(dirname "$0")/okx-identity.tgz.enc"

if [ -d "$XMTP_MARKER" ] && [ -n "$(ls -A "$XMTP_MARKER" 2>/dev/null || true)" ]; then
  echo "[restore-identity] identity already present on disk — leaving it untouched."
  exit 0
fi

if [ -z "${OKX_IDENTITY_PASSPHRASE:-}" ]; then
  echo "[restore-identity] ERROR: OKX_IDENTITY_PASSPHRASE is not set. Cannot decrypt identity." >&2
  exit 1
fi

if [ ! -f "$ENC_FILE" ]; then
  echo "[restore-identity] ERROR: encrypted bundle not found at $ENC_FILE" >&2
  exit 1
fi

echo "[restore-identity] first boot — restoring identity into $STATE_DIR"
mkdir -p "$STATE_DIR"
printf '%s' "$OKX_IDENTITY_PASSPHRASE" | \
  openssl enc -d -aes-256-cbc -salt -pbkdf2 -iter 200000 -in "$ENC_FILE" -pass stdin | \
  tar -xzf - -C "$STATE_DIR"

echo "[restore-identity] restore complete:"
ls -la "$STATE_DIR"

#!/usr/bin/env bash
# Install the onchainos CLI binary AT RUNTIME (the persistent disk, where $HOME
# lives, is mounted now — unlike during build).
#
# WHY THE OLD VERSION 404'd: it curled
#   https://raw.githubusercontent.com/okx/onchainos-cli/main/install.sh
# but there is no `okx/onchainos-cli` repo. OKX ships the CLI from
# `okx/onchainos-skills`. Correct, documented one-liner (Linux/macOS):
#   curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh
# The official installer auto-detects the platform, downloads the latest stable
# release from that repo's GitHub Releases, verifies its SHA256 against
# checksums.txt, and installs the binary to $HOME/.local/bin.
#
# onchainos is what the Claude provider shells out to for task-side actions the
# okx-ai skill drives (agent identity, file-upload/-download, message-eligible,
# sensitive-words). The daemon itself (okx-a2a) does NOT need it to stay online or
# to reply to chat, so this stays best-effort and NEVER exits non-zero — the
# daemon still boots and we keep the logs.
#
# CRITICAL — why we run the installer under `timeout`: its finish_install() hook
# prints "Detected okx-a2a. Ensuring the A2A environment (non-fatal)..." and then
# runs `okx-a2a doctor --fix` + `okx-a2a daemon restart`. On Render (no systemd)
# that hook BLOCKS FOREVER, so run-daemon.sh never reaches its own `daemon start`
# and the agent never comes online (this was the real boot hang). The onchainos
# BINARY is installed and checksum-verified BEFORE that hook, so a hard timeout
# only caps the hook — it never costs us the binary. run-daemon.sh then purges any
# autostart record the hook left and starts the daemon with --no-autostart, which
# is the authoritative daemon control for this environment.
set -u

BIN_DIR="$HOME/.local/bin"
HOOK_TIMEOUT="${ONCHAINOS_INSTALL_TIMEOUT:-120}"

# Already installed (persists on the disk across restarts)? Nothing to do — and
# skipping means the blocking A2A hook never runs again after the first boot.
if [ -x "$BIN_DIR/onchainos" ]; then
  echo "[install-onchainos] already present at $BIN_DIR/onchainos — skipping"
  exit 0
fi

echo "[install-onchainos] installing from okx/onchainos-skills (best-effort)"
mkdir -p "$BIN_DIR" || { echo "[install-onchainos] cannot create $BIN_DIR — skipping"; exit 0; }

SCRIPT="$(mktemp)"
if ! curl -fsSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh -o "$SCRIPT"; then
  echo "[install-onchainos] WARN: could not download installer — daemon still runs; only task-side onchainos actions are affected"
  rm -f "$SCRIPT"
  exit 0
fi

# -k 10: if it ignores SIGTERM, SIGKILL 10s later. Exit 124 = timed out.
timeout -k 10 "$HOOK_TIMEOUT" sh "$SCRIPT"
code=$?
rm -f "$SCRIPT"

if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
  echo "[install-onchainos] A2A post-install hook exceeded ${HOOK_TIMEOUT}s and was capped — this is expected on Render; run-daemon.sh starts the daemon itself"
elif [ "$code" -ne 0 ]; then
  echo "[install-onchainos] installer exited $code (non-fatal)"
fi

if [ -x "$BIN_DIR/onchainos" ]; then
  echo "[install-onchainos] binary present -> $BIN_DIR/onchainos"
else
  echo "[install-onchainos] WARN: binary not at $BIN_DIR/onchainos — task-side onchainos actions affected; daemon still runs"
fi

exit 0

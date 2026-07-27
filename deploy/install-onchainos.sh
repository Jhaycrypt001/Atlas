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
set -u

BIN_DIR="$HOME/.local/bin"

# Already installed (persists on the disk across restarts)? Nothing to do.
if [ -x "$BIN_DIR/onchainos" ]; then
  echo "[install-onchainos] already present at $BIN_DIR/onchainos — skipping"
  exit 0
fi

echo "[install-onchainos] installing from okx/onchainos-skills (best-effort)"
mkdir -p "$BIN_DIR" || { echo "[install-onchainos] cannot create $BIN_DIR — skipping"; exit 0; }

if curl -fsSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh; then
  if [ -x "$BIN_DIR/onchainos" ]; then
    echo "[install-onchainos] installed OK -> $BIN_DIR/onchainos"
  else
    echo "[install-onchainos] WARN: installer ran but binary not at $BIN_DIR/onchainos"
  fi
else
  echo "[install-onchainos] WARN: install failed — daemon still runs; only task-side onchainos actions are affected"
fi

exit 0

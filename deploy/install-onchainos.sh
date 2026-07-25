#!/usr/bin/env bash
# Best-effort install of the onchainos binary AT RUNTIME (the persistent disk,
# where $HOME lives, is mounted now — unlike during build).
#
# onchainos is used by the daemon's `agent refresh`. If this fails, the daemon
# still runs and stays online; only refresh is affected. So this script NEVER
# exits non-zero — the caller continues regardless.
set -u

BIN_DIR="$HOME/.local/bin"

# Already installed (persists on the disk across restarts)? Nothing to do.
if [ -x "$BIN_DIR/onchainos" ]; then
  echo "[install-onchainos] already present at $BIN_DIR/onchainos — skipping"
  exit 0
fi

echo "[install-onchainos] attempting best-effort install"
mkdir -p "$BIN_DIR" || { echo "[install-onchainos] cannot create $BIN_DIR — skipping"; exit 0; }

if bash -c '
  set -e
  cd "$(mktemp -d)"
  curl -fsSL https://raw.githubusercontent.com/okx/onchainos-cli/main/install.sh -o install.sh
  curl -fsSL https://raw.githubusercontent.com/okx/onchainos-cli/main/installer-checksums.txt -o installer-checksums.txt
  sha256sum -c installer-checksums.txt --ignore-missing
  bash install.sh
'; then
  echo "[install-onchainos] installed OK"
else
  echo "[install-onchainos] WARN: install skipped/failed — daemon still runs; only agent refresh is affected"
fi

exit 0

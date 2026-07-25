#!/usr/bin/env bash
# Render build step for the always-on A2A daemon.
#
# Installs, in order of importance:
#   1. @okxweb3/a2a-node  — the daemon itself                 (REQUIRED)
#   2. @anthropic-ai/claude-code — headless AI provider CLI   (REQUIRED)
#   3. onchainos binary   — used by the daemon's agent refresh (BEST-EFFORT)
#
# onchainos is a standalone binary (not an npm package). Its release URL is not
# pinned here, so we install it best-effort: if the download/verify fails the
# build STILL succeeds, because the daemon stays online without it — the only
# thing that breaks without onchainos is `agent refresh` (a noisy, non-fatal
# ENOENT). The online status the identity's migrated sqlite/xmtp state provides
# does not depend on it.
set -eu

echo "[build] installing okx-a2a daemon + headless claude CLI (required)"
npm i -g @okxweb3/a2a-node@0.1.10 @anthropic-ai/claude-code

echo "[build] installing onchainos binary (best-effort)"
mkdir -p "$HOME/.local/bin"
if bash -c '
  set -e
  cd "$(mktemp -d)"
  # Official installer for the onchainos CLI. If the URL/asset ever changes this
  # block fails and we fall through to the "|| true" below without failing build.
  curl -fsSL https://raw.githubusercontent.com/okx/onchainos-cli/main/install.sh -o install.sh
  curl -fsSL https://raw.githubusercontent.com/okx/onchainos-cli/main/installer-checksums.txt -o installer-checksums.txt
  sha256sum -c installer-checksums.txt --ignore-missing
  bash install.sh
'; then
  echo "[build] onchainos installed OK"
else
  echo "[build] WARN: onchainos install skipped/failed — daemon still runs; only agent refresh is affected"
fi

echo "[build] done"

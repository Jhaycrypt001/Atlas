#!/usr/bin/env bash
# Render BUILD step for the always-on A2A daemon.
#
# IMPORTANT: the persistent disk (mounted at $HOME=/var/okx-home) is NOT mounted
# during build — only at runtime. So the build must touch ONLY the global node
# path, never $HOME. Anything that writes to the disk (identity restore, the
# onchainos binary) belongs in the START command, not here.
#
# Build installs just the two required global npm packages:
#   1. @okxweb3/a2a-node        — the daemon itself
#   2. @anthropic-ai/claude-code — headless AI provider CLI (authed via ANTHROPIC_API_KEY)
set -eu

echo "[build] installing okx-a2a daemon + headless claude CLI (required)"
npm i -g @okxweb3/a2a-node@0.1.10 @anthropic-ai/claude-code

echo "[build] done"

#!/usr/bin/env bash
# Install the OKX Onchain OS skills into the daemon's Claude environment AT RUNTIME.
#
# WHY THIS IS REQUIRED (this is the fix for "agent did not respond / task timed out"):
#   When OKX sends the agent an A2A task, the @okxweb3/a2a-node daemon hands the
#   message to the `claude` provider WITH the tip:
#       "Read the okx-agent-task skill if you don't know the context"
#   If the onchainos skills are NOT installed, Claude has no idea how to speak the
#   A2A task protocol (accept / negotiate / deliver), so it never emits a valid
#   response -> OKX's platform test times out and the review fails.
#
#   Skills live under $HOME/.claude (the persistent disk, mounted only at RUNTIME),
#   so this MUST run in the start command, never in build.sh.
#
# It is idempotent (skips if already present) and retries, because a first-boot
# failure here = a failed review. It does not hard-exit non-zero, so the daemon
# still boots and we can read logs if the install ever fails.
set -u

SKILLS_DIR="$HOME/.claude/skills"
MARKER="$SKILLS_DIR/okx-ai"   # the skill the daemon's task tip points at

if [ -d "$MARKER" ]; then
  echo "[install-skills] onchainos skills already present at $SKILLS_DIR — skipping"
  exit 0
fi

echo "[install-skills] installing okx/onchainos-skills into $HOME/.claude (required for A2A replies)"

attempt=0
until [ "$attempt" -ge 3 ]; do
  attempt=$((attempt + 1))
  echo "[install-skills] attempt $attempt/3"
  if npx --yes skills add okx/onchainos-skills --yes -g; then
    if [ -d "$MARKER" ]; then
      echo "[install-skills] installed OK — okx-ai skill present"
      exit 0
    fi
    echo "[install-skills] command succeeded but $MARKER missing — retrying"
  fi
  sleep 5
done

echo "[install-skills] ERROR: could not install onchainos skills after 3 attempts." >&2
echo "[install-skills] The daemon will still boot, but A2A task replies will fail until this succeeds." >&2
echo "[install-skills] Installed skills dir contents:" >&2
ls -la "$SKILLS_DIR" 2>/dev/null || echo "[install-skills]   (skills dir does not exist)" >&2
exit 0

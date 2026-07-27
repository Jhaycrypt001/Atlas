#!/usr/bin/env bash
# Pack the local onchainos wallet session for transport to Render.
#
# Run this on the machine where `onchainos wallet login` has been done and
# `onchainos agent get --page 1 --page-size 50` returns ok:true.
#
# Output goes to a LOCAL FILE ONLY — never stdout, never the repo. The file
# contains private key material; the script prints its path, not its contents.
#
#   bash deploy/pack-onchainos-session.sh
#   -> paste the file's contents into Render as OKX_ONCHAINOS_SESSION_B64
#   -> then DELETE the file
set -euo pipefail

SRC="${HOME}/.onchainos"
OUT="${OUT:-${TMPDIR:-/tmp}/onchainos-session.b64}"

# The four files the CLI needs to authenticate and sign. Deliberately NOT the
# caches (chain_cache, balance_cache, doh-cache, audit.jsonl) — they are noise,
# and audit.jsonl in particular is a large activity log with no business on a server.
FILES=(session.json machine-identity keyring.enc wallets.json)

missing=0
for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then
    echo "[pack] ERROR: missing $SRC/$f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "[pack] Run 'onchainos wallet login' first." >&2
  exit 1
fi

# Refuse to pack an already-expired session — it would fail identically on Render.
# NB: quoted string in session.json ("sessionKeyExpireAt": "1793230852") — the
# quotes must be optional-matched or this silently yields "" and the guard no-ops.
exp="$(sed -nE 's/.*"sessionKeyExpireAt"[[:space:]]*:[[:space:]]*"?([0-9]+)"?.*/\1/p' "$SRC/session.json" | head -n1)"
now="$(date +%s)"
if [ -n "$exp" ] && [ "$exp" -le "$now" ]; then
  echo "[pack] ERROR: local session already expired — run 'onchainos wallet login' first." >&2
  exit 1
fi
[ -n "$exp" ] && echo "[pack] session valid for $(( (exp - now) / 86400 )) more day(s)"

umask 077
tar -czf - -C "$SRC" "${FILES[@]}" | base64 | tr -d '\n' > "$OUT"
chmod 600 "$OUT"

cat <<EOF

[pack] wrote $(wc -c < "$OUT") bytes to:
    $OUT

Next:
  1. Open that file, copy ALL of it.
  2. Render dashboard > atlas-a2a-daemon > Environment > Add Environment Variable
       key:   OKX_ONCHAINOS_SESSION_B64
       value: <paste>
  3. Save, then Manual Deploy.
  4. DELETE the file:  rm "$OUT"

This bundle contains private key material. Do not commit it, paste it into chat,
or send it anywhere except the Render dashboard.
EOF

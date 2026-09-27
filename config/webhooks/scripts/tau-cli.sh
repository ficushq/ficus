#!/usr/bin/env bash
# Resolve a runnable tau CLI for the webhook action scripts and exec it with all
# args. Order: the built dist (fast), then run from source via bun (works even
# when the deployment never built apps/cli — which is exactly the gap that made
# every webhook notification silently no-op on the cloud tenant, 2026-08-23).
#
# Deliberately does NOT fall back to a `tau` on PATH: a webhook must talk to THIS
# instance's API with the framework-injected FICUS_WEBHOOK_CONTEXT, FICUS_API_URL
# and FICUS_TOKEN, not whatever backend a
# globally installed tau happens to target.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DIST="$ROOT/apps/cli/dist/ficus.js"
SRC="$ROOT/apps/cli/src/index.ts"
if [ -f "$DIST" ]; then
  exec bun "$DIST" "$@"
fi
if [ -f "$SRC" ]; then
  exec bun "$SRC" "$@"
fi
echo "tau-cli.sh: no tau CLI found (looked for $DIST and $SRC)" >&2
exit 127

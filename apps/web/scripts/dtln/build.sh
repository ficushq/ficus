#!/usr/bin/env bash
# Rebuild apps/web/public/voice/dtln/dtln.js from pinned sources (see
# Dockerfile), format it like the rest of the repository, refresh the shipped
# upstream notices and rewrite provenance.json with the new hashes and the
# toolchain that produced them.
#
#   bash apps/web/scripts/dtln/build.sh            # build + install into public/
#   bash apps/web/scripts/dtln/build.sh --check    # build, then fail if the shipped asset differs
#   NO_CACHE=1 bash apps/web/scripts/dtln/build.sh --check
#                                                  # same, from a cold Docker cache — the
#                                                  # reproducibility proof recorded in provenance.json
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$here/../../../.." && pwd)
public_dir="$repo_root/apps/web/public/voice/dtln"
out_dir=$(mktemp -d "${TMPDIR:-/tmp}/ficus-dtln-build.XXXXXX")
trap 'rm -rf "$out_dir"' EXIT

mode=install
[[ "${1:-}" == "--check" ]] && mode=check

echo "==> Building the denoiser in Docker (this compiles the Rust crate; several minutes)"
docker build ${NO_CACHE:+--no-cache} --target export --output "type=local,dest=$out_dir" "$here"

echo "==> Making the glue an ES module and formatting it with the repository's prettier config"
# processor.js does `import dtln from './dtln.js'`. Emscripten's optimizer
# parses --post-js as a script, so the export is added here, after the link.
# Prettier resolves its config from the file's location, so format a copy that
# lives inside the repository (public/ is not prettier-ignored).
staged="$public_dir/dtln.building.js"
trap 'rm -rf "$out_dir" "$staged"' EXIT
{ cat "$out_dir/dtln.js"; printf '\nexport default DtlnPlugin\n'; } > "$staged"
(cd "$repo_root" && bunx prettier --log-level warn --write "$staged")
mv "$staged" "$out_dir/dtln.formatted.js"

if [[ "$mode" == "check" ]]; then
  if cmp -s "$out_dir/dtln.formatted.js" "$public_dir/dtln.js"; then
    echo "OK: shipped dtln.js matches a fresh build ($(tr '\n' ';' < "$out_dir/toolchain.txt"))"
    if [[ -n "${NO_CACHE:-}" ]]; then
      # A cold-cache rebuild that matches is the reproducibility proof.
      bun "$here/write-provenance.ts" "$public_dir" "$out_dir/toolchain.txt" --verified
    fi
    exit 0
  fi
  echo "MISMATCH: shipped dtln.js differs from a fresh build" >&2
  exit 1
fi

echo "==> Installing into $public_dir"
cp "$out_dir/dtln.formatted.js" "$public_dir/dtln.js"
cp "$out_dir/LICENSE.datadog" "$out_dir/NOTICE.datadog" "$out_dir/LICENSE-3rdparty.csv" "$public_dir/"
bun "$here/write-provenance.ts" "$public_dir" "$out_dir/toolchain.txt"
echo "==> Done. Run: bun test apps/web/src/voice/dtlnWorklet.test.ts"

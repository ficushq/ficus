/**
 * Sandbox installation of schpet/linear-cli (`linear`, ISC license).
 *
 * Upstream publishes prebuilt Rust binaries for glibc Linux only. The npm
 * package `@schpet/linear-cli` is a thin wrapper whose postinstall downloads
 * the same GitHub release asset without verifying it, so Ficus downloads the
 * release asset directly and checks a pinned SHA-256 digest before installing.
 *
 * Squad sandboxes are not all glibc: the Docker runtime image is Alpine (musl)
 * and its glibc-compat package is amd64-only. The installed `linear` command is
 * therefore a small launcher that runs the binary through the Nix glibc loader
 * and libgcc that the pinned devbox Node.js package already depends on. The
 * same launcher works on Alpine, Ubuntu and the VM image, on amd64 and arm64,
 * and does not depend on the image's glibc version. Those Nix store paths stay
 * live while the devbox profile holds Node.js; any package change alters the
 * toolchain fingerprint and reruns this step, which regenerates the launcher.
 */

/** The GraphQL endpoint the CLI is pinned to; also used by Ficus's own Linear queries. */
export const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql'

export interface LinearCliRelease {
  version: string
  /** Release assets by `uname -m`-normalized architecture. */
  assets: Record<'x86_64' | 'aarch64', { url: string; sha256: string }>
}

/** Pinned stable release. Digests come from the release's sha256.sum and the GitHub asset digests. */
export const LINEAR_CLI_RELEASE: LinearCliRelease = {
  version: '3.1.0',
  assets: {
    x86_64: {
      url: 'https://github.com/schpet/linear-cli/releases/download/v3.1.0/linear-x86_64-unknown-linux-gnu.tar.xz',
      sha256: 'bf7712097ce6a01e8a379de8357eca66d5748050201d336ba787b6ad3687f3e7',
    },
    aarch64: {
      url: 'https://github.com/schpet/linear-cli/releases/download/v3.1.0/linear-aarch64-unknown-linux-gnu.tar.xz',
      sha256: '4b0b15b69464e8b6a665290d702817654be2124cf1d58fad7d7ed5754f9431d7',
    },
  },
}

/** Devbox packages the setup step needs: Node.js for hashing and its Nix glibc, xz for the release archive. */
export const LINEAR_CLI_PACKAGES = ['nodejs@24.12.0', 'xz@5.8.3'] as const

/**
 * Writes the launcher. Runs under the devbox Node.js, whose loaded shared
 * objects name the Nix glibc loader, libc and libgcc_s directories.
 */
const LAUNCHER_SCRIPT = String.raw`const fs = require('fs')
const [real, out] = process.argv.slice(2)
const loaded = process.report.getReport().sharedObjects
const find = (pattern) => loaded.find((path) => pattern.test(path))
const loader = find(/^\/nix\/store\/[^/]+\/lib(64)?\/ld-linux[^/]*\.so\.[0-9]+$/)
const libc = find(/^\/nix\/store\/[^/]+\/lib\/libc\.so\.6$/)
const libgcc = find(/^\/nix\/store\/[^/]+\/lib\/libgcc_s\.so\.1$/)
if (!loader || !libc || !libgcc) {
  console.error('The Linear CLI needs the Nix glibc runtime of the devbox Node.js package')
  process.exit(1)
}
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'"
const dir = (path) => path.slice(0, path.lastIndexOf('/'))
const libraryPath = dir(libc) + ':' + dir(libgcc)
fs.writeFileSync(
  out,
  '#!/bin/sh\nexec ' + quote(loader) + ' --argv0 linear --library-path ' + quote(libraryPath) + ' ' + quote(real) + ' "$@"\n',
  { mode: 0o755 }
)`

/**
 * One setup step. It runs in an isolated temporary directory inside a
 * `set -eu` subshell, and fails before installing anything when the
 * platform is unsupported or the archive digest does not match.
 */
export function linearCliSetupStep(release: LinearCliRelease = LINEAR_CLI_RELEASE): { id: string; script: string } {
  const { version, assets } = release
  const lines = [
    '(',
    'set -eu',
    'tmp=$(mktemp -d)',
    'trap \'rm -rf -- "$tmp"\' EXIT',
    'cd "$tmp"',
    'case "$(uname -s)-$(uname -m)" in',
    `  Linux-x86_64|Linux-amd64) target=x86_64-unknown-linux-gnu; url='${assets.x86_64.url}'; digest='${assets.x86_64.sha256}' ;;`,
    `  Linux-aarch64|Linux-arm64) target=aarch64-unknown-linux-gnu; url='${assets.aarch64.url}'; digest='${assets.aarch64.sha256}' ;;`,
    '  *) echo "Unsupported Linear CLI platform" >&2; exit 1 ;;',
    'esac',
    'curl --fail --silent --show-error --location --retry 2 --max-time 120 "$url" -o cli.tar.xz',
    `actual=$(node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" cli.tar.xz)`,
    'if [ "$actual" != "$digest" ]; then echo "Linear CLI archive digest mismatch" >&2; exit 1; fi',
    'xz --decompress --stdout cli.tar.xz > cli.tar',
    'tar -xf cli.tar "linear-$target/linear"',
    "cat > launcher.cjs <<'FICUS_LINEAR_LAUNCHER'",
    LAUNCHER_SCRIPT,
    'FICUS_LINEAR_LAUNCHER',
    `dest="$DEVBOX_PROJECT_ROOT/linear-cli/${version}"`,
    'mkdir -p "$dest" "$DEVBOX_PROJECT_ROOT/npm/bin"',
    'install -m 755 "linear-$target/linear" "$dest/linear"',
    'node launcher.cjs "$dest/linear" launcher',
    'install -m 755 launcher "$DEVBOX_PROJECT_ROOT/npm/bin/linear"',
    ')',
  ]
  return { id: `linear-cli@${version}`, script: lines.join('\n') }
}

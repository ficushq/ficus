/**
 * The one tmux every Ficus call on a box uses (managed local deployments and
 * agent monitors, on squad AND private agent boxes).
 *
 * ## Why the binary is pinned
 * A box can carry more than one tmux: the image's (`/usr/bin/tmux`) and the
 * devbox comfort set's (`~/.ficus/devbox/.devbox/nix/profile/default/bin/tmux`).
 * A bare `tmux` resolves through PATH, and PATH differs between callers (login
 * vs non-login shell, toolchain reconcile, Core upgrade relaunch). tmux clients
 * and servers of different versions cannot talk: a 3.4 client against a 3.7
 * server prints "server exited unexpectedly". On 2026-10-18 one relaunch started
 * a 3.7 server and every later 3.4 call failed, so app launches failed, monitors
 * could not be created and `has-session` reported running apps as crashed.
 *
 * So every call resolves the binary IN THE BOX from a fixed candidate list
 * ({@link TMUX_CANDIDATES}, system tmux first) and runs it by absolute path. PATH
 * is consulted only as a last resort, when none of the fixed locations has one.
 * Only the tmux binary is pinned: the app or monitor command still runs with the
 * caller's recorded PATH (see launch-path.ts).
 *
 * ## Why Ficus has its own socket
 * Sessions are created on `-L ficus`, a server only Ficus starts (always with
 * the pinned binary), so a user's or devbox's tmux on the default socket can
 * never again break a Ficus launch. Sessions created before this change live on
 * the default socket, so lookups and stops check BOTH sockets: a deploy neither
 * orphans a running app nor reports it crashed.
 *
 * ## Servers of another version
 * Observation and stop (`has-session`, `kill-session`) never start a server.
 * When the pinned binary reports a version mismatch, they retry with the other
 * installed tmux binaries in the same fixed order, so a stale server another
 * binary started (the incident) is still found and stopped. Creating a session
 * only ever uses the pinned binary. If no binary can talk to a server, the
 * command exits {@link TMUX_UNREACHABLE_EXIT_CODE} after printing
 * {@link TMUX_UNREACHABLE_MARKER}: callers report that as
 * {@link TmuxServerUnreachableError}, never as "session gone".
 */

/** Ficus's own tmux socket name (`tmux -L ficus`). */
export const FICUS_TMUX_SOCKET = 'ficus'
/** The socket sessions were created on before {@link FICUS_TMUX_SOCKET}. */
export const LEGACY_TMUX_SOCKET = 'default'

/**
 * Where tmux is looked for, in order. System locations first (Ubuntu VM boxes,
 * macOS hosts), then the k8s agent image's global nix profile, then devbox
 * profiles. Shell words: the variables expand in the box.
 */
export const TMUX_CANDIDATES: readonly string[] = [
  '/usr/bin/tmux',
  '/usr/local/bin/tmux',
  '/opt/homebrew/bin/tmux',
  '/bin/tmux',
  '"${HOME:-}/.nix-profile/bin/tmux"',
  '/nix/var/nix/profiles/default/bin/tmux',
  // The k8s entrypoint's devbox dir (packages/sandbox-server/src/paths.ts).
  '"${FICUS_DEVBOX_DIR:-${WORKSPACE_PATH:-/workspace}}/.devbox/nix/profile/default/bin/tmux"',
  // A vm box's devbox (machines/devbox-seed.ts).
  '"${HOME:-}/.ficus/devbox/.devbox/nix/profile/default/bin/tmux"',
]

let candidatesOverride: readonly string[] | null = null

/**
 * Tests only: replace {@link TMUX_CANDIDATES} for every command built after
 * this call (`null` restores it). The real list holds absolute system paths.
 */
export function setTmuxCandidatesForTesting(candidates: readonly string[] | null): void {
  candidatesOverride = candidates
}

/** Exit status of a box command that could not reach a tmux server. */
export const TMUX_UNREACHABLE_EXIT_CODE = 86
/** Line printed (stdout and stderr) before exiting {@link TMUX_UNREACHABLE_EXIT_CODE}. */
export const TMUX_UNREACHABLE_MARKER = 'FICUS_TMUX_UNREACHABLE'

/** Messages a tmux client prints when it cannot talk to a server of another version. */
const MISMATCH_PATTERNS = ['server exited unexpectedly', 'protocol version mismatch', 'lost server']

/**
 * Bash function definitions (one bash `-c` script prelude) for the commands
 * below, resolving the pinned binary from `candidates` in order.
 *
 * - `ficus_tmux_try ARGS…`: run tmux, falling back across binaries on a version
 *   mismatch. Returns 0 on success, 1 when tmux says there is no such
 *   server/session, 2 when the server cannot be reached.
 * - `ficus_tmux_has NAME`: 0 alive on either socket, 1 missing on both, 2 unknown.
 * - `ficus_tmux_kill NAME`: kill on both sockets; 0 unless a server is unreachable.
 * - `ficus_tmux_new NAME CMD`: create on the Ficus socket with the pinned binary.
 * - `ficus_tmux_unreachable`: print the marker and exit with its status.
 */
export function tmuxShellFunctions(candidates: readonly string[] = candidatesOverride ?? TMUX_CANDIDATES): string {
  const mismatch = MISMATCH_PATTERNS.map((pattern) => `*${JSON.stringify(pattern)}*`).join('|')
  return `ficus_tmux_bins=()
for ficus_tmux_c in ${candidates.join(' ')}; do
  if [ -x "$ficus_tmux_c" ]; then ficus_tmux_bins+=("$ficus_tmux_c"); fi
done
if [ "\${#ficus_tmux_bins[@]}" = 0 ] && ficus_tmux_c=$(command -v tmux 2>/dev/null); then ficus_tmux_bins+=("$ficus_tmux_c"); fi
FICUS_TMUX="\${ficus_tmux_bins[0]:-}"
ficus_tmux_error=''
ficus_tmux_try() {
  local bin out
  if [ -z "$FICUS_TMUX" ]; then ficus_tmux_error='tmux is not installed on this box'; return 2; fi
  for bin in "\${ficus_tmux_bins[@]}"; do
    if out=$("$bin" "$@" 2>&1); then return 0; fi
    ficus_tmux_error="$bin: $out"
    case "$out" in
      ${mismatch}) continue ;;
      *"no server running"*|*"can't find session"*|*"session not found"*|*"error connecting to"*"No such file or directory"*) return 1 ;;
    esac
    return 2
  done
  ficus_tmux_error="no installed tmux can talk to this server (version mismatch): $ficus_tmux_error"
  return 2
}
ficus_tmux_has() {
  local status=0 legacy=0
  ficus_tmux_try -L ${FICUS_TMUX_SOCKET} has-session -t "$1" || status=$?
  [ "$status" = 0 ] && return 0
  ficus_tmux_try -L ${LEGACY_TMUX_SOCKET} has-session -t "$1" || legacy=$?
  [ "$legacy" = 0 ] && return 0
  if [ "$status" = 2 ] || [ "$legacy" = 2 ]; then return 2; fi
  return 1
}
ficus_tmux_kill() {
  local status=0 legacy=0
  ficus_tmux_try -L ${FICUS_TMUX_SOCKET} kill-session -t "$1" || status=$?
  ficus_tmux_try -L ${LEGACY_TMUX_SOCKET} kill-session -t "$1" || legacy=$?
  if [ "$status" = 2 ] || [ "$legacy" = 2 ]; then return 2; fi
  return 0
}
ficus_tmux_new() {
  local out
  if [ -z "$FICUS_TMUX" ]; then ficus_tmux_error='tmux is not installed on this box'; return 2; fi
  if out=$("$FICUS_TMUX" -L ${FICUS_TMUX_SOCKET} new-session -d -s "$1" "$2" 2>&1); then return 0; fi
  ficus_tmux_error="$FICUS_TMUX: $out"
  case "$out" in
    ${mismatch}) return 2 ;;
  esac
  printf '%s\\n' "$out" >&2
  return 1
}
ficus_tmux_unreachable() {
  printf '%s %s\\n' ${TMUX_UNREACHABLE_MARKER} "$ficus_tmux_error"
  printf '%s %s\\n' ${TMUX_UNREACHABLE_MARKER} "$ficus_tmux_error" >&2
  exit ${TMUX_UNREACHABLE_EXIT_CODE}
}`
}

/**
 * The box's tmux server for Ficus sessions could not be reached: typically a
 * server started by a tmux of another version. The session may well be alive,
 * so this must never be read as "crashed"/"lost" or trigger a restart.
 */
export class TmuxServerUnreachableError extends Error {
  /** tmux's own message (binary and error), at most 300 characters. */
  readonly detail: string | null
  constructor(detail?: string | null) {
    const clean = detail?.trim().slice(0, 300) || null
    super(
      'tmux server on the box is unreachable (likely a tmux client/server version mismatch); session state is unknown.' +
        (clean ? ` tmux said: ${clean}` : '')
    )
    this.name = 'TmuxServerUnreachableError'
    this.detail = clean
  }
}

/** The unreachable error a failed box command reports, if it is one. */
export function tmuxUnreachableFromOutput(text: string): TmuxServerUnreachableError | null {
  const line = text.split('\n').find((candidate) => candidate.includes(TMUX_UNREACHABLE_MARKER))
  if (line === undefined) return null
  return new TmuxServerUnreachableError(
    line.slice(line.indexOf(TMUX_UNREACHABLE_MARKER) + TMUX_UNREACHABLE_MARKER.length)
  )
}

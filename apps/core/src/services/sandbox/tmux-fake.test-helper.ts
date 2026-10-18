/**
 * A fake `tmux` for tests: a bash script that keeps per-socket "servers" as
 * directories under a state dir and, like real tmux, refuses to talk to a
 * server another version started ("server exited unexpectedly"). Every call is
 * appended to `<state>/calls` as `<binary> <args…>`.
 *
 * `new-session` runs the session command synchronously in a bare environment
 * (only system dirs on PATH, as a tmux server started elsewhere hands a new
 * session), then keeps the session "alive" until it is killed.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const FAKE_TMUX = `#!/bin/bash
v=__VERSION__
state="$FAKE_TMUX_STATE"
printf '%s %s\\n' "$0" "$*" >> "$state/calls"
sock=default
if [ "$1" = -L ]; then sock=$2; shift 2; fi
srv="$state/servers/$sock"
cmd=$1; shift
if [ -f "$srv/version" ] && [ "$(cat "$srv/version")" != "$v" ]; then echo 'server exited unexpectedly' >&2; exit 1; fi
case "$cmd" in
  has-session|kill-session)
    [ -f "$srv/version" ] || { echo "no server running on /tmp/fake/$sock" >&2; exit 1; }
    [ -f "$srv/sessions/$2" ] || { echo "can't find session: $2" >&2; exit 1; }
    [ "$cmd" = kill-session ] && rm -f "$srv/sessions/$2"
    exit 0 ;;
  new-session)
    name=$3; command=$4
    mkdir -p "$srv/sessions"; echo "$v" > "$srv/version"
    [ -f "$srv/sessions/$name" ] && { echo "duplicate session: $name" >&2; exit 1; }
    : > "$srv/sessions/$name"
    env -i HOME="$HOME" PATH=/usr/bin:/bin bash -c "$command" > /dev/null 2>&1
    exit 0 ;;
esac
echo "unknown command: $cmd" >&2
exit 1
`

export interface FakeTmuxBox {
  state: string
  /** Install a fake tmux of `version` at `path` (its directory is created). */
  install(path: string, version: string): string
  /** Start a server of `version` on `socket` holding `session` (as an old Ficus/devbox tmux would). */
  seedSession(socket: string, version: string, session: string): void
  hasSession(socket: string, session: string): boolean
  serverVersion(socket: string): string | null
  /** Binaries invoked, in order. */
  callers(): string[]
}

export function createFakeTmuxBox(root: string): FakeTmuxBox {
  const state = join(root, 'fake-tmux-state')
  mkdirSync(join(state, 'servers'), { recursive: true })
  writeFileSync(join(state, 'calls'), '')
  const server = (socket: string) => join(state, 'servers', socket)
  return {
    state,
    install(path, version) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, FAKE_TMUX.replace('__VERSION__', version))
      chmodSync(path, 0o755)
      return path
    },
    seedSession(socket, version, session) {
      mkdirSync(join(server(socket), 'sessions'), { recursive: true })
      writeFileSync(join(server(socket), 'version'), version)
      writeFileSync(join(server(socket), 'sessions', session), '')
    },
    hasSession(socket, session) {
      return existsSync(join(server(socket), 'sessions', session))
    },
    serverVersion(socket) {
      const file = join(server(socket), 'version')
      return existsSync(file) ? readFileSync(file, 'utf8').trim() : null
    },
    callers() {
      return readFileSync(join(state, 'calls'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' ')[0])
    },
  }
}

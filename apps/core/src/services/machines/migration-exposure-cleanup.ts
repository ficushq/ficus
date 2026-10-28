import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boxHomeForUser, boxUnixUser } from './box-paths'
import type { Machine } from './queries'
import type { SshRunner } from './ssh'

/**
 * Retire managed plaintext BEFORE migration's immutable snapshot. The source
 * unit is already stopped, so use SSH, not the unavailable box HTTP server.
 * Streaming/restoration and every manifest comparison remain byte-for-byte.
 */
export async function prepareMigrationSource(
  runner: SshRunner,
  machine: Machine,
  sandboxId: string,
  deps: { generatedEnv?: (squadId: string) => Promise<Uint8Array> } = {}
): Promise<void> {
  const user = boxUnixUser(sandboxId)
  const home = boxHomeForUser(user)
  const squadId = sandboxId.startsWith('squad_') ? sandboxId.slice(6) : null
  const content = squadId
    ? await (
        deps.generatedEnv ??
        (async (id) => {
          const { regenerateEnvFileForSquad } = await import('../squad/env')
          const { getSquadWorkspacePath } = await import('../squad/workspace')
          await regenerateEnvFileForSquad(id)
          return readFileSync(join(getSquadWorkspacePath(id), '.ficus', '.env'))
        })
      )(squadId)
    : undefined
  // home/user come exclusively from the canonical, hashed box identity helpers.
  // Validate both settings roots before changing either. Do not follow links or
  // recursively remove a conflicting user directory named like a managed file.
  const command = `sudo bash -c 'set -euo pipefail
home="$1"; user="$2"; refresh="$3"
for root in "$home/workspace" "$home/.private"; do
  [ ! -L "$root" ] || exit 40
  if [ -e "$root" ]; then
    [ -d "$root" ] || exit 40
    dot="$root/.ficus"
    [ ! -L "$dot" ] && { [ ! -e "$dot" ] || [ -d "$dot" ]; } || exit 40
  fi
done
if [ "$refresh" = 1 ]; then
  [ -d "$home/workspace" ] || exit 40
  dot="$home/workspace/.ficus"
  if [ ! -e "$dot" ]; then install -d -m 0755 -o "$user" -g "$user" -- "$dot"; fi
  temporary="$(mktemp "$dot/.env.migrate-XXXXXX")"
  cleanup() { rm -f -- "$temporary"; }
  trap cleanup EXIT
  cat > "$temporary"
  chmod 0600 "$temporary"
  chown "$user:$user" "$temporary"
  mv -T -- "$temporary" "$dot/.env"
fi
if [ -d "$home/.private/.ficus" ]; then
  rm -f -- "$home/.private/.ficus/agent-secrets.env"
fi
' -- '${home}' '${user}' '${squadId ? '1' : '0'}'`
  const result = await runner.run(machine, command, { stdin: content, timeoutMs: 30_000 })
  // Never include remote output or generated content in an error/status payload.
  if (result.exitCode !== 0)
    throw new Error('Migration source exposure sanitation failed; check managed settings paths and permissions')
}

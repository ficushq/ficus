import { createMigrationManifest } from './migration-manifest'
import type { MigrationManifestV1, MigrationRootInput, ManifestEntryV1 } from './migration-manifest'
import type { Machine } from './queries'
import type { SshRunner } from './ssh'

const BOX_USER = /^box_[0-9a-f]{12}$/
const HOME = /^\/home\/box_[0-9a-f]{12}(?:\/.ficus-migrate\/[0-9a-f-]{36})?$/

export function buildMigrationScanCommand(home: string, unixUser: string): string {
  if (!BOX_USER.test(unixUser) || !HOME.test(home) || !home.startsWith(`/home/${unixUser}`))
    throw new Error('invalid box scan identity')
  const qHome = `'${home}'`
  const qUser = `'${unixUser}'`
  return `sudo bash -c 'set -euo pipefail
home="$1"; user="$2"
for root in workspace .private; do
  base="$home/$root"
  if [ ! -e "$base" ]; then printf "R\\t%s\\tabsent\\t\\t\\n" "$root"; continue; fi
  [ -d "$base" ] && [ ! -L "$base" ] || { echo "unsupported root" >&2; exit 40; }
  [ "$(stat -c %U -- "$base")" = "$user" ] || { echo "invalid owner" >&2; exit 41; }
  printf "R\\t%s\\tpresent\\t%s\\tbox-user\\n" "$root" "$(stat -c %a -- "$base")"
  while IFS= read -r -d "" path; do
    rel="${'$'}{path#"$base/"}"
    # Branch on links before any file/dir predicate so dangling links are never
    # dereferenced. GNU stat defaults to lstat unless -L is supplied.
    owner="$(stat -c %U -- "$path")"; [ "$owner" = "$user" ] || { echo "invalid owner" >&2; exit 41; }
    mode="$(stat -c %a -- "$path")"; path64="$(printf %s "$rel" | base64 -w0)"
    if [ -L "$path" ]; then
      printf "E\\t%s\\tsymlink\\t%s\\t%s\\t\\t\\t%s\\n" "$root" "$path64" "$mode" "$(readlink -- "$path" | base64 -w0)"
    elif [ -f "$path" ]; then
      links="$(stat -c %h -- "$path")"; [ "$links" = 1 ] || { echo "unsupported hardlink" >&2; exit 42; }
      printf "E\\t%s\\tfile\\t%s\\t%s\\t%s\\t%s\\t\\n" "$root" "$path64" "$mode" "$(stat -c %s -- "$path")" "$(sha256sum -- "$path" | cut -d " " -f1)"
    elif [ -d "$path" ]; then
      printf "E\\t%s\\tdirectory\\t%s\\t%s\\t\\t\\t\\n" "$root" "$path64" "$mode"
    else echo "unsupported entry" >&2; exit 43; fi
  done < <(find "$base" -mindepth 1 -xdev -print0)
done' -- ${qHome} ${qUser}`
}

export async function scanMigrationManifest(
  runner: SshRunner,
  machine: Machine,
  home: string,
  unixUser: string,
  identity: Omit<MigrationManifestV1, 'schema' | 'roots' | 'totals' | 'manifestSha256'>
): Promise<MigrationManifestV1> {
  const result = await runner.run(machine, buildMigrationScanCommand(home, unixUser), { timeoutMs: 30 * 60_000 })
  if (result.exitCode !== 0) throw new Error(`migration scan failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  return createMigrationManifest(identity, parseMigrationScanRecords(result.stdout))
}

export function parseMigrationScanRecords(stdout: string): MigrationRootInput[] {
  const roots = new Map<string, MigrationRootInput>()
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const fields = line.split('\t')
    if (fields[0] === 'R') {
      const [, name, presence, mode, owner] = fields
      if (name !== 'workspace' && name !== '.private') throw new Error('unsupported migration root')
      if (roots.has(name)) throw new Error(`duplicate migration root ${name}`)
      if (presence === 'absent') roots.set(name, { name, presence, entries: [] })
      else if (presence === 'present') {
        if (owner !== 'box-user') throw new Error(`invalid root owner for ${name}`)
        roots.set(name, { name, presence, mode, owner, entries: [] })
      } else throw new Error('invalid root presence')
      continue
    }
    if (fields[0] === 'E') {
      const [, rootName, type, pathB64, mode, size, digest, targetB64] = fields
      const root = roots.get(rootName)
      if (!root || root.presence !== 'present') throw new Error('entry precedes present root')
      let entry: ManifestEntryV1
      if (type === 'file') entry = { pathB64, type, mode, size, contentSha256: digest }
      else if (type === 'directory') entry = { pathB64, type, mode }
      else if (type === 'symlink') entry = { pathB64, type, mode, targetB64 }
      else throw new Error(`unsupported migration entry type ${type}`)
      root.entries.push(entry)
      continue
    }
    throw new Error('invalid migration scan record')
  }
  const workspace = roots.get('workspace')
  const privateRoot = roots.get('.private')
  if (!workspace) throw new Error('workspace scan record missing')
  if (!privateRoot) throw new Error('.private scan record missing')
  return [workspace, privateRoot]
}

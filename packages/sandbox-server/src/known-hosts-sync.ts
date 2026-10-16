/**
 * Merge a squad's Core-managed known_hosts into the sandbox's own
 * `~/.ssh/known_hosts` (k8s runtime).
 *
 * The entrypoint mirrors Core's squad ssh dir (`/var/lib/ficus/ssh-source`)
 * into `/root/.ssh` every 30s. Mirroring `known_hosts` verbatim would discard
 * every host key trusted inside the sandbox, so the entrypoint excludes it from
 * the mirror and runs this instead:
 *
 *   bun /opt/sandbox/src/known-hosts-sync.ts <source known_hosts> <dest known_hosts>
 *
 * Core's entries land in a delimited managed block (`@ficus/shared/known-hosts`);
 * everything else in the destination is kept. The write is atomic (temp file in
 * the same directory, then rename), created 0600, and is skipped when the
 * result is unchanged. If the destination changes while the merge runs, the
 * merge starts over rather than dropping the concurrent addition.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { mergeManagedKnownHosts, type KnownHostsConflict } from '@ficus/shared/known-hosts'

const MERGE_ATTEMPTS = 3

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export interface KnownHostsSyncResult {
  written: boolean
  conflicts: KnownHostsConflict[]
}

export async function syncKnownHostsFile(sourcePath: string, destPath: string): Promise<KnownHostsSyncResult> {
  const managed = (await readOptional(sourcePath))?.toString('utf8') ?? ''
  for (let attempt = 1; attempt <= MERGE_ATTEMPTS; attempt++) {
    const existing = await readOptional(destPath)
    const merged = mergeManagedKnownHosts(existing?.toString('utf8') ?? '', managed)
    if (!merged.changed) return { written: false, conflicts: merged.conflicts }

    const temp = join(dirname(destPath), `.${basename(destPath)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temp, merged.content, { mode: 0o600, flag: 'wx' })
      await fs.chmod(temp, 0o600)
      // Compare-and-swap: a line appended since the read must not be lost.
      const current = await readOptional(destPath)
      const unchanged = existing === null ? current === null : current !== null && current.equals(existing)
      if (!unchanged) continue
      await fs.rename(temp, destPath)
      return { written: true, conflicts: merged.conflicts }
    } finally {
      await fs.rm(temp, { force: true })
    }
  }
  throw new Error(`${destPath} kept changing during the managed known_hosts merge; left untouched`)
}

if (import.meta.main) {
  const [sourcePath, destPath] = process.argv.slice(2)
  if (!sourcePath || !destPath) {
    console.error('usage: known-hosts-sync.ts <source known_hosts> <dest known_hosts>')
    process.exit(2)
  }
  try {
    const { conflicts } = await syncKnownHostsFile(sourcePath, destPath)
    for (const c of conflicts) {
      console.error(
        `[known-hosts] conflict: ${destPath} line ${c.line} pins a different ${c.keyType} key for ${c.host}; managed entry not written`
      )
    }
  } catch (err) {
    console.error(`[known-hosts] merge failed: ${(err as Error).message}`)
    process.exit(1)
  }
}

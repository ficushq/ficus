import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// `bun build` inlines this JSON, so a bundle carries the migration list its
// code (including the migrator's data-backfill hooks) was built against.
import buildJournal from '../../drizzle/meta/_journal.json'

export interface MigrationJournalEntry {
  tag: string
  when: number
}

const describeEntry = (entry: MigrationJournalEntry | undefined) => entry?.tag ?? 'none'

/**
 * Refuses to migrate when the on-disk migrations differ from the ones this
 * build was compiled with. Startup reads SQL from `apps/core/drizzle` at
 * runtime, so a stale `dist/` bundle would otherwise apply newer migrations
 * without the backfills that must run inside them (for example 0179's
 * work-stream numbering), failing mid-upgrade or silently dropping data.
 */
export function assertMigrationsMatchBuild(
  migrationsFolder: string,
  built: readonly MigrationJournalEntry[] = buildJournal.entries
): void {
  const onDisk = (
    JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
      entries: MigrationJournalEntry[]
    }
  ).entries
  const length = Math.max(onDisk.length, built.length)
  for (let index = 0; index < length; index += 1) {
    const expected = built[index]
    const actual = onDisk[index]
    if (expected?.tag === actual?.tag && expected?.when === actual?.when) continue
    throw new Error(
      `Core build does not match the migrations in ${migrationsFolder}: this build has ${built.length} ` +
        `migrations (last ${describeEntry(built.at(-1))}) but the folder has ${onDisk.length} ` +
        `(last ${describeEntry(onDisk.at(-1))}); first difference at #${index}: build ${describeEntry(expected)}, ` +
        `folder ${describeEntry(actual)}. The Core bundle is stale for this checkout, and applying its ` +
        'migrations without the matching code could fail or lose data. Rebuild Core from this checkout ' +
        '(`bun run build:core`), then restart.'
    )
  }
}

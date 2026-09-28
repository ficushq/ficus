import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { builtMigrationJournal } from './built-migration-journal' with { type: 'macro' }
import { migrationListFingerprint, readMigrationJournal, type MigrationJournalEntry } from './migration-journal'

export type { MigrationJournalEntry } from './migration-journal'

/**
 * The migration list this code was built against, which also covers the
 * migrator's data-backfill hooks. A bundle freezes it at `bun build`; a source run
 * reads this tree's journal at startup (see built-migration-journal.ts).
 */
const BUILT = builtMigrationJournal()
const RUNNING_FROM_SOURCE = import.meta.path.endsWith('.ts')

export const MIGRATION_BUILD_MISMATCH = 'FICUS_MIGRATION_BUILD_MISMATCH'

const sameEntry = (a: MigrationJournalEntry | undefined, b: MigrationJournalEntry | undefined) =>
  a?.tag === b?.tag && a?.when === b?.when
const isPrefix = (short: readonly MigrationJournalEntry[], long: readonly MigrationJournalEntry[]) =>
  short.length < long.length && short.every((entry, index) => sameEntry(entry, long[index]))
const describeEntry = (entry: MigrationJournalEntry | undefined) => entry?.tag ?? 'none'

export interface MigrationBuildContext {
  built?: readonly MigrationJournalEntry[]
  /** True when running TypeScript sources, where the build list is the source tree's own journal. */
  fromSource?: boolean
  ficusRoot?: string
}

function remedy(migrationsFolder: string, { fromSource, ficusRoot }: MigrationBuildContext): string {
  if (fromSource) {
    return (
      `This is a source run, so ${migrationsFolder} is not this source tree's migrations folder: ` +
      `check FICUS_ROOT (${ficusRoot ?? 'unset'}) and the working directory.`
    )
  }
  const install = existsSync(join(migrationsFolder, '../../../.git'))
    ? 'In this source checkout, rebuild Core (`bun run build:core`), then restart.'
    : 'In a release artifact, Docker image or Desktop install, dist and drizzle come from different builds: ' +
      'install a matching release or image, or reinstall.'
  return ficusRoot ? `${install} FICUS_ROOT is ${ficusRoot}; check that it points at this build's install.` : install
}

/**
 * Refuses to migrate when the on-disk migrations differ from the ones this code
 * was built with. Startup reads SQL from `apps/core/drizzle` at runtime, so a
 * bundle built before a migration existed would otherwise apply it without the
 * backfill that must run inside it (for example 0179's work-stream numbering),
 * failing mid-upgrade or silently dropping data. Reads files only; callers run it
 * before connecting to the database.
 */
export function assertMigrationsMatchBuild(migrationsFolder: string, context: MigrationBuildContext = {}): void {
  const built = context.built ?? BUILT.entries
  const onDisk = readMigrationJournal(migrationsFolder)
  const index = Array.from({ length: Math.max(built.length, onDisk.length) }).findIndex(
    (_, i) => !sameEntry(built[i], onDisk[i])
  )
  if (index === -1) return
  const direction = isPrefix(built, onDisk)
    ? 'the build predates the folder'
    : isPrefix(onDisk, built)
      ? 'the build is newer than the folder'
      : 'the build and the folder have diverged'
  throw new Error(
    `[${MIGRATION_BUILD_MISMATCH}] Refusing to migrate: this Core build (${Bun.main}) has ${built.length} ` +
      `migrations (last ${describeEntry(built.at(-1))}) but ${migrationsFolder} has ${onDisk.length} ` +
      `(last ${describeEntry(onDisk.at(-1))}); they first differ at #${index} (build ${describeEntry(built[index])}, ` +
      `folder ${describeEntry(onDisk[index])}), so ${direction}. ` +
      remedy(migrationsFolder, {
        fromSource: context.fromSource ?? RUNNING_FROM_SOURCE,
        ficusRoot: 'ficusRoot' in context ? context.ficusRoot : process.env.FICUS_ROOT,
      })
  )
}

export const CORE_BUNDLES = ['apps/core/dist/index.js', 'apps/core/dist/worker.js', 'apps/core/dist/migrate.js']

/**
 * The built Core bundles in a checkout that were not built from its current
 * migration list, so starting them would hit the refusal above. Bundles that do
 * not exist are not reported, nor is anything outside a Ficus checkout.
 */
export function staleCoreBundles(repoRoot: string): string[] {
  const folder = join(repoRoot, 'apps/core/drizzle')
  if (!existsSync(join(folder, 'meta/_journal.json'))) return []
  const fingerprint = migrationListFingerprint(readMigrationJournal(folder))
  return CORE_BUNDLES.filter((bundle) => {
    const path = join(repoRoot, bundle)
    return existsSync(path) && !readFileSync(path, 'utf8').includes(fingerprint)
  })
}

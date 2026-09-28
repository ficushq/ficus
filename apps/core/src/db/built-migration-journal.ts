import { join } from 'node:path'
import { migrationListFingerprint, readMigrationJournal, type MigrationJournalEntry } from './migration-journal'

/**
 * Bun macro: import it `with { type: 'macro' }` so the call runs at transpile
 * time. `bun build` then freezes the migration list into the bundle, while a
 * source run reads it fresh at startup. A macro's file reads are not part of the
 * `bun --watch` module graph, so `db:generate` rewriting the journal does not
 * restart `bun run dev` into applying a just-generated (possibly still
 * placeholder `--custom`) migration.
 *
 * Keep this function read-only: it runs every time a consuming file is
 * transpiled (dev start, tests, `bun build`), not once. No writes, network or
 * process side effects here.
 */
export function builtMigrationJournal(): { entries: MigrationJournalEntry[]; fingerprint: string } {
  const entries = readMigrationJournal(join(import.meta.dir, '../../drizzle'))
  return { entries, fingerprint: migrationListFingerprint(entries) }
}

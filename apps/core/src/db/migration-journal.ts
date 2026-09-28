import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MigrationJournalEntry {
  tag: string
  when: number
}

/** The ordered migration list in `<folder>/meta/_journal.json`, reduced to what identifies each migration. */
export function readMigrationJournal(migrationsFolder: string): MigrationJournalEntry[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries: MigrationJournalEntry[]
  }
  return journal.entries.map(({ tag, when }) => ({ tag, when }))
}

/** A string that appears verbatim in every bundle built from this migration list. */
export function migrationListFingerprint(entries: readonly MigrationJournalEntry[]): string {
  const digest = createHash('sha256')
    .update(entries.map((entry) => `${entry.tag}@${entry.when}`).join('\n'))
    .digest('hex')
  return `ficus-migrations:${entries.length}:${digest.slice(0, 16)}`
}

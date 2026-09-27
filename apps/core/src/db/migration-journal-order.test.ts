import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

const journal = JSON.parse(readFileSync(join(import.meta.dir, '../../drizzle/meta/_journal.json'), 'utf8')) as {
  entries: JournalEntry[]
}

// Drizzle applies only migrations whose `when` is later than the newest one already
// applied, so an entry older than its predecessor is silently skipped on any database
// that has run the predecessor. Branches that each add a migration must re-sequence on
// merge, not just renumber.
test('migration journal entries are sequential and strictly increasing in time', () => {
  journal.entries.forEach((entry, position) => {
    expect(entry.idx).toBe(position)
    expect(entry.tag.startsWith(`${String(position).padStart(4, '0')}_`)).toBe(true)
    if (position > 0) expect(entry.when).toBeGreaterThan(journal.entries[position - 1]!.when)
  })
})

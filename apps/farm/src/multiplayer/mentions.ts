import type { FarmPerson } from '@ficus/shared'

/*
 * @mentions in farm chat, in plain text: "@" then someone's name as the farm
 * shows it (their display name, or their email) or just its first word, so
 * "@Rosa Díaz", "@Rosa" and "@sam" all work. The composer suggests names as
 * you type; messages highlight them, and a mention of you chimes and can
 * notify you.
 */

export interface Mention {
  start: number
  end: number
  userId: string
}

const WORD = /[\p{L}\p{N}_]/u

/** The ways someone can be mentioned, longest first: their full name, and its first word (an email's name part). */
function aliases(person: FarmPerson): string[] {
  const local = person.name.includes('@') ? person.name.split('@')[0]! : person.name
  const first = local.split(/\s+/)[0] ?? ''
  return [...new Set([person.name, local, first].filter((alias) => alias.length > 1))].sort(
    (a, b) => b.length - a.length
  )
}

/** Every @mention of a known person in a message, in order (the longest name wins where two would match). */
export function findMentions(body: string, people: readonly FarmPerson[]): Mention[] {
  const found: Mention[] = []
  const lower = body.toLowerCase()
  const candidates = people
    .flatMap((person) => aliases(person).map((alias) => ({ alias: alias.toLowerCase(), userId: person.id })))
    .sort((a, b) => b.alias.length - a.alias.length)
  for (let at = lower.indexOf('@'); at !== -1; at = lower.indexOf('@', at + 1)) {
    // Not the middle of an email address or a word.
    if (at > 0 && WORD.test(body[at - 1]!)) continue
    const match = candidates.find(
      ({ alias }) => lower.startsWith(alias, at + 1) && !WORD.test(body[at + 1 + alias.length] ?? ' ')
    )
    if (!match) continue
    const end = at + 1 + match.alias.length
    found.push({ start: at, end, userId: match.userId })
    at = end - 1
  }
  return found
}

/** Whether a message mentions this person. */
export function mentionsUser(body: string, people: readonly FarmPerson[], userId: string): boolean {
  return findMentions(body, people).some((mention) => mention.userId === userId)
}

/** An "@name" being typed just before the caret, if any: where it starts and what's typed so far. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(?:^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.-]{0,24})$/u.exec(before)
  if (!match) return null
  return { start: caret - match[1]!.length - 1, query: match[1]! }
}

/** People whose name (or its first word) starts with what's typed, best first, at most `limit`. */
export function mentionCandidates(
  query: string,
  people: readonly FarmPerson[],
  exceptUserId: string | null,
  limit = 6
): FarmPerson[] {
  const q = query.toLowerCase()
  return people
    .filter((person) => person.id !== exceptUserId)
    .map((person) => {
      const words = person.name.toLowerCase().split(/[\s@.]+/)
      const rank = person.name.toLowerCase().startsWith(q) ? 0 : words.some((w) => w.startsWith(q)) ? 1 : 2
      return { person, rank }
    })
    .filter(({ rank }) => rank < 2)
    .sort((a, b) => a.rank - b.rank || a.person.name.localeCompare(b.person.name))
    .slice(0, limit)
    .map(({ person }) => person)
}

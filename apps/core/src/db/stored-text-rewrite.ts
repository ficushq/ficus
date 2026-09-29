/**
 * One-time rewrite of names Core stored in text before the Ficus rename (Task 36c): entity
 * references, the memory_search provenance marker, and the short-term-memory snapshot entry type.
 * Shared by the 0196 database migration and the one-shot HOME_DIR file rewrite, so stored rows and
 * files move to the same forms. Nothing here reads the old forms at runtime; this is migration code.
 *
 * The grammar is frozen here on purpose: a later change to the live reference grammar must not
 * change what this historical migration rewrote.
 */

// Migration history: the pre-rename spellings this rewrite exists to retire.
const OLD_SCHEME = 'tau'
const OLD_PROVENANCE = '<!--tau:memory-provenance'
export const PRE_RENAME_SNAPSHOT_TYPE = 'tau:short-term-memory-snapshot'

const NEW_SCHEME = 'ficus'
const NEW_PROVENANCE = '<!--ficus:memory-provenance'
export const SNAPSHOT_TYPE = 'ficus:short-term-memory-snapshot'

/** Cheap SQL (`~*`) and JS prefilter: can this text hold anything the rewrite would change? */
export const STORED_TEXT_CANDIDATE = `${OLD_SCHEME}:(ws|agent):|${OLD_PROVENANCE}`
const CANDIDATE = new RegExp(STORED_TEXT_CANDIDATE, 'i')

/**
 * A reference: `<old>:ws:<id>` or `<old>:agent:<id>` (any case, as the reader accepted), standing on
 * its own. Not when it continues a word, a path, a host, a query or another scheme (after `x/`, `a.`,
 * `?r=`, `x:`), and not when the id runs on into more of one (followed by `/extra`, `.example`, `:x`).
 * Sentence punctuation after it is fine.
 */
const REFERENCE = new RegExp(
  String.raw`(?<![\w/\\.:@#?=&%+~-])${OLD_SCHEME}:(ws|agent):([0-9a-f-]{1,36})(?![\w/\\-]|[.:@?#=&%+~][\w/])`,
  'gi'
)
/** Any `scheme://…` run: a reference inside a URL is part of that URL, never its own link. */
const URL_RUN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]*/gi
const UUID_TEMPLATE = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'

/** The reader's id grammar (parseEntityReference), frozen: a positive int32 work number, or a UUID or UUID prefix. */
function isReferenceId(kind: string, rawId: string): boolean {
  const id = rawId.toLowerCase()
  if (kind.toLowerCase() === 'ws' && /^[1-9]\d*$/.test(id) && Number(id) <= 2147483647) return true
  return ![...id].some((char, index) => (UUID_TEMPLATE[index] === '-' ? char !== '-' : !/[0-9a-f]/.test(char ?? '')))
}

type Range = [start: number, end: number]

/** Fenced code blocks (``` or ~~~, closed by a same-character fence at least as long, or the end). */
function fencedRanges(text: string): Range[] {
  const ranges: Range[] = []
  let fence: { char: string; length: number; start: number } | null = null
  let lineStart = 0
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline + 1
    const line = text.slice(lineStart, newline === -1 ? text.length : newline)
    if (!fence) {
      const open = /^[ \t]*(`{3,}|~{3,})/.exec(line)
      // A backtick fence's info string cannot hold a backtick (CommonMark); then it is inline code.
      if (open && !(open[1]![0] === '`' && line.slice(open[0].length).includes('`'))) {
        fence = { char: open[1]![0]!, length: open[1]!.length, start: lineStart }
      }
    } else {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
        ranges.push([fence.start, lineEnd])
        fence = null
      }
    }
    if (newline === -1) break
    lineStart = lineEnd
  }
  if (fence) ranges.push([fence.start, text.length])
  return ranges
}

/** Inline code spans: a backtick run closed by the next run of the same length. */
function inlineCodeRanges(text: string, from: number, to: number): Range[] {
  const ranges: Range[] = []
  const runs = [...text.slice(from, to).matchAll(/`+/g)].map((run) => ({ at: from + run.index, length: run[0].length }))
  for (let index = 0; index < runs.length; index += 1) {
    const open = runs[index]!
    const closeIndex = runs.findIndex((run, candidate) => candidate > index && run.length === open.length)
    if (closeIndex === -1) continue
    const close = runs[closeIndex]!
    ranges.push([open.at, close.at + close.length])
    index = closeIndex
  }
  return ranges
}

/** Where references are not references: code blocks, inline code, and URLs. */
function protectedRanges(text: string): Range[] {
  const fenced = fencedRanges(text)
  const ranges = [...fenced]
  let cursor = 0
  for (const [start, end] of [...fenced, [text.length, text.length] as Range]) {
    ranges.push(...inlineCodeRanges(text, cursor, start))
    cursor = end
  }
  for (const url of text.matchAll(URL_RUN)) ranges.push([url.index, url.index + url[0].length])
  return ranges
}

/** Rewrites pre-rename work-stream and agent references to `ficus:`, outside code and URLs. */
export function rewriteEntityReferences(text: string): string {
  if (!CANDIDATE.test(text)) return text
  let ranges: Range[] | null = null
  return text.replace(REFERENCE, (match, kind: string, id: string, offset: number) => {
    if (!isReferenceId(kind, id)) return match
    ranges ??= protectedRanges(text)
    if (ranges.some(([start, end]) => offset >= start && offset < end)) return match
    return `${NEW_SCHEME}${match.slice(OLD_SCHEME.length)}`
  })
}

/** Rewrites the pre-rename marker of the memory_search provenance comment. */
export function rewriteMemoryProvenance(text: string): string {
  if (!text.includes(OLD_PROVENANCE)) return text
  return text.replace(new RegExp(`${OLD_PROVENANCE}(?=\\s)`, 'g'), NEW_PROVENANCE)
}

/** Both text rewrites: what every stored string gets. */
export function rewriteStoredText(text: string): string {
  return rewriteEntityReferences(rewriteMemoryProvenance(text))
}

export type JsonPath = string[]

/**
 * Every string value (never a key) in a JSON document whose rewrite differs, with its path, so a
 * caller can patch exactly those values (jsonb_set) and leave the rest of the document untouched.
 * `skip` prunes a subtree, such as a signed thinking block.
 */
export function jsonStringChanges(
  value: unknown,
  rewrite: (text: string) => string,
  skip: (object: Record<string, unknown>) => boolean = () => false,
  path: JsonPath = []
): Array<{ path: JsonPath; value: string }> {
  if (typeof value === 'string') {
    const next = rewrite(value)
    return next === value ? [] : [{ path, value: next }]
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => jsonStringChanges(item, rewrite, skip, [...path, String(index)]))
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (skip(object)) return []
    return Object.entries(object).flatMap(([key, item]) => jsonStringChanges(item, rewrite, skip, [...path, key]))
  }
  return []
}

/** Applies `jsonStringChanges` to a parsed document in place. */
export function applyJsonStringChanges(document: unknown, changes: Array<{ path: JsonPath; value: string }>): unknown {
  for (const { path, value } of changes) {
    if (path.length === 0) return value
    let parent = document as Record<string, unknown>
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>
    parent[path.at(-1)!] = value
  }
  return document
}

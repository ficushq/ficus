import { DATABASE_QUERY_FAILED, isDatabaseQueryError } from '../../db/errors'

export interface StoredKeyRedaction<T> {
  value: T
  storedKeys: readonly string[]
}

export interface ContentSafetyPort {
  /** Replace every stored secret value and known credential format with a marker. */
  redact<T>(input: T): T
  /** Redact all policies; report only input-protected exact matches for refusal/audit. */
  redactWithStoredKeys<T>(input: T): StoredKeyRedaction<T>
  /**
   * Drop a partial stored value cut off at an edge of text: a trailing fragment
   * that starts a stored value (the rest has not streamed yet) and/or a leading
   * fragment that ends one (the start was truncated away). Run it on raw text
   * before redaction: replacing a stored value that sits inside another one
   * hides the outer value's fragment from matching. Returns the text without
   * those fragments (a cut never splits a complete stored value); never returns a fragment.
   */
  trimStoredValueFragments(text: string, edges: StoredValueFragmentEdges): string
}

export interface StoredValueFragmentEdges {
  leading?: boolean
  trailing?: boolean
}

export type SecretEntry = {
  key: string
  value: string
  /** Redact exact values/fragments, but exclude them from input refusal and audit attribution. */
  outputOnly?: boolean
}

/** KMP failure table: for each prefix of `pattern`, the length of its longest proper border. */
function failureTable(pattern: string): Int32Array {
  const table = new Int32Array(pattern.length)
  let border = 0
  for (let index = 1; index < pattern.length; index++) {
    while (border > 0 && pattern[index] !== pattern[border]) border = table[border - 1]!
    if (pattern[index] === pattern[border]) border++
    table[index] = border
  }
  return table
}

/**
 * Length of the longest proper prefix of `pattern` that `text` ends with.
 * `charAt(i)` reads the text window from its start (i = 0) to its edge.
 */
function edgeFragmentLength(
  pattern: string,
  table: Int32Array,
  windowLength: number,
  charAt: (index: number) => string
): number {
  let state = 0
  for (let index = 0; index < windowLength; index++) {
    const char = charAt(index)
    while (state > 0 && pattern[state] !== char) state = table[state - 1]!
    if (pattern[state] === char) state++
    // A complete value cannot occur in a window shorter than the value.
  }
  return state
}

type FragmentMatcher = { value: string; forward: Int32Array; reversed: string; backward: Int32Array }

export const MAX_GENERIC_CREDENTIAL_LENGTH = 512

const ENTROPIC_TOKEN = String.raw`(?!v?\d+(?:\.\d+)+(?:-[a-z]+)*(?![A-Za-z0-9_.~+\/=-]))(?![a-z]+(?:-[a-z]+)+-\d+(?![A-Za-z0-9_.~+\/=-]))(?!\.{0,2}\/)(?!~\/)(?!k8s\.io\/)(?=[A-Za-z0-9_.~+\/=-]{20,512}(?![A-Za-z0-9_.~+\/=-]))(?=[^\s,;]*[a-z])(?=[^\s,;]*\d)(?=(?:[^\s,;]*[A-Z]|[^\s,;]*[^A-Za-z0-9\s]))[^\s,;]+`
const ENTROPIC_DOUBLE_QUOTED = String.raw`"(?=[^"\r\n]{20,512}")(?=[^"\r\n]{0,511}[A-Za-z])(?=[^"\r\n]{0,511}\d)(?=[^"\r\n]{0,511}[^A-Za-z0-9\s])(?:\\.|[^"\r\n]){20,512}"`
const ENTROPIC_SINGLE_QUOTED = String.raw`'(?=[^'\r\n]{20,512}')(?=[^'\r\n]{0,511}[A-Za-z])(?=[^'\r\n]{0,511}\d)(?=[^'\r\n]{0,511}[^A-Za-z0-9\s])(?:\\.|[^'\r\n]){20,512}'`

const CREDENTIAL_PATTERNS = [
  new RegExp(String.raw`\bauthorization\s*:\s*(?:bearer|basic)\s+${ENTROPIC_TOKEN}`, 'gi'),
  new RegExp(String.raw`\b(?:cookie|set-cookie)\s*:\s*[A-Za-z0-9_.-]{1,64}=${ENTROPIC_TOKEN}`, 'gi'),
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]{1,16300}?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{5,509}\.[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}\b/g,
  new RegExp(String.raw`https?:\/\/[^\s/:@]{1,64}:${ENTROPIC_TOKEN}@`, 'gi'),
  new RegExp(String.raw`postgres(?:ql)?:\/\/[^\s/:@]{1,64}:${ENTROPIC_TOKEN}@`, 'gi'),
  new RegExp(
    String.raw`\b[A-Za-z0-9_]{0,64}(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Za-z0-9_]{0,64}\s*[=:]\s*(?:${ENTROPIC_DOUBLE_QUOTED}|${ENTROPIC_SINGLE_QUOTED}|${ENTROPIC_TOKEN})`,
    'gi'
  ),
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,255}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{32,255}\b/g,
] as const

function isCredentialMatch(match: string): boolean {
  const contextual =
    /^(?:\b[A-Za-z0-9_]{0,64}(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Za-z0-9_]{0,64}\s*[=:]|\b(?:cookie|set-cookie)\s*:\s*[A-Za-z0-9_.-]{1,64}=)\s*(.*)$/i.exec(
      match
    )
  if (!contextual) return true
  const value = contextual[1]!.replace(/^['"]|['"]$/g, '')
  if (/^(?:\.{0,2}|~)?\//.test(value) || /^k8s\.io\//i.test(value)) return false
  if (/^[a-z][a-z0-9]*(?:[./-][a-z][a-z0-9]*)+$/.test(value)) return false
  return true
}

function safeKeyName(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/**
 * In-memory content sanitizer for exact stored secrets and well-known credential formats.
 * Raw matches never cross this object's API boundary.
 */
export class ContentSafety implements ContentSafetyPort {
  #entries: readonly SecretEntry[]
  /** Built lazily: only streaming tool output needs fragment matching. */
  #fragmentMatchers: readonly FragmentMatcher[] | undefined

  private constructor(entries: readonly SecretEntry[]) {
    this.#entries = []
    this.replaceSecretEntries(entries)
  }

  /** @internal Keeps existing execution stream redactors on the same matcher generation. */
  replaceSecretEntries(entries: readonly SecretEntry[]): void {
    this.#entries = entries
      .filter((entry) => entry.value.length > 0)
      .map((entry) => ({ ...entry, key: safeKeyName(entry.key) }))
      .sort((left, right) => right.value.length - left.value.length)
    this.#fragmentMatchers = undefined
  }

  trimStoredValueFragments(text: string, edges: StoredValueFragmentEdges): string {
    if (!edges.leading && !edges.trailing) return text
    this.#fragmentMatchers ??= this.#entries
      .filter((entry) => entry.value.length > 1)
      .map((entry) => {
        // UTF-16 code units, matching how the text is indexed below.
        const reversed = entry.value.split('').reverse().join('')
        return {
          value: entry.value,
          forward: failureTable(entry.value),
          reversed,
          backward: failureTable(reversed),
        }
      })
    const matchers = this.#fragmentMatchers
    // Fragments are only possible at the ORIGINAL edges: that is where output may
    // continue (or was truncated away). Characters inside the text are known
    // output, so a cut point is never re-examined as a new edge.
    let start = 0
    let end = text.length
    for (const matcher of matchers) {
      // A fragment is shorter than its value, so only that many edge characters matter.
      const window = Math.min(text.length, matcher.value.length - 1)
      if (edges.trailing) {
        const offset = text.length - window
        const length = edgeFragmentLength(matcher.value, matcher.forward, window, (index) => text[offset + index]!)
        end = Math.min(end, text.length - length)
      }
      if (edges.leading) {
        const length = edgeFragmentLength(
          matcher.reversed,
          matcher.backward,
          window,
          (index) => text[window - 1 - index]!
        )
        start = Math.max(start, length)
      }
    }
    if (start === 0 && end === text.length) return text
    // A cut that lands inside a complete stored value (overlapping values: one
    // value's fragment starts within another printed in full) would leave part of
    // that value behind, unrecognisable to exact redaction. Move the cut out to
    // the edge of the overlapping run of complete occurrences it falls in.
    for (const [runStart, runEnd] of this.#occurrenceRuns(text)) {
      if (runStart < end && end < runEnd) end = runStart
      if (runStart < start && start < runEnd) start = runEnd
    }
    return start >= end ? '' : text.slice(start, end)
  }

  /**
   * Complete stored-value occurrences in `text`, merged into disjoint runs of
   * overlapping occurrences. A point strictly inside a run is strictly inside
   * some occurrence, and moving out of that occurrence repeatedly ends at the
   * run's edge, so one lookup per run replaces an unbounded cascade.
   */
  #occurrenceRuns(text: string): Array<[number, number]> {
    const spans: Array<[number, number]> = []
    for (const entry of this.#entries) {
      for (let at = text.indexOf(entry.value); at >= 0; at = text.indexOf(entry.value, at + 1)) {
        spans.push([at, at + entry.value.length])
      }
    }
    spans.sort((left, right) => left[0] - right[0])
    const runs: Array<[number, number]> = []
    for (const [spanStart, spanEnd] of spans) {
      const run = runs.at(-1)
      if (run && spanStart < run[1]) run[1] = Math.max(run[1], spanEnd)
      else runs.push([spanStart, spanEnd])
    }
    return runs
  }

  static fromSecretEntries(entries: readonly SecretEntry[]): ContentSafety {
    return new ContentSafety(entries)
  }

  redact<T>(input: T): T {
    return this.redactWithStoredKeys(input).value
  }

  redactWithStoredKeys<T>(input: T): StoredKeyRedaction<T> {
    const seen = new WeakSet<object>()
    const replacements = new WeakMap<object, unknown>()
    const storedKeys = new Set<string>()

    const redactText = (text: string): string => this.redactString(text, storedKeys)

    const copyOwnData = (source: object, target: object, skipped: ReadonlySet<PropertyKey> = new Set()): object => {
      for (const property of Reflect.ownKeys(source)) {
        if (skipped.has(property) || (typeof property === 'string' && /^\d+$/.test(property))) continue
        const descriptor = Object.getOwnPropertyDescriptor(source, property)
        if (!descriptor || !('value' in descriptor)) throw new Error('content_safety_unsafe_accessor')
        const safeProperty =
          typeof property === 'symbol' ? Symbol(redactText(property.description ?? '')) : redactText(property)
        Object.defineProperty(target, safeProperty, {
          value: visit(descriptor.value),
          enumerable: descriptor.enumerable,
          configurable: true,
          writable: true,
        })
      }
      return target
    }

    const visit = (value: unknown): unknown => {
      if (typeof value === 'string') return redactText(value)
      if (typeof value === 'function') return '[REDACTED_UNSUPPORTED:function]'
      if (typeof value === 'symbol') return '[REDACTED_UNSUPPORTED:symbol]'
      if (typeof value === 'bigint') return `${value}n`
      if (value === null || typeof value !== 'object') return value
      if (replacements.has(value)) return replacements.get(value)
      if (seen.has(value)) return '[REDACTED_CIRCULAR]'
      seen.add(value)

      if (Array.isArray(value)) {
        const output: unknown[] = []
        for (const child of value) output.push(visit(child))
        replacements.set(value, output)
        return output
      }
      if (value instanceof Error) {
        // A query wrapper includes SQL/parameters in its message, stack and own fields.
        // Drop the entire payload (including driver detail), not just known credentials.
        if (isDatabaseQueryError(value)) {
          // Still inspect own data for stored-key audit attribution; discard the sanitized payload.
          copyOwnData(value, {})
          const error = new Error(DATABASE_QUERY_FAILED)
          error.stack = DATABASE_QUERY_FAILED
          replacements.set(value, error)
          return error
        }
        const message = redactText(value.message)
        const error = new Error(message)
        if (value.cause !== undefined)
          Object.defineProperty(error, 'cause', { value: visit(value.cause), configurable: true })
        error.name = redactText(value.name)
        if (value.stack) error.stack = redactText(value.stack)
        const output = copyOwnData(value, error, new Set(['name', 'message', 'stack', 'cause']))
        replacements.set(value, output)
        return output
      }
      if (value instanceof URL) {
        // Detect against the original serialization, but preserve a valid URL
        // object rather than feeding a whole-prefix placeholder to new URL().
        redactText(value.toString())
        const safeUrl = new URL(value.toString())
        if (safeUrl.username || safeUrl.password) {
          safeUrl.username = '[REDACTED_CREDENTIAL]'
          safeUrl.password = ''
        }
        const safeHref = redactText(safeUrl.toString())
        let output: URL
        try {
          output = new URL(safeHref)
        } catch {
          output = new URL('about:blank#REDACTED_CREDENTIAL')
        }
        const copied = copyOwnData(value, output) as URL
        replacements.set(value, copied)
        return copied
      }
      if (value instanceof Map) {
        const output = new Map()
        for (const [key, child] of value) output.set(visit(key), visit(child))
        const copied = copyOwnData(value, output)
        replacements.set(value, copied)
        return copied
      }
      if (value instanceof Set) {
        const output = new Set()
        for (const child of value) output.add(visit(child))
        const copied = copyOwnData(value, output)
        replacements.set(value, copied)
        return copied
      }
      if (value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise) {
        throw new Error('content_safety_unsupported_container')
      }
      if (value instanceof RegExp) {
        const output = copyOwnData(value, new RegExp(redactText(value.source), value.flags), new Set(['lastIndex']))
        replacements.set(value, output)
        return output
      }
      if (value instanceof String) {
        const output = copyOwnData(value, new String(redactText(value.toString())), new Set(['length']))
        replacements.set(value, output)
        return output
      }
      if (value instanceof Date) {
        const output = copyOwnData(value, new Date(value.getTime()))
        replacements.set(value, output)
        return output
      }
      if (value instanceof ArrayBuffer || value instanceof DataView || value instanceof Uint8Array) {
        const bytes =
          value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        const decoded = new TextDecoder().decode(bytes)
        const redacted = redactText(decoded)
        const safeBytes = redacted === decoded ? bytes.slice() : new TextEncoder().encode(redacted)
        const output =
          value instanceof ArrayBuffer
            ? safeBytes.buffer
            : value instanceof DataView
              ? new DataView(safeBytes.buffer)
              : safeBytes
        const copied = copyOwnData(value, output, new Set(['length', 'byteLength', 'byteOffset', 'buffer']))
        replacements.set(value, copied)
        return copied
      }

      const output: Record<string, unknown> = {}
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor)) throw new Error('content_safety_unsafe_accessor')
        const safeKey = typeof key === 'symbol' ? `Symbol(${redactText(key.description ?? '')})` : redactText(key)
        output[safeKey] = visit(descriptor.value)
      }
      replacements.set(value, output)
      return output
    }

    return { value: visit(input) as T, storedKeys: Array.from(storedKeys).sort() }
  }

  private redactString(input: string, storedKeys?: Set<string>): string {
    // Interpolated Drizzle messages no longer carry the Error object/type.
    const queryStart = input.indexOf('Failed query: ')
    if (queryStart >= 0 && storedKeys) {
      for (const entry of this.#entries) if (!entry.outputOnly && input.includes(entry.value)) storedKeys.add(entry.key)
    }
    let value = queryStart < 0 ? input : `${input.slice(0, queryStart)}${DATABASE_QUERY_FAILED}`
    const placeholders: string[] = []
    value = value.replace(/\[REDACTED_(?:SECRET_ENV:[A-Za-z0-9_.-]+|CREDENTIAL)\]/g, (placeholder) => {
      const index = placeholders.push(placeholder) - 1
      return `\uE000CONTENT_SAFETY_PLACEHOLDER_${index}\uE000`
    })

    type MatchSpan = { start: number; end: number; stored?: SecretEntry }
    const spans: MatchSpan[] = []
    for (const entry of this.#entries) {
      let start = value.indexOf(entry.value)
      if (start >= 0 && storedKeys && !entry.outputOnly) storedKeys.add(entry.key)
      while (start >= 0) {
        spans.push({ start, end: start + entry.value.length, stored: entry })
        start = value.indexOf(entry.value, start + 1)
      }
    }
    for (const pattern of CREDENTIAL_PATTERNS) {
      pattern.lastIndex = 0
      for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
        // A future global grammar must not be able to pin this hot path at one
        // index if it accidentally permits an empty match.
        if (match[0].length === 0) {
          pattern.lastIndex++
          continue
        }
        if (!isCredentialMatch(match[0])) continue
        spans.push({ start: match.index, end: match.index + match[0].length })
      }
    }
    spans.sort((left, right) => left.start - right.start || right.end - left.end)
    const merged: MatchSpan[] = []
    for (const span of spans) {
      const current = merged.at(-1)
      if (!current || span.start >= current.end) {
        merged.push({ ...span })
        continue
      }
      current.end = Math.max(current.end, span.end)
      if (!current.stored || (span.stored && span.stored.value.length > current.stored.value.length)) {
        current.stored = span.stored
      }
    }
    let output = ''
    let cursor = 0
    for (const span of merged) {
      output += value.slice(cursor, span.start)
      output += span.stored ? `[REDACTED_SECRET_ENV:${span.stored.key}]` : '[REDACTED_CREDENTIAL]'
      cursor = span.end
    }
    output += value.slice(cursor)
    return output.replace(/\uE000CONTENT_SAFETY_PLACEHOLDER_(\d+)\uE000/g, (_marker, index: string) => {
      return placeholders[Number(index)] ?? '[REDACTED_CREDENTIAL]'
    })
  }
}

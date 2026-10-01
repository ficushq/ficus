import { DATABASE_QUERY_FAILED, isDatabaseQueryError } from '../../db/errors'

export interface StoredKeyRedaction<T> {
  value: T
  storedKeys: readonly string[]
}

export interface ContentSafetyPort {
  /** Replace every stored secret value and known credential format with a marker. */
  redact<T>(input: T): T
  /** Redact and report the sanitized key names whose exact stored values matched. */
  redactWithStoredKeys<T>(input: T): StoredKeyRedaction<T>
}

type SecretEntry = { key: string; value: string }

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

  private constructor(entries: readonly SecretEntry[]) {
    this.#entries = []
    this.replaceSecretEntries(entries)
  }

  /** @internal Keeps existing execution stream redactors on the same matcher generation. */
  replaceSecretEntries(entries: readonly SecretEntry[]): void {
    this.#entries = entries
      .filter((entry) => entry.value.length > 0)
      .map((entry) => ({ key: safeKeyName(entry.key), value: entry.value }))
      .sort((left, right) => right.value.length - left.value.length)
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
      for (const entry of this.#entries) if (input.includes(entry.value)) storedKeys.add(entry.key)
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
      if (start >= 0 && storedKeys) storedKeys.add(entry.key)
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

/**
 * Env-prefix rename (Tau → Ficus): `TAU_*` → `FICUS_*`.
 *
 * Host env files are hard-renamed with backups by the upgrade toolkit (and by
 * `renameEnvPrefix` for local installs). `bridgeLegacyEnv` is the one-release
 * in-process fallback for env the toolkit never rewrites (docker-compose
 * self-hosters, a local install self-updated by the old updater, user shells).
 * It ends in Wave 3, when `stripLegacyEnv` replaces it.
 *
 * Nothing here ever logs or throws a value: messages and results carry names only.
 */

export const LEGACY_ENV_PREFIX = 'TAU_'
export const ENV_PREFIX = 'FICUS_'
export type EnvPrefix = 'TAU_' | 'FICUS_'

export interface LegacyEnvBridgeResult {
  moved: string[]
  shadowed: string[]
  conflicts: string[]
}

const MANAGED_SECRET_KEYS_SUFFIX = 'MANAGED_SECRET_KEYS'

/** v2.1 (Ruling 24, N-I2): suffixes whose conflicting values must never be resolved silently. */
export function isProtectedEnvSuffix(suffix: string): boolean {
  return /ENCRYPTION_KEY|PASSWORD/.test(suffix)
}

/** A conflicting value for an encryption key keeps the legacy value: the secret store was encrypted with it. */
function keepsLegacyValue(suffix: string): boolean {
  return /ENCRYPTION_KEY/.test(suffix)
}

function isManagedSecretKeys(suffix: string): boolean {
  return suffix === MANAGED_SECRET_KEYS_SUFFIX || suffix.endsWith(`_${MANAGED_SECRET_KEYS_SUFFIX}`)
}

function otherPrefix(prefix: EnvPrefix): EnvPrefix {
  return prefix === LEGACY_ENV_PREFIX ? ENV_PREFIX : LEGACY_ENV_PREFIX
}

export class EnvPrefixConflictError extends Error {
  readonly keys: string[]

  constructor(keys: string[]) {
    super(
      `${keys.join(', ')}: the ${LEGACY_ENV_PREFIX} and ${ENV_PREFIX} names hold different values; ` +
        'keep the right one, remove the wrong value, then re-run'
    )
    this.name = 'EnvPrefixConflictError'
    this.keys = keys
  }
}

/** Map comma-separated env names in a *_MANAGED_SECRET_KEYS value to the target prefix. */
export function mapManagedKeyList(value: string, to: EnvPrefix): string {
  const from = otherPrefix(to)
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => (item.startsWith(from) ? `${to}${item.slice(from.length)}` : item))
    .join(',')
}

/**
 * One release only. For each TAU_X: if FICUS_X is unset, set FICUS_X to its value (moved);
 * otherwise leave FICUS_X (shadowed). Always delete TAU_X. For keys ending in _MANAGED_SECRET_KEYS,
 * the moved value's comma-separated items are mapped TAU_→FICUS_. Never throws.
 * Protected conflict (FICUS_X set, different value, X protected): TAU_X is listed in `conflicts`; for
 * *ENCRYPTION_KEY* the TAU_ value is KEPT (FICUS_X is overwritten with it), because that is the key
 * the existing secret store was encrypted with. Identical values are a silent `shadowed`.
 *
 * Empty values never overwrite or erase a real one: an empty FICUS_X counts as unset, so a
 * non-empty TAU_X moves over it, and an empty TAU_X never replaces a FICUS_X value. Neither case
 * is a conflict.
 *
 * Run it on process.env exactly once, at boot, before anything reads the env. Never run it again
 * on process.env after loading a `.env` file into it: the file's TAU_X would then be compared with
 * the FICUS_X the first run moved from the invocation env, and a protected conflict would replace
 * the explicit value with the file's. Instead, load the file into a separate record, bridge that
 * record, and merge it into process.env without overriding keys that are already set.
 */
export function bridgeLegacyEnv(env: Record<string, string | undefined>): LegacyEnvBridgeResult {
  const result: LegacyEnvBridgeResult = { moved: [], shadowed: [], conflicts: [] }
  for (const key of Object.keys(env)) {
    try {
      const suffix = suffixOf(key, LEGACY_ENV_PREFIX)
      if (suffix === null) continue
      const legacyValue = env[key]
      const target = `${ENV_PREFIX}${suffix}`
      const current = env[target]
      if (legacyValue !== undefined) {
        if (current === undefined || (current === '' && legacyValue !== '')) {
          env[target] = isManagedSecretKeys(suffix) ? mapManagedKeyList(legacyValue, ENV_PREFIX) : legacyValue
          result.moved.push(key)
        } else {
          result.shadowed.push(key)
          if (legacyValue !== '' && current !== legacyValue && isProtectedEnvSuffix(suffix)) {
            result.conflicts.push(key)
            if (keepsLegacyValue(suffix)) env[target] = legacyValue
          }
        }
      }
      delete env[key]
    } catch {
      // Never throws: an unwritable env entry is left as it is.
    }
  }
  return result
}

export interface LegacyEnvBridgeLogLines {
  warn: string | null
  debug: string | null
  error: string | null
}

/**
 * The boot log lines for a bridge result, names only. Single-sourced because GATE C keys on the
 * warn text. Each line is null when there is nothing to report.
 */
export function formatLegacyEnvBridge(result: LegacyEnvBridgeResult): LegacyEnvBridgeLogLines {
  return {
    warn:
      result.moved.length > 0
        ? `legacy TAU_* environment moved to FICUS_*: ${result.moved.join(', ')} (rename them; TAU_* is ignored from the next release)`
        : null,
    debug:
      result.shadowed.length > 0
        ? `legacy TAU_* variables ignored (FICUS_ already set): ${result.shadowed.length}`
        : null,
    error:
      result.conflicts.length > 0
        ? `legacy TAU_* and FICUS_* disagree for: ${result.conflicts.join(', ')}; kept TAU_ for *ENCRYPTION_KEY*, FICUS_ otherwise — remove the wrong one`
        : null,
  }
}

/** Wave 3 replacement (Task 36): delete every TAU_X, return the names. Never throws. */
export function stripLegacyEnv(env: Record<string, string | undefined>): string[] {
  const removed: string[] = []
  for (const key of Object.keys(env)) {
    if (suffixOf(key, LEGACY_ENV_PREFIX) === null) continue
    try {
      delete env[key]
      removed.push(key)
    } catch {
      // Never throws.
    }
  }
  return removed
}

/** One `KEY=value` assignment in a dotenv file, possibly spanning several lines. */
interface EnvEntry {
  /** Index of the `KEY=` line. */
  start: number
  /** Index of the last line of a multi-line quoted value (`start` for a one-line value). */
  end: number
  /** Everything before the key: indentation and an optional `export `. */
  lead: string
  key: string
  /** The first line's text after `=`, without its line ending. */
  firstValue: string
  /** The first line's `\r` when the file uses CRLF, else ''. */
  eol: string
  /** The whole value (continuation lines joined with `\n`, `\r` removed), for comparing entries. */
  value: string
}

/**
 * `KEY=` with no space around `=`, optionally after indentation and `export `. A line with spaces
 * around `=` is left alone on purpose; the shell toolkit's twin (Task 11) matches the same shape.
 */
const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const QUOTES = new Set(['"', "'", '`'])

/** Index of the first `quote` in `text` that is not escaped by a backslash, or -1. */
function findClosingQuote(text: string, quote: string): number {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') index++
    else if (text[index] === quote) return index
  }
  return -1
}

function splitLineEnding(line: string): [body: string, eol: string] {
  return line.endsWith('\r') ? [line.slice(0, -1), '\r'] : [line, '']
}

/**
 * Parse the assignments of a dotenv file. A value that opens a quote and does not close it on the
 * same line continues until the closing quote, as dotenv reads it (for example a PEM block), so a
 * `TAU_X=` line inside it is value text, never a key.
 */
function parseEnvEntries(lines: string[]): EnvEntry[] {
  const entries: EnvEntry[] = []
  for (let index = 0; index < lines.length; index++) {
    const [body, eol] = splitLineEnding(lines[index])
    const match = ENV_LINE.exec(body)
    if (!match) continue
    const entry: EnvEntry = {
      start: index,
      end: index,
      lead: match[1],
      key: match[2],
      firstValue: match[3],
      eol,
      value: match[3],
    }
    const opened = match[3].trimStart()
    const quote = opened[0]
    if (quote !== undefined && QUOTES.has(quote) && findClosingQuote(opened.slice(1), quote) === -1) {
      while (entry.end + 1 < lines.length) {
        entry.end++
        const [continuation] = splitLineEnding(lines[entry.end])
        entry.value += `\n${continuation}`
        if (findClosingQuote(continuation, quote) !== -1) break
      }
    }
    entries.push(entry)
    index = entry.end
  }
  return entries
}

/** The value as a dotenv reader sees it, for comparing two entries: trimmed, surrounding quotes removed. */
function normalizedValue(raw: string): string {
  const value = raw.trim()
  const quote = value[0]
  if (quote !== undefined && QUOTES.has(quote)) {
    const close = findClosingQuote(value.slice(1), quote)
    return close === -1 ? value.slice(1) : value.slice(1, 1 + close)
  }
  return value
}

/** The part after `prefix`, or null when `key` does not start with it or is only the prefix. */
function suffixOf(key: string, prefix: EnvPrefix): string | null {
  return key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : null
}

/**
 * Pure hard rename of a dotenv file: every `KEY=` / `export KEY=` line whose key starts with `from`
 * becomes `to`. If a `to` line for the same suffix already exists, the `to` line wins and the `from`
 * line is dropped (listed in `conflicts`); identical values are dropped silently. v2.1: a protected
 * suffix (isProtectedEnvSuffix) with DIFFERENT values throws EnvPrefixConflictError before returning
 * anything (Ruling 24). *_MANAGED_SECRET_KEYS values are mapped. Comments, blank lines and
 * order are preserved. Idempotent.
 *
 * Also: an empty `to` value counts as unset (the `from` line is renamed in place and the empty `to`
 * line is dropped), and an empty `from` value is dropped silently. CRLF line endings are kept.
 * Lines inside a multi-line quoted value are never rewritten. Each key is listed once.
 */
export function renameEnvPrefix(
  content: string,
  from: EnvPrefix,
  to: EnvPrefix
): { content: string; renamed: string[]; conflicts: string[] } {
  const lines = content.split('\n')
  const entries = parseEnvEntries(lines)

  // Existing `to` values, by suffix. When a key repeats, dotenv keeps the last one.
  const targetValues = new Map<string, string>()
  // Suffixes with a non-empty `from` value.
  const sourceSet = new Set<string>()
  for (const entry of entries) {
    const toSuffix = suffixOf(entry.key, to)
    if (toSuffix !== null) targetValues.set(toSuffix, normalizedValue(entry.value))
    const fromSuffix = suffixOf(entry.key, from)
    if (fromSuffix !== null && normalizedValue(entry.value) !== '') sourceSet.add(fromSuffix)
  }
  /** The `to` value that wins over a `from` line, or null when `to` is unset or empty. */
  const winningTarget = (suffix: string): string | null => {
    const target = targetValues.get(suffix)
    return target === undefined || target === '' ? null : target
  }

  const protectedConflicts: string[] = []
  for (const entry of entries) {
    const suffix = suffixOf(entry.key, from)
    if (suffix === null || !isProtectedEnvSuffix(suffix)) continue
    const target = winningTarget(suffix)
    const value = normalizedValue(entry.value)
    if (target !== null && value !== '' && target !== value && !protectedConflicts.includes(entry.key)) {
      protectedConflicts.push(entry.key)
    }
  }
  if (protectedConflicts.length > 0) throw new EnvPrefixConflictError(protectedConflicts)

  const renamed: string[] = []
  const conflicts: string[] = []
  const replaced = new Map<number, string | null>()
  for (const entry of entries) {
    const toSuffix = suffixOf(entry.key, to)
    if (toSuffix !== null) {
      // An empty `to` value yields to a non-empty `from` value, which is renamed in its own place.
      if (winningTarget(toSuffix) === null && sourceSet.has(toSuffix)) replaced.set(entry.start, null)
      continue
    }
    const suffix = suffixOf(entry.key, from)
    if (suffix === null) continue
    const value = normalizedValue(entry.value)
    const target = winningTarget(suffix)
    const emptyTargetExists = targetValues.get(suffix) === ''
    if (target !== null || (emptyTargetExists && value === '')) {
      // The `to` line wins; this line is dropped. A differing non-empty value is reported.
      if (target !== null && value !== '' && target !== value && !conflicts.includes(entry.key)) {
        conflicts.push(entry.key)
      }
      replaced.set(entry.start, null)
      continue
    }
    const firstValue =
      entry.start === entry.end && isManagedSecretKeys(suffix)
        ? mapManagedKeyValue(entry.firstValue, to)
        : entry.firstValue
    replaced.set(entry.start, `${entry.lead}${to}${suffix}=${firstValue}${entry.eol}`)
    if (!renamed.includes(entry.key)) renamed.push(entry.key)
  }

  const out: string[] = []
  const entryAt = new Map(entries.map((entry) => [entry.start, entry]))
  for (let index = 0; index < lines.length; index++) {
    const entry = entryAt.get(index)
    if (!entry || !replaced.has(index)) {
      out.push(lines[index])
      continue
    }
    const replacement = replaced.get(index)
    if (replacement === null || replacement === undefined) {
      // Drop the whole entry, including the continuation lines of a multi-line value.
      index = entry.end
      continue
    }
    out.push(replacement)
  }

  return { content: out.join('\n'), renamed, conflicts }
}

/** Map a raw dotenv value, keeping its surrounding quotes. */
function mapManagedKeyValue(raw: string, to: EnvPrefix): string {
  const value = raw.trim()
  const quote = value[0]
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    return `${quote}${mapManagedKeyList(value.slice(1, -1), to)}${quote}`
  }
  return mapManagedKeyList(value, to)
}

function definedEntries(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}

/**
 * User-app env we hand to hosted apps: env plus TAU_ aliases for listed FICUS_ keys (one release).
 * Undefined values are skipped, in the input and in the output.
 */
export function withLegacyAppAliases(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): Record<string, string> {
  const out = definedEntries(env)
  for (const key of keys) {
    const suffix = suffixOf(key, ENV_PREFIX)
    const value = env[key]
    if (suffix === null || value === undefined) continue
    out[`${LEGACY_ENV_PREFIX}${suffix}`] = value
  }
  return out
}

/**
 * One-release dual-emit for env handed to processes that may still read TAU_* (Tasks 8/13, e.g.
 * sandbox children): a copy of env plus TAU_X for every FICUS_X that has no TAU_X already.
 * Undefined values are skipped. The input is not modified.
 */
export function withLegacyEnvAliases(env: Record<string, string | undefined>): Record<string, string> {
  const out = definedEntries(env)
  for (const [key, value] of Object.entries(out)) {
    const suffix = suffixOf(key, ENV_PREFIX)
    if (suffix === null) continue
    const alias = `${LEGACY_ENV_PREFIX}${suffix}`
    if (out[alias] === undefined) out[alias] = value
  }
  return out
}

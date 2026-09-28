import { bridgeLegacyEnv } from '@ficus/shared/legacy-env'

export interface EnvUpdate {
  key: string
  value: string
  /** True when the operator passed the flag: replaces an existing value. */
  explicit: boolean
}

const TRAILER = '# --- added by tau setup ---'
/** .env.example ships this placeholder; treat it as "unset". */
const PLACEHOLDERS: Record<string, string[]> = { APP_URL: ['https://your-domain.com'] }

const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * The key/value pairs of a .env file. One release (Ficus rename): a legacy
 * `TAU_X` line reads as `FICUS_X`, so an install whose .env predates the rename
 * is still read correctly — for example its `TAU_INSTANCE` label, where the
 * wrong answer acts on another instance. When both spellings are present the
 * boot bridge's rule applies: the `FICUS_X` line wins, except for
 * `*ENCRYPTION_KEY*`, where a differing `TAU_X` value is kept because it is the
 * key the existing secret store was encrypted with.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line.trim())
    if (m) out[m[1]] = unquote(m[2])
  }
  bridgeLegacyEnv(out)
  return out
}

function renderValue(value: string): string {
  return /[\s#]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

function isEffectivelyEmpty(key: string, value: string): boolean {
  return value === '' || (PLACEHOLDERS[key] ?? []).includes(value)
}

/**
 * Applies `updates` to the text of a .env file, preserving every unmanaged
 * line, comments, and order. A key that exists with a non-empty value is kept
 * unless the update is explicit. Missing keys are appended under one trailer.
 */
export function mergeEnvFile(text: string, updates: EnvUpdate[]): string {
  const lines = text.split('\n')
  // Drop the trailing empty element produced by a final newline so we can re-add it.
  const hadTrailingNewline = text.endsWith('\n')
  if (hadTrailingNewline) lines.pop()
  const pending = new Map(updates.map((u) => [u.key, u]))

  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i].trim())
    if (!m) continue
    const update = pending.get(m[1])
    if (!update) continue
    pending.delete(m[1])
    const current = unquote(m[2])
    if (!update.explicit && !isEffectivelyEmpty(m[1], current)) continue
    lines[i] = `${m[1]}=${renderValue(update.value)}`
  }

  if (pending.size > 0) {
    if (!lines.includes(TRAILER)) {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
      lines.push(TRAILER)
    }
    for (const update of pending.values()) lines.push(`${update.key}=${renderValue(update.value)}`)
  }

  return lines.join('\n') + '\n'
}

/** One line per changed key, secrets redacted — what dry-run prints. */
export function renderEnvDiff(before: string, after: string, secretKeys: string[]): string[] {
  const a = parseEnvFile(before)
  const b = parseEnvFile(after)
  const out: string[] = []
  for (const [key, value] of Object.entries(b)) {
    if (a[key] === value) continue
    out.push(`${key}=${secretKeys.includes(key) ? '<redacted>' : value}`)
  }
  return out
}

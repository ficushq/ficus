/** Version marker persisted with operations-analyst evidence. */
export const REDACTION_VERSION = 'ops-redaction-v1'

/** Text which has passed the mandatory operations-analyst redaction boundary. */
export type RedactedText = string & { readonly __redacted: unique symbol }

const REDACTED = '[REDACTED]'

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Remove credentials from untrusted diagnostic evidence. This deliberately has
 * no logging: callers must treat both arguments as sensitive.
 */
export function redactEvidence(raw: string, knownSecrets: readonly string[]): RedactedText {
  let text = raw

  // Exact configured values are first so a known value cannot be split by a
  // later, shape-based matcher. Sorting also makes overlapping values safe.
  const exactValues = [...new Set(knownSecrets.filter((secret) => secret.length >= 4))].sort(
    (a, b) => b.length - a.length
  )
  for (const secret of exactValues) {
    text = text.replace(new RegExp(escapeRegex(secret), 'g'), REDACTED)
  }

  // Multi-line private-key material must be removed before control characters
  // are normalized away.
  text = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, REDACTED)

  // Credentials embedded in a URL, including a password that would otherwise
  // look like an ordinary path segment.
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)

  // HTTP auth and cookies.
  text = text.replace(/\b(authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi, `$1${REDACTED}`)
  text = text.replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`)

  // Conventional secret key/value forms, URL query values, and shell flags.
  const secretName =
    '(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|token|password|passwd|secret|client[_-]?secret|cookie|session(?:[_-]?id)?)'
  text = text.replace(new RegExp(`\\b(${secretName}\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s;&,]+)`, 'gi'), `$1${REDACTED}`)
  text = text.replace(
    new RegExp(`(--${secretName.replace('?:', '?:')})(?:=|\\s+)(?:"[^"]*"|'[^']*'|[^\\s;&,]+)`, 'gi'),
    `$1=${REDACTED}`
  )

  // JWTs and common Ficus, GitHub, cloud, chat, and model-provider token
  // prefixes. Requiring a useful suffix avoids redacting ordinary prose.
  // Pre-rename `tau_` values stay redacted: they can sit in old evidence and
  // authenticate again if a tenant rolls back to the pre-rename release.
  text = text.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, REDACTED)
  text = text.replace(
    /\b(?:(?:ficus|tau)_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{12,}|sk-(?:[A-Za-z0-9-]*[A-Za-z0-9])[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|hf_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{12,})\b/g,
    REDACTED
  )

  // Keep evidence safe for single-line storage and bounded downstream prompts.
  text = text
    // eslint-disable-next-line no-control-regex -- control bytes are intentionally removed from evidence
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320)
  return text as RedactedText
}

/** Redact generated templates too, preserving one evidence safety boundary. */
export function generatedEvidence(text: string): RedactedText {
  return redactEvidence(text, [])
}

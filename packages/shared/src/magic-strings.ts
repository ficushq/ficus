// --- Token types ---

export type MagicStringToken =
  { type: 'rewind'; step: string; message: string } | { type: 'step_complete'; message: string | null }

export interface RewindDirective {
  step: string
  message: string
}

// --- Magic string definitions ---
// Each definition describes an opener pattern, an optional closer string, and
// how to produce a token. While inside a block, no other magic strings are
// detected. Self-closing defs (closer = null) produce a token from the opener
// match alone.

interface MagicStringDef {
  tokenType: MagicStringToken['type']
  opener: RegExp
  closer: string | null
  /** If false, only the last occurrence in a message is used. */
  allowMultiple: boolean
  toToken: (match: RegExpExecArray, inner: string | null) => MagicStringToken
}

const MAGIC_STRING_DEFS: MagicStringDef[] = [
  {
    tokenType: 'rewind',
    opener: /\[REWIND:(\w[\w-]*)\]/,
    closer: '[/REWIND]',
    allowMultiple: false,
    toToken: (m, inner) => ({ type: 'rewind', step: m[1].trim(), message: inner!.trim() }),
  },
  {
    tokenType: 'step_complete',
    opener: /\[STEP_COMPLETE(?::([^\]]*))?\]/,
    closer: null,
    allowMultiple: false,
    toToken: (m, _inner) => ({ type: 'step_complete', message: m[1]?.trim() || null }),
  },
]

/** Token types where only the last occurrence in a message is used. */
export const UNIQUE_MAGIC_TYPES: ReadonlySet<MagicStringToken['type']> = new Set(
  MAGIC_STRING_DEFS.filter((d) => !d.allowMultiple).map((d) => d.tokenType)
)

// --- Single-pass parser ---

/**
 * Parse all magic strings from content in a single left-to-right pass.
 * Block-level defs (closer != null) consume everything until their closer —
 * any magic strings inside are treated as plain text.
 * Self-closing defs (closer == null) produce a token from the opener match alone.
 */
export function parseMagicStrings(content: string): MagicStringToken[] {
  const tokens: MagicStringToken[] = []
  let pos = 0

  while (pos < content.length) {
    const remaining = content.slice(pos)

    // Find the earliest opener among all magic string types
    let best: { def: MagicStringDef; match: RegExpExecArray } | null = null

    for (const def of MAGIC_STRING_DEFS) {
      const m = def.opener.exec(remaining)
      if (m && (!best || m.index < best.match.index)) {
        best = { def, match: m }
      }
    }

    if (!best) break

    const absMatchEnd = pos + best.match.index + best.match[0].length

    if (best.def.closer === null) {
      // Self-closing: token produced from opener match alone
      tokens.push(best.def.toToken(best.match, null))
      pos = absMatchEnd
    } else {
      // Block: consume everything until closer
      const closeIdx = content.indexOf(best.def.closer, absMatchEnd)
      if (closeIdx !== -1) {
        const inner = content.slice(absMatchEnd, closeIdx)
        tokens.push(best.def.toToken(best.match, inner))
        pos = closeIdx + best.def.closer.length
      } else {
        // Unclosed block — skip past opener
        pos = absMatchEnd
      }
    }
  }

  return tokens
}

// --- Convenience functions (delegate to parser) ---

export function detectStepComplete(content: string): boolean {
  return parseMagicStrings(content).some((t) => t.type === 'step_complete')
}

export function extractStepCompleteMessage(content: string): string | null {
  const tokens = parseMagicStrings(content).filter((t) => t.type === 'step_complete')
  const token = tokens[tokens.length - 1]
  return token?.type === 'step_complete' ? token.message : null
}

export function detectRewind(content: string): RewindDirective | null {
  const tokens = parseMagicStrings(content).filter((t) => t.type === 'rewind')
  const token = tokens[tokens.length - 1]
  if (!token || token.type !== 'rewind') return null
  return { step: token.step, message: token.message }
}

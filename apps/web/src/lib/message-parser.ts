import { parseMagicStrings, UNIQUE_MAGIC_TYPES, type MagicStringToken } from '@ficus/shared'

export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'step_complete'; message?: string }
  | { type: 'rewind'; step: string; message: string }

/**
 * Parse message content into renderable segments.
 * Uses the shared single-pass magic string parser, then interleaves text
 * segments for content between magic strings.
 */
export function parseMessageContent(content: string): MessageSegment[] {
  const tokens = parseMagicStrings(content)
  if (tokens.length === 0) {
    const trimmed = content.trim()
    return trimmed ? [{ type: 'text', content: trimmed }] : []
  }

  // For unique types (only last occurrence used), find which index is the last
  const lastByType = new Map<MagicStringToken['type'], number>()
  tokens.forEach((t, i) => {
    if (UNIQUE_MAGIC_TYPES.has(t.type)) lastByType.set(t.type, i)
  })

  // First pass: find all token locations (advancing a scan cursor)
  const tokenLocs: ({ start: number; end: number } | null)[] = []
  let scanPos = 0
  for (const token of tokens) {
    const loc = findTokenLocation(content, scanPos, token)
    tokenLocs.push(loc)
    if (loc) scanPos = loc.end
  }

  // Second pass: build segments, only splitting text around active tokens.
  // Inactive tokens (earlier occurrences of unique types) are left in the
  // text flow so their raw syntax remains visible.
  const segments: MessageSegment[] = []
  let pos = 0

  for (let i = 0; i < tokens.length; i++) {
    const loc = tokenLocs[i]
    if (!loc) continue

    const isActive = !UNIQUE_MAGIC_TYPES.has(tokens[i].type) || lastByType.get(tokens[i].type) === i
    if (!isActive) continue // raw syntax stays as part of surrounding text

    // Text before this active token (may include raw syntax of inactive tokens)
    if (loc.start > pos) {
      const text = content.slice(pos, loc.start).trim()
      if (text) segments.push({ type: 'text', content: text })
    }

    const segment = tokenToSegment(tokens[i])
    if (segment) segments.push(segment)
    pos = loc.end
  }

  // Remaining text after last token
  if (pos < content.length) {
    const text = content.slice(pos).trim()
    if (text) segments.push({ type: 'text', content: text })
  }

  return segments
}

function tokenToSegment(token: MagicStringToken): MessageSegment | null {
  switch (token.type) {
    case 'rewind':
      return { type: 'rewind', step: token.step, message: token.message }
    case 'step_complete':
      return { type: 'step_complete', message: token.message ?? undefined }
    default:
      // artifact and artifact_edit are handled via tools now — skip
      return null
  }
}

// --- Token location finding ---
// These patterns mirror MAGIC_STRING_DEFS in the shared package to locate
// each token's position in the original content string.

const TOKEN_LOCATORS: Partial<Record<MagicStringToken['type'], { opener: RegExp; closer: string | null }>> = {
  rewind: { opener: /\[REWIND:\w[\w-]*\]/, closer: '[/REWIND]' },
  step_complete: { opener: /\[STEP_COMPLETE(?::[^\]]*)?\]/, closer: null },
}

function findTokenLocation(
  content: string,
  startFrom: number,
  token: MagicStringToken
): { start: number; end: number } | null {
  const locator = TOKEN_LOCATORS[token.type]
  if (!locator) return null
  const { opener, closer } = locator
  const remaining = content.slice(startFrom)
  const m = opener.exec(remaining)
  if (!m) return null

  const absStart = startFrom + m.index
  const afterOpener = absStart + m[0].length

  if (closer === null) {
    return { start: absStart, end: afterOpener }
  }

  const closeIdx = content.indexOf(closer, afterOpener)
  if (closeIdx === -1) return null
  return { start: absStart, end: closeIdx + closer.length }
}

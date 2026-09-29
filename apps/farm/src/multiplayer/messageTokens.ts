import {
  ENTITY_REFERENCE_SCHEME,
  entityReferenceHref,
  LEGACY_ENTITY_REFERENCE_SCHEME,
  parseEntityReference,
  type FarmPerson,
} from '@ficus/shared'
import { findMentions } from './mentions'

/*
 * A farm chat message, split into what it's made of: plain text, @mentions,
 * references to things on the farm (drawn as chips that fly the camera there)
 * and other links. References are the chat's own `ficus:ws:<id>` /
 * `ficus:agent:<id>` (the old `tau:` ones too), or a pasted web-app link to a // ficus-36c
 * squad, a work stream or an agent.
 */

export type FarmRef = { kind: 'ws'; id: string } | { kind: 'agent'; id: string } | { kind: 'squad'; id: string }

export type MessageToken =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; userId: string }
  /** `href` is set when it came from a web-app link (somewhere to go if it isn't on this farm). */
  | { kind: 'ref'; text: string; ref: FarmRef; href?: string }
  | { kind: 'link'; text: string; href: string }

// The schemes the shared entity references accept (the current one, and the one stored before the rename).
const REFERENCE = new RegExp(
  `\\b(?:${ENTITY_REFERENCE_SCHEME}|${LEGACY_ENTITY_REFERENCE_SCHEME}):(?:ws|agent):[0-9a-f-]{1,36}\\b`,
  'gi'
)
// Trailing punctuation isn't part of a pasted link.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'"]/gi
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What a web-app link points at on the farm, if anything: /squads/<id>[/work?ws=<id>] or /chat/<agentId>. */
export function refFromUrl(href: string): FarmRef | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const squadAt = parts.indexOf('squads')
  const squadId = parts[squadAt + 1]
  if (squadAt !== -1 && squadId && UUID.test(squadId)) {
    const ws = url.searchParams.get('ws')
    return ws ? { kind: 'ws', id: ws.toLowerCase() } : { kind: 'squad', id: squadId.toLowerCase() }
  }
  const chatAt = parts.indexOf('chat')
  const agentId = parts[chatAt + 1]
  if (chatAt !== -1 && agentId && UUID.test(agentId)) return { kind: 'agent', id: agentId.toLowerCase() }
  return null
}

/** The chat's own reference to something on the farm, for sharing it in a message. */
export function farmRefText(ref: Exclude<FarmRef, { kind: 'squad' }>): string {
  return entityReferenceHref(ref.kind, ref.id)
}

type Span = { start: number; end: number; token: Exclude<MessageToken, { kind: 'text' }> }

/** Splits a message into text, mentions, farm references and links, in order. */
export function tokenize(body: string, people: readonly FarmPerson[]): MessageToken[] {
  const spans: Span[] = []
  for (const match of body.matchAll(REFERENCE)) {
    const ref = parseEntityReference(match[0])
    if (ref)
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        token: { kind: 'ref', text: match[0], ref },
      })
  }
  for (const match of body.matchAll(URL_PATTERN)) {
    const start = match.index
    const end = start + match[0].length
    if (spans.some((s) => start < s.end && end > s.start)) continue
    const ref = refFromUrl(match[0])
    spans.push({
      start,
      end,
      token: ref
        ? { kind: 'ref', text: match[0], ref, href: match[0] }
        : { kind: 'link', text: match[0], href: match[0] },
    })
  }
  for (const mention of findMentions(body, people)) {
    if (spans.some((s) => mention.start < s.end && mention.end > s.start)) continue
    spans.push({
      start: mention.start,
      end: mention.end,
      token: { kind: 'mention', text: body.slice(mention.start, mention.end), userId: mention.userId },
    })
  }
  spans.sort((a, b) => a.start - b.start)

  const tokens: MessageToken[] = []
  let at = 0
  for (const span of spans) {
    if (span.start > at) tokens.push({ kind: 'text', text: body.slice(at, span.start) })
    tokens.push(span.token)
    at = span.end
  }
  if (at < body.length) tokens.push({ kind: 'text', text: body.slice(at) })
  return tokens
}

/** A message as a line of plain text for a speech bubble on the map: references and links become 🔗. */
export function bubbleText(body: string): string {
  return body.replace(REFERENCE, '🔗').replace(URL_PATTERN, '🔗')
}

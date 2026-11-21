import {
  ENTITY_REFERENCE_SCHEME,
  agentIdFromAssistantAgentPath,
  entityReferenceHref,
  parseEntityReference,
  type FarmPerson,
} from '@ficus/shared'
import { findMentions } from './mentions'

/*
 * A farm chat message, split into what it's made of: plain text, @mentions,
 * references to things on the farm (drawn as chips that fly the camera there)
 * and other links. References are the chat's own `ficus:ws:<id>` /
 * `ficus:agent:<id>`, or a pasted web-app link to a squad, a work stream or
 * an agent.
 */

export type FarmRef = { kind: 'ws'; id: string } | { kind: 'agent'; id: string } | { kind: 'squad'; id: string }

export type MessageToken =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; userId: string }
  /** `href` is set when it came from a web-app link (somewhere to go if it isn't on this farm). */
  | { kind: 'ref'; text: string; ref: FarmRef; href?: string }
  | { kind: 'link'; text: string; href: string }

// The scheme the shared entity references accept.
const REFERENCE = new RegExp(`\\b${ENTITY_REFERENCE_SCHEME}:(?:ws|agent):[0-9a-f-]{1,36}\\b`, 'gi')
// Trailing punctuation isn't part of a pasted link.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'"]/gi
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What a web-app link points at on the farm, if anything: an agent's chat (see {@link agentIdFromUrl}),
 * /squads/<id>/work?ws=<id> or /squads/<id>. The app's base path may precede the route.
 */
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
  const squadPage = squadAt !== -1 && squadId !== undefined
  const agentId = agentIdFromUrl(url, parts, squadPage ? squadAt : -1)
  if (agentId) return { kind: 'agent', id: agentId.toLowerCase() }
  if (squadPage && UUID.test(squadId)) {
    const ws = url.searchParams.get('ws')
    return ws ? { kind: 'ws', id: ws.toLowerCase() } : { kind: 'squad', id: squadId.toLowerCase() }
  }
  return null
}

/**
 * The agent a web-app link opens a chat with, in every form the app has written:
 * - its squad's Chats tab, /squads/<id or slug>/agents?agent=<id> (or the squad page with ?agent=);
 * - /assistant/agents/<id>, the Assistant's view of an agent, where squadless agents open;
 * - the Assistant's own URL state ending in that agent's chat (?commandStack=[…, ["chat", id, squad,
 *   agent, …]]), which squadless links carried before that route, on any page but a squad's;
 * - /chat/<id>, the retired chat page, in older messages.
 */
function agentIdFromUrl(url: URL, parts: string[], squadAt: number): string | null {
  const squadChats =
    squadAt !== -1 &&
    (parts.length === squadAt + 2 || (parts.length === squadAt + 3 && parts[squadAt + 2] === 'agents'))
  const candidates = [
    squadChats ? url.searchParams.get('agent') : null,
    agentIdFromAssistantAgentPath(url.pathname),
    squadAt === -1 ? agentIdFromCommandStack(url.searchParams.get('commandStack')) : null,
    parts.at(-2) === 'chat' ? (parts.at(-1) ?? null) : null,
  ]
  return candidates.find((id) => id !== null && UUID.test(id)) ?? null
}

function agentIdFromCommandStack(raw: string | null): string | null {
  if (!raw) return null
  try {
    const rows: unknown = JSON.parse(raw)
    const top = Array.isArray(rows) ? rows.at(-1) : null
    return Array.isArray(top) && top[0] === 'chat' && typeof top[3] === 'string' ? top[3] : null
  } catch {
    return null
  }
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

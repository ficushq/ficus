import {
  MESSAGE_SEARCH_MAX_LIMIT,
  MESSAGE_SEARCH_SCOPES,
  type MessageSearchResponse,
  type MessageSearchResult,
  type MessageSearchScope,
} from '@ficus/shared'
import type { Command } from 'commander'
import { apiGet } from '../client'
import { isJsonMode, output, outputError } from '../output'

/** Largest --context the CLI accepts. */
export const MAX_SEARCH_CONTEXT = 20
/**
 * Extra messages fetched around a hit for --context. New messages that arrive between the search and
 * the context request shift the hit's position; this many can arrive before the context misses it.
 */
const CONTEXT_SLACK = 10
/** Characters of a context message shown on its one line. */
const CONTEXT_PREVIEW = 200

/** A message as the list endpoint returns it; only the fields the context view reads. */
export interface ContextMessage {
  id: string
  role: 'human' | 'assistant'
  content: string
  createdAt: string
  metadata?: { content?: Array<{ type?: string; toolCall?: { toolName?: string } }> } & Record<string, unknown>
}

export interface SearchContext {
  /** Up to N messages before the hit, oldest first. */
  before: ContextMessage[]
  /** Up to N messages after the hit, oldest first. */
  after: ContextMessage[]
}

export type SearchHitWithContext = MessageSearchResult & { context?: SearchContext | null }

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Who wrote the hit and where it matched: `human`, `human (Noah)`, `assistant`, `assistant bash result`. */
export function hitLabel(hit: MessageSearchResult): string {
  const who = hit.sender ? `${hit.role} (${hit.sender.name})` : hit.source ? `${hit.role} (${hit.source})` : hit.role
  const match = hit.match
  if (!match || match.field === 'text') return who
  const part = match.field === 'tool_name' ? 'call' : match.field === 'tool_args' ? 'args' : 'result'
  return `${who} ${match.toolName || 'tool'} ${part}`
}

/** One model-friendly line per hit: id, timestamp, who and where, then the snippet. */
export function formatHitLine(hit: MessageSearchResult): string {
  const { text, truncatedStart, truncatedEnd } = hit.snippet
  const snippet = `${truncatedStart ? '…' : ''}${text}${truncatedEnd ? '…' : ''}`
  return `${hit.id} ${hit.createdAt} ${hitLabel(hit)}: ${snippet}`
}

/** One line for a neighbouring message: its text, then the tools it called. */
export function formatContextLine(message: ContextMessage): string {
  const tools = (message.metadata?.content ?? [])
    .filter((block) => block?.type === 'tool_use')
    .map((block) => block.toolCall?.toolName || 'tool')
  const text = oneLine(message.content ?? '', CONTEXT_PREVIEW)
  const toolNote = tools.length ? `[tools: ${tools.join(', ')}]` : ''
  return `${message.id} ${message.createdAt} ${message.role}: ${[text, toolNote].filter(Boolean).join(' ')}`
}

/**
 * The N messages before and after a hit, in conversation order. The hit's `newerCount` is its
 * position counted from the newest message, which is the list endpoint's offset (newest first).
 * Returns null when the hit is no longer where the search said, or is too close to the start of a
 * page that has older messages beyond it, because more messages arrived since than the slack covers.
 */
export async function fetchHitContext(
  agentId: string,
  hit: Pick<MessageSearchResult, 'id' | 'newerCount'>,
  n: number
): Promise<SearchContext | null> {
  const offset = Math.max(0, hit.newerCount - n)
  const limit = hit.newerCount - offset + 1 + n + CONTEXT_SLACK
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  const page = await apiGet<{ messages: ContextMessage[]; pagination?: { hasMore?: boolean } }>(
    `/api/agents/${encodeURIComponent(agentId)}/messages?${params}`
  )
  // The list endpoint returns the page oldest first.
  const messages = page.messages ?? []
  const index = messages.findIndex((message) => message.id === hit.id)
  if (index < 0) return null
  // Older messages exist beyond this page, so fewer than n before the hit means the window was cut short.
  if (index < n && page.pagination?.hasMore) return null
  return { before: messages.slice(Math.max(0, index - n), index), after: messages.slice(index + 1, index + 1 + n) }
}

function parseIntOption(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  return parsed
}

export function parseSearchScope(value: string | undefined, fallback: MessageSearchScope): MessageSearchScope {
  if (value === undefined) return fallback
  if (!(MESSAGE_SEARCH_SCOPES as readonly string[]).includes(value))
    throw new Error(`--in must be one of ${MESSAGE_SEARCH_SCOPES.join(', ')}`)
  return value as MessageSearchScope
}

export function parseRole(value: string | undefined): 'human' | 'assistant' | undefined {
  if (value === undefined) return undefined
  if (value !== 'human' && value !== 'assistant') throw new Error('--role must be human or assistant')
  return value
}

export function registerAgentSearchCommand(agent: Command) {
  // ficus agent search <id> <query...> [--in all|text|tools] [--role] [--context N] [--limit N] [--cursor C]
  agent
    .command('search <id> <query...>')
    .description(
      [
        "Search an agent's whole conversation history, newest first. The query is a case-insensitive, literal",
        'substring (%, _ and \\ match themselves; several words are joined with spaces and match as one phrase).',
        'By default it searches message text and tool calls (tool names, arguments and results). Each hit is one',
        'line: message id, timestamp, who wrote it and where it matched (for a tool hit, the tool and whether the',
        'match is in its args, its result or its name, shown as call), then a snippet. With --json the full results, including',
        'newerCount (how many messages are newer) and the snippet highlight ranges, are printed. Put -- before a',
        'query that starts with a dash: ficus agent search <id> -- --force.',
      ].join(' ')
    )
    .option('--in <scope>', 'Where to search: all (message text and tool calls), text, or tools', 'all')
    .option('--role <role>', 'Only messages from human or assistant')
    .option('--before <timestamp>', 'Only messages before this ISO timestamp')
    .option('--after <timestamp>', 'Only messages after this ISO timestamp')
    .option(
      '--context <n>',
      `Also show the n messages before and after each hit, in conversation order (0-${MAX_SEARCH_CONTEXT})`
    )
    .option('--limit <n>', `Hits per page (1-${MESSAGE_SEARCH_MAX_LIMIT}, default 20)`)
    .option('--cursor <cursor>', 'Next page: the cursor printed after the previous page')
    .action(async (id: string, queryWords: string[], options) => {
      try {
        const query = queryWords.join(' ')
        const scope = parseSearchScope(options.in, 'all')
        const role = parseRole(options.role)
        const limit = parseIntOption(options.limit, '--limit', 1, MESSAGE_SEARCH_MAX_LIMIT)
        const context = parseIntOption(options.context, '--context', 0, MAX_SEARCH_CONTEXT) ?? 0

        const params = new URLSearchParams({ q: query, in: scope })
        if (role) params.set('role', role)
        if (options.before) params.set('before', options.before)
        if (options.after) params.set('after', options.after)
        if (limit) params.set('limit', String(limit))
        if (options.cursor) params.set('cursor', options.cursor)
        const response = await apiGet<MessageSearchResponse>(
          `/api/agents/${encodeURIComponent(id)}/messages/search?${params}`
        )

        const hits: SearchHitWithContext[] = response.results
        if (context > 0) {
          for (const hit of hits) hit.context = await fetchHitContext(id, hit, context)
        }

        if (isJsonMode()) {
          output({ results: hits, nextCursor: response.nextCursor })
          return
        }
        if (hits.length === 0) {
          console.log(options.cursor ? 'No more matches' : 'No matches')
          return
        }
        hits.forEach((hit, i) => {
          if (context === 0) {
            console.log(formatHitLine(hit))
            return
          }
          if (i > 0) console.log('')
          console.log(`--- hit ${i + 1} of ${hits.length} ---`)
          if (!hit.context) {
            console.log(`> ${formatHitLine(hit)}`)
            console.log('  (context unavailable: too many messages arrived since the search; search again)')
            return
          }
          for (const message of hit.context.before) console.log(`  ${formatContextLine(message)}`)
          console.log(`> ${formatHitLine(hit)}`)
          for (const message of hit.context.after) console.log(`  ${formatContextLine(message)}`)
        })
        if (response.nextCursor) console.log(`\nMore matches: add --cursor ${response.nextCursor}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}

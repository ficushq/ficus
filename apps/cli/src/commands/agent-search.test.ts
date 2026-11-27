import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Command } from 'commander'
import type { MessageSearchResult } from '@ficus/shared'
import { apiGet } from '../client'
import { isJsonMode, output, outputError } from '../output'
import { registerAgentCommands } from './agent'
import { formatContextLine, formatHitLine } from './agent-search'

const get = apiGet as ReturnType<typeof mock>

function hit(id: string, newerCount: number, extra: Partial<MessageSearchResult> = {}): MessageSearchResult {
  return {
    id,
    createdAt: '2026-11-27T07:00:00.000Z',
    role: 'assistant',
    sender: null,
    source: null,
    isSystem: false,
    match: { field: 'text' },
    snippet: { text: 'the deploy pipeline', truncatedStart: false, truncatedEnd: false, highlights: [[4, 10]] },
    newerCount,
    ...extra,
  }
}

/** A conversation of ten messages m0 (oldest) to m9 (newest), served like the list endpoint does. */
const conversation = Array.from({ length: 10 }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 ? 'assistant' : 'human',
  content: `message ${i}`,
  createdAt: `2026-11-27T07:0${i}:00.000Z`,
  metadata: i === 3 ? { content: [{ type: 'tool_use', toolCall: { toolName: 'bash' } }] } : {},
}))

function listPage(path: string) {
  const params = new URL(path, 'http://x').searchParams
  const offset = Number(params.get('offset') ?? 0)
  const limit = Number(params.get('limit') ?? 50)
  const newestFirst = [...conversation].reverse().slice(offset, offset + limit)
  return { messages: newestFirst.reverse(), pagination: { hasMore: offset + limit < conversation.length } }
}

async function run(args: string[]): Promise<string[]> {
  const lines: string[] = []
  const log = spyOn(console, 'log').mockImplementation((line?: unknown) => void lines.push(String(line ?? '')))
  try {
    const program = new Command().exitOverride()
    registerAgentCommands(program)
    await program.parseAsync(['agent', ...args], { from: 'user' })
  } finally {
    log.mockRestore()
  }
  return lines
}

beforeEach(() => {
  get.mockReset()
  ;(output as ReturnType<typeof mock>).mockClear()
  ;(outputError as ReturnType<typeof mock>).mockClear()
})

afterEach(() => {
  get.mockReset().mockResolvedValue({})
})

describe('formatHitLine', () => {
  it('puts the id, timestamp, author and snippet on one line', () => {
    expect(formatHitLine(hit('m1', 0, { role: 'human', sender: { userId: 'u1', name: 'Noah' } }))).toBe(
      'm1 2026-11-27T07:00:00.000Z human (Noah): the deploy pipeline'
    )
    expect(formatHitLine(hit('m1', 0, { role: 'human', source: 'inbox' }))).toBe(
      'm1 2026-11-27T07:00:00.000Z human (inbox): the deploy pipeline'
    )
  })

  it('names the tool and whether the match is in its arguments or result, and marks cut text', () => {
    const result = hit('m2', 0, {
      match: { field: 'tool_result', toolName: 'bash', toolCallId: 'c1' },
      snippet: { text: 'exit code 1', truncatedStart: true, truncatedEnd: true, highlights: [] },
    })
    expect(formatHitLine(result)).toBe('m2 2026-11-27T07:00:00.000Z assistant bash result: …exit code 1…')
    const args = hit('m2', 0, { match: { field: 'tool_args', toolName: 'read', toolCallId: 'c2' } })
    expect(formatHitLine(args)).toContain(' assistant read args: ')
    const name = hit('m2', 0, { match: { field: 'tool_name', toolName: 'memory_search', toolCallId: 'c3' } })
    expect(formatHitLine(name)).toContain(' assistant memory_search call: ')
  })

  it('shortens a context message to one line and lists the tools it called', () => {
    expect(
      formatContextLine({
        id: 'm3',
        role: 'assistant',
        content: 'first\nsecond',
        createdAt: 't',
        metadata: { content: [{ type: 'tool_use', toolCall: { toolName: 'bash' } }, { type: 'text' }] },
      })
    ).toBe('m3 t assistant: first second [tools: bash]')
    expect(formatContextLine({ id: 'm4', role: 'human', content: 'x'.repeat(300), createdAt: 't' })).toBe(
      `m4 t human: ${'x'.repeat(200)}…`
    )
  })
})

describe('ficus agent search', () => {
  it('searches message text and tool calls by default and prints one line per hit', async () => {
    get.mockResolvedValue({ results: [hit('m9', 0), hit('m5', 4)], nextCursor: 'next-1' })
    const lines = await run(['search', 'agent-1', 'deploy', 'pipeline'])
    expect(get).toHaveBeenCalledWith('/api/agents/agent-1/messages/search?q=deploy+pipeline&in=all')
    expect(lines).toEqual([
      'm9 2026-11-27T07:00:00.000Z assistant: the deploy pipeline',
      'm5 2026-11-27T07:00:00.000Z assistant: the deploy pipeline',
      '\nMore matches: add --cursor next-1',
    ])
  })

  it('passes scope, role, time range, limit and cursor through', async () => {
    get.mockResolvedValue({ results: [], nextCursor: null })
    const lines = await run([
      'search',
      'agent-1',
      '50%_off',
      '--in',
      'tools',
      '--role',
      'human',
      '--before',
      '2026-11-27T00:00:00Z',
      '--after',
      '2026-11-01T00:00:00Z',
      '--limit',
      '5',
      '--cursor',
      'abc',
    ])
    const params = new URL(get.mock.calls[0][0] as string, 'http://x').searchParams
    expect(Object.fromEntries(params)).toEqual({
      q: '50%_off',
      in: 'tools',
      role: 'human',
      before: '2026-11-27T00:00:00Z',
      after: '2026-11-01T00:00:00Z',
      limit: '5',
      cursor: 'abc',
    })
    expect(lines).toEqual(['No more matches'])
  })

  it('rejects an unknown scope, role, limit or context before calling the API', async () => {
    for (const args of [
      ['--in', 'thinking'],
      ['--role', 'system'],
      ['--limit', '51'],
      ['--context', '21'],
      ['--context', 'two'],
    ]) {
      ;(outputError as ReturnType<typeof mock>).mockClear()
      await run(['search', 'agent-1', 'x', ...args])
      expect(outputError).toHaveBeenCalledTimes(1)
    }
    expect(get).not.toHaveBeenCalled()
  })

  it('shows the n messages before and after each hit in conversation order', async () => {
    get.mockImplementation(async (path: string) =>
      path.includes('/messages/search') ? { results: [hit('m5', 4), hit('m0', 9)], nextCursor: null } : listPage(path)
    )
    const lines = await run(['search', 'agent-1', 'deploy', '--context', '2'])
    expect(get).toHaveBeenCalledWith('/api/agents/agent-1/messages?offset=2&limit=15')
    expect(lines).toEqual([
      '--- hit 1 of 2 ---',
      '  m3 2026-11-27T07:03:00.000Z assistant: message 3 [tools: bash]',
      '  m4 2026-11-27T07:04:00.000Z human: message 4',
      '> m5 2026-11-27T07:00:00.000Z assistant: the deploy pipeline',
      '  m6 2026-11-27T07:06:00.000Z human: message 6',
      '  m7 2026-11-27T07:07:00.000Z assistant: message 7',
      '',
      '--- hit 2 of 2 ---',
      '> m0 2026-11-27T07:00:00.000Z assistant: the deploy pipeline',
      '  m1 2026-11-27T07:01:00.000Z assistant: message 1',
      '  m2 2026-11-27T07:02:00.000Z human: message 2',
    ])
  })

  it('still finds the hit when new messages arrived after the search', async () => {
    // The search saw m5 with 4 newer messages; 3 more arrived before the context request.
    const grown = [...conversation, ...['n1', 'n2', 'n3'].map((id) => ({ ...conversation[9], id }))]
    get.mockImplementation(async (path: string) => {
      if (path.includes('/messages/search')) return { results: [hit('m5', 4)], nextCursor: null }
      const params = new URL(path, 'http://x').searchParams
      const offset = Number(params.get('offset'))
      const limit = Number(params.get('limit'))
      const newestFirst = [...grown].reverse().slice(offset, offset + limit)
      return { messages: newestFirst.reverse(), pagination: { hasMore: offset + limit < grown.length } }
    })
    const lines = await run(['search', 'agent-1', 'deploy', '--context', '1'])
    expect(lines).toEqual([
      '--- hit 1 of 1 ---',
      '  m4 2026-11-27T07:04:00.000Z human: message 4',
      '> m5 2026-11-27T07:00:00.000Z assistant: the deploy pipeline',
      '  m6 2026-11-27T07:06:00.000Z human: message 6',
    ])
  })

  it('gives no context rather than a cut-short window when more messages arrived than it allows for', async () => {
    // The search saw m5 with 4 newer messages; 12 more arrived, so m5 is the first message of the page.
    const grown = [...conversation, ...Array.from({ length: 12 }, (_, i) => ({ ...conversation[9], id: `n${i}` }))]
    get.mockImplementation(async (path: string) => {
      if (path.includes('/messages/search')) return { results: [hit('m5', 4)], nextCursor: null }
      const params = new URL(path, 'http://x').searchParams
      const offset = Number(params.get('offset'))
      const limit = Number(params.get('limit'))
      const newestFirst = [...grown].reverse().slice(offset, offset + limit)
      return { messages: newestFirst.reverse(), pagination: { hasMore: offset + limit < grown.length } }
    })
    const lines = await run(['search', 'agent-1', 'deploy', '--context', '2'])
    expect(lines[1]).toBe('> m5 2026-11-27T07:00:00.000Z assistant: the deploy pipeline')
    expect(lines[2]).toContain('context unavailable')
  })

  it('takes a query that starts with a dash after --', async () => {
    get.mockResolvedValue({ results: [], nextCursor: null })
    await run(['search', 'agent-1', '--in', 'tools', '--', '--force', 'push'])
    expect(get).toHaveBeenCalledWith('/api/agents/agent-1/messages/search?q=--force+push&in=tools')
  })

  it('says so when the hit is no longer in reach of its position', async () => {
    get.mockImplementation(async (path: string) =>
      path.includes('/messages/search') ? { results: [hit('gone', 4)], nextCursor: null } : listPage(path)
    )
    const lines = await run(['search', 'agent-1', 'deploy', '--context', '1'])
    expect(lines[1]).toBe('> gone 2026-11-27T07:00:00.000Z assistant: the deploy pipeline')
    expect(lines[2]).toContain('context unavailable')
  })

  it('returns the full structured result with context under --json', async () => {
    ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
    get.mockImplementation(async (path: string) =>
      path.includes('/messages/search') ? { results: [hit('m5', 4)], nextCursor: 'c2' } : listPage(path)
    )
    const lines = await run(['search', 'agent-1', 'deploy', '--context', '1'])
    expect(lines).toEqual([])
    const [[printed]] = (output as ReturnType<typeof mock>).mock.calls as [[any]]
    expect(printed.nextCursor).toBe('c2')
    expect(printed.results[0].snippet.highlights).toEqual([[4, 10]])
    expect(printed.results[0].context.before.map((m: { id: string }) => m.id)).toEqual(['m4'])
    expect(printed.results[0].context.after.map((m: { id: string }) => m.id)).toEqual(['m6'])
  })
})

describe('ficus agent messages --search and worker-log --search use the shared search', () => {
  it('keeps --role, --before and --after, searches text by default and accepts --in', async () => {
    get.mockResolvedValue({ messages: [], pagination: { totalCount: 0 } })
    await run(['messages', 'agent-1', '--role', 'human', '--search', '50%_off', '--after', '2026-11-01T00:00:00Z'])
    expect(get).toHaveBeenLastCalledWith(
      '/api/agents/agent-1/messages?after=2026-11-01T00%3A00%3A00Z&search=50%25_off&role=human'
    )
    await run(['messages', 'agent-1', '--search', 'needle', '--in', 'all'])
    expect(get).toHaveBeenLastCalledWith('/api/agents/agent-1/messages?search=needle&in=all')
    ;(outputError as ReturnType<typeof mock>).mockClear()
    await run(['messages', 'agent-1', '--search', 'needle', '--in', 'nowhere'])
    expect(outputError).toHaveBeenCalledTimes(1)
  })

  it('reports how many messages match the search', async () => {
    get.mockResolvedValue({
      messages: [{ role: 'human', content: 'needle', createdAt: '2026-11-27T07:00:00.000Z' }],
      pagination: { totalCount: 3 },
    })
    const lines = await run(['messages', 'agent-1', '--search', 'needle', '--last', '1'])
    expect(lines.at(-1)).toBe('--- Showing 1 of 3 matching message(s) ---')
  })

  it('searches tool calls too in worker-log, and skips the count it never shows', async () => {
    get.mockResolvedValue({ messages: [], pagination: {} })
    await run(['worker-log', 'agent-1', '--search', 'needle'])
    expect(get).toHaveBeenLastCalledWith('/api/agents/agent-1/messages?role=assistant&search=needle&in=all&count=false')
  })
})

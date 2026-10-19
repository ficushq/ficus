import { expect, test } from 'bun:test'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BigbrainClient } from './client'

function fixture(reply: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = []
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = new Server({ name: 'synthetic', version: '1' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: ['load_memory', 'search_vault', 'read_note', 'drop', 'admin'].map((name) => ({
      name,
      inputSchema: { type: 'object' as const },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    calls.push(request.params)
    return {
      content: [
        {
          type: 'text',
          text:
            request.params.name === 'load_memory'
              ? String(reply(request.params.name, request.params.arguments ?? {}))
              : JSON.stringify(reply(request.params.name, request.params.arguments ?? {})),
        },
      ],
    }
  })
  const ready = server.connect(serverTransport)
  const client = new BigbrainClient({
    transport: async () => {
      await ready
      return clientTransport
    },
  })
  return { client, calls, dispose: () => server.close() }
}
test('uses current search contract and preserves provenance/filter metadata', async () => {
  const response = {
    hits: [{ path: 'log/insertions/one.json', provenance: { from_kind: 'agent' } }],
    relaxation: 'literal',
    applied_filters: { source: 'mcp' },
    only_agent_records: true,
  }
  const f = fixture(() => response)
  try {
    expect(await f.client.searchVault({ queries: ['one', 'two'], after: '2026-01-01', n: 2 })).toEqual(response)
    expect(f.calls).toEqual([
      { name: 'search_vault', arguments: { queries: ['one', 'two'], after: '2026-01-01', n: 2 } },
    ])
  } finally {
    await f.dispose()
  }
})
test('preserves paginated markdown, windows and unresolved links', async () => {
  const path = 'log/insertions/one.json'
  const response = {
    path,
    markdown: '<untrusted-data>slice</untrusted-data>',
    markdown_length: 100,
    start: 10,
    end: 15,
    truncated: true,
    links: [{ name: 'unknown', path: null }],
    window: { total: 40 },
  }
  const f = fixture(() => response)
  try {
    expect(await f.client.readNote({ path, start: 10, chars: 5, q: 'term', slack: 2 })).toEqual(response)
  } finally {
    await f.dispose()
  }
})
test('load memory accepts no parameters and queued drops are not saved receipts', async () => {
  const f = fixture((name) => (name === 'load_memory' ? '' : { queued: true, id: 'synthetic' }))
  try {
    expect(await f.client.loadMemory()).toBe('')
    expect(f.calls[0]).toEqual({ name: 'load_memory', arguments: {} })
  } finally {
    await f.dispose()
  }
  const drop = fixture(() => ({ queued: true, id: 'synthetic' }))
  try {
    expect(await drop.client.drop({ title: 'Finding', body: 'Evidence', kind: 'finding' })).toEqual({
      queued: true,
      id: 'synthetic',
    })
  } finally {
    await drop.dispose()
  }
})
test('strict inputs reject identity, traversal and ambiguous search before transport', async () => {
  let launched = false
  const client = new BigbrainClient({
    transport: async () => {
      launched = true
      throw new Error('should not launch')
    },
  })
  for (const path of ['../x', '/secret', 'x//y', 'x/./y', 'C:/x', 'x\\y'])
    await expect(client.readNote({ path })).rejects.toMatchObject({ code: 'invalid_configuration' })
  await expect(client.searchVault({ query: 'x', queries: ['y'] })).rejects.toMatchObject({
    code: 'invalid_configuration',
  })
  await expect(client.drop({ title: 'x', body: 'y', author: 'admin' } as never)).rejects.toMatchObject({
    code: 'invalid_configuration',
  })
  expect(launched).toBe(false)
})
test.each([
  { path: 'memory/x', markdown: 'x', start: 20, end: 10, markdown_length: 30 },
  { path: 'memory/x', markdown: 'x', links: [{ name: 'bad', path: '../secret' }] },
  { path: 'wrong', markdown: 'x' },
])('rejects unsafe or inconsistent read responses', async (response) => {
  const f = fixture(() => response)
  try {
    await expect(f.client.readNote({ path: 'memory/x' })).rejects.toMatchObject({ code: 'invalid_response' })
  } finally {
    await f.dispose()
  }
})
test('gate is rechecked after initialization and before dispatch', async () => {
  const f = fixture(() => ({ hits: [] }))
  try {
    await expect(
      f.client.searchVault(
        { query: 'x' },
        {
          beforeCall: async () => {
            throw new Error('revoked')
          },
        }
      )
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.calls).toHaveLength(0)
  } finally {
    await f.dispose()
  }
})

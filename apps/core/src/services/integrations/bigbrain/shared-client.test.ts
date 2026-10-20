import { expect, test } from 'bun:test'
import { BigbrainSharedClient, sharedSearchInput, sharedReadInput, sharedRecentInput } from './shared-client'
import { BigbrainError } from './errors'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT as pin,
} from '@ficus/shared/managed-bigbrain'
const vaultId = '11111111-1111-4111-8111-111111111111'
const upstreamVaultId = '22222222-2222-4222-8222-222222222222'
const physicalHostBinding = '33333333-3333-4333-8333-333333333333'
const binding = { tenantId: vaultId, physicalHostBinding, hostEpoch: 2 }
const material = {
  ...binding,
  contractVersion: 1 as const,
  vaultId,
  generation: 1,
  upstreamVaultId,
  upstreamCommit: pin,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  credentialId: '1234abcd',
  kind: 'agent' as const,
  scopes: ['read'] as ['read'],
  followsMember: false as const,
  token: `sv_1234abcd_${'a'.repeat(43)}`,
}
const capabilities = {
  ...binding,
  contractVersion: 1 as const,
  available: true,
  reasonCode: null,
  installed: true,
  upstreamCommit: pin,
  artifactDigest: `sha256:${'b'.repeat(64)}`,
  sharedProtocol: 1 as const,
  hostState: 'active' as const,
  limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  observedAt: '2026-10-20T00:00:00.000Z',
}
const vault = {
  vaultId,
  upstreamVaultId,
  origin: `https://bb-${vaultId.replaceAll('-', '')}.example.com`,
  appliedGeneration: 1,
  state: 'ready' as const,
  readAccess: 'active' as const,
}
const whoami = {
  vault: { id: upstreamVaultId, name: 'Research' },
  handle: 'ficus-reader',
  display: 'Ficus reader',
  member_id: '1234abcd',
  role: 'member',
  kind: 'agent',
  permissions: ['read'],
  credential: { id: material.credentialId, name: 'Ficus read access' },
}
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...headers } })
function fixture(
  options: {
    whoami?: unknown
    protocol?: string
    mcp?: (id: unknown) => Response
    beforeCall?: () => Promise<void>
  } = {}
) {
  const calls: { url: string; init: RequestInit }[] = []
  const transport = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! })
    if (String(url).endsWith('/v1/whoami'))
      return json(options.whoami ?? whoami, { 'BigBrain-Protocol': options.protocol ?? '1' })
    const body = JSON.parse(String(init!.body))
    return (
      options.mcp?.(body.id) ??
      json({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: '<untrusted-data>member proposal</untrusted-data>' }] },
      })
    )
  }
  const client = new BigbrainSharedClient({
    capabilities,
    vault,
    material,
    fetch: transport,
    beforeCall: options.beforeCall ?? (async () => {}),
  })
  return { client, calls }
}

test('uses only four read methods through the fixed loopback gateway and retains text unchanged', async () => {
  const f = fixture()
  expect(await f.client.overview()).toBe('<untrusted-data>member proposal</untrusted-data>')
  await f.client.searchVault({ queries: ['one', 'two'], limit: 5 })
  await f.client.readRecord({ id: 'ins_abc123', start: 20, chars: 10 })
  await f.client.recent({ before: 40, limit: 5 })
  expect(f.calls).toHaveLength(8)
  expect(f.calls.every((c) => c.url.startsWith('http://localhost/') && c.init.redirect === 'error')).toBe(true)
  const tools = f.calls.filter((c) => c.url.endsWith('/mcp'))
  expect(tools.map((c) => JSON.parse(String(c.init.body)).params.name)).toEqual([
    'overview',
    'search_vault',
    'read_record',
    'recent',
  ])
  for (const call of tools) {
    const headers = new Headers(call.init.headers)
    expect(headers.get('Host')).toBe(new URL(vault.origin).hostname)
    expect(headers.get('MCP-Protocol-Version')).toBe('2025-06-18')
    expect(headers.get('Authorization')).toBe(`Bearer ${material.token}`)
  }
})
test('whoami identity/protocol/exact read-only scope is checked before every tool call', async () => {
  for (const options of [
    { whoami: { ...whoami, permissions: ['read', 'write'] } },
    { whoami: { ...whoami, permissions: [] } },
    { whoami: { ...whoami, kind: 'person' } },
    { whoami: { ...whoami, role: 'owner' } },
    { whoami: { ...whoami, vault: { id: vaultId } } },
    { whoami: { ...whoami, credential: { id: 'deadbeef' } } },
    { protocol: '2' },
  ]) {
    const f = fixture(options)
    await expect(f.client.overview()).rejects.toBeInstanceOf(BigbrainError)
    expect(f.calls).toHaveLength(1)
  }
})
test('no writer/foreign/future handoff, other host, or non-ready/revoked vault can dispatch', () => {
  for (const override of [
    { material: { ...material, followsMember: true } },
    { material: { ...material, scopes: ['read', 'write'] } },
    // Minted for a generation or epoch Core has not observed yet.
    { material: { ...material, generation: 2 } },
    { material: { ...material, hostEpoch: 3 } },
    // Another physical host (e.g. restored elsewhere) or tenant.
    { material: { ...material, physicalHostBinding: vaultId } },
    { material: { ...material, tenantId: upstreamVaultId } },
    { capabilities: { ...capabilities, available: false, reasonCode: 'maintenance' } },
    { vault: { ...vault, state: 'degraded' } },
    { vault: { ...vault, readAccess: 'revoked' } },
    { vault: { ...vault, upstreamVaultId: physicalHostBinding } },
    { vault: { ...vault, origin: `https://bb-${upstreamVaultId.replaceAll('-', '')}.example.com` } },
  ])
    expect(
      () =>
        new BigbrainSharedClient({
          capabilities,
          vault,
          material,
          beforeCall: async () => {},
          ...override,
        } as never)
    ).toThrow()
})

test('suspend/resume, rename and Core upgrades do not invalidate an unrevoked read credential', () => {
  for (const override of [
    { capabilities: { ...capabilities, hostEpoch: 5 } },
    { capabilities: { ...capabilities, artifactDigest: `sha256:${'c'.repeat(64)}` } },
    { vault: { ...vault, appliedGeneration: 4 } },
  ])
    expect(
      () => new BigbrainSharedClient({ capabilities, vault, material, beforeCall: async () => {}, ...override })
    ).not.toThrow()
})
test('input windows/search/recent are bounded and cannot smuggle a path or another tool', () => {
  expect(sharedSearchInput.safeParse({ queries: ['one'], limit: 50 }).success).toBe(true)
  for (const input of [
    {},
    { query: 'one', queries: ['two'] },
    { query: 'x'.repeat(1001) },
    { query: 'one', tool: 'drop' },
    { queries: Array(9).fill('one') },
  ])
    expect(sharedSearchInput.safeParse(input).success).toBe(false)
  for (const id of ['ins_a', 'ast_b', 'ent_c'])
    expect(sharedReadInput.safeParse({ id, chars: 80000 }).success).toBe(true)
  for (const input of [
    { id: '../file' },
    { id: 'ins_a', start: -1 },
    { id: 'ins_a', chars: 80001 },
    { id: 'ins_a', path: '/etc' },
  ])
    expect(sharedReadInput.safeParse(input).success).toBe(false)
  expect(sharedRecentInput.safeParse({ before: 0 }).success).toBe(false)
})
test('rejects errors, non-text MCP content, response ID mismatch, and secret error bodies safely', async () => {
  for (const response of [
    (id: unknown) =>
      json({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'PRIVATE' }] } }),
    (id: unknown) => json({ jsonrpc: '2.0', id, result: { content: [{ type: 'image', data: 'PRIVATE' }] } }),
    () => json({ jsonrpc: '2.0', id: 'other', result: { content: [{ type: 'text', text: 'PRIVATE' }] } }),
    () => new Response('PRIVATE', { status: 500 }),
  ]) {
    const f = fixture({ mcp: response })
    try {
      await f.client.overview()
      throw new Error('unexpected success')
    } catch (error) {
      expect(error).toBeInstanceOf(BigbrainError)
      expect(String(error)).not.toContain('PRIVATE')
      expect(JSON.stringify(error)).not.toContain(material.token)
    }
  }
})
test('cancels oversized streamed responses instead of truncating or buffering unbounded data', async () => {
  let cancelled = false
  const f = fixture({
    mcp: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new Uint8Array(256 * 1024))
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      ),
  })
  await expect(f.client.overview()).rejects.toMatchObject({ code: 'response_too_large' })
  expect(cancelled).toBe(true)
})
test('cancellation settles even while a live authorization callback has not returned', async () => {
  let entered!: () => void
  let release!: () => void
  let callbackReleased = false
  const started = new Promise<void>((r) => {
    entered = r
  })
  const waiting = new Promise<void>((r) => {
    release = r
  })
  const abort = new AbortController()
  const f = fixture({
    beforeCall: async () => {
      entered()
      await waiting
    },
  })
  const pending = f.client.overview({ signal: abort.signal })
  await started
  // Cleanup fallback makes the old hanging implementation fail by event order, not a timing threshold.
  const cleanup = setTimeout(() => {
    callbackReleased = true
    release()
  }, 1000)
  try {
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(callbackReleased).toBe(false)
    expect(f.calls).toHaveLength(0)
  } finally {
    clearTimeout(cleanup)
    release()
    await pending.catch(() => {})
  }
})

test('pre-dispatch and post-response live fences suppress mid-flight revoked content', async () => {
  let checks = 0
  const f = fixture({
    beforeCall: async () => {
      if (++checks === 3) throw new BigbrainError('binding_changed')
    },
  })
  await expect(f.client.overview()).rejects.toMatchObject({ code: 'binding_changed' })
  expect(f.calls).toHaveLength(2)
  const denied = fixture({
    beforeCall: async () => {
      throw new BigbrainError('binding_changed')
    },
  })
  await expect(denied.client.overview()).rejects.toMatchObject({ code: 'binding_changed' })
  expect(denied.calls).toHaveLength(0)
})

test('verify checks identity only and never calls an MCP tool', async () => {
  const f = fixture()
  await f.client.verify()
  expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/whoami'])
  const writer = fixture({ whoami: { ...whoami, permissions: ['read', 'write'] } })
  await expect(writer.client.verify()).rejects.toMatchObject({ code: 'invalid_auth' })
})

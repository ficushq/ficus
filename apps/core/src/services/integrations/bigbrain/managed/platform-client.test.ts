import { afterEach, describe, expect, test } from 'bun:test'
import { MANAGED_BIGBRAIN_DEFAULT_LIMITS, MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import { ManagedBigbrainPlatformError, managedBigbrainPlatform } from './platform-client'

const originalFetch = globalThis.fetch
const originalEnv = {
  baseUrl: process.env.FICUS_PLATFORM_BASE_URL,
  token: process.env.FICUS_PLATFORM_INSTANCE_TOKEN,
}
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalEnv.baseUrl === undefined) delete process.env.FICUS_PLATFORM_BASE_URL
  else process.env.FICUS_PLATFORM_BASE_URL = originalEnv.baseUrl
  if (originalEnv.token === undefined) delete process.env.FICUS_PLATFORM_INSTANCE_TOKEN
  else process.env.FICUS_PLATFORM_INSTANCE_TOKEN = originalEnv.token
})

const TOKEN = 'instance-token-SENTINEL'
const TENANT = '11111111-1111-4111-8111-111111111111'
const VAULT = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'
const OWNER = '44444444-4444-4444-8444-444444444444'
const REQUEST = '55555555-5555-4555-8555-555555555555'
const OPERATION = '66666666-6666-4666-8666-666666666666'

function configure() {
  process.env.FICUS_PLATFORM_BASE_URL = 'https://platform.example/'
  process.env.FICUS_PLATFORM_INSTANCE_TOKEN = TOKEN
}
type Seen = { method: string; url: string; auth: string | null; body: string; redirect?: RequestRedirect }
function respond(reply: (seen: Seen) => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    const entry = {
      method: request.method,
      url: request.url,
      auth: request.headers.get('authorization'),
      body: await request.text(),
      redirect: init?.redirect,
    }
    seen.push(entry)
    return reply(entry)
  }) as unknown as typeof fetch
  return seen
}

const capabilities = {
  contractVersion: 1,
  tenantId: TENANT,
  physicalHostBinding: '77777777-7777-4777-8777-777777777777',
  available: true,
  reasonCode: null,
  installed: true,
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  sharedProtocol: 1,
  hostEpoch: 1,
  hostState: 'active',
  limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  observedAt: '2026-10-20T00:00:00.000Z',
}
const summary = {
  contractVersion: 1,
  vaultId: VAULT,
  displayName: 'Research',
  ownerUserId: OWNER,
  state: 'ready',
  readAccess: 'active',
  desiredGeneration: 1,
  appliedGeneration: 1,
  upstreamVaultId: OTHER,
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  origin: null,
  operationId: OPERATION,
  lastErrorCode: null,
  retryable: false,
  updatedAt: '2026-10-20T00:00:00.000Z',
}
const operation = {
  contractVersion: 1,
  operationId: OPERATION,
  vaultId: VAULT,
  generation: 1,
  state: 'accepted',
  code: null,
}
const put = {
  requestId: REQUEST,
  expectedGeneration: 0,
  displayName: 'Research',
  owner: { userId: OWNER, handle: 'ada', display: 'Ada' },
}

async function refusal(promise: Promise<unknown>): Promise<ManagedBigbrainPlatformError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedBigbrainPlatformError)
    expect(String((error as Error).message)).not.toContain(TOKEN)
    return error as ManagedBigbrainPlatformError
  }
  throw new Error('expected a refusal')
}

describe('managed BigBrain Platform client', () => {
  test('uses fixed route templates, the instance bearer, JSON bodies and never follows redirects', async () => {
    configure()
    const seen = respond((s) =>
      Response.json(
        s.url.endsWith('/capabilities')
          ? capabilities
          : s.method === 'GET' && s.url.endsWith('/vaults')
            ? { items: [summary] }
            : s.method === 'GET'
              ? summary
              : operation,
        { status: s.method === 'GET' ? 200 : 202 }
      )
    )
    expect((await managedBigbrainPlatform.capabilities()).tenantId).toBe(TENANT)
    expect((await managedBigbrainPlatform.listVaults()).items).toHaveLength(1)
    expect((await managedBigbrainPlatform.getVault(VAULT)).vaultId).toBe(VAULT)
    expect((await managedBigbrainPlatform.putVault(VAULT, put)).operationId).toBe(OPERATION)
    await managedBigbrainPlatform.retryVault(VAULT, { requestId: REQUEST, expectedGeneration: 1 })
    await managedBigbrainPlatform.setReadAccess(VAULT, { requestId: REQUEST, expectedGeneration: 1, action: 'revoke' })
    await managedBigbrainPlatform.deleteVault(VAULT, {
      requestId: REQUEST,
      expectedGeneration: 1,
      confirmedVaultId: VAULT,
      confirmedName: 'Research',
    })
    expect(seen.map((s) => `${s.method} ${s.url.replace('https://platform.example', '')}`)).toEqual([
      'GET /api/managed-bigbrain/capabilities',
      'GET /api/managed-bigbrain/vaults',
      `GET /api/managed-bigbrain/vaults/${VAULT}`,
      `PUT /api/managed-bigbrain/vaults/${VAULT}`,
      `POST /api/managed-bigbrain/vaults/${VAULT}/retry`,
      `POST /api/managed-bigbrain/vaults/${VAULT}/read-access`,
      `DELETE /api/managed-bigbrain/vaults/${VAULT}`,
    ])
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}` && s.redirect === 'error')).toBe(true)
    expect(seen.filter((s) => s.method === 'GET').every((s) => s.body === '')).toBe(true)
    expect(JSON.parse(seen[3]!.body)).toEqual(put)
  })

  test('invalid identifiers and bodies are refused before any network request', async () => {
    configure()
    const seen = respond(() => Response.json(operation, { status: 202 }))
    expect((await refusal(managedBigbrainPlatform.getVault('../admin'))).code).toBe('invalid_request')
    expect((await refusal(managedBigbrainPlatform.putVault(VAULT, { ...put, extra: 'x' } as typeof put))).code).toBe(
      'invalid_request'
    )
    expect(
      (
        await refusal(
          managedBigbrainPlatform.deleteVault(VAULT, {
            requestId: REQUEST,
            expectedGeneration: 1,
            confirmedVaultId: OTHER,
            confirmedName: 'Research',
          })
        )
      ).code
    ).toBe('invalid_request')
    expect(seen).toHaveLength(0)
  })

  test('responses about another vault, another tenant or a malformed shape are invalid', async () => {
    configure()
    respond(() => Response.json({ ...operation, vaultId: OTHER }, { status: 202 }))
    expect((await refusal(managedBigbrainPlatform.putVault(VAULT, put))).code).toBe('invalid_response')
    respond(() => Response.json({ ...summary, vaultId: OTHER }))
    expect((await refusal(managedBigbrainPlatform.getVault(VAULT))).code).toBe('invalid_response')
    respond(() => Response.json({ ...summary, token: 'sv_leak' }))
    expect((await refusal(managedBigbrainPlatform.getVault(VAULT))).code).toBe('invalid_response')
    respond(() => Response.json(capabilities))
    expect((await refusal(managedBigbrainPlatform.capabilities({ expectedTenantId: OWNER }))).code).toBe(
      'identity_mismatch'
    )
    respond(() => new Response('not json'))
    expect((await refusal(managedBigbrainPlatform.listVaults())).code).toBe('invalid_response')
  })

  test('oversized bodies are refused without buffering them whole', async () => {
    configure()
    respond(() => new Response(JSON.stringify({ items: [], pad: 'x'.repeat(70 * 1024) })))
    expect((await refusal(managedBigbrainPlatform.listVaults())).code).toBe('output_limit')
  })

  test('Platform refusals keep only allowlisted contract codes; HTTP status classifies the rest', async () => {
    configure()
    const cases: Array<[number, unknown, string, boolean]> = [
      [403, { code: 'capability_stale' }, 'capability_stale', false],
      [409, { code: 'generation_conflict' }, 'generation_conflict', false],
      [503, { code: 'host_unreachable' }, 'host_unreachable', true],
      [429, { code: 'capacity' }, 'capacity', true],
      [400, { code: 'invalid_request' }, 'invalid_request', false],
      [401, { code: 'unauthorized' }, 'unauthorized', false],
      [404, { code: 'not_found' }, 'not_found', false],
      // Unknown or secret-bearing bodies never cross the boundary.
      [403, { code: 'some_new_code' }, 'forbidden', false],
      [409, { code: 'request_conflict', detail: 'sv_secret' }, 'request_conflict', false],
      [500, 'stack trace sv_secret', 'operation_failed', true],
      [302, {}, 'invalid_response', false],
    ]
    for (const [status, body, code, retryable] of cases) {
      respond(() => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
      const error = await refusal(managedBigbrainPlatform.putVault(VAULT, put))
      expect([status, String(error.code), error.retryable]).toEqual([status, code, retryable])
      expect(error.message).not.toContain('sv_secret')
    }
  })

  test('transport failures and deadlines are retryable host_unreachable; unconfigured is not_installed', async () => {
    configure()
    globalThis.fetch = (async () => {
      throw new Error(`connect ECONNREFUSED ${TOKEN}`)
    }) as unknown as typeof fetch
    const down = await refusal(managedBigbrainPlatform.capabilities())
    expect([down.code, down.retryable]).toEqual(['host_unreachable', true])
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      )) as unknown as typeof fetch
    const slow = await refusal(managedBigbrainPlatform.capabilities({ timeoutMs: 20 }))
    expect([slow.code, slow.retryable]).toEqual(['host_unreachable', true])
    delete process.env.FICUS_PLATFORM_BASE_URL
    const missing = await refusal(managedBigbrainPlatform.capabilities())
    expect([missing.code, missing.retryable]).toEqual(['not_installed', false])
  })

  test('owner invite results are secret: returned once, never placed in errors, and must be well-formed', async () => {
    configure()
    const origin = (id: string) => `https://bb-${id.replaceAll('-', '')}.vaults.example.com`
    const invite = { inviteUrl: `${origin(VAULT)}/invite#${'A'.repeat(43)}`, expiresAt: '2026-10-20T01:00:00.000Z' }
    const seen = respond(() => Response.json(invite, { headers: { 'cache-control': 'no-store' } }))
    const input = { requestId: REQUEST, expectedGeneration: 1, actorUserId: OWNER }
    const result = await managedBigbrainPlatform.createOwnerInvite(VAULT, input)
    expect(result.inviteUrl).toBe(invite.inviteUrl)
    expect(seen[0]!.url).toBe(`https://platform.example/api/managed-bigbrain/vaults/${VAULT}/owner-invite`)
    for (const bad of [
      { ...invite, extra: 1 },
      { ...invite, inviteUrl: `${origin(OTHER)}/invite#${'A'.repeat(43)}` },
    ]) {
      respond(() => Response.json(bad))
      const error = await refusal(managedBigbrainPlatform.createOwnerInvite(VAULT, input))
      expect(error.code).toBe('invalid_response')
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('invite#')
    }
  })
})

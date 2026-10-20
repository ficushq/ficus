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
const origin = (id: string) => `https://bb-${id.replaceAll('-', '')}.vaults.example.com`

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
  zone: 'vaults.example.com',
  limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  observedAt: '2026-10-20T00:00:00.000Z',
}
const dns = {
  contractVersion: 1,
  tenantId: TENANT,
  vaultId: VAULT,
  zone: 'vaults.example.com',
  hostname: `bb-${VAULT.replaceAll('-', '')}.vaults.example.com`,
  origin: origin(VAULT),
  serverIp: '203.0.113.7',
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

describe('slim managed BigBrain Platform client', () => {
  test('only support and exact per-vault DNS: fixed routes, instance bearer, no redirects, no vault metadata', async () => {
    configure()
    const seen = respond((s) =>
      s.url.endsWith('/capabilities')
        ? Response.json(capabilities)
        : s.method === 'PUT'
          ? Response.json(dns)
          : new Response(null, { status: 204 })
    )
    expect((await managedBigbrainPlatform.support()).zone).toBe('vaults.example.com')
    expect((await managedBigbrainPlatform.ensureDns(VAULT, origin(VAULT))).hostname).toBe(dns.hostname)
    await managedBigbrainPlatform.deleteDns(VAULT)
    expect(seen.map((s) => `${s.method} ${s.url.replace('https://platform.example', '')}`)).toEqual([
      'GET /api/managed-bigbrain/capabilities',
      `PUT /api/managed-bigbrain/dns/${VAULT}`,
      `DELETE /api/managed-bigbrain/dns/${VAULT}`,
    ])
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}` && s.redirect === 'error')).toBe(true)
    // Platform never learns names, owners or generations.
    expect(seen.map((s) => s.body)).toEqual(['', '{}', ''])
    expect(Object.keys(managedBigbrainPlatform).sort()).toEqual(['deleteDns', 'ensureDns', 'support'])
  })

  test('a DNS record for another vault or origin, a foreign tenant or a malformed reply is refused', async () => {
    configure()
    respond(() =>
      Response.json({
        ...dns,
        vaultId: OTHER,
        origin: origin(OTHER),
        hostname: `bb-${OTHER.replaceAll('-', '')}.vaults.example.com`,
      })
    )
    expect((await refusal(managedBigbrainPlatform.ensureDns(VAULT, origin(VAULT)))).code).toMatch(/identity_mismatch/)
    respond(() => Response.json(dns))
    expect(
      (
        await refusal(
          managedBigbrainPlatform.ensureDns(VAULT, `https://bb-${VAULT.replaceAll('-', '')}.other.example.com`)
        )
      ).code
    ).toBe('identity_mismatch')
    respond(() => Response.json({ ...dns, recordId: 'cf-1' }))
    expect((await refusal(managedBigbrainPlatform.ensureDns(VAULT, origin(VAULT)))).code).toBe('invalid_response')
    respond(() => Response.json(capabilities))
    expect((await refusal(managedBigbrainPlatform.support({ expectedTenantId: OTHER }))).code).toBe('identity_mismatch')
    expect((await refusal(managedBigbrainPlatform.ensureDns('../admin', origin(VAULT)))).code).toBe('invalid_request')
  })

  test('deleting an absent record is success; other refusals keep allowlisted codes only', async () => {
    configure()
    respond(() => Response.json({ code: 'not_found' }, { status: 404 }))
    await managedBigbrainPlatform.deleteDns(VAULT)
    for (const [status, body, code, retryable] of [
      [429, { code: 'capacity' }, 'capacity', true],
      [409, { code: 'identity_mismatch' }, 'identity_mismatch', false],
      [503, { code: 'dns_unavailable' }, 'dns_unavailable', true],
      [500, 'stack trace sv_secret', 'operation_failed', true],
      [403, { code: 'some_new_code' }, 'forbidden', false],
    ] as const) {
      respond(() => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
      const error = await refusal(managedBigbrainPlatform.ensureDns(VAULT, origin(VAULT)))
      expect([String(error.code), error.retryable]).toEqual([code, retryable])
      expect(error.message).not.toContain('sv_secret')
    }
  })

  test('transport failures are retryable host_unreachable; unconfigured is not_installed; oversize is refused', async () => {
    configure()
    globalThis.fetch = (async () => {
      throw new Error(`connect ECONNREFUSED ${TOKEN}`)
    }) as unknown as typeof fetch
    const down = await refusal(managedBigbrainPlatform.support())
    expect([down.code, down.retryable]).toEqual(['host_unreachable', true])
    respond(() => new Response(JSON.stringify({ pad: 'x'.repeat(70 * 1024) })))
    expect((await refusal(managedBigbrainPlatform.support())).code).toBe('output_limit')
    delete process.env.FICUS_PLATFORM_BASE_URL
    const missing = await refusal(managedBigbrainPlatform.support())
    expect([missing.code, missing.retryable]).toEqual(['not_installed', false])
  })
})

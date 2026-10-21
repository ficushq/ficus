import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { isManagedVaultHost, managedVaultHostGuard } from './managed-vault-host'

function app() {
  const a = new Hono()
  a.use('*', managedVaultHostGuard)
  // Stand-in for Core's identity middleware, which must never answer as a vault.
  a.all('*', (c) => c.json({ error: 'Authentication required' }, 401))
  return a
}
const PREFIXED = 'noah-bb-3294c8f0f133.ficus.sh'
const FALLBACK = `bb-${'3294c8f0f1334a1b8c2d0123456789ab'}.ficus.sh`

describe('managedVaultHostGuard', () => {
  test('a vault hostname (either form) never reaches Core handlers', async () => {
    for (const host of [PREFIXED, FALLBACK, PREFIXED.toUpperCase(), `${PREFIXED}.`, `${PREFIXED}:443`]) {
      for (const [path, method] of [
        ['/', 'GET'],
        ['/v1/whoami', 'GET'],
        ['/v1/invites/redeem', 'POST'],
        ['/api/auth/me', 'GET'],
      ] as const) {
        const res = await app().request(path, { method, headers: { Host: host } })
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ code: 'not_found' })
        expect(res.headers.get('cache-control')).toBe('no-store')
      }
    }
  })

  test('Core hosts and look-alikes pass through untouched', async () => {
    for (const host of ['noah.ficus.sh', 'localhost:3000', '127.0.0.1', 'bb-123.ficus.sh', 'noah-bb.ficus.sh']) {
      expect(isManagedVaultHost(host)).toBe(false)
      expect((await app().request('/api/auth/me', { headers: { Host: host } })).status).toBe(401)
    }
    expect(isManagedVaultHost(undefined)).toBe(false)
  })
})

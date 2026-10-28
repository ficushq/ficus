import { expect, test } from 'bun:test'
import { firstPartyIntegrationPlugin } from '../first-party-plugins'

// Bun fetch includes a preconnect helper; model that boundary without weakening types.
function stubFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect() {} })
}

const validBodies: Record<string, unknown> = {
  cloudflare: { success: true, result: { status: 'active' } },
  digitalocean: { account: { uuid: 'account-id' } },
  netlify: { id: 'user-id' },
  railway: { data: { projects: { edges: [] } } },
  supabase: [],
  vercel: { user: { id: 'user-id' } },
}
for (const [key, body] of Object.entries(validBodies)) {
  test(`${key} validates only with authenticated provider evidence and sanitizes failures`, async () => {
    const plugin = firstPartyIntegrationPlugin(key)
    expect(plugin).toBeDefined()
    if (!plugin) return
    const original = globalThis.fetch
    const requests: RequestInit[] = []
    const context = {
      connection: { id: 'fixture', providerKey: key, adapterVersion: 1, configuration: { version: 1 } },
      credential: 'synthetic-token',
    }
    try {
      globalThis.fetch = stubFetch(async (_url, init) => {
        requests.push(init!)
        return Response.json(body)
      })
      expect(await plugin.runtime.provider.validate(context)).toEqual({ ok: true, grantedScopes: [] })
      expect(requests[0]?.headers).toMatchObject({ Authorization: 'Bearer synthetic-token' })
      expect(requests[0]?.signal).toBeDefined()
      globalThis.fetch = stubFetch(async () => Response.json({ error: 'synthetic-token' }, { status: 401 }))
      expect(await plugin.runtime.provider.validate(context)).toEqual({ ok: false, code: 'invalid_auth' })
      globalThis.fetch = stubFetch(async () => Response.json({ errors: [{ message: 'synthetic-token' }] }))
      expect(await plugin.runtime.provider.validate(context)).toEqual({ ok: false, code: 'invalid_auth' })
      globalThis.fetch = stubFetch(async () => {
        throw new Error('synthetic-token')
      })
      expect(await plugin.runtime.provider.validate(context)).toEqual({ ok: false, code: 'provider_unavailable' })
    } finally {
      globalThis.fetch = original
    }
  })
}

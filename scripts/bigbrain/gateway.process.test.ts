import { expect, test } from 'bun:test'
import { createGatewayHandler } from './gateway-policy'
const id = '11111111-1111-4111-8111-111111111111'
const origin = `https://bb-${id.replaceAll('-', '')}.example.com`

test('real loopback forwarding preserves Host/auth and streams a bounded reply with owned cleanup', async () => {
  let calls = 0
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      calls++
      if (
        request.headers.get('Authorization') !== 'Bearer synthetic' ||
        request.headers.get('Host') !== new URL(origin).hostname
      )
        return new Response(null, { status: 401 })
      return Response.json({ ok: true }, { headers: { 'BigBrain-Protocol': '1', 'Referrer-Policy': 'no-referrer' } })
    },
  })
  const gateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: createGatewayHandler({
      manifest: async () => ({
        contractVersion: 1,
        tenantId: id,
        physicalHostBinding: id,
        hostEpoch: 1,
        hostState: 'active',
        routes: [{ vaultId: id, upstreamVaultId: id, origin, localPort: upstream.port, state: 'ready' }],
      }),
    }),
  })
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/whoami`, {
      headers: { Host: new URL(origin).hostname, Authorization: 'Bearer synthetic' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(response.headers.get('BigBrain-Protocol')).toBe('1')
    const denied = await fetch(`http://127.0.0.1:${gateway.port}/api/secrets`, {
      headers: { Host: new URL(origin).hostname },
    })
    expect(denied.status).toBe(404)
    await denied.body?.cancel()
    expect(calls).toBe(1)
  } finally {
    await gateway.stop(true)
    await upstream.stop(true)
  }
})

import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayHandler } from './gateway-policy'
const id = '11111111-1111-4111-8111-111111111111'
const origin = `https://bb-${id.replaceAll('-', '')}.example.com`
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('real Unix-socket forwarding preserves Host/auth and streams a bounded reply with owned cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bigbrain-gateway-'))
  roots.push(root)
  let calls = 0
  const vaultSocket = join(root, 'vault.sock')
  const upstream = Bun.serve({
    unix: vaultSocket,
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
  const gatewaySocket = join(root, 'gateway.sock')
  const gateway = Bun.serve({
    unix: gatewaySocket,
    fetch: createGatewayHandler({
      socketPath: () => vaultSocket,
      manifest: async () => ({
        contractVersion: 1,
        tenantId: id,
        physicalHostBinding: id,
        hostEpoch: 1,
        hostState: 'active',
        routes: [{ vaultId: id, upstreamVaultId: id, origin, state: 'ready' }],
      }),
    }),
  })
  try {
    const response = await fetch(`http://${new URL(origin).hostname}/v1/whoami`, {
      unix: gatewaySocket,
      headers: { Authorization: 'Bearer synthetic' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(response.headers.get('BigBrain-Protocol')).toBe('1')
    const denied = await fetch(`http://${new URL(origin).hostname}/api/secrets`, { unix: gatewaySocket })
    expect(denied.status).toBe(404)
    await denied.body?.cancel()
    expect(calls).toBe(1)
  } finally {
    await gateway.stop(true)
    await upstream.stop(true)
  }
})

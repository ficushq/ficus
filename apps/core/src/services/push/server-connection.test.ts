import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { RelayServerConnection } from './server-connection'
import { relayConnectionSecretKey } from './relay'

const id = 'c08470e9-dd6a-4ae0-92e8-22e2325f480e'
const instanceId = '438b5fe1-30a0-4d87-8584-8a125ba1aa1a'
const token = `ficus_pri_${instanceId}_${'a'.repeat(43)}`
function fixture() {
  const env: NodeJS.ProcessEnv = {
    PUBLIC_URL: 'https://selfhost.example.com:8443',
    FICUS_PUSH_RELAY_URL: 'https://cloud.example.com',
  }
  const calls: { url: string; init: RequestInit }[] = []
  const saved: string[][] = []
  const storage = new Map<string, string>()
  let failSave = false
  let now = 0
  let tokenError: number | undefined
  let reply: 'pending' | 'denied' | 'connected' = 'pending'
  let challenge = ''
  let origin = env.PUBLIC_URL!
  let approval: Record<string, unknown> = {}
  let localUser: () => Promise<string | undefined> = async () => 'Noah'
  const deps: NonNullable<ConstructorParameters<typeof RelayServerConnection>[0]> = {
    env: () => env,
    now: () => now,
    config: () => {
      const saved = storage.get(relayConnectionSecretKey(env))
      return saved ? { token: saved, instanceId, baseUrl: 'https://cloud.example.com' } : null
    },
    describeUser: (userId) => {
      expect(userId).toBe('admin')
      return localUser()
    },
    read: (key) => storage.get(key),
    remove: async (key) => {
      storage.delete(key)
    },
    save: async (...args) => {
      if (args[0].startsWith('__push-relay-connection:')) {
        if (failSave) throw new Error('test persistence failure')
        saved.push(args)
      }
      storage.set(args[0], args[1])
    },
    fetch: async (url, init) => {
      calls.push({ url, init })
      const input = init.body ? JSON.parse(String(init.body)) : undefined
      if (url.endsWith('/authorize')) {
        challenge = input.codeChallenge
        expect(input).not.toHaveProperty('codeVerifier')
        return Response.json({ id, expiresIn: 600 })
      }
      if (url.endsWith('/token')) {
        if (tokenError) return new Response('provider-private-diagnostics', { status: tokenError })
        expect(createHash('sha256').update(input.codeVerifier).digest('base64url')).toBe(challenge)
        return Response.json({ status: reply, ...(reply === 'connected' ? { token, ...approval } : {}) })
      }
      expect(init.headers).toEqual({ Authorization: `Bearer ${token}` })
      return Response.json({
        instanceId,
        name: 'Example',
        origin,
        instancePro: true,
        allowance: 5,
        used: 1,
        registered: 1,
      })
    },
  }
  const service = new RelayServerConnection(deps)
  return {
    service,
    storage,
    restart: () => new RelayServerConnection(deps),
    tokenError: (status: number | undefined) => {
      tokenError = status
    },
    failSave: (value: boolean) => {
      failSave = value
    },
    env,
    calls,
    saved,
    setReply: (value: typeof reply) => {
      reply = value
    },
    advance: (ms: number) => {
      now += ms
    },
    setOrigin: (value: string) => {
      origin = value
    },
    setApproval: (value: Record<string, unknown>) => {
      approval = value
    },
    setLocalUser: (value: () => Promise<string | undefined>) => {
      localUser = value
    },
  }
}

const recordKey = (env: NodeJS.ProcessEnv) =>
  relayConnectionSecretKey(env).replace('__push-relay-connection:', '__push-relay-connection-record:')

describe('connection record', () => {
  async function connect(f: ReturnType<typeof fixture>) {
    await f.service.start('admin', 'Example')
    f.setReply('connected')
    expect(await f.service.poll('admin', id)).toEqual({ status: 'connected' })
  }

  test('records the local time and connecting person when Cloud sends no approval details', async () => {
    const f = fixture()
    f.advance(Date.parse('2026-10-06T18:02:00.000Z'))
    await connect(f)
    expect(JSON.parse(f.storage.get(recordKey(f.env))!)).toEqual({
      connectedAt: '2026-10-06T18:02:00.000Z',
      connectedBy: 'Noah',
    })
    expect(await f.service.status()).toMatchObject({
      connected: true,
      connection: { connectedAt: '2026-10-06T18:02:00.000Z', connectedBy: 'Noah' },
    })
    expect((await f.service.status()).connection).not.toHaveProperty('accountEmail')
  })

  test('prefers Cloud’s approval time and records the approving account email', async () => {
    const f = fixture()
    f.advance(Date.parse('2026-10-07T00:00:00.000Z'))
    f.setApproval({ connectedAt: '2026-10-06T18:02:00.000Z', accountEmail: 'owner@example.com' })
    await connect(f)
    expect((await f.service.status()).connection).toEqual({
      connectedAt: '2026-10-06T18:02:00.000Z',
      connectedBy: 'Noah',
      accountEmail: 'owner@example.com',
    })
  })

  test('ignores malformed approval details and a missing local name without failing the connection', async () => {
    const f = fixture()
    f.advance(Date.parse('2026-10-07T00:00:00.000Z'))
    f.setApproval({ connectedAt: 'yesterday', accountEmail: 42 })
    f.setLocalUser(async () => {
      throw new Error('lookup failed')
    })
    await connect(f)
    expect((await f.service.status()).connection).toEqual({ connectedAt: '2026-10-07T00:00:00.000Z' })
  })

  test('reconnecting overwrites the record', async () => {
    const f = fixture()
    f.setApproval({ connectedAt: '2026-10-01T00:00:00.000Z', accountEmail: 'old@example.com' })
    await connect(f)
    f.setReply('pending')
    f.setApproval({ connectedAt: '2026-10-06T18:02:00.000Z' })
    f.setLocalUser(async () => 'Second Admin')
    await connect(f)
    expect((await f.service.status()).connection).toEqual({
      connectedAt: '2026-10-06T18:02:00.000Z',
      connectedBy: 'Second Admin',
    })
  })

  test('disconnect clears the record', async () => {
    const f = fixture()
    f.setApproval({ connectedAt: '2026-10-06T18:02:00.000Z', accountEmail: 'owner@example.com' })
    await connect(f)
    await f.service.disconnect('admin')
    expect(f.storage.get(recordKey(f.env))).toBe('')
    expect(await f.service.status()).toMatchObject({ configured: false, connected: false, connection: null })
  })

  test('a connection made before records existed reports no record', async () => {
    const f = fixture()
    f.storage.set(relayConnectionSecretKey(f.env), token)
    expect(await f.service.status()).toMatchObject({ connected: true, connection: null })
  })

  test('an unverifiable connection still reports its record', async () => {
    const f = fixture()
    await connect(f)
    f.setOrigin('https://other.example.com')
    expect(await f.service.status()).toMatchObject({
      connected: false,
      configured: true,
      connection: { connectedBy: 'Noah' },
    })
  })

  test('a failed record write keeps the approval recoverable', async () => {
    const f = fixture()
    await f.service.start('admin', 'Example')
    f.setReply('connected')
    const save = f.storage.set.bind(f.storage)
    let fail = true
    f.storage.set = (key, value) => {
      if (fail && key.startsWith('__push-relay-connection-record:')) throw new Error('record persistence failure')
      return save(key, value)
    }
    await expect(f.service.poll('admin', id)).rejects.toThrow('record persistence failure')
    expect(f.storage.get('__push-relay-pending')).not.toBe('')
    fail = false
    expect(await f.restart().poll('admin', id)).toEqual({ status: 'connected' })
    expect(JSON.parse(f.storage.get(recordKey(f.env))!)).toMatchObject({ connectedBy: 'Noah' })
  })
})

describe('self-hosted server connection', () => {
  test('holds verifier on server, validates origin, saves only scoped token and returns no credential', async () => {
    const f = fixture()
    const start = await f.service.start('admin', 'Example')
    expect(start).toEqual({ id, approvalUrl: `https://cloud.example.com/connect/server?request=${id}`, expiresIn: 600 })
    expect(await f.service.poll('admin', id)).toEqual({ status: 'pending' })
    expect(f.saved).toHaveLength(0)
    f.setReply('connected')
    const result = await f.service.poll('admin', id)
    expect(result).toEqual({ status: 'connected' })
    expect(f.saved).toEqual([[relayConnectionSecretKey(f.env), token, 'admin']])
    for (const call of f.calls) {
      expect(call.url).toStartWith('https://cloud.example.com/api/relay-server/')
      expect(call.init.redirect).toBe('error')
    }
    await expect(f.service.poll('admin', id)).rejects.toThrow('expired')
  })
  test('connects an APP_URL-only server under a reverse-proxy path', async () => {
    const f = fixture()
    delete f.env.PUBLIC_URL
    f.env.APP_URL = 'https://home.example.com/ficus/'
    f.env.FICUS_API_URL = 'http://127.0.0.1:3000'
    f.setOrigin('https://home.example.com/ficus')
    const before = await f.service.status()
    expect(before.origin).toBe('https://home.example.com/ficus')
    expect('setupError' in before ? before.setupError : undefined).toBeUndefined()
    await f.service.start('admin', 'Home')
    expect(JSON.parse(String(f.calls[0]?.init.body)).origin).toBe('https://home.example.com/ficus')
    f.setReply('connected')
    expect(await f.service.poll('admin', id)).toEqual({ status: 'connected' })
    expect(f.saved).toEqual([[relayConnectionSecretKey(f.env), token, 'admin']])
  })
  test('changing APP_URL invalidates an approval even when legacy PUBLIC_URL remains unchanged', async () => {
    const f = fixture()
    await f.service.start('admin', 'Home')
    f.env.APP_URL = 'https://new.example.com/ficus'
    await expect(f.service.poll('admin', id)).rejects.toThrow('address changed')
    expect(f.saved).toHaveLength(0)
  })
  test('another user cannot redeem a pending request', async () => {
    const f = fixture()
    await f.service.start('admin', 'Example')
    await expect(f.service.poll('other', id)).rejects.toThrow('expired')
    expect(f.calls).toHaveLength(1)
  })
  test('refuses credential for a different origin without persisting it', async () => {
    const f = fixture()
    await f.service.start('admin', 'Example')
    f.setReply('connected')
    f.setOrigin('https://other.example.com')
    await expect(f.service.poll('admin', id)).rejects.toThrow('different server')
    expect(f.saved).toHaveLength(0)
  })
  test('configuration changes invalidate approval and bind persisted credential to both origins', async () => {
    const f = fixture()
    const original = relayConnectionSecretKey(f.env)
    await f.service.start('admin', 'Example')
    f.env.FICUS_PUSH_RELAY_URL = 'https://other-cloud.example.com'
    expect(relayConnectionSecretKey(f.env)).not.toBe(original)
    await expect(f.service.poll('admin', id)).rejects.toThrow('address changed')
    expect(f.calls).toHaveLength(1)
  })
  test('expiry and denial remove authority to complete an approval', async () => {
    const f = fixture()
    await f.service.start('admin', 'Example')
    f.setReply('denied')
    expect(await f.service.poll('admin', id)).toEqual({ status: 'denied' })
    await expect(f.service.poll('admin', id)).rejects.toThrow('expired')
    await f.service.start('admin', 'Example')
    f.advance(600001)
    await expect(f.service.poll('admin', id)).rejects.toThrow('expired')
    expect(f.saved).toHaveLength(0)
  })
  test('disconnect persists empty tombstone and invalidates in-flight approvals', async () => {
    const f = fixture()
    await f.service.start('admin', 'Example')
    expect(await f.service.disconnect('admin')).toEqual({ disconnected: true })
    expect(f.saved).toEqual([[relayConnectionSecretKey(f.env), '', 'admin']])
    await expect(f.service.poll('admin', id)).rejects.toThrow('expired')
  })
  test('recovers the same issued credential after persistence failure and API restart', async () => {
    const f = fixture()
    await f.service.start('admin', 'Example')
    f.setReply('connected')
    f.failSave(true)
    await expect(f.service.poll('admin', id)).rejects.toThrow('persistence failure')
    expect(f.saved).toHaveLength(0)
    f.failSave(false)
    expect(await f.restart().poll('admin', id)).toEqual({ status: 'connected' })
    expect(f.saved).toEqual([[relayConnectionSecretKey(f.env), token, 'admin']])
    expect(f.storage.get('__push-relay-pending')).toBe('')
    expect(f.storage.has(`__push-relay-verifier:${id}`)).toBe(false)
  })
  test('disconnect invalidates durable approval even when clearing credential fails', async () => {
    const f = fixture()
    await f.service.start('admin', 'Example')
    f.failSave(true)
    await expect(f.service.disconnect('admin')).rejects.toThrow('persistence failure')
    await expect(f.restart().poll('admin', id)).rejects.toThrow('expired')
    f.failSave(false)
    await f.restart().disconnect('admin')
    expect(f.saved).toEqual([[relayConnectionSecretKey(f.env), '', 'admin']])
  })
  test('terminal revocation allows an immediate fresh approval but transport failure retains recovery', async () => {
    const revoked = fixture()
    await revoked.service.start('admin', 'Example')
    revoked.tokenError(401)
    await expect(revoked.service.poll('admin', id)).rejects.toThrow('expired or was revoked')
    expect(revoked.storage.get('__push-relay-pending')).toBe('')
    await revoked.restart().start('admin', 'Example')
    expect(revoked.calls.filter((call) => call.url.endsWith('/authorize'))).toHaveLength(2)

    const transient = fixture()
    await transient.service.start('admin', 'Example')
    transient.tokenError(503)
    await expect(transient.service.poll('admin', id)).rejects.toThrow('Could not reach Ficus Cloud')
    expect(transient.storage.get('__push-relay-pending')).not.toBe('')
    await transient.restart().start('admin', 'Example')
    expect(transient.calls.filter((call) => call.url.endsWith('/authorize'))).toHaveLength(1)
    transient.tokenError(undefined)
    transient.setReply('connected')
    expect(await transient.restart().poll('admin', id)).toEqual({ status: 'connected' })
  })
  test('managed Cloud needs no request and cannot be overridden', async () => {
    const f = fixture()
    f.env.FICUS_MANAGED = '1'
    expect(await f.service.status()).toMatchObject({ managed: true, connected: true })
    await expect(f.service.start('admin', 'Example')).rejects.toThrow('automatically')
    await expect(f.service.disconnect('admin')).rejects.toThrow('automatically')
    expect(f.calls).toHaveLength(0)
    expect(f.saved).toHaveLength(0)
  })
  test('requires public HTTPS origin and reuses a durable pending request', async () => {
    const f = fixture()
    f.env.PUBLIC_URL = 'http://192.0.2.1:8080'
    await expect(f.service.start('admin', 'Example')).rejects.toThrow('HTTPS')
    expect(f.calls).toHaveLength(0)
    f.env.PUBLIC_URL = 'https://192.0.2.1:8443'
    await f.service.start('admin', 'Example')
    expect(await f.restart().start('admin', 'Example')).toMatchObject({ id })
    expect(f.calls).toHaveLength(1)
    await expect(f.service.start('other', 'Example')).rejects.toThrow('administrator')
  })
})

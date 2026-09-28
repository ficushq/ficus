import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { eq, inArray, like } from 'drizzle-orm'
import { Hono } from 'hono'
import { createRemoteHostsRouter } from './remote-hosts'
import { identityMiddleware } from '../middleware/identity'
import { db, agents, remoteHostGrants, remoteHosts, roles, squads } from '../db'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import * as onboardingEvents from '../services/onboarding/events'
import {
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestUser,
  type TestUser,
} from '../test-utils'

const prefix = `rhroute-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

describe('remote-hosts routes', () => {
  let admin: TestUser
  let unprivileged: TestUser
  let priorKey: string | undefined

  beforeAll(async () => {
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
    resetSecretStore()
    await getSecretStore().initialize()

    admin = await createTestAdmin({ prefix })
    unprivileged = await createTestUser({ prefix })
  })

  afterAll(async () => {
    await cleanupTestRbac(prefix)
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    resetSecretStore()
  })

  afterEach(async () => {
    const all = await db.select({ id: remoteHosts.id, name: remoteHosts.name }).from(remoteHosts)
    for (const h of all) {
      if (h.name.startsWith(prefix)) {
        await db.delete(remoteHosts).where(eq(remoteHosts.id, h.id)) // cascades grants
        await getSecretStore().delete(`remote-host-ssh:${h.id}`)
      }
    }
  })

  // No-op materialize by default: route tests assert DB/API state, not the
  // filesystem side effects covered by materialize.test.ts. Individual tests
  // override this to assert invocation.
  function authedRouter(deps: Parameters<typeof createRemoteHostsRouter>[0] = {}) {
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.route('/', createRemoteHostsRouter({ materialize: async () => {}, ...deps }))
    return app
  }

  function req(method = 'GET', body?: unknown, token = admin.token) {
    return {
      method,
      headers: { ...authHeaders(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }
  }

  async function createHost(router: Hono, overrides: Record<string, unknown> = {}) {
    const res = await router.request(
      '/',
      req('POST', {
        name: `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
        sshHost: '10.0.0.1',
        sshUser: 'tau',
        ...overrides,
      })
    )
    expect(res.status).toBe(201)
    return res.json()
  }

  async function createSquad(name: string) {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${prefix} ${name}`, purpose: 'test squad', status: 'active' })
      .returning()
    return squad
  }

  it('rejects unauthenticated and unprivileged access', async () => {
    const router = authedRouter()
    expect((await router.request('/')).status).toBe(401)
    expect(
      (
        await router.request(
          '/',
          req('POST', { name: `${prefix}-unauth`, sshHost: 'h', sshUser: 'u' }, unprivileged.token)
        )
      ).status
    ).toBe(403)
  })

  it('registers a host, returning the public key and never any private key material', async () => {
    const router = authedRouter()
    const created = await createHost(router, { name: `${prefix}-a` })

    expect(created.sshPublicKey).toContain('ssh-ed25519')
    expect(created.sshKeyId).toBeUndefined()
    expect(created.squadIds).toEqual([])
    expect(JSON.stringify(created)).not.toContain('PRIVATE KEY')

    const getRes = await router.request(`/${created.id}`, req('GET'))
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json()
    expect(getBody.sshPublicKey).toBe(created.sshPublicKey)
    expect(getBody.sshKeyId).toBeUndefined()
    expect(JSON.stringify(getBody)).not.toContain('PRIVATE KEY')
  })

  it('notifies onboarding (remote_hosts signal) on create and on delete', async () => {
    const router = authedRouter()
    const createSpy = spyOn(onboardingEvents, 'notifyOnboardingChanged')
    const created = await createHost(router, { name: `${prefix}-notify` })
    expect(createSpy).toHaveBeenCalledTimes(1)
    createSpy.mockClear()

    const delRes = await router.request(`/${created.id}`, req('DELETE'))
    expect(delRes.status).toBe(204)
    expect(createSpy).toHaveBeenCalledTimes(1)
    createSpy.mockRestore()
  })

  it('defaults sshPort to 22 and accepts an explicit port', async () => {
    const router = authedRouter()
    const withDefault = await createHost(router, { name: `${prefix}-port-default` })
    expect(withDefault.sshPort).toBe(22)

    const withPort = await createHost(router, { name: `${prefix}-port-explicit`, sshPort: 2222 })
    expect(withPort.sshPort).toBe(2222)
  })

  it('rejects duplicate names with 409', async () => {
    const router = authedRouter()
    const payload = { name: `${prefix}-dup`, sshHost: '10.0.0.2', sshUser: 'tau' }
    expect((await router.request('/', req('POST', payload))).status).toBe(201)
    expect((await router.request('/', req('POST', payload))).status).toBe(409)
  })

  it('rejects a name outside the charset with 400', async () => {
    const router = authedRouter()
    const res = await router.request('/', req('POST', { name: 'Not_Valid!', sshHost: '10.0.0.3', sshUser: 'tau' }))
    expect(res.status).toBe(400)
  })

  it('rejects a whitespace-containing sshHost/sshUser with 400', async () => {
    const router = authedRouter()
    const res1 = await router.request(
      '/',
      req('POST', { name: `${prefix}-ws-host`, sshHost: '10.0.0.1 extra', sshUser: 'tau' })
    )
    expect(res1.status).toBe(400)

    const res2 = await router.request(
      '/',
      req('POST', { name: `${prefix}-ws-user`, sshHost: '10.0.0.1', sshUser: 'ta\nu' })
    )
    expect(res2.status).toBe(400)
  })

  it('404s creating a host with an unknown squadId, minting nothing', async () => {
    const router = authedRouter()
    const before = new Set(
      (await getSecretStore().list()).map((s) => s.key).filter((k) => k.startsWith('remote-host-ssh:'))
    )

    const res = await router.request(
      '/',
      req('POST', {
        name: `${prefix}-unknown-squad`,
        sshHost: '10.0.0.1',
        sshUser: 'tau',
        squadIds: ['00000000-0000-0000-0000-000000000000'],
      })
    )
    expect(res.status).toBe(404)

    const after = (await getSecretStore().list()).map((s) => s.key).filter((k) => k.startsWith('remote-host-ssh:'))
    expect(after.filter((k) => !before.has(k))).toEqual([])
  })

  it('deletes the just-minted secret when the row insert fails (rollback parity with routes/machines.ts)', async () => {
    // The keypair is persisted to the secret store BEFORE the row insert; if the
    // insert throws (e.g. a dup-name race between the pre-check and the insert)
    // the key must not orphan. Force the insert to fail via deps injection and
    // assert the secret was removed.
    const before = new Set(
      (await getSecretStore().list()).map((s) => s.key).filter((k) => k.startsWith('remote-host-ssh:'))
    )

    const router = authedRouter({
      insert: async () => {
        throw new Error('duplicate key value violates unique constraint "remote_hosts_name_unique"')
      },
    })

    const res = await router.request(
      '/',
      req('POST', { name: `${prefix}-rollback`, sshHost: '10.0.0.1', sshUser: 'tau' })
    )
    expect(res.status).toBe(500)

    const after = (await getSecretStore().list()).map((s) => s.key).filter((k) => k.startsWith('remote-host-ssh:'))
    expect(after.filter((k) => !before.has(k))).toEqual([])
  })

  it('lists hosts with their granted squad ids', async () => {
    const router = authedRouter()
    const squad = await createSquad('list-grants')
    try {
      const created = await createHost(router, { name: `${prefix}-list`, squadIds: [squad.id] })
      expect(created.squadIds).toEqual([squad.id])

      const res = await router.request('/', req('GET'))
      const list = await res.json()
      const found = list.find((h: { id: string }) => h.id === created.id)
      expect(found.squadIds).toEqual([squad.id])
    } finally {
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('returns 404 for a missing host', async () => {
    const router = authedRouter()
    expect((await router.request('/00000000-0000-0000-0000-000000000000', req('GET'))).status).toBe(404)
  })

  describe('grants', () => {
    it('grants and revokes a squad, never letting a duplicate grant through', async () => {
      const router = authedRouter()
      const squad = await createSquad('grant-cycle')
      try {
        const created = await createHost(router, { name: `${prefix}-grant` })

        const grantRes = await router.request(`/${created.id}/grants`, req('POST', { squadId: squad.id }))
        expect(grantRes.status).toBe(201)
        const granted = await grantRes.json()
        expect(granted.squadIds).toEqual([squad.id])

        // Duplicate grant → 409 (decision: pre-checked, documented in report).
        const dupRes = await router.request(`/${created.id}/grants`, req('POST', { squadId: squad.id }))
        expect(dupRes.status).toBe(409)

        // Revoke now ROTATES the host key (spec §7) and returns 200 with the
        // new public key + operator guidance, not a bare 204.
        const revokeRes = await router.request(`/${created.id}/grants/${squad.id}`, req('DELETE'))
        expect(revokeRes.status).toBe(200)
        expect((await revokeRes.json()).rotated).toBe(true)

        const rows = await db.select().from(remoteHostGrants).where(eq(remoteHostGrants.hostId, created.id))
        expect(rows).toEqual([])

        // Revoking again is idempotent, not a 404 (only a missing HOST 404s) —
        // it still rotates the key (nothing granted to break).
        const revokeAgain = await router.request(`/${created.id}/grants/${squad.id}`, req('DELETE'))
        expect(revokeAgain.status).toBe(200)
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('404s granting/revoking against an unknown squad or host', async () => {
      const router = authedRouter()
      const created = await createHost(router, { name: `${prefix}-grant-404` })

      const unknownSquad = await router.request(
        `/${created.id}/grants`,
        req('POST', { squadId: '00000000-0000-0000-0000-000000000000' })
      )
      expect(unknownSquad.status).toBe(404)

      const unknownHost = await router.request(
        '/00000000-0000-0000-0000-000000000000/grants',
        req('POST', { squadId: '00000000-0000-0000-0000-000000000000' })
      )
      expect(unknownHost.status).toBe(404)
    })
  })

  describe('revoke rotates the host key (spec §7)', () => {
    it('rotates the keypair: new public key, new secret in place, surfaced with authorized_keys guidance', async () => {
      const router = authedRouter()
      const squad = await createSquad('rotate')
      try {
        const created = await createHost(router, { name: `${prefix}-rotate`, squadIds: [squad.id] })
        const secretKey = `remote-host-ssh:${created.id}`
        const oldPub = created.sshPublicKey
        const oldPriv = getSecretStore().get(secretKey)
        expect(oldPub).toContain('ssh-ed25519')
        expect(oldPriv).toBeString()

        const res = await router.request(`/${created.id}/grants/${squad.id}`, req('DELETE'))
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.revoked).toBe(true)
        expect(body.rotated).toBe(true)
        expect(body.sshPublicKey).toContain('ssh-ed25519')
        expect(body.sshPublicKey).not.toBe(oldPub)
        expect(body.message).toContain('authorized_keys')
        // Never leak private key material in the rotation response.
        expect(JSON.stringify(body)).not.toContain('PRIVATE KEY')

        // Private key rotated in place under the SAME secret-store handle.
        const newPriv = getSecretStore().get(secretKey)
        expect(newPriv).toBeString()
        expect(newPriv).not.toBe(oldPriv)

        // The host row now serves the rotated public key.
        const getRes = await router.request(`/${created.id}`, req('GET'))
        expect((await getRes.json()).sshPublicKey).toBe(body.sshPublicKey)
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('re-materializes the revoked squad (drop) then every remaining granted squad (new key)', async () => {
      const calls: string[] = []
      const router = authedRouter({ materialize: async (s: string) => void calls.push(s) })
      const squadA = await createSquad('rotate-mat-a')
      const squadB = await createSquad('rotate-mat-b')
      try {
        const created = await createHost(router, {
          name: `${prefix}-rotate-mat`,
          squadIds: [squadA.id, squadB.id],
        })

        calls.length = 0
        const res = await router.request(`/${created.id}/grants/${squadA.id}`, req('DELETE'))
        expect(res.status).toBe(200)
        // Revoked squad first (drop its stanza), then the still-granted squad.
        expect(calls).toEqual([squadA.id, squadB.id])
      } finally {
        await db.delete(squads).where(inArray(squads.id, [squadA.id, squadB.id]))
      }
    })

    it('rotation failure: revoke still persists, response warns, previous key stays valid', async () => {
      // Seed the host with a working keypair, then revoke through a router whose
      // keypair mint throws — the grant delete is committed BEFORE rotation, so
      // a failed rotation must leave the revoke standing and the old key intact.
      const seedRouter = authedRouter()
      const squad = await createSquad('rotate-fail')
      try {
        const created = await createHost(seedRouter, { name: `${prefix}-rotate-fail`, squadIds: [squad.id] })
        const secretKey = `remote-host-ssh:${created.id}`
        const oldPub = created.sshPublicKey
        const oldPriv = getSecretStore().get(secretKey)

        const failRouter = authedRouter({
          generateKeypair: async () => {
            throw new Error('ssh-keygen boom')
          },
        })
        const res = await failRouter.request(`/${created.id}/grants/${squad.id}`, req('DELETE'))
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.revoked).toBe(true)
        expect(body.rotated).toBe(false)
        expect(body.warning).toBeString()
        expect(body.sshPublicKey).toBeUndefined()

        // Revoke persisted despite the rotation failure.
        expect(await db.select().from(remoteHostGrants).where(eq(remoteHostGrants.hostId, created.id))).toEqual([])

        // Old key material is untouched — still valid for the operator to retry.
        expect(getSecretStore().get(secretKey)).toBe(oldPriv)
        const getRes = await failRouter.request(`/${created.id}`, req('GET'))
        expect((await getRes.json()).sshPublicKey).toBe(oldPub)
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('a remaining squad re-materialize failure never lies about rotation: rotated:true, others still materialized, revoke persisted', async () => {
      // The mint + persist succeed, so the key HAS rotated. Delivering it to the
      // remaining granted squads is best-effort — one squad's materialize throwing
      // must NOT flip the response to rotated:false (which would tell the operator
      // the old key still works while the store/row already hold the new one).
      const seedRouter = authedRouter()
      const squadRevoked = await createSquad('remat-fail-revoked')
      const squadFail = await createSquad('remat-fail-fail')
      const squadOk = await createSquad('remat-fail-ok')
      try {
        const created = await createHost(seedRouter, {
          name: `${prefix}-remat-fail`,
          squadIds: [squadRevoked.id, squadFail.id, squadOk.id],
        })
        const oldPub = created.sshPublicKey

        const materialized: string[] = []
        const failRouter = authedRouter({
          materialize: async (s: string) => {
            if (s === squadFail.id) throw new Error('materialize boom')
            materialized.push(s)
          },
        })

        const res = await failRouter.request(`/${created.id}/grants/${squadRevoked.id}`, req('DELETE'))
        expect(res.status).toBe(200)
        const body = await res.json()

        // Rotation happened: honest rotated:true carrying the NEW public key.
        expect(body.revoked).toBe(true)
        expect(body.rotated).toBe(true)
        expect(body.sshPublicKey).toContain('ssh-ed25519')
        expect(body.sshPublicKey).not.toBe(oldPub)

        // The throwing squad did not abort the loop — the revoked squad's drop
        // and the other remaining squad were still materialized.
        expect(materialized).toContain(squadRevoked.id)
        expect(materialized).toContain(squadOk.id)

        // Revoke persisted: only squadRevoked's grant is gone; the others remain.
        const grants = await db.select().from(remoteHostGrants).where(eq(remoteHostGrants.hostId, created.id))
        expect(grants.map((g) => g.squadId).sort()).toEqual([squadFail.id, squadOk.id].sort())

        // Host row serves the rotated key.
        const getRes = await failRouter.request(`/${created.id}`, req('GET'))
        expect((await getRes.json()).sshPublicKey).toBe(body.sshPublicKey)
      } finally {
        await db.delete(squads).where(inArray(squads.id, [squadRevoked.id, squadFail.id, squadOk.id]))
      }
    })

    it('never opens an ssh connection to the host during revoke+rotate (no remote mutation)', async () => {
      let sshCalls = 0
      const router = authedRouter({
        sshRunner: {
          run: async () => {
            sshCalls++
            return { exitCode: 0, stdout: '', stderr: '' }
          },
        },
      })
      const squad = await createSquad('rotate-no-ssh')
      try {
        const created = await createHost(router, { name: `${prefix}-rotate-no-ssh`, squadIds: [squad.id] })
        const res = await router.request(`/${created.id}/grants/${squad.id}`, req('DELETE'))
        expect(res.status).toBe(200)
        expect(sshCalls).toBe(0)
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })
  })

  describe('DELETE /:id', () => {
    it('deletes the host row + its secret, and its grants cascade away', async () => {
      const router = authedRouter()
      const squad = await createSquad('delete-cascade')
      try {
        const created = await createHost(router, { name: `${prefix}-del`, squadIds: [squad.id] })
        const secretKey = `remote-host-ssh:${created.id}`
        expect(getSecretStore().get(secretKey)).toBeString()

        const res = await router.request(`/${created.id}`, req('DELETE'))
        expect(res.status).toBe(204)

        expect(getSecretStore().get(secretKey)).toBeUndefined()
        expect(await db.select().from(remoteHosts).where(eq(remoteHosts.id, created.id))).toEqual([])
        expect(await db.select().from(remoteHostGrants).where(eq(remoteHostGrants.hostId, created.id))).toEqual([])
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('returns 404 deleting a missing host', async () => {
      const router = authedRouter()
      expect((await router.request('/00000000-0000-0000-0000-000000000000', req('DELETE'))).status).toBe(404)
    })
  })

  describe('POST /:id/check', () => {
    it('reports reachable when the injected runner exits 0', async () => {
      const router = authedRouter({ sshRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } })
      const created = await createHost(router, { name: `${prefix}-check-ok` })

      const res = await router.request(`/${created.id}/check`, req('POST'))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ reachable: true })
    })

    it('reports unreachable with the stderr tail on a non-zero exit', async () => {
      const router = authedRouter({
        sshRunner: { run: async () => ({ exitCode: 255, stdout: '', stderr: 'Connection refused' }) },
      })
      const created = await createHost(router, { name: `${prefix}-check-fail` })

      const res = await router.request(`/${created.id}/check`, req('POST'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reachable).toBe(false)
      expect(body.error).toContain('Connection refused')
    })

    it('reports unreachable (never throws) when the runner itself throws', async () => {
      const router = authedRouter({
        sshRunner: {
          run: async () => {
            throw new Error('boom')
          },
        },
      })
      const created = await createHost(router, { name: `${prefix}-check-throw` })

      const res = await router.request(`/${created.id}/check`, req('POST'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reachable).toBe(false)
      expect(body.error).toContain('boom')
    })

    it('maps a missing-secret error (materializePrivateKey) to a generic message, never leaking the secret handle', async () => {
      const router = authedRouter({
        sshRunner: {
          run: async () => {
            // Mirrors keys.ts's materializePrivateKey throw shape exactly, since
            // the real defaultSshRunner materializes the key internally before
            // connecting — the secret-store handle (`remote-host-ssh:<id>`)
            // must never reach the API caller.
            throw new Error("no private key stored (secret 'remote-host-ssh:some-host-id')")
          },
        },
      })
      const created = await createHost(router, { name: `${prefix}-check-nokey` })

      const res = await router.request(`/${created.id}/check`, req('POST'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reachable).toBe(false)
      expect(body.error).toBe('no key available for this host')
      expect(body.error).not.toContain('remote-host-ssh')
    })
  })

  describe('materializer invocation', () => {
    it('invokes materialize for every affected squad on create+grant, grant, revoke, and delete', async () => {
      const calls: string[] = []
      const router = authedRouter({ materialize: async (squadId: string) => void calls.push(squadId) })
      const squadA = await createSquad('mat-a')
      const squadB = await createSquad('mat-b')
      try {
        calls.length = 0
        const created = await createHost(router, { name: `${prefix}-mat`, squadIds: [squadA.id] })
        expect(calls).toEqual([squadA.id])

        calls.length = 0
        await router.request(`/${created.id}/grants`, req('POST', { squadId: squadB.id }))
        expect(calls).toEqual([squadB.id])

        calls.length = 0
        await router.request(`/${created.id}/grants/${squadA.id}`, req('DELETE'))
        // Revoke re-materializes the revoked squad (drop its stanza) AND every
        // remaining granted squad (deliver the rotated key) — spec §7.
        expect(calls).toEqual([squadA.id, squadB.id])

        calls.length = 0
        await router.request(`/${created.id}`, req('DELETE'))
        // Only squadB was still granted at delete time.
        expect(calls).toEqual([squadB.id])
      } finally {
        await db.delete(squads).where(inArray(squads.id, [squadA.id, squadB.id]))
      }
    })
  })

  describe('squad surface', () => {
    async function seedWorkerRole() {
      await db
        .insert(roles)
        .values({
          name: 'Default Worker',
          slug: 'default-worker',
          isSystem: true,
          permissions: ['remote-hosts:read', 'remote-hosts:write'],
        })
        .onConflictDoUpdate({
          target: roles.slug,
          set: { permissions: ['remote-hosts:read', 'remote-hosts:write'] },
        })
    }

    async function agentToken(squadId: string) {
      const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId }).returning()
      const tok = await createTestAgentToken({ agentId: agent.id, squadId })
      return { agent, tok }
    }

    it('add-and-grant creates a host and grants it to the squad in one step', async () => {
      await seedWorkerRole()
      const squad = await createSquad('add-grant')
      const { agent, tok } = await agentToken(squad.id)
      try {
        const router = authedRouter()
        const res = await router.request(
          `/squad/${squad.id}`,
          req('POST', { name: `${prefix}-squad-add`, sshHost: '10.0.0.9', sshUser: 'tau' }, tok.token)
        )
        expect(res.status).toBe(201)
        const body = await res.json()
        expect(body.squadIds).toEqual([squad.id])
        expect(body.sshKeyId).toBeUndefined()

        const listRes = await router.request(`/squad/${squad.id}`, req('GET', undefined, tok.token))
        const list = await listRes.json()
        expect(list.some((h: { id: string }) => h.id === body.id)).toBe(true)
      } finally {
        await db.delete(agents).where(eq(agents.id, agent.id))
        await db.delete(squads).where(eq(squads.id, squad.id))
        await db.delete(roles).where(eq(roles.slug, 'default-worker'))
      }
    })

    it('add-and-grant deletes the just-minted secret when the row insert fails (rollback parity)', async () => {
      await seedWorkerRole()
      const squad = await createSquad('add-grant-rollback')
      const { agent, tok } = await agentToken(squad.id)
      try {
        const before = new Set(
          (await getSecretStore().list()).map((s) => s.key).filter((k) => k.startsWith('remote-host-ssh:'))
        )

        const router = authedRouter({
          insert: async () => {
            throw new Error('duplicate key value violates unique constraint "remote_hosts_name_unique"')
          },
        })
        const res = await router.request(
          `/squad/${squad.id}`,
          req('POST', { name: `${prefix}-squad-add-rollback`, sshHost: '10.0.0.9', sshUser: 'tau' }, tok.token)
        )
        expect(res.status).toBe(500)

        const after = (await getSecretStore().list()).map((s) => s.key).filter((k) => k.startsWith('remote-host-ssh:'))
        expect(after.filter((k) => !before.has(k))).toEqual([])
      } finally {
        await db.delete(agents).where(eq(agents.id, agent.id))
        await db.delete(squads).where(eq(squads.id, squad.id))
        await db.delete(roles).where(eq(roles.slug, 'default-worker'))
      }
    })

    it('a worker role with only remote-hosts:read gets 403 on add-and-grant (POST /squad/:squadId)', async () => {
      // Unlike seedWorkerRole (which grants both read+write for the other squad-
      // surface tests), this seeds a role with read ONLY, so the write-gated
      // add-and-grant route must reject it — a genuine read/write boundary check,
      // not just an unauthenticated/unprivileged-entirely check.
      await db
        .insert(roles)
        .values({
          name: 'Default Worker',
          slug: 'default-worker',
          isSystem: true,
          permissions: ['remote-hosts:read'],
        })
        .onConflictDoUpdate({
          target: roles.slug,
          set: { permissions: ['remote-hosts:read'] },
        })
      const squad = await createSquad('read-only-boundary')
      const { agent, tok } = await agentToken(squad.id)
      try {
        const router = authedRouter()
        const res = await router.request(
          `/squad/${squad.id}`,
          req('POST', { name: `${prefix}-read-only`, sshHost: '10.0.0.9', sshUser: 'tau' }, tok.token)
        )
        expect(res.status).toBe(403)
      } finally {
        await db.delete(agents).where(eq(agents.id, agent.id))
        await db.delete(squads).where(eq(squads.id, squad.id))
        await db.delete(roles).where(eq(roles.slug, 'default-worker'))
      }
    })

    it('squad revoke removes only this squad grant and never deletes the host', async () => {
      await seedWorkerRole()
      const squad = await createSquad('squad-revoke')
      const { agent, tok } = await agentToken(squad.id)
      try {
        const router = authedRouter()
        const created = await createHost(router, { name: `${prefix}-squad-revoke`, squadIds: [squad.id] })

        const revokeRes = await router.request(`/squad/${squad.id}/${created.id}`, req('DELETE', undefined, tok.token))
        expect(revokeRes.status).toBe(200)
        expect((await revokeRes.json()).rotated).toBe(true)

        // Grant gone...
        expect(await db.select().from(remoteHostGrants).where(eq(remoteHostGrants.hostId, created.id))).toEqual([])
        // ...but the host row itself survives (admin-only delete).
        const stillThere = await router.request(`/${created.id}`, req('GET'))
        expect(stillThere.status).toBe(200)
      } finally {
        await db.delete(agents).where(eq(agents.id, agent.id))
        await db.delete(squads).where(eq(squads.id, squad.id))
        await db.delete(roles).where(eq(roles.slug, 'default-worker'))
      }
    })

    it('squad revoke on an already-deleted host returns a distinguishing no-op message', async () => {
      const squad = await createSquad('squad-revoke-gone')
      try {
        const router = authedRouter()
        // A host id that has no row: the revoke is an idempotent grant-delete
        // with no key material left to rotate. The message distinguishes this
        // from a genuine rotation failure (which carries a `warning`).
        const goneHostId = '00000000-0000-0000-0000-000000000000'
        const res = await router.request(`/squad/${squad.id}/${goneHostId}`, req('DELETE'))
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.revoked).toBe(true)
        expect(body.rotated).toBe(false)
        expect(body.message).toBe('Host already deleted; nothing to rotate.')
        expect(body.warning).toBeUndefined()
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('cross-squad IDOR: squad-A agent token gets 403 on squad-B list/add/revoke', async () => {
      await seedWorkerRole()
      const squadA = await createSquad('idor-a')
      const squadB = await createSquad('idor-b')
      const { agent, tok } = await agentToken(squadA.id)
      try {
        const router = authedRouter()

        const listRes = await router.request(`/squad/${squadB.id}`, req('GET', undefined, tok.token))
        expect(listRes.status).toBe(403)

        const addRes = await router.request(
          `/squad/${squadB.id}`,
          req('POST', { name: `${prefix}-idor`, sshHost: '10.0.0.9', sshUser: 'tau' }, tok.token)
        )
        expect(addRes.status).toBe(403)

        const revokeRes = await router.request(
          `/squad/${squadB.id}/00000000-0000-0000-0000-000000000000`,
          req('DELETE', undefined, tok.token)
        )
        expect(revokeRes.status).toBe(403)
      } finally {
        await db.delete(agents).where(eq(agents.id, agent.id))
        await db.delete(squads).where(inArray(squads.id, [squadA.id, squadB.id]))
        await db.delete(roles).where(eq(roles.slug, 'default-worker'))
      }
    })

    describe('POST /squad/:squadId/check/:hostId', () => {
      it('squad-scoped write can check a host granted to its own squad', async () => {
        await seedWorkerRole()
        const squad = await createSquad('check-granted')
        const { agent, tok } = await agentToken(squad.id)
        try {
          const router = authedRouter({
            sshRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
          })
          const created = await createHost(router, { name: `${prefix}-squad-check`, squadIds: [squad.id] })

          const res = await router.request(`/squad/${squad.id}/check/${created.id}`, req('POST', undefined, tok.token))
          expect(res.status).toBe(200)
          expect(await res.json()).toEqual({ reachable: true })
        } finally {
          await db.delete(agents).where(eq(agents.id, agent.id))
          await db.delete(squads).where(eq(squads.id, squad.id))
          await db.delete(roles).where(eq(roles.slug, 'default-worker'))
        }
      })

      it('404s checking a host that is not granted to the squad', async () => {
        await seedWorkerRole()
        const squad = await createSquad('check-ungranted')
        const { agent, tok } = await agentToken(squad.id)
        try {
          const router = authedRouter()
          const created = await createHost(router, { name: `${prefix}-squad-check-ungranted` }) // no grant

          const res = await router.request(`/squad/${squad.id}/check/${created.id}`, req('POST', undefined, tok.token))
          expect(res.status).toBe(404)
        } finally {
          await db.delete(agents).where(eq(agents.id, agent.id))
          await db.delete(squads).where(eq(squads.id, squad.id))
          await db.delete(roles).where(eq(roles.slug, 'default-worker'))
        }
      })

      it('cross-squad IDOR: squad-A agent gets 403 checking on squad-B surface', async () => {
        await seedWorkerRole()
        const squadA = await createSquad('check-idor-a')
        const squadB = await createSquad('check-idor-b')
        const { agent, tok } = await agentToken(squadA.id)
        try {
          const router = authedRouter()
          const created = await createHost(router, { name: `${prefix}-squad-check-idor`, squadIds: [squadB.id] })

          const res = await router.request(`/squad/${squadB.id}/check/${created.id}`, req('POST', undefined, tok.token))
          expect(res.status).toBe(403)
        } finally {
          await db.delete(agents).where(eq(agents.id, agent.id))
          await db.delete(squads).where(inArray(squads.id, [squadA.id, squadB.id]))
          await db.delete(roles).where(eq(roles.slug, 'default-worker'))
        }
      })
    })

    describe('POST /squad/:squadId/sync', () => {
      it('400s for a user identity (agent-only route)', async () => {
        const squad = await createSquad('sync-user')
        try {
          const router = authedRouter()
          const res = await router.request(`/squad/${squad.id}/sync`, req('POST', undefined, admin.token))
          expect(res.status).toBe(400)
        } finally {
          await db.delete(squads).where(eq(squads.id, squad.id))
        }
      })

      it('403s an agent syncing a squad other than its own', async () => {
        await seedWorkerRole()
        const squadA = await createSquad('sync-a')
        const squadB = await createSquad('sync-b')
        const { agent, tok } = await agentToken(squadA.id)
        try {
          const router = authedRouter()
          const res = await router.request(`/squad/${squadB.id}/sync`, req('POST', undefined, tok.token))
          expect(res.status).toBe(403)
        } finally {
          await db.delete(agents).where(eq(agents.id, agent.id))
          await db.delete(squads).where(inArray(squads.id, [squadA.id, squadB.id]))
          await db.delete(roles).where(eq(roles.slug, 'default-worker'))
        }
      })

      it('returns {pushed:false, reason:"live-mount"} for an agent syncing its own squad with no vm box row', async () => {
        await seedWorkerRole()
        const squad = await createSquad('sync-own')
        const { agent, tok } = await agentToken(squad.id)
        try {
          const router = authedRouter()
          const res = await router.request(`/squad/${squad.id}/sync`, req('POST', undefined, tok.token))
          expect(res.status).toBe(200)
          expect(await res.json()).toEqual({ pushed: false, reason: 'live-mount' })
        } finally {
          await db.delete(agents).where(eq(agents.id, agent.id))
          await db.delete(squads).where(eq(squads.id, squad.id))
          await db.delete(roles).where(eq(roles.slug, 'default-worker'))
        }
      })

      it("invokes pushSquadSshToBox with the calling agent's own sandboxId (agent_<agentId>)", async () => {
        await seedWorkerRole()
        const squad = await createSquad('sync-invoke')
        const { agent, tok } = await agentToken(squad.id)
        try {
          const calls: Array<{ squadId: string; sandboxId: string }> = []
          const router = authedRouter({
            pushSquadSshToBox: async (squadId: string, sandboxId: string) => {
              calls.push({ squadId, sandboxId })
              return { pushed: true }
            },
          })
          const res = await router.request(`/squad/${squad.id}/sync`, req('POST', undefined, tok.token))
          expect(res.status).toBe(200)
          expect(await res.json()).toEqual({ pushed: true })
          expect(calls).toEqual([{ squadId: squad.id, sandboxId: `agent_${agent.id}` }])
        } finally {
          await db.delete(agents).where(eq(agents.id, agent.id))
          await db.delete(squads).where(eq(squads.id, squad.id))
          await db.delete(roles).where(eq(roles.slug, 'default-worker'))
        }
      })
    })
  })

  it('cleans up any stray squads created under this prefix', async () => {
    await db.delete(squads).where(like(squads.name, `${prefix}%`))
  })
})

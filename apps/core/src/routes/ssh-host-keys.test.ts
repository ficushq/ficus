import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, inArray, like } from 'drizzle-orm'
import { Hono } from 'hono'
import { agents, db, machines, squads, sshTrustTargets } from '../db'
import { authzSentinel } from '../middleware/authz-sentinel'
import { identityMiddleware } from '../middleware/identity'
import { ensureTrustTarget, machineTrustSpec } from '../services/ssh-trust'
import {
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { createSshHostKeysRouter } from './ssh-host-keys'

const prefix = `sshhk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// Synthetic host key blob (4-byte length + type + payload). Never a real host's key.
function syntheticKey(seed: string): string {
  const type = Buffer.from('ssh-ed25519')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(type.length)
  return Buffer.concat([len, type, Buffer.from(`synthetic-${seed}`)]).toString('base64')
}

describe('ssh host keys routes', () => {
  let admin: TestUser
  let unprivileged: TestUser
  const machineIds: string[] = []
  const squadIds: string[] = []
  const agentIds: string[] = []

  // The scanner is always a synthetic fake: these tests never connect anywhere.
  const app = new Hono()
  app.use('*', identityMiddleware)
  // Production's sentinel: every route must run an authorization guard.
  app.use('*', authzSentinel)
  app.route(
    '/api/ssh-host-keys',
    createSshHostKeysRouter({ scanner: async () => [{ keyType: 'ssh-ed25519', publicKey: syntheticKey(prefix) }] })
  )

  const api = (path: string, init: RequestInit) => app.request(`/api/ssh-host-keys${path === '/' ? '' : path}`, init)

  function req(method: string, token: string) {
    return { method, headers: authHeaders(token) }
  }

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix })
    unprivileged = await createTestUser({ prefix })
  })

  afterAll(async () => {
    await db.delete(sshTrustTargets).where(like(sshTrustTargets.label, `%${prefix}%`))
    if (machineIds.length) await db.delete(machines).where(inArray(machines.id, machineIds))
    for (const id of agentIds) await db.delete(agents).where(eq(agents.id, id))
    if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds))
    await cleanupTestRbac(prefix)
  })

  async function machineTarget() {
    const [machine] = await db
      .insert(machines)
      .values({
        name: `${prefix}-${machineIds.length}`,
        provider: 'ssh',
        sshHost: '10.0.0.9',
        sshUser: 'ficus',
        sshKeyId: `${prefix}-secret`,
        sshPublicKey: 'ssh-ed25519 AAAA test',
      })
      .returning()
    machineIds.push(machine.id)
    return ensureTrustTarget(machineTrustSpec(machine))
  }

  /** An agent holding the admin's own permissions: only the person check can stop it. */
  async function adminPoweredAgent() {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'system-manager', ownerUserId: admin.id }).returning()
    agentIds.push(agent.id)
    return createTestAgentToken({ agentId: agent.id, squadId: null, userId: admin.id })
  }

  it('lists machine host keys for machines:read only', async () => {
    const target = await machineTarget()
    const res = await api('/', req('GET', admin.token))
    expect(res.status).toBe(200)
    const listed = (await res.json()) as Array<{ id: string; hostKeyState: string; machineId: string }>
    expect(listed.find((t) => t.id === target.id)).toMatchObject({ hostKeyState: 'unverified' })
    expect((await api('/', req('GET', unprivileged.token))).status).toBe(403)
  })

  it('fetching keys never trusts one; an agent cannot trust a key even with every permission; a person can', async () => {
    const target = await machineTarget()

    const scanned = await (await api(`/${target.id}/scan`, req('POST', admin.token))).json()
    expect(scanned.hostKeyState).toBe('pending')
    const [pending] = scanned.hostKeys
    expect(pending).toMatchObject({ status: 'pending', origin: 'scan' })
    expect(JSON.stringify(scanned)).not.toContain(syntheticKey(prefix))

    const agentToken = await adminPoweredAgent()
    const refused = await api(`/${target.id}/keys/${pending.id}/trust`, req('POST', agentToken.token))
    expect(refused.status).toBe(403)
    expect((await refused.json()).code).toBe('user_session_required')
    expect((await api(`/${target.id}/keys/${pending.id}/reject`, req('POST', agentToken.token))).status).toBe(403)
    expect((await api(`/${target.id}/scan`, req('POST', unprivileged.token))).status).toBe(403)

    const trusted = await api(`/${target.id}/keys/${pending.id}/trust`, req('POST', admin.token))
    expect(trusted.status).toBe(200)
    const body = await trusted.json()
    expect(body.hostKeyState).toBe('trusted')
    expect(body.hostKeys[0]).toMatchObject({ status: 'trusted', decidedByUserId: admin.id })
    expect((await api(`/${target.id}/keys/${pending.id}/trust`, req('POST', admin.token))).status).toBe(409)
  })

  it("a squad's memory git remote is listed from its sync config and decided by a person", async () => {
    const [squad] = await db
      .insert(squads)
      .values({
        name: `${prefix} memory`,
        purpose: 'test squad',
        status: 'active',
        metadata: {
          memory: {
            enabled: true,
            sync: { providers: [{ type: 'git', repoUrl: 'git@git.example.com:org/mem.git', sshKeyName: 'k' }] },
          },
        },
      })
      .returning()
    squadIds.push(squad.id)

    const list = await api(`/squad/${squad.id}`, req('GET', admin.token))
    expect(list.status).toBe(200)
    const [target] = (await list.json()) as Array<{ id: string; scope: string; kind: string; label: string }>
    expect(target).toMatchObject({ scope: `memory-git:${squad.id}:git.example.com`, kind: 'memory-git' })
    // Labelled for cleanup.
    await db
      .update(sshTrustTargets)
      .set({ label: `Memory sync ${prefix}` })
      .where(eq(sshTrustTargets.id, target.id))

    expect((await api(`/squad/${squad.id}`, req('GET', unprivileged.token))).status).toBe(403)
    const scanned = await (await api(`/${target.id}/scan`, req('POST', admin.token))).json()
    const agentToken = await adminPoweredAgent()
    expect(
      (await api(`/${target.id}/keys/${scanned.hostKeys[0].id}/trust`, req('POST', agentToken.token))).status
    ).toBe(403)
    const trusted = await api(`/${target.id}/keys/${scanned.hostKeys[0].id}/trust`, req('POST', admin.token))
    expect((await trusted.json()).hostKeyState).toBe('trusted')
  })
})

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { db, agents, squads, workStreams, messages, roles } from '../db'
import { Agent } from '../entities/Agent'
import { Execution } from '../entities/Execution'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import { squadsRouter } from './squads'
import { getHomeDir } from '../lib/utils/home'
import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestRole,
  createTestUser,
} from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/squads', squadsRouter)

describe('guarded squad flex cleanup', () => {
  let prefix: string
  let own: Squad
  let other: Squad
  let agentIds: string[]
  let managerRoleId: string | undefined

  beforeEach(async () => {
    prefix = `cleanup-${randomUUID()}`
    agentIds = []
    managerRoleId = undefined
    own = await Squad.create({ name: `${prefix}-own`, purpose: 'cleanup fixture' })
    other = await Squad.create({ name: `${prefix}-other`, purpose: 'cleanup fixture' })
  })

  afterEach(async () => {
    // Own every fixture: never sweep another test's agents or work streams.
    await db.delete(workStreams).where(inArray(workStreams.squadId, [own.id, other.id]))
    if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds))
    await db.delete(squads).where(inArray(squads.id, [own.id, other.id]))
    if (managerRoleId) await db.delete(roles).where(eq(roles.id, managerRoleId))
    await cleanupTestRbac(prefix)
  })

  async function worker(squad = own, options: Partial<Parameters<typeof Agent.create>[0]> = {}) {
    const agent = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id, persist: false, ...options })
    agentIds.push(agent.id)
    return agent
  }

  function request(squadId: string | null, token: string | undefined, dryRun = false) {
    return app.request(`/api/squads/${squadId ? `${squadId}/` : ''}cleanup-agents${dryRun ? '?dryRun=true' : ''}`, {
      method: 'POST',
      headers: token ? authHeaders(token) : {},
    })
  }

  async function managerToken() {
    // Seed only when absent; never overwrite a role owned by another fixture.
    const [role] = await db
      .insert(roles)
      .values({
        name: `${prefix}-manager`,
        slug: 'default-manager',
        permissions: ['agents:terminate'],
      })
      .onConflictDoNothing()
      .returning()
    managerRoleId = role?.id
    const manager = await worker(own, { agentTypeId: 'manager', persist: true })
    return (await createTestAgentToken({ agentId: manager.id, squadId: own.id })).token
  }

  it('allows a manager to preview and clean only its own canonical squad, preserving history and worktrees', async () => {
    const token = await managerToken()
    const eligible = await worker()
    const foreign = await worker(other)
    const historyId = randomUUID()
    await db
      .insert(messages)
      .values({ id: historyId, agentId: eligible.id, role: 'assistant', content: 'Retained history' })
    const tree = join(getHomeDir(), 'worktrees', randomUUID())
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, 'retained'), 'worktree data')
    await storedLegacyWorkStream({
      squadId: own.id,
      title: 'retained worktree',
      agentIds: [eligible.id],
      metadata: { git: { worktree: tree } },
    })
    await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.squadId, own.id))

    const terminate = spyOn(Agent.prototype, 'tryTerminate')
    try {
      const preview = await request(own.id.slice(0, 8), token, true)
      expect(preview.status).toBe(200)
      expect(await preview.json()).toMatchObject({
        checked: 1,
        terminated: 1,
        agents: [{ id: eligible.id, squadName: own.name }],
      })
      expect(terminate).not.toHaveBeenCalled()
      await eligible.reload()
      expect(eligible.status).toBe('idle')

      const response = await request(own.id.slice(0, 8), token)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        checked: 1,
        terminated: 1,
        deferred: 0,
        agents: [{ id: eligible.id }],
      })
      await eligible.reload()
      await foreign.reload()
      expect(eligible).toMatchObject({ status: 'dormant', terminatedAt: null })
      expect(foreign.status).toBe('idle')
      expect(await db.select().from(messages).where(eq(messages.id, historyId))).toHaveLength(1)
      expect(existsSync(join(tree, 'retained'))).toBe(true)
    } finally {
      terminate.mockRestore()
    }
  })

  it('denies cross-squad, unprivileged, and unauthenticated requests before any cleanup query or lifecycle operation', async () => {
    const token = await managerToken()
    const nobody = await createTestUser({ prefix })
    await worker(other)
    const cleanup = spyOn(Squad, 'cleanupFlexAgents')
    const canTerminate = spyOn(Agent.prototype, 'canTerminate')
    const terminate = spyOn(Agent.prototype, 'tryTerminate')
    try {
      for (const dryRun of [false, true]) {
        expect((await request(other.id, token, dryRun)).status).toBe(403)
        expect((await request(other.id.slice(0, 8), token, dryRun)).status).toBe(403)
        expect((await request(own.id, nobody.token, dryRun)).status).toBe(403)
        expect((await request(own.id, undefined, dryRun)).status).toBe(401)
        expect((await request(null, token, dryRun)).status).toBe(403)
      }
      expect(cleanup).not.toHaveBeenCalled()
      expect(canTerminate).not.toHaveBeenCalled()
      expect(terminate).not.toHaveBeenCalled()
    } finally {
      cleanup.mockRestore()
      canTerminate.mockRestore()
      terminate.mockRestore()
    }
  })

  it('allows a non-manager principal with an explicit squad agents:terminate grant', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['agents:terminate'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: own.id })
    const eligible = await worker()
    for (const dryRun of [true, false]) {
      expect((await request(other.id, user.token, dryRun)).status).toBe(403)
      const response = await request(own.id, user.token, dryRun)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ checked: 1, terminated: 1, agents: [{ id: eligible.id }] })
      expect((await request(null, user.token, dryRun)).status).toBe(403)
    }
  })

  it('excludes protected identities and non-live records, and guards open work and transitional states', async () => {
    const eligible = await worker()
    const persistent = await worker(own, { persist: true })
    const manager = await worker(own, { agentTypeId: 'manager' })
    const consultant = await worker(own, { agentTypeId: 'consultant' })
    const child = await worker(own, { parentAgentId: persistent.id })
    const dormant = await worker()
    const terminated = await worker()
    const compacting = await worker()
    const resetting = await worker()
    const open = await worker()
    await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, dormant.id))
    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, terminated.id))
    await db.update(agents).set({ status: 'compacting' }).where(eq(agents.id, compacting.id))
    await db.update(agents).set({ status: 'resetting' }).where(eq(agents.id, resetting.id))
    await storedLegacyWorkStream({ squadId: own.id, title: 'open work', agentIds: [open.id] })

    const preview = await Squad.cleanupFlexAgents(true, own.id)
    expect(preview).toMatchObject({ checked: 4, terminated: 1, agents: [{ id: eligible.id }] })
    const result = await Squad.cleanupFlexAgents(false, own.id)
    expect(result).toMatchObject({ checked: 4, terminated: 1, agents: [{ id: eligible.id }] })
    for (const agent of [persistent, manager, consultant, child, open]) {
      await agent.reload()
      expect(agent.status).toBe('idle')
    }
    for (const [agent, status] of [
      [dormant, 'dormant'],
      [terminated, 'terminated'],
      [compacting, 'compacting'],
      [resetting, 'resetting'],
    ] as const) {
      await agent.reload()
      expect(agent.status).toBe(status)
    }
  })

  it('bounds the shared service candidate query and metadata lookup to the requested squad', async () => {
    const eligible = await worker()
    const foreign = await worker(other)
    const canTerminate = spyOn(Agent.prototype, 'canTerminate')
    const terminate = spyOn(Agent.prototype, 'tryTerminate')
    try {
      const preview = await Squad.cleanupFlexAgents(true, own.id)
      expect(preview).toMatchObject({ checked: 1, terminated: 1, agents: [{ id: eligible.id, squadName: own.name }] })
      expect(canTerminate).toHaveBeenCalledTimes(1)
      expect(terminate).not.toHaveBeenCalled()
      const result = await Squad.cleanupFlexAgents(false, own.id)
      expect(result).toMatchObject({ checked: 1, terminated: 1, agents: [{ id: eligible.id }] })
      expect(terminate).toHaveBeenCalledTimes(1)
      await foreign.reload()
      expect(foreign.status).toBe('idle')
    } finally {
      canTerminate.mockRestore()
      terminate.mockRestore()
    }
  })

  it('reports mid-turn dormancy as deferred rather than completed, without stopping the execution', async () => {
    const token = await managerToken()
    const agent = await worker()
    const execution = await agent.queueExecution({ message: 'mid-turn' })
    await Execution.update(execution.id, { status: 'running' })
    const preview = await request(own.id, token, true)
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ checked: 1, terminated: 1, deferred: 0 })
    await agent.reload()
    expect(agent.pendingDormancyAt).toBeNull()
    const result = await Squad.cleanupFlexAgents(false, own.id)
    expect(result).toMatchObject({
      checked: 1,
      terminated: 0,
      agents: [],
      deferred: 1,
      deferredAgents: [{ id: agent.id }],
    })
    await agent.reload()
    expect(agent.status).not.toBe('dormant')
    expect(agent.pendingDormancyAt).not.toBeNull()
    expect((await Execution.mustFind(execution.id)).status).toBe('running')
    const response = await request(own.id, token)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ terminated: 0, deferred: 1, deferredAgents: [{ id: agent.id }] })
  })

  it('keeps the system:cleanup administrator route global and supports legacy dry-run calls', async () => {
    const admin = await createTestAdmin({ prefix })
    const eligible = await worker()
    const foreign = await worker(other)
    const preview = await request(null, admin.token, true)
    expect(preview.status).toBe(200)
    expect((await preview.json()).agents.map((a: { id: string }) => a.id)).toEqual(
      expect.arrayContaining([eligible.id, foreign.id])
    )
    const response = await request(null, admin.token)
    expect(response.status).toBe(200)
    expect((await response.json()).agents.map((a: { id: string }) => a.id)).toEqual(
      expect.arrayContaining([eligible.id, foreign.id])
    )
    await eligible.reload()
    await foreign.reload()
    expect(eligible.status).toBe('dormant')
    expect(foreign.status).toBe('dormant')
  })
})

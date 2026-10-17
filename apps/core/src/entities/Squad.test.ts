import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { like, eq, sql } from 'drizzle-orm'
import { existsSync } from 'fs'
import { Squad } from './Squad'
import { Agent } from './Agent'
import { Schedule } from './Schedule'
import { AgentType } from '../entities/AgentType'
import { db } from '../db'
import { squads, squadPresets, agents, agentTypes, workStreams, squadRelationships, messages } from '../db/schema'
import { getSquadWorkspacePath } from '../services/squad/workspace'

describe('Squad entity', () => {
  let testPrefix: string

  beforeEach(() => {
    testPrefix = `sq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    // Clean up test squads
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  // ---------------------------------------------------------------------------
  // Static Methods
  // ---------------------------------------------------------------------------

  describe('Squad.create', () => {
    it('creates a squad with name and purpose', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Mobile Team`,
        purpose: 'Mobile app development',
      })

      expect(squad.id).toBeDefined()
      expect(squad.name).toBe(`${testPrefix} Mobile Team`)
      expect(squad.purpose).toBe('Mobile app development')
      expect(squad.status).toBe('active')
      expect(squad.defaultAgents).toEqual([])
      expect(squad.globalCollaborationEnabled).toBe(false)
      expect(squad.toJson().globalCollaborationEnabled).toBe(false)
    })

    it('enables shared memory without selecting workspace paths or sync providers', async () => {
      const squad = await Squad.create({ name: `${testPrefix} Memory Default`, purpose: 'Testing' })
      const persisted = await Squad.mustFind(squad.id)
      expect(persisted.isMemoryEnabled).toBe(true)
      expect(persisted.memoryConfig).toEqual({ enabled: true })
    })

    it('preserves an explicit memory opt-out and its other settings', async () => {
      const memory = { enabled: false, workspacePaths: { include: ['repo/docs/**/*.md'] } }
      const squad = await Squad.create({
        name: `${testPrefix} Memory Opt Out`,
        purpose: 'Testing',
        metadata: { memory, repo: 'repo' },
      })
      expect((await Squad.mustFind(squad.id)).isMemoryEnabled).toBe(false)
      expect(squad.metadata).toEqual({ memory, repo: 'repo' })
      await squad.update({ purpose: 'Unrelated update' })
      expect((await Squad.mustFind(squad.id)).isMemoryEnabled).toBe(false)
    })

    it('defaults enablement while preserving supplied memory settings', async () => {
      const memory = { embeddingModel: 'custom-model', workspacePaths: { include: ['repo/README.md'] } }
      const squad = await Squad.create({
        name: `${testPrefix} Memory Settings`,
        purpose: 'Testing',
        metadata: { memory },
      })
      expect(squad.memoryConfig).toEqual({ ...memory, enabled: true })
    })

    it('does not enable a legacy squad when reading or updating unrelated metadata', async () => {
      const [row] = await db
        .insert(squads)
        .values({
          name: `${testPrefix} Legacy Memory`,
          purpose: 'Testing',
          metadata: { repo: 'legacy' },
        })
        .returning()
      const squad = await Squad.mustFind(row.id)
      expect(squad.isMemoryEnabled).toBe(false)
      await squad.update({ metadata: { another: 'value' } })
      const persisted = await Squad.mustFind(row.id)
      expect(persisted.isMemoryEnabled).toBe(false)
      expect(persisted.metadata).toEqual({ repo: 'legacy', another: 'value' })
    })

    it('does not create a workspace before storage is needed', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Lazy Workspace`,
        purpose: 'Verify lazy workspace creation',
      })

      expect(existsSync(getSquadWorkspacePath(squad.id))).toBe(false)
    })

    it('creates squad with optional fields', async () => {
      // Insert the creation preset.
      await db.insert(squadPresets).values({ id: 'engineering-squad', name: 'Engineering Squad' }).onConflictDoNothing()

      const squad = await Squad.create({
        name: `${testPrefix} Backend Team`,
        purpose: 'Backend services',
        squadPresetId: 'engineering-squad',
        defaultAgents: ['architect', 'engineer'],
        context: 'Use TypeScript and follow our API conventions.',
        metadata: { repo: 'backend-api' },
      })

      expect(squad.squadPresetId).toBe('engineering-squad')
      expect(squad.defaultAgents).toEqual(['architect', 'engineer'])
      expect(squad.context).toBe('Use TypeScript and follow our API conventions.')
      expect(squad.metadata).toEqual({ repo: 'backend-api', memory: { enabled: true } })
    })

    it('provisions a manager-targeted schedule template without failing (manager exists first)', async () => {
      // Regression: schedule provisioning used to run BEFORE the manager agent was
      // created, so a squad preset with a manager-targeted schedule (e.g. engineering's
      // "Manager Check-in") threw squad_manager_missing → 500, leaving a
      // half-provisioned squad (the row insert had already committed). Provisioning now
      // runs after the manager exists.
      await db
        .insert(squadPresets)
        .values({
          id: `${testPrefix}-mgr-sched`,
          name: 'Manager Schedule Type',
          scheduleTemplates: [
            {
              name: 'Manager Check-in',
              enabled: true,
              schedule: { interval: '1h' },
              action: { type: 'inbox_message', target: 'manager', content: 'check in' },
            },
          ],
        })
        .onConflictDoNothing()

      const squad = await Squad.create({
        name: `${testPrefix} Scheduled Team`,
        purpose: 'Manager-scheduled squad',
        squadPresetId: `${testPrefix}-mgr-sched`,
        defaultAgents: [],
      })

      // Manager was created, and the schedule provisioned against it.
      expect(squad.managerAgentId).toBeTruthy()
      const schedules = await Schedule.list({ scopeType: 'squad', scopeId: squad.id })
      expect(schedules.some((sch) => sch.name === 'Manager Check-in')).toBe(true)

      await db.delete(squadPresets).where(eq(squadPresets.id, `${testPrefix}-mgr-sched`))
    })
  })

  describe('Squad.find', () => {
    it('returns squad by full id', async () => {
      const created = await Squad.create({
        name: `${testPrefix} Test Squad`,
        purpose: 'Testing',
      })

      const squad = await Squad.find(created.id)
      expect(squad?.id).toBe(created.id)
      expect(squad?.name).toBe(`${testPrefix} Test Squad`)
    })

    it('returns null for non-existent squad', async () => {
      const squad = await Squad.find('00000000-0000-0000-0000-000000000000')
      expect(squad).toBeNull()
    })

    it('supports short UUID prefix lookup', async () => {
      const created = await Squad.create({
        name: `${testPrefix} Prefix Test`,
        purpose: 'Testing prefix lookup',
      })

      const prefix = created.id.slice(0, 8)
      const squad = await Squad.find(prefix)
      expect(squad?.id).toBe(created.id)
    })
  })

  describe('Squad.list', () => {
    it('returns all squads', async () => {
      await Squad.create({ name: `${testPrefix} Squad 1`, purpose: 'Purpose 1' })
      await Squad.create({ name: `${testPrefix} Squad 2`, purpose: 'Purpose 2' })

      const all = await Squad.list()
      const ours = all.filter((s) => s.name.startsWith(testPrefix))
      expect(ours.length).toBe(2)
    })

    it('filters by status', async () => {
      await Squad.create({ name: `${testPrefix} Active`, purpose: 'Active squad' })
      const paused = await Squad.create({ name: `${testPrefix} Paused`, purpose: 'Paused squad' })
      await paused.update({ status: 'paused' })

      const activeOnly = await Squad.list({ status: 'active' })
      const ours = activeOnly.filter((s) => s.name.startsWith(testPrefix))
      expect(ours.length).toBe(1)
      expect(ours[0].name).toBe(`${testPrefix} Active`)
    })
  })

  describe('Squad.update (static)', () => {
    it('updates squad fields via static method', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Original`,
        purpose: 'Original purpose',
      })

      const updated = await Squad.update(squad.id, {
        name: `${testPrefix} Updated`,
        purpose: 'Updated purpose',
      })

      expect(updated.name).toBe(`${testPrefix} Updated`)
      expect(updated.purpose).toBe('Updated purpose')
    })

    it('deep merges metadata instead of replacing', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Metadata Test`,
        purpose: 'Testing metadata merge',
        metadata: {
          memory: { enabled: true, model: 'text-embedding-3-small' },
          existing: 'value',
        },
      })

      // Update with new notifications config - should preserve memory and existing
      const updated = await Squad.update(squad.id, {
        metadata: {
          notifications: { discord: { instanceId: 'inst-1', channelId: '123' } },
        },
      })

      expect(updated.metadata).toEqual({
        memory: { enabled: true, model: 'text-embedding-3-small' },
        existing: 'value',
        notifications: { discord: { instanceId: 'inst-1', channelId: '123' } },
      })
    })

    it('deep merges nested objects within metadata', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Deep Merge`,
        purpose: 'Testing deep merge',
        metadata: {
          notifications: {
            discord: { instanceId: 'inst-1', channelId: '123' },
            slack: { instanceId: 'inst-2', channelId: 'C456' },
          },
        },
      })

      // Update just the telegram config - should preserve discord and slack
      const updated = await Squad.update(squad.id, {
        metadata: {
          notifications: {
            telegram: { instanceId: 'inst-3', chatId: '-100' },
          },
        },
      })

      expect(updated.metadata).toEqual({
        memory: { enabled: true },
        notifications: {
          discord: { instanceId: 'inst-1', channelId: '123' },
          slack: { instanceId: 'inst-2', channelId: 'C456' },
          telegram: { instanceId: 'inst-3', chatId: '-100' },
        },
      })
    })

    it('removes metadata keys when set to null', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Null Delete`,
        purpose: 'Testing null deletion',
        metadata: {
          memory: { enabled: true },
          notifications: { discord: { instanceId: 'inst-1', channelId: '123' } },
          toRemove: 'this will be removed',
        },
      })

      // Set toRemove to null - should delete it
      const updated = await Squad.update(squad.id, {
        metadata: { toRemove: null },
      })

      expect(updated.metadata).toEqual({
        memory: { enabled: true },
        notifications: { discord: { instanceId: 'inst-1', channelId: '123' } },
      })
      expect('toRemove' in (updated.metadata as object)).toBe(false)
    })

    it('removes nested keys when set to null', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Nested Null`,
        purpose: 'Testing nested null deletion',
        metadata: {
          notifications: {
            discord: { instanceId: 'inst-1', channelId: '123' },
            slack: { instanceId: 'inst-2', channelId: 'C456' },
          },
        },
      })

      // Remove just the slack config
      const updated = await Squad.update(squad.id, {
        metadata: {
          notifications: { slack: null },
        },
      })

      expect(updated.metadata).toEqual({
        memory: { enabled: true },
        notifications: {
          discord: { instanceId: 'inst-1', channelId: '123' },
        },
      })
    })

    it('replaces arrays instead of merging', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Array Replace`,
        purpose: 'Testing array replacement',
        metadata: {
          tags: ['tag1', 'tag2', 'tag3'],
        },
      })

      // Arrays should be replaced, not merged
      const updated = await Squad.update(squad.id, {
        metadata: { tags: ['newTag'] },
      })

      expect(updated.metadata).toEqual({
        memory: { enabled: true },
        tags: ['newTag'],
      })
    })

    it('updates global collaboration', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Global Flag`,
        purpose: 'Testing global collaboration flag',
      })

      const updated = await squad.update({ globalCollaborationEnabled: true })

      expect(updated.globalCollaborationEnabled).toBe(true)
      expect(updated.toJson().globalCollaborationEnabled).toBe(true)
    })
  })

  describe('typeContext', () => {
    beforeEach(async () => {
      await AgentType.upsert({
        id: 'architect',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Architect',
        systemPrompt: 'You are an architect.',
      })
      await AgentType.upsert({
        id: 'engineer',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Engineer',
        systemPrompt: 'You are an engineer.',
      })
      await AgentType.upsert({
        id: 'manager',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Manager',
        systemPrompt: 'You are a manager.',
      })
    })

    it('creates a squad with typeContext', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} TC`,
        purpose: 'testing typeContext',
        typeContext: { architect: 'design first', engineer: 'ship fast' },
      })
      expect(squad.typeContext).toEqual({ architect: 'design first', engineer: 'ship fast' })
      expect(squad.toJson().typeContext).toEqual({ architect: 'design first', engineer: 'ship fast' })
    })

    it('defaults typeContext to null', async () => {
      const squad = await Squad.create({ name: `${testPrefix} TC2`, purpose: 'p' })
      expect(squad.typeContext).toBeNull()
    })

    it('replaces typeContext when setting from null', async () => {
      const squad = await Squad.create({ name: `${testPrefix} TC3`, purpose: 'p' })
      await squad.update({ typeContext: { manager: 'be decisive' } })
      expect(squad.typeContext).toEqual({ manager: 'be decisive' })
    })

    it('merges typeContext on update instead of replacing', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} TC-MERGE`,
        purpose: 'p',
        typeContext: { architect: 'a', engineer: 'b' },
      })
      // Update just engineer — architect should be preserved
      await squad.update({ typeContext: { engineer: 'c' } })
      expect(squad.typeContext).toEqual({ architect: 'a', engineer: 'c' })
    })

    it('deletes a key when set to null on update', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} TC-DEL`,
        purpose: 'p',
        typeContext: { architect: 'a', engineer: 'b' },
      })
      await squad.update({ typeContext: { architect: null } })
      expect(squad.typeContext).toEqual({ engineer: 'b' })
    })

    it('clears all typeContext when set to null on update', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} TC4`,
        purpose: 'p',
        typeContext: { engineer: 'x' },
      })
      await squad.update({ typeContext: null })
      expect(squad.typeContext).toBeNull()
    })

    it('strips empty-string values', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} TC5`,
        purpose: 'p',
        typeContext: { architect: 'keep', engineer: '' },
      })
      expect(squad.typeContext?.architect).toBe('keep')
      expect(squad.typeContext?.engineer).toBeUndefined()
    })
  })

  describe('detached squad presets', () => {
    it('copies members and manager context once, and retains provenance after preset deletion', async () => {
      const { SquadPreset } = await import('./SquadPreset')
      const { squadPresetSync } = await import('../services/config-sync')
      const id = `${testPrefix}-preset`
      try {
        await SquadPreset.upsert({
          id,
          name: 'Starting point',
          defaultAgents: ['engineer'],
          managerInstructions: 'Coordinate the project.',
        })
        const squad = await Squad.create({ name: `${testPrefix} Detached`, purpose: 'Testing', squadPresetId: id })
        expect(squad.defaultAgents).toEqual(['engineer'])
        expect(squad.typeContext).toEqual({ manager: 'Coordinate the project.' })
        await SquadPreset.upsert({
          id,
          name: 'Changed',
          defaultAgents: ['architect'],
          managerInstructions: 'Changed guidance.',
          scheduleTemplates: [
            {
              name: 'New timer',
              action: { type: 'inbox_message', target: 'manager', content: 'New' },
              schedule: { interval: '1h' },
            },
          ],
        })
        await squadPresetSync.afterSync(id)
        await db.delete(squadPresets).where(eq(squadPresets.id, id))
        const detached = await Squad.mustFind(squad.id)
        expect(detached.squadPresetId).toBe(id)
        expect(detached.defaultAgents).toEqual(['engineer'])
        expect(detached.typeContext).toEqual({ manager: 'Coordinate the project.' })
        expect((await detached.getActiveAgents()).map((a) => a.agentTypeId).sort()).toEqual(['engineer', 'manager'])
        expect(await Schedule.list({ scopeType: 'squad', scopeId: squad.id })).toEqual([])
      } finally {
        await db.delete(squadPresets).where(eq(squadPresets.id, id))
        SquadPreset.invalidateCache()
      }
    })

    it('lets explicit members and manager context override preset defaults', async () => {
      const { SquadPreset } = await import('./SquadPreset')
      const id = `${testPrefix}-override`
      try {
        await SquadPreset.upsert({ id, name: 'Preset', defaultAgents: ['engineer'], managerInstructions: 'Template' })
        const squad = await Squad.create({
          name: `${testPrefix} Override`,
          purpose: 'Testing',
          squadPresetId: id,
          defaultAgents: [],
          typeContext: { manager: 'Custom' },
        })
        expect(squad.defaultAgents).toEqual([])
        expect(squad.typeContext?.manager).toBe('Custom')
      } finally {
        await db.delete(squadPresets).where(eq(squadPresets.id, id))
        SquadPreset.invalidateCache()
      }
    })
  })

  describe('Squad.cleanupFlexAgents', () => {
    afterEach(async () => {
      await db.delete(workStreams)
      await db.delete(agents)
    })

    it('is a no-op for flex agents already terminated by direct work stream cleanup', async () => {
      const squad = await Squad.create({ name: `${testPrefix} Cleanup Test`, purpose: 'Testing' })
      const agent = await Agent.create({ agentTypeId: 'flex', squadId: squad.id, persist: false })
      const ws = await storedLegacyWorkStream({ squadId: squad.id, title: 'Test WS', agentIds: [agent.id] })
      await ws.update({ status: 'done' })

      await agent.reload()
      expect(agent).toMatchObject({ status: 'dormant', dormantAt: expect.any(Date), terminatedAt: null })

      const result = await Squad.cleanupFlexAgents(true)

      expect(result.agents.some((candidate) => candidate.id === agent.id)).toBe(false)
    })

    it('terminates flex agents missed by direct cleanup reconciliation', async () => {
      const squad = await Squad.create({ name: `${testPrefix} Cleanup Reconcile`, purpose: 'Testing' })
      const agent = await Agent.create({ agentTypeId: 'flex', squadId: squad.id, persist: false })
      const ws = await storedLegacyWorkStream({ squadId: squad.id, title: 'Test WS', agentIds: [agent.id] })
      await db
        .update(workStreams)
        .set({ status: 'done', updatedAt: sql`now()` })
        .where(eq(workStreams.id, ws.id))

      const result = await Squad.cleanupFlexAgents()

      expect(result.checked).toBeGreaterThanOrEqual(1)
      expect(result.terminated).toBeGreaterThanOrEqual(1)

      await agent.reload()
      expect(agent).toMatchObject({ status: 'dormant', dormantAt: expect.any(Date), terminatedAt: null })
    })

    it('does not terminate flex agents with active work streams', async () => {
      const squad = await Squad.create({ name: `${testPrefix} Active WS`, purpose: 'Testing' })
      const agent = await Agent.create({ agentTypeId: 'flex', squadId: squad.id, persist: false })
      await storedLegacyWorkStream({ squadId: squad.id, title: 'Active WS', agentIds: [agent.id] })

      const result = await Squad.cleanupFlexAgents()

      expect(result.checked).toBeGreaterThanOrEqual(1)

      await agent.reload()
      expect(agent.terminatedAt).toBeNull()
    })

    it('does not sweep consultant agents', async () => {
      const squad = await Squad.create({ name: `${testPrefix} Consultant Cleanup`, purpose: 'test' })
      const consultant = await Agent.create({ agentTypeId: 'consultant', squadId: squad.id, persist: false })

      const result = await Squad.cleanupFlexAgents(true) // dryRun
      expect(result.agents.map((a) => a.id)).not.toContain(consultant.id)
    })
  })

  // ---------------------------------------------------------------------------
  // Instance Methods
  // ---------------------------------------------------------------------------

  describe('squad.update', () => {
    it('updates squad fields via instance method', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Instance`,
        purpose: 'Testing instance update',
      })

      await squad.update({ status: 'paused' })
      expect(squad.status).toBe('paused')
    })

    it('updates defaultAgents', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Agents Test`,
        purpose: 'Testing agents',
      })

      const updated = await squad.update({
        defaultAgents: ['architect', 'reviewer'],
      })
      expect(updated.defaultAgents).toEqual(['architect', 'reviewer'])
    })
  })

  describe('squad.archive', () => {
    it('soft-deletes the squad: row persists, hidden from list(), still resolvable by find()', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} To Delete`,
        purpose: 'Will be deleted',
      })

      await squad.archive()

      // Row still exists with archivedAt set
      const [row] = await db.select().from(squads).where(eq(squads.id, squad.id))
      expect(row).toBeDefined()
      expect(row.archivedAt).not.toBeNull()

      // Hidden from default listings
      const listed = await Squad.list()
      expect(listed.find((s) => s.id === squad.id)).toBeUndefined()

      // Still resolvable directly (find does not filter archived)
      const found = await Squad.find(squad.id)
      expect(found).not.toBeNull()
      expect(found!.isArchived).toBe(true)
    })
  })

  describe('squad.toJson', () => {
    it('serializes squad to JSON', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} JSON Test`,
        purpose: 'Testing JSON serialization',
      })

      const json = squad.toJson()
      expect(json.id).toBe(squad.id)
      expect(json.name).toBe(squad.name)
      expect(json.purpose).toBe(squad.purpose)
      expect(json.status).toBe(squad.status)
      expect(json.createdAt).toBeInstanceOf(Date)
    })
  })

  // ---------------------------------------------------------------------------
  // Agent Management
  // ---------------------------------------------------------------------------

  describe('squad.getManagerAgent', () => {
    it('returns the squad manager agent', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Manager Test`,
        purpose: 'Testing',
      })

      const manager = await squad.getManagerAgent()
      expect(manager).not.toBeNull()
      expect(manager?.agentTypeId).toBe('manager')
    })
  })

  describe('squad.getActiveAgents', () => {
    it('returns all active agents in squad', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Active Agents`,
        purpose: 'Testing',
        defaultAgents: ['engineer', 'engineer'],
      })

      const worker = await squad.spawnAgent('architect')

      const squadAgents = await squad.getActiveAgents()

      // manager + 2 default engineers + 1 architect
      expect(squadAgents.length).toBe(4)
      expect(squadAgents.some((a) => a.id === worker.id)).toBe(true)
    })

    it('excludes dormant and terminated agents', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Terminated Test`,
        purpose: 'Testing',
        defaultAgents: ['engineer', 'engineer'],
      })

      const worker = await squad.spawnAgent('architect')
      const terminatedWorker = await squad.spawnAgent('architect')
      await worker.tryTerminate()
      await terminatedWorker.update({ status: 'terminated', terminatedAt: new Date() })

      const squadAgents = await squad.getActiveAgents()

      // manager + 2 default engineers (dormant/final architects excluded)
      expect(squadAgents.length).toBe(3)
      expect(squadAgents.some((a) => a.id === worker.id)).toBe(false)
      expect(squadAgents.some((a) => a.id === terminatedWorker.id)).toBe(false)
    })
  })

  describe('squad.getAddressableAgents', () => {
    it('returns each live or dormant top-level agent exactly once and excludes final and child rows', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Addressable Agents`,
        purpose: 'Testing',
      })
      const live = await squad.spawnAgent('engineer')
      const dormant = await squad.spawnAgent('architect')
      const terminated = await squad.spawnAgent('consultant')
      const child = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id, parentAgentId: live.id })
      await dormant.update({ status: 'dormant' })
      await terminated.update({ status: 'terminated', terminatedAt: new Date() })

      const ids = (await squad.getAddressableAgents()).map((agent) => agent.id)

      expect(ids.filter((id) => id === live.id)).toHaveLength(1)
      expect(ids.filter((id) => id === dormant.id)).toHaveLength(1)
      expect(ids).not.toContain(terminated.id)
      expect(ids).not.toContain(child.id)
    })

    it('does not duplicate or lose an agent that becomes dormant at the roster query seam', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Addressable Transition Seam`,
        purpose: 'Testing',
      })
      const transitioning = await squad.spawnAgent('engineer')
      const originalList = Agent.list
      let rosterListCalls = 0
      const list = spyOn(Agent, 'list').mockImplementation(async (filters) => {
        const result = await originalList(filters)
        if (
          filters?.squadId === squad.id &&
          filters.topLevelOnly === true &&
          (filters.addressable === true || filters.live === true || filters.status === 'dormant')
        ) {
          rosterListCalls++
          if (rosterListCalls === 1) await transitioning.update({ status: 'dormant' })
        }
        return result
      })
      try {
        const ids = (await squad.getAddressableAgents()).map((agent) => agent.id)
        expect(ids.filter((id) => id === transitioning.id)).toHaveLength(1)
        expect(rosterListCalls).toBe(1)
      } finally {
        list.mockRestore()
      }
    })
  })

  describe('squad.spawnAgent', () => {
    it('creates an agent in the squad', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Spawn Test`,
        purpose: 'Testing',
      })

      const agent = await squad.spawnAgent('engineer')

      expect(agent.agentTypeId).toBe('engineer')
      expect(agent.squadId).toBe(squad.id)
      expect(agent.persist).toBe(false)
    })

    it('creates a persistent agent when persist=true', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Persist Spawn`,
        purpose: 'Testing',
      })

      const agent = await squad.spawnAgent('engineer', true)

      expect(agent.agentTypeId).toBe('engineer')
      expect(agent.squadId).toBe(squad.id)
      expect(agent.persist).toBe(true)
    })
  })

  describe('squad.reconcileAgents', () => {
    it('spawns missing default agents', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Reconcile`,
        purpose: 'Testing',
        defaultAgents: ['engineer', 'engineer'],
      })

      // Verify: manager + 2 engineers already spawned by init
      let agentList = await squad.getActiveAgents()
      expect(agentList.filter((a) => a.agentTypeId === 'engineer').length).toBe(2)

      // Add architect to defaultAgents
      await squad.update({ defaultAgents: ['engineer', 'engineer', 'architect'] })

      const spawned = await squad.reconcileAgents()

      expect(spawned).toBe(1)
      agentList = await squad.getActiveAgents()
      expect(agentList.filter((a) => a.agentTypeId === 'architect').length).toBe(1)
    })

    it('spawns default agents with persist=true', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Persist Default`,
        purpose: 'Testing',
        defaultAgents: ['engineer', 'engineer'],
      })

      const agentList = await squad.getActiveAgents()
      const engineers = agentList.filter((a) => a.agentTypeId === 'engineer')
      expect(engineers.length).toBe(2)
      // Default agents should be persistent
      for (const eng of engineers) {
        expect(eng.persist).toBe(true)
      }
    })

    it('does not spawn duplicates when already at desired count', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} No Dup`,
        purpose: 'Testing',
        defaultAgents: ['engineer', 'engineer'],
      })

      // Already has 2 engineers from init
      const spawned = await squad.reconcileAgents()

      expect(spawned).toBe(0)
    })

    it('counts a dormant persistent default agent without spawning a replacement', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Dormant Default`,
        purpose: 'Testing',
        defaultAgents: ['engineer'],
      })
      const engineer = (await squad.getActiveAgents()).find((agent) => agent.agentTypeId === 'engineer')!
      await engineer.update({ status: 'dormant' })

      expect(await squad.reconcileAgents()).toBe(0)
      expect((await squad.getDormantAgents()).filter((agent) => agent.agentTypeId === 'engineer')).toHaveLength(1)
      expect((await squad.getActiveAgents()).filter((agent) => agent.agentTypeId === 'engineer')).toHaveLength(0)
    })

    it('returns 0 for inactive squads', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Inactive`,
        purpose: 'Testing',
        defaultAgents: ['engineer'],
      })
      await squad.update({ status: 'archived' })

      const spawned = await squad.reconcileAgents()
      expect(spawned).toBe(0)
    })

    it('counts manager as a default agent of its type', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Manager Default`,
        purpose: 'Testing',
        defaultAgents: ['manager'],
      })

      // Manager fills the manager default slot — no additional spawn needed
      const agentList = await squad.getActiveAgents()
      const managers = agentList.filter((a) => a.agentTypeId === 'manager')
      expect(managers.length).toBe(1) // manager itself satisfies the default slot
    })
  })

  // ---------------------------------------------------------------------------
  // Relationships
  // ---------------------------------------------------------------------------

  describe('squad relationships', () => {
    let squad1: Squad
    let squad2: Squad
    let squad3: Squad

    beforeEach(async () => {
      squad1 = await Squad.create({ name: `${testPrefix} Leadership`, purpose: 'Organization leadership' })
      squad2 = await Squad.create({ name: `${testPrefix} Engineering`, purpose: 'Engineering work' })
      squad3 = await Squad.create({ name: `${testPrefix} Marketing`, purpose: 'Marketing work' })
    })

    afterEach(async () => {
      await db.delete(squadRelationships)
    })

    describe('squad.addRelationship', () => {
      it('creates a reports_to relationship', async () => {
        const rel = await squad2.addRelationship(squad1.id, 'reports_to')

        expect(rel.id).toBeDefined()
        expect(rel.sourceSquadId).toBe(squad2.id)
        expect(rel.targetSquadId).toBe(squad1.id)
        expect(rel.relationshipType).toBe('reports_to')
        expect(rel.metadata).toEqual({})
        expect(rel.createdAt).toBeInstanceOf(Date)
      })

      it('creates a collaborates relationship', async () => {
        const rel = await squad2.addRelationship(squad3.id, 'collaborates')
        expect(rel.relationshipType).toBe('collaborates')
      })

      it('creates a depends_on relationship', async () => {
        const rel = await squad3.addRelationship(squad2.id, 'depends_on')
        expect(rel.relationshipType).toBe('depends_on')
      })

      it('stores metadata', async () => {
        const rel = await squad2.addRelationship(squad1.id, 'reports_to', { notes: 'Primary reporting line' })
        expect(rel.metadata).toEqual({ notes: 'Primary reporting line' })
      })

      it('prevents self-relationships', async () => {
        await expect(squad1.addRelationship(squad1.id, 'collaborates')).rejects.toThrow(
          'cannot have relationship with itself'
        )
      })

      it('throws for non-existent target squad', async () => {
        await expect(squad1.addRelationship('00000000-0000-0000-0000-000000000000', 'reports_to')).rejects.toThrow(
          'Target squad not found'
        )
      })
    })

    describe('squad.getRelationships', () => {
      it('returns all relationships for a squad', async () => {
        await squad2.addRelationship(squad1.id, 'reports_to')
        await squad2.addRelationship(squad3.id, 'collaborates')

        const rels = await squad2.getRelationships()
        expect(rels.length).toBe(2)
      })

      it('includes relationships where squad is target', async () => {
        await squad2.addRelationship(squad1.id, 'reports_to')

        const rels = await squad1.getRelationships()
        expect(rels.length).toBe(1)
        expect(rels[0].targetSquadId).toBe(squad1.id)
      })

      it('filters by relationship type', async () => {
        await squad2.addRelationship(squad1.id, 'reports_to')
        await squad2.addRelationship(squad3.id, 'collaborates')

        const rels = await squad2.getRelationships('reports_to')
        expect(rels.length).toBe(1)
        expect(rels[0].relationshipType).toBe('reports_to')
      })

      it('returns empty array when no relationships', async () => {
        const rels = await squad1.getRelationships()
        expect(rels).toEqual([])
      })
    })

    describe('squad.withRelationships', () => {
      it('returns squad with empty relationships when none exist', async () => {
        const result = await squad1.withRelationships()

        expect(result.id).toBe(squad1.id)
        expect(result.relationships.reportsTo).toEqual([])
        expect(result.relationships.collaborates).toEqual([])
        expect(result.relationships.dependsOn).toEqual([])
        expect(result.relationships.reportedBy).toEqual([])
        expect(result.relationships.dependedOnBy).toEqual([])
      })

      it('returns only communication-safe fields for explicit and global foreign squads', async () => {
        await squad1.update({
          context: 'explicit-context-secret',
          typeContext: { manager: 'explicit-type-context-secret' },
          metadata: { secret: 'explicit-metadata-secret' },
        })
        await squad3.update({
          context: 'global-context-secret',
          typeContext: { manager: 'global-type-context-secret' },
          metadata: { secret: 'global-metadata-secret' },
          globalCollaborationEnabled: true,
        })
        await squad2.addRelationship(squad1.id, 'reports_to')

        const result = await squad2.withRelationships()
        const explicit = result.relationships.reportsTo[0]
        const global = result.relationships.collaborates.find((candidate) => candidate.id === squad3.id)

        expect(Object.keys(explicit).sort()).toEqual(['id', 'managerAgentId', 'name', 'purpose'])
        expect(Object.keys(global!).sort()).toEqual(['id', 'managerAgentId', 'name', 'purpose'])
        expect(explicit).toEqual({
          id: squad1.id,
          managerAgentId: squad1.managerAgentId,
          name: squad1.name,
          purpose: squad1.purpose,
        })
        expect(global).toEqual({
          id: squad3.id,
          managerAgentId: squad3.managerAgentId,
          name: squad3.name,
          purpose: squad3.purpose,
        })

        const serialized = JSON.stringify(result.relationships)
        for (const sentinel of [
          'explicit-context-secret',
          'explicit-type-context-secret',
          'explicit-metadata-secret',
          'global-context-secret',
          'global-type-context-secret',
          'global-metadata-secret',
        ]) {
          expect(serialized).not.toContain(sentinel)
        }
      })

      it('categorizes outgoing reports_to relationships', async () => {
        await squad2.addRelationship(squad1.id, 'reports_to')

        const result = await squad2.withRelationships()

        expect(result.relationships.reportsTo.length).toBe(1)
        expect(result.relationships.reportsTo[0].id).toBe(squad1.id)
        expect(result.relationships.reportedBy).toEqual([])
      })

      it('categorizes incoming reports_to as reportedBy', async () => {
        await squad2.addRelationship(squad1.id, 'reports_to')

        const result = await squad1.withRelationships()

        expect(result.relationships.reportedBy.length).toBe(1)
        expect(result.relationships.reportedBy[0].id).toBe(squad2.id)
        expect(result.relationships.reportsTo).toEqual([])
      })

      it('handles collaborates relationships (both directions)', async () => {
        await squad2.addRelationship(squad3.id, 'collaborates')

        const engineering = await squad2.withRelationships()
        const marketing = await squad3.withRelationships()

        expect(engineering.relationships.collaborates.length).toBe(1)
        expect(engineering.relationships.collaborates[0].id).toBe(squad3.id)
        expect(marketing.relationships.collaborates.length).toBe(1)
        expect(marketing.relationships.collaborates[0].id).toBe(squad2.id)
      })

      it('categorizes depends_on relationships correctly', async () => {
        await squad3.addRelationship(squad2.id, 'depends_on')

        const marketing = await squad3.withRelationships()
        const engineering = await squad2.withRelationships()

        expect(marketing.relationships.dependsOn.length).toBe(1)
        expect(marketing.relationships.dependsOn[0].id).toBe(squad2.id)
        expect(engineering.relationships.dependedOnBy.length).toBe(1)
        expect(engineering.relationships.dependedOnBy[0].id).toBe(squad3.id)
      })

      it('includes globally collaborative squads as virtual collaborators', async () => {
        await squad3.update({ globalCollaborationEnabled: true })

        const result = await squad2.withRelationships()

        expect(result.relationships.collaborates.map((s) => s.id)).toContain(squad3.id)
      })

      it('does not duplicate explicit collaborator that is globally collaborative', async () => {
        await squad3.update({ globalCollaborationEnabled: true })
        await squad2.addRelationship(squad3.id, 'collaborates')

        const result = await squad2.withRelationships()

        expect(result.relationships.collaborates.filter((s) => s.id === squad3.id)).toHaveLength(1)
      })

      it('does not include itself as a virtual collaborator', async () => {
        await squad2.update({ globalCollaborationEnabled: true })

        const result = await squad2.withRelationships()

        expect(result.relationships.collaborates.map((s) => s.id)).not.toContain(squad2.id)
      })
    })

    describe('squad.canCommunicateWith', () => {
      it('returns true for related squads (reports_to)', async () => {
        await squad2.addRelationship(squad1.id, 'reports_to')

        expect(await squad1.canCommunicateWith(squad2.id)).toBe(true)
        expect(await squad2.canCommunicateWith(squad1.id)).toBe(true)
      })

      it('returns true for collaborates relationships', async () => {
        await squad2.addRelationship(squad3.id, 'collaborates')

        expect(await squad2.canCommunicateWith(squad3.id)).toBe(true)
        expect(await squad3.canCommunicateWith(squad2.id)).toBe(true)
      })

      it('returns false for unrelated squads', async () => {
        expect(await squad2.canCommunicateWith(squad3.id)).toBe(false)
      })

      it('returns true when the target squad has global collaboration enabled', async () => {
        await squad3.update({ globalCollaborationEnabled: true })

        expect(await squad2.canCommunicateWith(squad3.id)).toBe(true)
      })

      it('returns true when the source squad has global collaboration enabled', async () => {
        await squad2.update({ globalCollaborationEnabled: true })

        expect(await squad2.canCommunicateWith(squad3.id)).toBe(true)
      })

      it('returns true for same squad (self-communication)', async () => {
        expect(await squad1.canCommunicateWith(squad1.id)).toBe(true)
      })
    })

    describe('squad.getConnectedSquads', () => {
      it('returns all squads connected via relationships', async () => {
        await squad2.addRelationship(squad1.id, 'reports_to')
        await squad2.addRelationship(squad3.id, 'collaborates')

        const connected = await squad1.getConnectedSquads()
        const ids = connected.map((s) => s.id)

        expect(ids).toContain(squad1.id)
        expect(ids).toContain(squad2.id)
        expect(ids).toContain(squad3.id)
      })

      it('returns only starting squad when no relationships', async () => {
        const connected = await squad1.getConnectedSquads()

        expect(connected.length).toBe(1)
        expect(connected[0].id).toBe(squad1.id)
      })

      it('handles transitive connections', async () => {
        const qa = await Squad.create({ name: `${testPrefix} QA`, purpose: 'Quality assurance' })

        await squad2.addRelationship(squad1.id, 'reports_to')
        await qa.addRelationship(squad2.id, 'reports_to')

        const connected = await squad1.getConnectedSquads()
        const ids = connected.map((s) => s.id)

        expect(ids).toContain(squad1.id)
        expect(ids).toContain(squad2.id)
        expect(ids).toContain(qa.id)
      })
    })

    describe('squad.removeRelationship', () => {
      it('removes all relationships between squads', async () => {
        await squad2.addRelationship(squad1.id, 'reports_to')
        await squad2.addRelationship(squad1.id, 'collaborates')

        await squad2.removeRelationship(squad1.id)

        const rels = await squad2.getRelationships()
        expect(rels.length).toBe(0)
      })

      it('removes only specified relationship type', async () => {
        await squad2.addRelationship(squad1.id, 'reports_to')
        await squad2.addRelationship(squad1.id, 'collaborates')

        await squad2.removeRelationship(squad1.id, 'reports_to')

        const rels = await squad2.getRelationships()
        expect(rels.length).toBe(1)
        expect(rels[0].relationshipType).toBe('collaborates')
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  describe('squad.searchMessages', () => {
    let squad: Squad
    let testAgentTypeId: string
    let agent1: Agent
    let agent2: Agent

    beforeEach(async () => {
      testAgentTypeId = `${testPrefix}-type`
      await AgentType.create({
        id: testAgentTypeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Test Agent Type',
        systemPrompt: 'You are a test agent.',
      })

      squad = await Squad.create({ name: `${testPrefix} Search Squad`, purpose: 'Testing search' })
      agent1 = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      agent2 = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
    })

    afterEach(async () => {
      await db.delete(messages).where(eq(messages.agentId, agent1.id))
      await db.delete(messages).where(eq(messages.agentId, agent2.id))
      await db.delete(agents).where(eq(agents.id, agent1.id))
      await db.delete(agents).where(eq(agents.id, agent2.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    })

    it('searches across multiple agents', async () => {
      await agent1.recordMessage({ role: 'assistant', content: 'Agent 1 implemented the API' })
      await agent2.recordMessage({ role: 'assistant', content: 'Agent 2 also touched the API' })
      await agent1.recordMessage({ role: 'assistant', content: 'Agent 1 did something else' })

      const results = await squad.searchMessages('API')
      expect(results.length).toBe(2)
      const agentIds = results.map((r) => r.agentId)
      expect(agentIds).toContain(agent1.id)
      expect(agentIds).toContain(agent2.id)
    })

    it('returns empty for no matches', async () => {
      await agent1.recordMessage({ role: 'assistant', content: 'Hello' })

      const results = await squad.searchMessages('zzzznotfound')
      expect(results.length).toBe(0)
    })

    it('filters by role', async () => {
      await agent1.recordMessage({ role: 'human', content: 'Tell me about the API' })
      await agent1.recordMessage({ role: 'assistant', content: 'The API handles requests' })

      const results = await squad.searchMessages('API', { role: 'assistant' })
      expect(results.length).toBe(1)
      expect(results[0].role).toBe('assistant')
    })

    it('respects limit', async () => {
      await agent1.recordMessage({ role: 'assistant', content: 'Match 1 keyword' })
      await agent1.recordMessage({ role: 'assistant', content: 'Match 2 keyword' })
      await agent1.recordMessage({ role: 'assistant', content: 'Match 3 keyword' })

      const results = await squad.searchMessages('keyword', { limit: 2 })
      expect(results.length).toBe(2)
    })

    it('includes agent type info in results', async () => {
      await agent1.recordMessage({ role: 'assistant', content: 'Searchable content' })

      const results = await squad.searchMessages('Searchable')
      expect(results.length).toBe(1)
      expect(results[0].agentTypeId).toBe(testAgentTypeId)
    })

    it('is case-insensitive', async () => {
      await agent1.recordMessage({ role: 'assistant', content: 'The DATABASE is ready' })

      const results = await squad.searchMessages('database')
      expect(results.length).toBe(1)
    })
  })
})

describe('Squad.findManyByIds', () => {
  const prefix = `sqbatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  afterEach(async () => {
    await db.delete(squads).where(like(squads.name, `${prefix}%`))
  })

  it('returns found squads keyed by id in one query, deduping ids and omitting unknown ones', async () => {
    const a = await Squad.create({ name: `${prefix} D1`, purpose: 'p' })
    const b = await Squad.create({ name: `${prefix} D2`, purpose: 'p' })
    const found = await Squad.findManyByIds([a.id, b.id, a.id, '00000000-0000-4000-8000-000000000000'])
    expect([...found.keys()].sort()).toEqual([a.id, b.id].sort())
    expect(found.get(a.id)!.name).toBe(`${prefix} D1`)
    expect(await Squad.findManyByIds([])).toEqual(new Map())
  })

  it('is never stale: a raw archive write is visible on the next call', async () => {
    const a = await Squad.create({ name: `${prefix} E`, purpose: 'p' })
    await Squad.findManyByIds([a.id])
    await db.update(squads).set({ archivedAt: new Date() }).where(eq(squads.id, a.id))
    expect((await Squad.findManyByIds([a.id])).get(a.id)!.isArchived).toBe(true)
    expect((await Squad.find(a.id))!.isArchived).toBe(true)
  })
})

import { expect, test } from 'bun:test'
import { creationWorkflow } from './creation-source'

test('a squad without a preset defaults to the registered Solo style', () => {
  expect(creationWorkflow(undefined, undefined)).toEqual({ kind: 'preset', id: 'solo', customizations: [] })
})
test('explicit sources win over squad defaults', () => {
  const explicit = { kind: 'preset' as const, id: 'research-brief', customizations: [] }
  const configured = { kind: 'preset' as const, id: 'solo-coding', customizations: [] }
  expect(creationWorkflow(explicit, configured)).toEqual(explicit)
  expect(creationWorkflow(undefined, configured)).toEqual(configured)
})

import { afterEach, beforeEach, describe, spyOn } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { createBlankWorkflow, type WorkflowSource } from '@ficus/shared'
import { db, agents, agentTypes, squads, squadPresets, workStreams, workflows, executions } from '../../db'
import { Squad } from '../../entities/Squad'
import { SquadPreset } from '../../entities/SquadPreset'
import { WorkStream } from '../../entities/WorkStream'
import { Agent } from '../../entities/Agent'
import { Schedule } from '../../entities/Schedule'
import { getFlow } from './execution'
import { resolveCreationWorkflow } from './creation-source'

describe('inherited creation defaults', () => {
  let prefix: string
  let squad: Squad
  let source: WorkflowSource
  let ownedSquads: string[]
  let send: ReturnType<typeof spyOn<Agent, 'sendMessage'>>

  beforeEach(async () => {
    prefix = `default-${randomUUID()}`
    ownedSquads = []
    send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({ success: true, status: 'queued', queued: true })
    await db.insert(agentTypes).values({ id: prefix, name: 'Worker', model: 'test:model', systemPrompt: 'Expertise' })
    const definition = createBlankWorkflow()
    definition.name = 'Preset default'
    definition.participants.worker!.agentTypeId = prefix
    await db.insert(workflows).values({ id: prefix, definition })
    source = { kind: 'preset', id: prefix, customizations: [] }
    await SquadPreset.upsert({
      id: prefix,
      name: 'Domain preset',
      workflows: { default: source, choices: [], guidance: '' },
    })
    // A migrated squad owns its copied default.
    const [row] = await db
      .insert(squads)
      .values({ name: prefix, purpose: 'Test defaults', squadPresetId: prefix, metadata: { workflow: source } })
      .returning()
    ownedSquads.push(row!.id)
    squad = await Squad.mustFind(row!.id)
  })

  afterEach(async () => {
    send.mockRestore()
    const workers = await db.select({ id: agents.id }).from(agents).where(inArray(agents.squadId, ownedSquads))
    if (workers.length)
      await db.delete(executions).where(
        inArray(
          executions.agentId,
          workers.map((row) => row.id)
        )
      )
    await db.delete(workStreams).where(inArray(workStreams.squadId, ownedSquads))
    await db.delete(agents).where(inArray(agents.squadId, ownedSquads))
    await db.delete(squads).where(inArray(squads.id, ownedSquads))
    await db.delete(squadPresets).where(eq(squadPresets.id, prefix))
    SquadPreset.invalidateCache()
    await db.delete(workflows).where(eq(workflows.id, prefix))
    await db.delete(agentTypes).where(eq(agentTypes.id, prefix))
  })

  test('migrated squads use their copied default and new squads store the same choice', async () => {
    expect(squad.metadata.workflow).toEqual(source)
    expect(await resolveCreationWorkflow(undefined, squad)).toEqual(source)
    const created = await WorkStream.create({ squadId: squad.id, title: 'Inherited' })
    expect((await getFlow(created.id))!.state.definition.name).toBe('Preset default')
    expect(created.agentIds).toHaveLength(1)
    const fresh = await Squad.create({ name: `${prefix}-new`, purpose: 'New squad', squadPresetId: prefix })
    ownedSquads.push(fresh.id)
    expect(fresh.metadata.workflow).toEqual(source)
  })

  test('saved overrides and explicit choices win without rewriting an existing snapshot', async () => {
    const definition = createBlankWorkflow()
    definition.name = 'Squad override'
    definition.participants.worker!.agentTypeId = prefix
    await squad.update({ metadata: { workflow: { kind: 'inline', definition } } })
    const first = await WorkStream.create({ squadId: squad.id, title: 'Saved default' })
    const explicit = await WorkStream.create({ squadId: squad.id, title: 'Explicit', workflow: source })
    expect((await getFlow(first.id))!.state.definition.name).toBe('Squad override')
    expect((await getFlow(explicit.id))!.state.definition.name).toBe('Preset default')
    definition.name = 'Changed default'
    await squad.update({ metadata: { workflow: { kind: 'inline', definition } } })
    expect((await getFlow(first.id))!.state.definition.name).toBe('Squad override')
  })

  test('disabled inherited presets fail without creating an unstyled stream', async () => {
    await db.update(workflows).set({ disabled: true }).where(eq(workflows.id, prefix))
    await expect(WorkStream.create({ squadId: squad.id, title: 'Unavailable' })).rejects.toThrow('disabled')
    expect(await WorkStream.list({ squadId: squad.id })).toHaveLength(0)
    expect(await squad.getAgents()).toHaveLength(0)
  })

  test('queued creation snapshots the default but does not start another worker', async () => {
    await squad.update({ maxConcurrentWorkStreams: 1 })
    const first = await WorkStream.create({ squadId: squad.id, title: 'Active' })
    const second = await WorkStream.create({ squadId: squad.id, title: 'Queued' })
    expect(first.status).toBe('active')
    expect(second.status).toBe('queued')
    expect(second.assigneeAgentId).toBeNull()
    expect((await getFlow(second.id))!.state.definition.name).toBe('Preset default')
    expect(await squad.getAgents()).toHaveLength(1)
  })

  test('schedules inherit the current default at each run and do not flag approval flows as legacy orphans', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: squad.id,
      name: prefix,
      schedule: { interval: '1h', skipIfUnresolved: false },
      action: { type: 'create_work_stream', title: 'Scheduled' },
    })
    await schedule.trigger()
    const [first] = await WorkStream.findByMetadata({ scheduleId: schedule.id })
    const definition = createBlankWorkflow()
    definition.name = 'Approval default'
    definition.participants.worker!.agentTypeId = prefix
    definition.steps = [
      {
        kind: 'human-approval',
        id: 'approve',
        instructions: 'Approve the task',
        output: 'Decision',

        approver: 'reviewers',
        outcomes: { approved: { next: 'finish' } },
      },
    ]
    definition.entry = 'approve'
    await squad.update({ metadata: { workflow: { kind: 'inline', definition } } })
    await schedule.trigger()
    const streams = await WorkStream.findByMetadata({ scheduleId: schedule.id })
    const second = streams.find((row) => row.id !== first!.id)!
    expect((await getFlow(first!.id))!.state.definition.name).toBe('Preset default')
    expect((await getFlow(second.id))!.state.definition.name).toBe('Approval default')
    expect(second.assigneeAgentId).toBeNull()
    expect(await Schedule.hasUnresolvedWorkStreams(schedule.id)).toBe(true)
    await second.reload()
    expect(second.metadata.scheduleRecovery).toBeUndefined()
    expect((await second.getOpenWaits()).map((wait) => wait.type)).toEqual(['manual'])
  })
})

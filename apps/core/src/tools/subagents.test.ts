import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { agents } from '../db/schema'
import { Agent } from '../entities/Agent'
import { SubagentTestFixture } from '../test-utils/subagent-fixture'
import { Subagent } from '../entities/Subagent'
import { createDispatchTool } from './dispatch'
import { createCheckSubagentsTool, createStopSubagentTool } from './subagents'

describe('subagent tools ownership scoping', () => {
  let agentTypeId: string
  let createdAgentIds: string[]

  let fixture: SubagentTestFixture

  beforeEach(async () => {
    fixture = new SubagentTestFixture('subagent-tools', 'anthropic:claude-sonnet-4-5')
    agentTypeId = fixture.parentTypeId
    createdAgentIds = fixture.agentIds
    await fixture.setup()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  async function createParent(): Promise<Agent> {
    const parent = await Agent.create({ agentTypeId, persist: true })
    createdAgentIds.push(parent.id)
    return parent
  }

  function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  }

  async function setChildActivity(
    subagentId: string,
    activityAt: Date,
    options: { terminated?: boolean; dormant?: boolean; resultStatus?: string } = {}
  ): Promise<void> {
    const child = await Agent.mustFind(subagentId)
    await db
      .update(agents)
      .set({
        status: options.terminated ? 'terminated' : options.dormant ? 'dormant' : 'idle',
        dormantAt: options.dormant ? activityAt : null,
        terminatedAt: options.terminated ? activityAt : null,
        updatedAt: activityAt,
        metadata: {
          ...(child.metadata ?? {}),
          ...(options.resultStatus ? { resultStatus: options.resultStatus } : {}),
        },
      })
      .where(eq(agents.id, subagentId))
  }

  it('documents the three subagent model choices and their exclusivity', () => {
    const dispatchTool = createDispatchTool({
      agentId: 'schema-test',
      parentExecutionContext: { version: 1, squadId: null, environmentToolNames: [] },
    })
    const itemProperties = (dispatchTool.parameters as any).properties.subagents.items.properties

    expect(itemProperties.inheritModel).toMatchObject({ type: 'boolean' })
    expect(itemProperties.model.description).toContain('explicit child model override')
    expect(itemProperties.inheritModel.description).toContain("parent's full resolved model fallback chain")
    expect(itemProperties.inheritModel.description).toContain('cannot be true when model is provided')
    expect(dispatchTool.description).toContain("defaults through the subagent's Standard tier")
    expect(dispatchTool.description).toContain('model provides an explicit child override')
    expect(dispatchTool.description).toContain(
      "inheritModel=true copies the parent's full resolved model fallback chain"
    )
    expect(dispatchTool.description).toContain('model and inheritModel=true cannot be combined')
  })

  it('dispatch returns the same children when the same tool call runs twice', async () => {
    const parent = await createParent()
    const executionId = '77777777-7777-4777-8777-777777777777'
    const dispatchTool = createDispatchTool({
      agentId: parent.id,
      parentExecutionContext: { version: 1, squadId: null, environmentToolNames: [], executionId },
    })
    const run = (toolCallId: string, instructions: string) =>
      dispatchTool.execute(
        toolCallId,
        { subagents: [{ instructions, label: 'child' }] } as never,
        undefined,
        undefined,
        {} as never
      )

    const first = await run('tool-call-1', 'scoped child')
    const second = await run('tool-call-1', 'scoped child')
    const other = await run('tool-call-2', 'another child')
    const ids = (result: Awaited<ReturnType<typeof run>>) =>
      (result.details as { subagents: Array<{ subagentId: string }> }).subagents.map((child) => child.subagentId)
    const children = await Agent.list({ parentAgentId: parent.id })
    createdAgentIds.push(...children.map((child) => child.id))

    expect(ids(second)).toEqual(ids(first))
    expect(second.details).toMatchObject({ reused: 'tool-call' })
    expect(second.content[0]).toMatchObject({ text: expect.stringContaining('no new subagents were started') })
    expect(ids(other)).not.toEqual(ids(first))
    expect(children).toHaveLength(2)
  })

  it('dispatch uses the executing agent as parent and ignores caller-supplied parent ids', async () => {
    const parent = await createParent()
    const otherParent = await createParent()
    const dispatchTool = createDispatchTool({
      agentId: parent.id,
      parentExecutionContext: { version: 1, squadId: null, environmentToolNames: ['bash'] },
    })

    const result = await (
      dispatchTool.execute as unknown as (
        toolCallId: string,
        params: unknown
      ) => ReturnType<typeof dispatchTool.execute>
    )('tool-call-1', {
      parentAgentId: otherParent.id,
      subagents: [{ instructions: 'scoped child', label: 'scoped' }],
    })

    const details = result.details as { subagents: Array<{ subagentId: string }> }
    const child = await Agent.mustFind(details.subagents[0].subagentId)
    createdAgentIds.push(child.id)

    expect(child.parentAgentId).toBe(parent.id)
    expect(child.parentAgentId).not.toBe(otherParent.id)
    expect(child.metadata).toMatchObject({
      parentExecutionContext: { version: 1, squadId: null, environmentToolNames: ['bash'] },
    })
  })

  it('check_subagents lists only the executing agent children', async () => {
    const parent = await createParent()
    const otherParent = await createParent()
    const { subagents: parentChildren } = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'visible child', label: 'visible' }],
    })
    const { subagents: otherChildren } = await Subagent.dispatch({
      parentAgentId: otherParent.id,
      subagents: [{ instructions: 'hidden child', label: 'hidden' }],
    })
    createdAgentIds.push(parentChildren[0].subagentId, otherChildren[0].subagentId)

    const checkTool = createCheckSubagentsTool({ agentId: parent.id })
    const result = await (
      checkTool.execute as unknown as (toolCallId: string, params: unknown) => ReturnType<typeof checkTool.execute>
    )('tool-call-2', {})
    const details = result.details as { subagents: Array<{ subagentId: string }> }
    const ids = details.subagents.map((child) => child.subagentId)

    expect(ids).toContain(parentChildren[0].subagentId)
    expect(ids).not.toContain(otherChildren[0].subagentId)
  })

  it('check_subagents hides old terminated subagents by default but keeps active and recent children newest-first', async () => {
    const parent = await createParent()
    const { subagents: children } = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [
        { instructions: 'still running', label: 'active-old' },
        { instructions: 'recently done', label: 'recent-done' },
        { instructions: 'stale done', label: 'stale-done' },
      ],
    })
    createdAgentIds.push(...children.map((child) => child.subagentId))

    await setChildActivity(children[0].subagentId, daysAgo(30), { dormant: true })
    await setChildActivity(children[1].subagentId, daysAgo(1), { terminated: true, resultStatus: 'completed' })
    await setChildActivity(children[2].subagentId, daysAgo(14), { terminated: true, resultStatus: 'completed' })

    const checkTool = createCheckSubagentsTool({ agentId: parent.id })
    const result = await (
      checkTool.execute as unknown as (toolCallId: string, params: unknown) => ReturnType<typeof checkTool.execute>
    )('tool-call-recency-default', {})
    const details = result.details as { subagents: Array<{ subagentId: string; resultStatus: string | null }> }

    expect(details.subagents.map((child) => child.subagentId)).toEqual([children[1].subagentId, children[0].subagentId])
    expect(details.subagents[0].resultStatus).toBe('completed')
  })

  it('check_subagents honors recentWithinDays when widening the historical window', async () => {
    const parent = await createParent()
    const { subagents: children } = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [
        { instructions: 'active historical', label: 'active-historical' },
        { instructions: 'within override', label: 'within-override' },
        { instructions: 'outside override', label: 'outside-override' },
      ],
    })
    createdAgentIds.push(...children.map((child) => child.subagentId))

    await setChildActivity(children[0].subagentId, daysAgo(60))
    await setChildActivity(children[1].subagentId, daysAgo(14), { terminated: true, resultStatus: 'completed' })
    await setChildActivity(children[2].subagentId, daysAgo(45), { terminated: true, resultStatus: 'completed' })

    const checkTool = createCheckSubagentsTool({ agentId: parent.id })
    const result = await (
      checkTool.execute as unknown as (toolCallId: string, params: unknown) => ReturnType<typeof checkTool.execute>
    )('tool-call-recency-override', { recentWithinDays: 30 })
    const details = result.details as { subagents: Array<{ subagentId: string }> }
    const ids = details.subagents.map((child) => child.subagentId)

    expect(ids).toContain(children[0].subagentId)
    expect(ids).toContain(children[1].subagentId)
    expect(ids).not.toContain(children[2].subagentId)
  })

  it("stop_subagent cannot stop another agent's child", async () => {
    const parent = await createParent()
    const otherParent = await createParent()
    const { subagents: otherChildren } = await Subagent.dispatch({
      parentAgentId: otherParent.id,
      subagents: [{ instructions: 'do not stop', label: 'other' }],
    })
    createdAgentIds.push(otherChildren[0].subagentId)

    const stopTool = createStopSubagentTool({ agentId: parent.id })
    await expect(
      (stopTool.execute as unknown as (toolCallId: string, params: unknown) => ReturnType<typeof stopTool.execute>)(
        'tool-call-3',
        { subagentId: otherChildren[0].subagentId, reason: 'not owner' }
      )
    ).rejects.toThrow('Subagent does not belong to parent')

    expect((await Agent.mustFind(otherChildren[0].subagentId)).terminatedAt).toBeNull()
  })
})

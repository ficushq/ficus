import { describe, expect, it } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { SessionMessagePersistence, type SessionMessagePersistenceDeps } from './session-message-persistence'
import { StreamBuffer } from '../../services/streaming/buffer'
import { StreamEventCollector } from '../../services/streaming/events'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { db } from '../../db'
import { agents, agentTypes, executions, messages } from '../../db/schema'
import { Agent } from '../Agent'
import { AgentType } from '../AgentType'

function makeDeps(overrides: Partial<SessionMessagePersistenceDeps> = {}): SessionMessagePersistenceDeps {
  return {
    executionId: 'exec-1',
    deliveryOwner: { generation: 'session-1', executionId: 'exec-1' },
    agent: {
      id: 'agent-1',
      recordMessage: async (input: any) => ({ id: `msg-${Math.random().toString(36).slice(2, 8)}`, ...input }),
      confirmSessionDelivery: async () => [],
      update: async () => ({}),
    } as any,
    ...overrides,
  }
}

/** Test seam: expose the protected enqueue for chain-mechanics tests. */
class TestPersistence extends SessionMessagePersistence {
  push(task: () => Promise<void>): void {
    this.enqueue(task)
  }
}

describe('SessionMessagePersistence stream groups and turn rows', () => {
  it('scopes the stream group id to execution+run and bumps on rotate', () => {
    const p = new TestPersistence(makeDeps())
    const first = p.currentStreamGroupId
    expect(first.startsWith('exec-1:')).toBe(true)
    expect(first.endsWith(':1')).toBe(true)

    p.rotateStreamGroup()
    const second = p.currentStreamGroupId
    expect(second.endsWith(':2')).toBe(true)
    expect(second.slice(0, second.lastIndexOf(':'))).toBe(first.slice(0, first.lastIndexOf(':')))
  })

  it('records turn row ids per stream group, deduplicated, and reads back only the current group', () => {
    const p = new TestPersistence(makeDeps())
    p.recordTurnRowId('a')
    p.recordTurnRowId('b')
    p.recordTurnRowId('a')
    expect(p.currentTurnRowIds()).toEqual(['a', 'b'])

    p.rotateStreamGroup()
    expect(p.currentTurnRowIds()).toEqual([])
    p.recordTurnRowId('c')
    expect(p.currentTurnRowIds()).toEqual(['c'])
  })

  it('defers a post-compaction rotation to the next assistant output, once', () => {
    const p = new TestPersistence(makeDeps())
    p.rotateStreamGroupBeforeNextOutput()
    expect(p.currentStreamGroupId.endsWith(':1')).toBe(true)

    p.beginAssistantOutput()
    expect(p.currentStreamGroupId.endsWith(':2')).toBe(true)
    p.beginAssistantOutput()
    expect(p.currentStreamGroupId.endsWith(':2')).toBe(true)
  })

  it('drops a deferred rotation when a user message already started a new group', () => {
    const p = new TestPersistence(makeDeps())
    p.rotateStreamGroupBeforeNextOutput()
    // A queued user message rotates on persist; the reply must stay in its group.
    p.rotateStreamGroup()
    p.beginAssistantOutput()
    expect(p.currentStreamGroupId.endsWith(':2')).toBe(true)
  })
})

describe('SessionMessagePersistence chain', () => {
  it('runs enqueued tasks strictly in order even when earlier tasks are slower', async () => {
    const p = new TestPersistence(makeDeps())
    const order: number[] = []
    p.push(async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push(1)
    })
    p.push(async () => {
      order.push(2)
    })
    await p.waitForAll()
    expect(order).toEqual([1, 2])
  })

  it('a failed task does not break the chain and waitForAll still settles', async () => {
    const p = new TestPersistence(makeDeps())
    const order: number[] = []
    p.push(async () => {
      throw new Error('boom')
    })
    p.push(async () => {
      order.push(2)
    })
    await p.waitForAll()
    expect(order).toEqual([2])
  })

  it('waitForAll covers tasks enqueued while earlier tasks were still running', async () => {
    const p = new TestPersistence(makeDeps())
    const order: number[] = []
    p.push(async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push(1)
      p.push(async () => {
        order.push(2)
      })
    })
    await p.waitForAll()
    // First waitForAll snapshot may not include the nested task; a second await must.
    await p.waitForAll()
    expect(order).toEqual([1, 2])
  })
})

function makeBound(depsOverrides: Partial<SessionMessagePersistenceDeps> = {}, savedMessageId?: string) {
  const recorded: any[] = []
  const updates: any[] = []
  const deps = makeDeps({
    agent: {
      id: 'agent-1',
      recordMessage: async (input: any) => {
        const saved = { id: savedMessageId ?? `msg-${recorded.length + 1}`, ...input }
        recorded.push(saved)
        return saved
      },
      confirmSessionDelivery: async (deliveryId: string, owner: unknown, entryId: string, identity: unknown) => {
        updates.push({ confirmed: deliveryId, owner, entryId, identity })
        return []
      },
      update: async (patch: any) => {
        updates.push({ update: patch })
        return {}
      },
    } as any,
    ...depsOverrides,
  })
  const p = new SessionMessagePersistence(deps)
  const buffer = new StreamBuffer()
  const collector = new StreamEventCollector(buffer, () => p.currentStreamGroupId)
  p.attach({
    collector,
    buffer,
    captureUsage: () => ({ inputTokens: 1, outputTokens: 2 }) as any,
  })
  return {
    p,
    buffer,
    collector,
    recorded,
    updates,
  }
}

function persistedEvent(message: any) {
  return { type: 'session_message_persisted', message, entryId: 'entry-user', deliveryId: 'claim-1' } as any
}

describe('SessionMessagePersistence persisted events', () => {
  it('persistSessionUsage writes the agent row without a per-execution delta', async () => {
    const { p, updates } = makeBound()
    const withDelta = {
      stats: {
        userMessages: 1,
        assistantMessages: 1,
        totalMessages: 2,
        tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
        cost: 1,
      },
      context: null,
      delta: { tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 }, cost: 0.5 },
    } as any
    ;(p as any).bindings.captureUsage = () => withDelta

    const returned = await p.persistSessionUsage('test')

    const patch = updates.find((u) => u.update)?.update
    expect(patch.sessionUsage.delta).toBeUndefined()
    expect(returned.delta).toBeUndefined()
    expect(returned.stats).toEqual(withDelta.stats)
  })

  it('persists a plain assistant message, stamps the stream group, and records the turn row', async () => {
    const { p, recorded } = makeBound()
    p.enqueuePersistedEvent(persistedEvent({ role: 'assistant', content: 'hello there' }))
    await p.waitForAll()

    expect(recorded).toHaveLength(1)
    expect(recorded[0].role).toBe('assistant')
    expect(recorded[0].content).toBe('hello there')
    expect(recorded[0].metadata).toMatchObject({
      executionId: 'exec-1',
      streamGroupId: p.currentStreamGroupId,
    })

    expect(p.currentTurnRowIds()).toEqual(['msg-1'])
    expect(p.lastAssistant()?.messageId).toBe('msg-1')
  })

  it('uses out-of-band identity for real SDK multi-block arrays and image attachments', async () => {
    const { p, updates } = makeBound()
    const before = p.currentStreamGroupId
    p.enqueuePersistedEvent(
      persistedEvent({
        role: 'user',
        content: [
          { type: 'text', text: 'decorated' },
          { type: 'text', text: ' prompt' },
          { type: 'image', data: 'fixture', mimeType: 'image/png' },
        ],
      })
    )
    await p.waitForAll()
    expect(p.currentStreamGroupId).not.toBe(before)
    expect(p.currentStreamGroupId).toBe('exec-1:session:entry-user:0')
    expect(updates).toContainEqual({
      confirmed: 'claim-1',
      owner: { generation: 'session-1', executionId: 'exec-1' },
      entryId: 'entry-user',
      identity: { executionId: 'exec-1', streamGroupId: p.currentStreamGroupId },
    })
    expect(updates.some((u) => u.update?.sessionUsage)).toBe(true)
  })

  it('never acknowledges an identity-free user message, including absent content', async () => {
    const { p, updates } = makeBound()
    p.enqueuePersistedEvent({
      type: 'session_message_persisted',
      message: { role: 'user', content: [] },
      entryId: 'neutral',
    } as any)
    await p.waitForAll()
    expect(updates.some((u) => u.confirmed)).toBe(false)
  })

  it('an aborted assistant message marks its tool calls errored in metadata', async () => {
    const { p, collector, recorded } = makeBound()
    // Prime the collector with a tool-call block so snapshot() has content.
    // (Real StreamEventCollector shape: message_update/toolcall_start reads
    // the tool call out of assistantMessageEvent.partial.content[contentIndex].)
    collector.handleEvent({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: { content: [{ type: 'toolCall', id: 'tc-1', name: 'bash' }] },
      },
    } as any)
    p.enqueuePersistedEvent(
      persistedEvent({
        role: 'assistant',
        stopReason: 'aborted',
        content: [{ type: 'toolCall', id: 'tc-1' }],
      })
    )
    await p.waitForAll()

    expect(recorded).toHaveLength(1)
    const blocks = recorded[0].metadata?.content ?? []
    const tool = blocks.find((b: any) => b.type === 'tool_use')
    expect(tool).toBeDefined()
    expect(tool!.toolCall.isError).toBe(true)
    // Aborted with tool calls: no active tool message is left open.
    await p.markActiveToolAborted()
    expect(p.lastAssistant()?.messageId).toBe('msg-1')
  })

  it('emits message.updated after a tool result patches the matched persisted assistant row', async () => {
    const typeId = `tool-result-event-${crypto.randomUUID()}`
    const messageId = crypto.randomUUID()
    const toolResult = `tool-output-${crypto.randomUUID()}`
    let ownerId: string | undefined

    try {
      await AgentType.create({
        id: typeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Tool result event fixture',
        systemPrompt: 'Test.',
      })
      ownerId = (await Agent.create({ agentTypeId: typeId })).id
      await db.insert(messages).values({
        id: messageId,
        agentId: ownerId,
        role: 'assistant',
        content: 'before',
        metadata: { fixture: 'matched' },
      })
      const { p, collector } = makeBound(
        {
          agent: {
            id: ownerId,
            recordMessage: async (input: any) => ({ id: messageId, ...input }),
            confirmSessionDelivery: async () => [],
            update: async () => ({}),
          } as any,
        },
        messageId
      )
      collector.handleEvent({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 0,
          partial: { content: [{ type: 'toolCall', id: 'tc-1', name: 'bash' }] },
        },
      } as any)
      p.enqueuePersistedEvent(persistedEvent({ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1' }] }))
      await p.waitForAll()
      collector.handleEvent({
        type: 'tool_execution_end',
        toolCallId: 'tc-1',
        result: toolResult,
        isError: false,
      } as any)
      const updated: Array<{ agentId: string; messageId: string; executionId?: string; streamGroupId?: string }> = []
      const unsubscribe = eventEmitter.on('message.updated', (data) => updated.push(data))

      try {
        p.enqueuePersistedEvent(persistedEvent({ role: 'toolResult', toolCallId: 'tc-1', content: 'done' }))
        await p.waitForAll()
      } finally {
        unsubscribe()
      }

      expect(updated).toEqual([
        { agentId: ownerId, messageId, executionId: 'exec-1', streamGroupId: p.currentStreamGroupId },
      ])
      const [row] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.agentId, ownerId)))
      expect(row?.content).not.toBe('before')
      expect(row?.metadata).toMatchObject({
        content: [
          {
            type: 'tool_use',
            toolCall: { toolCallId: 'tc-1', result: toolResult, isError: false },
          },
        ],
      })
    } finally {
      await db.delete(messages).where(eq(messages.id, messageId))
      if (ownerId) await db.delete(agents).where(eq(agents.id, ownerId))
      await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    }
  })

  it('patches only the active tool row before emitting its scoped message.updated event', async () => {
    const typeId = `abort-event-${crypto.randomUUID()}`
    const messageId = crypto.randomUUID()
    const nonmatchingMessageId = crypto.randomUUID()
    let ownerId: string | undefined
    let otherOwnerId: string | undefined

    try {
      await AgentType.create({
        id: typeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Abort event fixture',
        systemPrompt: 'Test.',
      })
      ownerId = (await Agent.create({ agentTypeId: typeId })).id
      otherOwnerId = (await Agent.create({ agentTypeId: typeId })).id
      await db.insert(messages).values([
        { id: messageId, agentId: ownerId, role: 'assistant', content: 'before', metadata: { fixture: 'matched' } },
        {
          id: nonmatchingMessageId,
          agentId: otherOwnerId,
          role: 'assistant',
          content: 'untouched',
          metadata: { fixture: 'nonmatching-owner' },
        },
      ])

      const preState = await db
        .select()
        .from(messages)
        .where(inArray(messages.id, [messageId, nonmatchingMessageId]))
      expect(preState).toHaveLength(2)
      expect(preState.find((row) => row.id === messageId)).toMatchObject({ agentId: ownerId, content: 'before' })

      const { p, collector } = makeBound(
        {
          agent: {
            id: ownerId,
            recordMessage: async (input: any) => ({ id: messageId, ...input }),
            confirmSessionDelivery: async () => [],
            update: async () => ({}),
          } as any,
        },
        messageId
      )
      collector.handleEvent({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 0,
          partial: { content: [{ type: 'toolCall', id: 'tc-abort', name: 'bash' }] },
        },
      } as any)
      p.enqueuePersistedEvent(persistedEvent({ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-abort' }] }))
      await p.waitForAll()

      const observed: Array<{
        event: { agentId: string; messageId: string; executionId?: string; streamGroupId?: string }
        row: typeof messages.$inferSelect
      }> = []
      let observation: Promise<void> | undefined
      const unsubscribe = eventEmitter.on('message.updated', (event) => {
        observation = db
          .select()
          .from(messages)
          .where(and(eq(messages.id, event.messageId), eq(messages.agentId, event.agentId)))
          .then(([row]) => {
            if (row) observed.push({ event, row })
          })
      })

      try {
        await p.markActiveToolAborted('Stopped')
        await observation
      } finally {
        unsubscribe()
      }

      expect(observed).toHaveLength(1)
      expect(observed[0]!.event).toEqual({
        agentId: ownerId,
        messageId,
        executionId: 'exec-1',
        streamGroupId: p.currentStreamGroupId,
      })
      expect(observed[0]!.row.content).not.toBe('before')
      expect(observed[0]!.row.metadata).toMatchObject({
        content: [{ type: 'tool_use', toolCall: { toolCallId: 'tc-abort', result: 'Stopped', isError: true } }],
      })
      const [nonmatching] = await db.select().from(messages).where(eq(messages.id, nonmatchingMessageId))
      expect(nonmatching).toMatchObject({
        agentId: otherOwnerId,
        content: 'untouched',
        metadata: { fixture: 'nonmatching-owner' },
      })

      const { p: foreignTarget, collector: foreignCollector } = makeBound(
        {
          agent: {
            id: ownerId,
            recordMessage: async (input: any) => ({ id: nonmatchingMessageId, ...input }),
            confirmSessionDelivery: async () => [],
            update: async () => ({}),
          } as any,
        },
        nonmatchingMessageId
      )
      foreignCollector.handleEvent({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 0,
          partial: { content: [{ type: 'toolCall', id: 'tc-foreign', name: 'bash' }] },
        },
      } as any)
      foreignTarget.enqueuePersistedEvent(
        persistedEvent({ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-foreign' }] })
      )
      await foreignTarget.waitForAll()

      const foreignEvents: Array<{ agentId: string; messageId: string }> = []
      const unsubscribeForeign = eventEmitter.on('message.updated', (event) => foreignEvents.push(event))
      try {
        await foreignTarget.markActiveToolAborted('Must not persist')
      } finally {
        unsubscribeForeign()
      }

      const [foreignRow] = await db.select().from(messages).where(eq(messages.id, nonmatchingMessageId))
      expect(foreignRow).toMatchObject({
        agentId: otherOwnerId,
        content: 'untouched',
        metadata: { fixture: 'nonmatching-owner' },
      })
      expect(foreignEvents).toEqual([])
    } finally {
      await db.delete(messages).where(inArray(messages.id, [messageId, nonmatchingMessageId]))
      const createdAgentIds = [ownerId, otherOwnerId].filter((id): id is string => id !== undefined)
      if (createdAgentIds.length > 0) await db.delete(agents).where(inArray(agents.id, createdAgentIds))
      await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    }
  })

  it('does not emit message.updated when a valid active message ID matches no row', async () => {
    const ownerId = crypto.randomUUID()
    const missingMessageId = crypto.randomUUID()
    const { p, collector } = makeBound(
      {
        agent: {
          id: ownerId,
          recordMessage: async (input: any) => ({ id: missingMessageId, ...input }),
          confirmSessionDelivery: async () => [],
          update: async () => ({}),
        } as any,
      },
      missingMessageId
    )
    collector.handleEvent({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: { content: [{ type: 'toolCall', id: 'tc-missing', name: 'bash' }] },
      },
    } as any)
    p.enqueuePersistedEvent(persistedEvent({ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-missing' }] }))
    await p.waitForAll()
    expect(await db.select().from(messages).where(eq(messages.id, missingMessageId))).toEqual([])

    const updated: Array<{ agentId: string; messageId: string }> = []
    const unsubscribe = eventEmitter.on('message.updated', (event) => updated.push(event))
    try {
      await expect(p.markActiveToolAborted('Stopped')).resolves.toBeUndefined()
    } finally {
      unsubscribe()
    }

    expect(updated).toEqual([])
    expect(await db.select().from(messages).where(eq(messages.id, missingMessageId))).toEqual([])
  })

  it('does not emit message.updated when a tool result matches no owned row', async () => {
    const ownerId = crypto.randomUUID()
    const missingMessageId = crypto.randomUUID()
    const { p, collector } = makeBound(
      {
        agent: {
          id: ownerId,
          recordMessage: async (input: any) => ({ id: missingMessageId, ...input }),
          confirmSessionDelivery: async () => [],
          update: async () => ({}),
        } as any,
      },
      missingMessageId
    )
    collector.handleEvent({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: { content: [{ type: 'toolCall', id: 'tc-missing-result', name: 'bash' }] },
      },
    } as any)
    p.enqueuePersistedEvent(
      persistedEvent({ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-missing-result' }] })
    )
    await p.waitForAll()
    collector.handleEvent({
      type: 'tool_execution_end',
      toolCallId: 'tc-missing-result',
      result: 'done',
      isError: false,
    } as any)

    const updated: Array<{ agentId: string; messageId: string }> = []
    const unsubscribe = eventEmitter.on('message.updated', (event) => updated.push(event))
    try {
      p.enqueuePersistedEvent(persistedEvent({ role: 'toolResult', toolCallId: 'tc-missing-result', content: 'done' }))
      await p.waitForAll()
    } finally {
      unsubscribe()
    }

    expect(updated).toEqual([])
  })

  it('does not emit message.updated when the active tool abort persistence fails', async () => {
    const { p, collector } = makeBound({}, 'not-a-uuid')
    collector.handleEvent({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: { content: [{ type: 'toolCall', id: 'tc-abort', name: 'bash' }] },
      },
    } as any)
    p.enqueuePersistedEvent(persistedEvent({ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-abort' }] }))
    await p.waitForAll()
    const updated: Array<{ agentId: string; messageId: string; executionId?: string; streamGroupId?: string }> = []
    const unsubscribe = eventEmitter.on('message.updated', (data) => updated.push(data))

    await expect(p.markActiveToolAborted('Stopped')).rejects.toBeDefined()
    unsubscribe()

    expect(updated).toEqual([])
  })

  it('enqueueCompactionNotice records the [System] compaction row through the chain', async () => {
    const { p, recorded } = makeBound()
    p.enqueueCompactionNotice()
    await p.waitForAll()

    expect(recorded).toHaveLength(1)
    expect(recorded[0].content).toContain('Context compacted')
    expect(recorded[0].metadata.source).toBe('compaction')
    expect(recorded[0].metadata).not.toHaveProperty('executionId')
    expect(recorded[0].metadata).not.toHaveProperty('streamGroupId')
  })
})

describe('SessionMessagePersistence latest text (live activity, display only)', () => {
  it('commits a running execution text once per change, and never a finished one', async () => {
    const typeId = `latest-text-${crypto.randomUUID()}`
    let ownerId: string | undefined
    try {
      await AgentType.create({
        id: typeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Latest text fixture',
        systemPrompt: 'Test.',
      })
      ownerId = (await Agent.create({ agentTypeId: typeId })).id
      const [running] = await db.insert(executions).values({ agentId: ownerId, status: 'running' }).returning()
      const [finished] = await db.insert(executions).values({ agentId: ownerId, status: 'completed' }).returning()
      const read = async (id: string) => (await db.select().from(executions).where(eq(executions.id, id)))[0]!

      const live = new SessionMessagePersistence(makeDeps({ executionId: running.id }))
      live.enqueueLatestText('Reading the diff')
      await live.waitForAll()
      const first = await read(running.id)
      expect(first.latestText).toBe('Reading the diff')
      expect(first.latestTextAt).toBeInstanceOf(Date)

      // The same text again (text_end then toolcall_start) writes nothing.
      live.enqueueLatestText('Reading the diff')
      await live.waitForAll()
      expect((await read(running.id)).latestTextAt?.getTime()).toBe(first.latestTextAt?.getTime())

      live.enqueueLatestText('Reading the diff, then the Caddyfile')
      await live.waitForAll()
      expect((await read(running.id)).latestText).toBe('Reading the diff, then the Caddyfile')

      const done = new SessionMessagePersistence(makeDeps({ executionId: finished.id }))
      done.enqueueLatestText('Too late')
      await done.waitForAll()
      expect((await read(finished.id)).latestText).toBeNull()
    } finally {
      if (ownerId) await db.delete(agents).where(eq(agents.id, ownerId))
      await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    }
  })
})

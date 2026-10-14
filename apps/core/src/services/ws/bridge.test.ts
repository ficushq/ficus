import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { WebSocketManager } from './manager'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { setupEventBridge } from './bridge'

describe('WebSocket Event Bridge', () => {
  test('broadcasts schedule health transitions to collection and instance topics', () => {
    const manager = new WebSocketManager()
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    eventEmitter.removeAllListeners()
    setupEventBridge(manager)

    for (const event of ['schedule.failed', 'schedule.recovered', 'schedule.automatically_disabled'] as const) {
      const data = { scheduleId: 'schedule-1', healthEventId: 'event-1' }
      eventEmitter.emit(event, data)
      expect(broadcastSpy).toHaveBeenCalledWith('schedules', event, data)
      expect(broadcastSpy).toHaveBeenCalledWith('schedules:schedule-1', event, data)
    }
  })

  let manager: WebSocketManager

  beforeEach(() => {
    manager = new WebSocketManager()
    eventEmitter.removeAllListeners()
  })

  test('broadcasts message.created to agents topic (wrapped)', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { messageId: 'msg-1', agentId: 'agent-1' }
    eventEmitter.emit('message.created', data)

    expect(broadcastSpy).toHaveBeenCalledWith('agents', 'message.created', data)
    expect(broadcastSpy).toHaveBeenCalledWith('agents:agent-1', 'message.created', data)
  })

  test('forwards enriched message.updated identity unchanged to collection and instance topics', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = {
      messageId: 'msg-1',
      agentId: 'agent-1',
      executionId: 'execution-1',
      streamGroupId: 'group-1',
    }
    eventEmitter.emit('message.updated', data)

    expect(broadcastSpy).toHaveBeenCalledWith('agents', 'message.updated', data)
    expect(broadcastSpy).toHaveBeenCalledWith('agents:agent-1', 'message.updated', data)
  })

  test('broadcasts agent.updated to agents topic (wrapped)', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { agentId: 'agent-1', squadId: 'squad-1' }
    eventEmitter.emit('agent.updated', data)

    expect(broadcastSpy).toHaveBeenCalledWith('agents', 'agent.updated', data)
    expect(broadcastSpy).toHaveBeenCalledWith('agents:agent-1', 'agent.updated', data)
  })

  test('broadcasts agent.mood, a label only, to the agents topics under the agent scope', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { agentId: 'agent-1', squadId: 'squad-1', mood: 'exploring' as const, source: 'model' as const, at: 1 }
    eventEmitter.emit('agent.mood', data)

    expect(broadcastSpy).toHaveBeenCalledWith('agents', 'agent.mood', data)
    expect(broadcastSpy).toHaveBeenCalledWith('agents:agent-1', 'agent.mood', data)
  })

  test.each([
    'agent-question.created',
    'agent-question.answered',
    'agent-question.delivery-failed',
    'agent-question.delivery-retrying',
    'agent-question.dismissed',
  ] as const)('broadcasts %s to agent topics and the canonical Action Center audience', async (event) => {
    const broadcastSpy = mock(async () => {})
    const invalidationSpy = mock(() => {})
    const audienceSpy = mock(async () => ['direct-user', 'owner-user'])
    manager.broadcast = broadcastSpy
    manager.broadcastActionCenterInvalidation = invalidationSpy
    setupEventBridge(manager, { listAgentQuestionAttentionUserIds: audienceSpy })

    const data = { questionId: 'question-1', agentId: 'agent-1', squadId: 'squad-1' }
    eventEmitter.emit(event, data)
    await Bun.sleep(0)

    expect(broadcastSpy).toHaveBeenCalledWith('agents', event, data)
    expect(broadcastSpy).toHaveBeenCalledWith('agents:agent-1', event, data)
    expect(audienceSpy).toHaveBeenCalledTimes(1)
    expect(audienceSpy).toHaveBeenCalledWith(data.questionId)
    expect(invalidationSpy).toHaveBeenCalledTimes(1)
    expect(invalidationSpy).toHaveBeenCalledWith(['direct-user', 'owner-user'])
  })

  test('fails Action Center audience lookup closed without hiding existing agent events', async () => {
    const broadcastSpy = mock(async () => {})
    const invalidationSpy = mock(() => {})
    manager.broadcast = broadcastSpy
    manager.broadcastActionCenterInvalidation = invalidationSpy
    setupEventBridge(manager, {
      listAgentQuestionAttentionUserIds: mock(async () => {
        throw new Error('database unavailable')
      }),
    })

    const data = { questionId: 'question-1', agentId: 'agent-1', squadId: 'squad-1' }
    eventEmitter.emit('agent-question.created', data)
    await Bun.sleep(0)

    expect(broadcastSpy).toHaveBeenCalledWith('agents', 'agent-question.created', data)
    expect(broadcastSpy).toHaveBeenCalledWith('agents:agent-1', 'agent-question.created', data)
    expect(invalidationSpy).not.toHaveBeenCalled()
  })

  test('fences Action Center delivery after audience lookup through current subscriptions', async () => {
    const lookupStarted = Promise.withResolvers<void>()
    const releaseLookup = Promise.withResolvers<string[]>()
    const ws = { readyState: WebSocket.OPEN, send: mock((_data: string) => 0) } as any
    const client = manager.addClient(ws, { type: 'user', userId: 'direct-user' })
    await manager.subscribe(client, 'actions')
    ws.send.mockClear()
    setupEventBridge(manager, {
      listAgentQuestionAttentionUserIds: mock(async () => {
        lookupStarted.resolve()
        return releaseLookup.promise
      }),
    })

    eventEmitter.emit('agent-question.created', {
      questionId: 'question-1',
      agentId: 'agent-1',
      squadId: 'squad-1',
    })
    await lookupStarted.promise
    manager.removeClient(client)
    releaseLookup.resolve(['direct-user'])
    await Bun.sleep(0)

    expect(ws.send).not.toHaveBeenCalled()
  })

  test('broadcasts artifact.updated to agents topic (wrapped)', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = {
      agentId: 'agent-1',
      squadId: null,
      artifactId: 'artifact-1',
      title: 'Dashboard',
      summary: 'Updated dashboard.',
      status: 'ready' as const,
      updatedAt: '2026-05-02T22:30:00.000Z',
    }
    eventEmitter.emit('artifact.updated', data)

    expect(broadcastSpy).toHaveBeenCalledWith('agents', 'artifact.updated', data)
    expect(broadcastSpy).toHaveBeenCalledWith('agents:agent-1', 'artifact.updated', data)
  })

  test('routes sandbox.status for an agent box to the agents topic + instance', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { sandboxId: 'agent_abc123' }
    eventEmitter.emit('sandbox.status', data)

    expect(broadcastSpy).toHaveBeenCalledWith('agents', 'sandbox.status', data)
    expect(broadcastSpy).toHaveBeenCalledWith('agents:abc123', 'sandbox.status', data)
  })

  test('routes sandbox.status for a system-manager box to the agents collection only', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { sandboxId: 'system_manager_user-1' }
    eventEmitter.emit('sandbox.status', data)

    expect(broadcastSpy).toHaveBeenCalledWith('agents', 'sandbox.status', data)
    expect(broadcastSpy).not.toHaveBeenCalledWith('agents:user-1', 'sandbox.status', data)
  })

  test('routes sandbox.status for a squad box to the squads topic + instance', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { sandboxId: 'squad_sq1' }
    eventEmitter.emit('sandbox.status', data)

    expect(broadcastSpy).toHaveBeenCalledWith('squads', 'sandbox.status', data)
    expect(broadcastSpy).toHaveBeenCalledWith('squads:sq1', 'sandbox.status', data)
  })

  test('does not broadcast sandbox.status for an unknown sandbox-id prefix', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    eventEmitter.emit('sandbox.status', { sandboxId: 'mystery_xyz' })

    expect(broadcastSpy).not.toHaveBeenCalled()
  })

  test('broadcasts execution.completed to agents topic (wrapped)', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { executionId: 'exec-123', agentId: 'agent-1', status: 'completed' }
    eventEmitter.emit('execution.completed', data)

    expect(broadcastSpy).toHaveBeenCalledWith('agents', 'execution.completed', data)
    expect(broadcastSpy).toHaveBeenCalledWith('agents:agent-1', 'execution.completed', data)
  })

  test('broadcasts squad.created to squads topic (wrapped)', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { squadId: 'squad-1' }
    eventEmitter.emit('squad.created', data)

    expect(broadcastSpy).toHaveBeenCalledWith('squads', 'squad.created', data)
    expect(broadcastSpy).toHaveBeenCalledWith('squads:squad-1', 'squad.created', data)
  })

  test('routes content-free slot invalidation only through squad-scoped topics', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)
    const data = { squadId: 'squad-1' }
    eventEmitter.emit('slots.updated', data)
    expect(broadcastSpy).toHaveBeenCalledTimes(2)
    expect(broadcastSpy).toHaveBeenCalledWith('squads', 'slots.updated', data)
    expect(broadcastSpy).toHaveBeenCalledWith('squads:squad-1', 'slots.updated', data)
  })

  test('broadcasts machine.created to machines topic + instance', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { machineId: 'machine-1' }
    eventEmitter.emit('machine.created', data)

    expect(broadcastSpy).toHaveBeenCalledWith('machines', 'machine.created', data)
    expect(broadcastSpy).toHaveBeenCalledWith('machines:machine-1', 'machine.created', data)
  })

  test('broadcasts machine.updated to machines topic + instance', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { machineId: 'machine-1' }
    eventEmitter.emit('machine.updated', data)

    expect(broadcastSpy).toHaveBeenCalledWith('machines', 'machine.updated', data)
    expect(broadcastSpy).toHaveBeenCalledWith('machines:machine-1', 'machine.updated', data)
  })

  test('broadcasts machine.status to machines topic + instance', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { machineId: 'machine-1', status: 'ready' }
    eventEmitter.emit('machine.status', data)

    expect(broadcastSpy).toHaveBeenCalledWith('machines', 'machine.status', data)
    expect(broadcastSpy).toHaveBeenCalledWith('machines:machine-1', 'machine.status', data)
  })

  test('broadcasts machine.deleted to machines topic + instance', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { machineId: 'machine-1' }
    eventEmitter.emit('machine.deleted', data)

    expect(broadcastSpy).toHaveBeenCalledWith('machines', 'machine.deleted', data)
    expect(broadcastSpy).toHaveBeenCalledWith('machines:machine-1', 'machine.deleted', data)
  })

  test('broadcasts box.status to machines topic + instance (keyed by machineId)', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { sandboxId: 'agent_a1', machineId: 'machine-1', status: 'ready', port: 50100 }
    eventEmitter.emit('box.status', data)

    expect(broadcastSpy).toHaveBeenCalledWith('machines', 'box.status', data)
    expect(broadcastSpy).toHaveBeenCalledWith('machines:machine-1', 'box.status', data)
  })

  test('broadcasts workStream.updated to workstreams topic (wrapped)', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { workStreamId: 'ws-1', squadId: 'squad-1' }
    eventEmitter.emit('workStream.updated', data)

    expect(broadcastSpy).toHaveBeenCalledWith('workstreams', 'workStream.updated', data)
    expect(broadcastSpy).toHaveBeenCalledWith('workstreams:ws-1', 'workStream.updated', data)
  })

  test('broadcasts worker.status to worker topic only (no instance topic)', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    eventEmitter.emit('worker.status', { status: 'online', activeExecutions: 2, uptime: 100 })

    expect(broadcastSpy).toHaveBeenCalledTimes(1)
    expect(broadcastSpy).toHaveBeenCalledWith('worker', 'worker.status', {
      status: 'online',
      activeExecutions: 2,
      uptime: 100,
    })
  })

  test('broadcasts onboarding.updated to the onboarding topic only (no instance topic)', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    eventEmitter.emit('onboarding.updated', {})

    expect(broadcastSpy).toHaveBeenCalledTimes(1)
    expect(broadcastSpy).toHaveBeenCalledWith('onboarding', 'onboarding.updated', {})
  })

  test('broadcasts inbox.messageReceived for an agent recipient to inbox collection and recipient topics', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = {
      messageId: 'msg-1',
      recipientType: 'agent' as const,
      recipientId: 'agent-1',
      senderAgentId: null,
    }
    eventEmitter.emit('inbox.messageReceived', data)

    expect(broadcastSpy).toHaveBeenCalledTimes(2)
    expect(broadcastSpy).toHaveBeenCalledWith('inbox', 'inbox.messageReceived', data)
    expect(broadcastSpy).toHaveBeenCalledWith('inbox:agent-1', 'inbox.messageReceived', data)
  })

  test('broadcasts inbox.messageRead for an agent recipient to inbox collection and recipient topics', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = {
      messageId: 'msg-1',
      recipientType: 'agent' as const,
      recipientId: 'agent-1',
    }
    eventEmitter.emit('inbox.messageRead', data)

    expect(broadcastSpy).toHaveBeenCalledTimes(2)
    expect(broadcastSpy).toHaveBeenCalledWith('inbox', 'inbox.messageRead', data)
    expect(broadcastSpy).toHaveBeenCalledWith('inbox:agent-1', 'inbox.messageRead', data)
  })

  test('broadcasts inbox.allRead for an agent recipient to inbox collection and recipient topics', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = { recipientType: 'agent' as const, recipientId: 'agent-1' }
    eventEmitter.emit('inbox.allRead', data)

    expect(broadcastSpy).toHaveBeenCalledTimes(2)
    expect(broadcastSpy).toHaveBeenCalledWith('inbox', 'inbox.allRead', data)
    expect(broadcastSpy).toHaveBeenCalledWith('inbox:agent-1', 'inbox.allRead', data)
  })

  test('serializes projected Activity delivery per squad so tombstones precede replacements', async () => {
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const delivered: string[] = []
    manager.broadcastActivity = mock(async (data) => {
      delivered.push(`${data.operation}:${data.item.id}`)
      if (delivered.length === 1) await firstPending
    })
    setupEventBridge(manager)
    const item = {
      id: `30:${crypto.randomUUID()}`,
      at: new Date().toISOString(),
      agentId: null,
      agentTypeId: null,
      kind: 'workstream' as const,
      summary: '[ws visibility changed]',
      preview: [{ text: '[ws visibility changed]' }],
      ref: { type: 'workstream' as const, workStreamId: crypto.randomUUID() },
    }
    const base = {
      squadId: crypto.randomUUID(),
      item,
      quietEligible: true,
      accessScope: 'workstreams' as const,
      inboxRecipientId: null,
      agentTypeRequiresAgentsRead: false,
    }
    eventEmitter.emit('squadActivity.projected', { ...base, operation: 'delete' })
    eventEmitter.emit('squadActivity.projected', { ...base, operation: 'upsert' })
    const other = { ...base, squadId: crypto.randomUUID(), item: { ...item, id: `30:${crypto.randomUUID()}` } }
    eventEmitter.emit('squadActivity.projected', { ...other, operation: 'upsert' })
    await Bun.sleep(0)
    expect(delivered).toEqual([`delete:${item.id}`, `upsert:${other.item.id}`])
    releaseFirst()
    await Bun.sleep(0)
    expect(delivered).toEqual([`delete:${item.id}`, `upsert:${other.item.id}`, `upsert:${item.id}`])
  })

  test('bounds a stalled Activity queue and falls back to reconciliation', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let broadcasts = 0
    let reconciliations = 0
    manager.broadcastActivity = mock(async () => {
      broadcasts++
      if (broadcasts === 1) await blocked
    })
    manager.purgeActivitySubscriptions = mock(async () => {
      reconciliations++
    })
    setupEventBridge(manager)
    const base = {
      squadId: crypto.randomUUID(),
      item: {
        id: `30:${crypto.randomUUID()}`,
        at: new Date().toISOString(),
        agentId: null,
        agentTypeId: null,
        kind: 'workstream' as const,
        summary: '[ws overflow]',
        preview: [{ text: '[ws overflow]' }],
        ref: { type: 'workstream' as const, workStreamId: crypto.randomUUID() },
      },
      operation: 'upsert' as const,
      quietEligible: true,
      accessScope: 'workstreams' as const,
      inboxRecipientId: null,
      agentTypeRequiresAgentsRead: false,
    }
    eventEmitter.emit('squadActivity.projected', base)
    for (let index = 0; index < 251; index++)
      eventEmitter.emit('squadActivity.projected', {
        ...base,
        item: { ...base.item, id: `30:${crypto.randomUUID()}` },
      })
    release()
    for (let attempt = 0; attempt < 50 && reconciliations === 0; attempt++) await Bun.sleep(0)
    expect(reconciliations).toBe(1)
    expect(broadcasts).toBe(1)
  })

  test('continues an Activity delivery queue after a failed broadcast', async () => {
    const delivered: string[] = []
    manager.broadcastActivity = mock(async (data) => {
      delivered.push(data.operation)
      if (delivered.length === 1) throw new Error('first delivery failed')
    })
    setupEventBridge(manager)
    const base = {
      squadId: crypto.randomUUID(),
      item: {
        id: `30:${crypto.randomUUID()}`,
        at: new Date().toISOString(),
        agentId: null,
        agentTypeId: null,
        kind: 'workstream' as const,
        summary: '[ws queue]',
        preview: [{ text: '[ws queue]' }],
        ref: { type: 'workstream' as const, workStreamId: crypto.randomUUID() },
      },
      quietEligible: true,
      accessScope: 'workstreams' as const,
      inboxRecipientId: null,
      agentTypeRequiresAgentsRead: false,
    }
    eventEmitter.emit('squadActivity.projected', { ...base, operation: 'delete' })
    eventEmitter.emit('squadActivity.projected', { ...base, operation: 'upsert' })
    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(delivered).toEqual(['delete', 'upsert'])
  })

  test('does not broadcast internal integration projection invalidations', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    eventEmitter.emit('integration.projection-invalidated', {
      squadId: crypto.randomUUID(),
      providerKey: 'notion',
    })

    expect(broadcastSpy).not.toHaveBeenCalled()
  })

  test('broadcasts inbox.messageReceived for a human recipient to inbox collection and recipient topics', () => {
    const broadcastSpy = mock(async () => {})
    manager.broadcast = broadcastSpy
    setupEventBridge(manager)

    const data = {
      messageId: 'msg-1',
      recipientType: 'user' as const,
      recipientId: 'user-1',
      senderAgentId: null,
    }
    eventEmitter.emit('inbox.messageReceived', data)

    expect(broadcastSpy).toHaveBeenCalledTimes(2)
    expect(broadcastSpy).toHaveBeenCalledWith('inbox', 'inbox.messageReceived', data)
    expect(broadcastSpy).toHaveBeenCalledWith('inbox:user-1', 'inbox.messageReceived', data)
  })
})

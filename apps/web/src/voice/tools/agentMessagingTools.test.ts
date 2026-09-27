import { describe, expect, test } from 'bun:test'
import { createAgentMessagingTools } from './agentMessagingTools'

const calls: Array<{ agentId: string; content: string; mode?: string }> = []
const inboxCalls: unknown[] = []
const stops: string[] = []
let agentFixture: any = { id: 'agent-1', agentTypeId: 'system-manager', squadId: null }
let inboxDelivered = true

const { directMessageAgentTool, workspaceInboxMessageAgentTool } = createAgentMessagingTools({
  getAgent: async () => agentFixture,
  sendAgentMessage: async (agentId: string, content: string, _images?: string[], mode?: any) => {
    calls.push({ agentId, content, mode })
    return { success: true, status: 'queued' } as any
  },
  stopAgent: async (agentId: string) => {
    stops.push(agentId)
    return { success: true }
  },
  sendInboxMessage: async (input: any) => {
    inboxCalls.push(input)
    return {
      id: 'inbox-message-id',
      recipientType: 'agent',
      recipientId: input.recipientId,
      senderType: 'voice_assistant',
      senderId: 'me',
      subject: null,
      content: input.content,
      metadata: input.metadata,
      readAt: null,
      deliveredAt: inboxDelivered ? '2026-05-03T00:00:00.000Z' : null,
      deliveryMode: input.deliveryMode,
      createdAt: '2026-05-03T00:00:00.000Z',
    } as any
  },
})
const messageAgentTool = directMessageAgentTool

describe('message_agent voice tool', () => {
  test('direct site-operator tool calls sendAgentMessage with default steer delivery mode', async () => {
    calls.length = 0
    inboxCalls.length = 0
    agentFixture = { id: 'system-manager', agentTypeId: 'system-manager', squadId: null, status: 'idle' }

    const result = await directMessageAgentTool.execute({ agentId: 'system-manager', content: 'Please help' }, {})

    expect(result).toEqual({ ok: true, agentStatus: 'queued' })
    expect(calls).toEqual([{ agentId: 'system-manager', content: 'Please help', mode: 'steer' }])
    expect(inboxCalls).toEqual([])
  })

  test('stop mode stops the agent without sending a message', async () => {
    calls.length = 0
    stops.length = 0
    agentFixture = { id: 'worker', agentTypeId: 'engineer', squadId: 'squad', status: 'active' }
    const result = await directMessageAgentTool.execute({ agentId: 'worker', mode: 'stop' }, {})
    expect(result).toEqual({ ok: true, stopped: true })
    expect(stops).toEqual(['worker'])
    expect(calls).toEqual([])
  })

  test('default delivery is steer', async () => {
    calls.length = 0
    agentFixture = { id: 'worker', agentTypeId: 'engineer', squadId: 'squad', status: 'active' }
    await directMessageAgentTool.execute({ agentId: 'worker', content: 'Now' }, {})
    expect(calls).toEqual([{ agentId: 'worker', content: 'Now', mode: 'steer' }])
  })

  test('rejects a missing content when mode is not stop', async () => {
    calls.length = 0
    agentFixture = { id: 'worker', agentTypeId: 'engineer', squadId: 'squad', status: 'active' }
    const result = await directMessageAgentTool.execute({ agentId: 'worker' }, {})
    expect(result).toEqual({ error: 'content is required unless mode is stop' })
    expect(calls).toEqual([])
  })

  test('direct site-operator tool calls sendAgentMessage with selected delivery mode', async () => {
    calls.length = 0
    inboxCalls.length = 0
    agentFixture = { id: 'system-manager', agentTypeId: 'system-manager', squadId: null, status: 'running' }

    const result = await directMessageAgentTool.execute(
      { agentId: 'system-manager', content: 'Later note', mode: 'follow-up' },
      {}
    )

    expect(result).toEqual({ ok: true, agentStatus: 'queued' })
    expect(calls).toEqual([{ agentId: 'system-manager', content: 'Later note', mode: 'follow-up' }])
    expect(inboxCalls).toEqual([])
  })

  test('workspace message_agent sends inbox message from workspace voice assistant', async () => {
    calls.length = 0
    inboxCalls.length = 0
    inboxDelivered = true
    agentFixture = { id: 'manager-agent', agentTypeId: 'system-manager', squadId: null, status: 'idle' }

    const result = await workspaceInboxMessageAgentTool.execute(
      { agentId: 'manager-agent', content: 'Check the launch plan' },
      {}
    )

    expect(inboxCalls).toEqual([
      expect.objectContaining({
        recipientType: 'agent',
        recipientId: 'manager-agent',
        asVoiceAssistant: true,
        content:
          'Check the launch plan\n\nReply to the workspace voice assistant through inbox: ficus inbox send <this message\'s sender id> "<message>" --recipient-type voice_assistant.',
        deliveryMode: 'steer',
        metadata: {
          sourceTool: 'message_agent',
        },
      }),
    ])
    expect(calls).toEqual([])
    expect(result).toEqual({ ok: true, persisted: true, delivered: true, deliveryMode: 'steer' })
  })

  test('workspace message_agent reports whether inbox delivery was claimed', async () => {
    calls.length = 0
    inboxCalls.length = 0
    agentFixture = { id: 'manager-agent', agentTypeId: 'system-manager', squadId: null, status: 'running' }

    inboxDelivered = true
    await expect(
      workspaceInboxMessageAgentTool.execute(
        { agentId: 'manager-agent', content: 'Queued note', mode: 'follow-up' },
        {}
      )
    ).resolves.toEqual({ ok: true, persisted: true, delivered: true, deliveryMode: 'follow-up' })

    inboxDelivered = false
    await expect(
      workspaceInboxMessageAgentTool.execute({ agentId: 'manager-agent', content: 'Interrupt now' }, {})
    ).resolves.toEqual({ ok: true, persisted: true, delivered: false, deliveryMode: 'steer' })
    inboxDelivered = true
  })

  test('workspace message_agent rejects a missing content', async () => {
    calls.length = 0
    inboxCalls.length = 0
    agentFixture = { id: 'manager-agent', agentTypeId: 'system-manager', squadId: null, status: 'idle' }

    const result = await workspaceInboxMessageAgentTool.execute({ agentId: 'manager-agent' }, {})

    expect(result).toEqual({ error: 'content is required' })
    expect(inboxCalls).toEqual([])
  })

  test('workspace message_agent rejects stop mode without forwarding it as a delivery mode', async () => {
    calls.length = 0
    inboxCalls.length = 0
    agentFixture = { id: 'manager-agent', agentTypeId: 'system-manager', squadId: null, status: 'active' }

    const result = await workspaceInboxMessageAgentTool.execute(
      { agentId: 'manager-agent', content: 'stop it', mode: 'stop' },
      {}
    )

    expect(result).toEqual({ error: 'stop is not available in this surface' })
    expect(inboxCalls).toEqual([])
  })

  test('allows waiting-input artifact builders so voice can answer ask_human questions', async () => {
    calls.length = 0
    inboxCalls.length = 0
    agentFixture = {
      id: 'artifact-agent',
      agentTypeId: 'artifact-builder-default',
      squadId: null,
      status: 'waiting-input',
    }

    const result = await messageAgentTool.execute({ agentId: 'artifact-agent', content: 'Use Vercel' }, {})

    expect(result).toMatchObject({ ok: true })
    expect(calls).toEqual([{ agentId: 'artifact-agent', content: 'Use Vercel', mode: 'steer' }])
    expect(inboxCalls).toEqual([])
  })

  test('rejects artifact builders that are not waiting for input', async () => {
    calls.length = 0
    inboxCalls.length = 0
    agentFixture = { id: 'artifact-agent', agentTypeId: 'artifact-builder-default', squadId: null }

    const result = await messageAgentTool.execute({ agentId: 'artifact-agent', content: 'tweak it' }, {})

    expect(result).toMatchObject({ ok: false })
    expect(String((result as any).error)).toContain('request_artifact')
    expect(calls).toEqual([])
  })

  test('allows system managers and squad agents', async () => {
    calls.length = 0
    inboxCalls.length = 0
    agentFixture = { id: 'system-manager', agentTypeId: 'system-manager', squadId: null }
    await expect(messageAgentTool.execute({ agentId: 'system-manager', content: 'help' }, {})).resolves.toMatchObject({
      ok: true,
    })

    agentFixture = { id: 'worker-1', agentTypeId: 'engineer', squadId: 'squad-1' }
    await expect(
      messageAgentTool.execute({ agentId: 'worker-1', content: 'help', mode: 'follow-up' }, {})
    ).resolves.toMatchObject({
      ok: true,
    })

    expect(calls.map((call) => call.agentId)).toEqual(['system-manager', 'worker-1'])
    expect(calls[1].mode).toBe('follow-up')
  })

  test('each surface describes the routing it actually has', () => {
    // The site operator owns delegate_task, so its message_agent must not route work to a
    // "user assistant"; the workspace surface has no delegate_task and must never name it.
    const direct = directMessageAgentTool.definition.description
    expect(direct).toContain('delegate_task')
    expect(direct).not.toContain('user assistant')
    expect(workspaceInboxMessageAgentTool.definition.description).not.toContain('delegate_task')
  })
})

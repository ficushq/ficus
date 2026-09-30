import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { buildNotificationEvent, getAppOrigin } from './event-builders'
import { WorkStream } from '../../entities/WorkStream'
import { Squad } from '../../entities/Squad'
import { InboxMessage } from '../../entities/InboxMessage'
import { Agent } from '../../entities/Agent'
import * as questionsModule from '../agents/questions'
import * as waitsModule from '../work-streams/waits'

const spies: Array<{ mockRestore: () => void }> = []

function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy)
  return spy
}

describe('notification event builders', () => {
  const originalAppUrl = process.env.APP_URL

  afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore()
    if (originalAppUrl === undefined) delete process.env.APP_URL
    else process.env.APP_URL = originalAppUrl
  })

  test('builds an agent question notification from persisted state', async () => {
    process.env.APP_URL = 'https://ficus.example'
    track(
      spyOn(questionsModule, 'getAgentQuestion').mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000001',
        agentId: 'a1',
        squadId: 's1',
        ownerUserId: null,
        questionData: {
          questions: [
            { id: '1', type: 'text', question: ' Which release should I target? ' },
            { id: '2', type: 'text', question: '  ' },
          ],
        },
        status: 'open',
        answer: null,
        answeredByUserId: null,
        createdAt: new Date().toISOString(),
        answeredAt: null,
      })
    )
    track(
      spyOn(Agent, 'find').mockResolvedValue({
        id: 'a1',
        agentTypeId: 'engineer',
        metadata: { name: 'Forge' },
      } as any)
    )
    track(spyOn(Squad, 'find').mockResolvedValue({ id: 's1', name: 'Ficus' } as any))

    expect(
      await buildNotificationEvent('agent-question.created', {
        questionId: '00000000-0000-4000-8000-000000000001',
        agentId: 'forged',
      })
    ).toMatchObject({
      type: 'agent-question.created',
      actionId: 'agent-question:00000000-0000-4000-8000-000000000001',
      agentId: 'a1',
      squadId: 's1',
      squadName: 'Ficus',
      title: '❓ Forge has a question',
      body: 'Which release should I target?',
      url: 'https://ficus.example/squads/s1?agent=a1',
    })
  })

  test('builds personal agent question routing and rejects missing questions', async () => {
    process.env.APP_URL = 'https://ficus.example'
    const persisted = {
      id: '00000000-0000-4000-8000-000000000002',
      agentId: 'a-personal',
      squadId: null,
      ownerUserId: 'u1',
      questionData: { questions: [{ id: '1', type: 'text' as const, question: '' }] },
      status: 'open' as const,
      answer: null,
      answeredByUserId: null,
      createdAt: new Date().toISOString(),
      answeredAt: null,
    }
    const getQuestionSpy = track(
      spyOn(questionsModule, 'getAgentQuestion').mockImplementation(async (id) =>
        id === persisted.id ? persisted : null
      )
    )
    track(
      spyOn(Agent, 'find').mockResolvedValue({
        id: 'a-personal',
        agentTypeId: 'manager',
        metadata: {},
      } as any)
    )

    expect(await buildNotificationEvent('agent-question.created', { questionId: 42 })).toBeNull()
    expect(getQuestionSpy).not.toHaveBeenCalled()

    expect(await buildNotificationEvent('agent-question.created', { questionId: persisted.id })).toMatchObject({
      actionId: `agent-question:${persisted.id}`,
      agentId: 'a-personal',
      title: '❓ manager has a question',
      body: 'Open Ficus to respond',
      url: 'https://ficus.example/chat/a-personal',
    })
    expect(await buildNotificationEvent('agent-question.created', {})).toBeNull()
    expect(await buildNotificationEvent('agent-question.created', { questionId: 'missing' })).toBeNull()
  })

  test('adds the work stream id to work stream notification events', async () => {
    track(
      spyOn(WorkStream, 'find').mockResolvedValue({
        id: 'ws1',
        squadId: 's1',
        title: 'Needs review',
        description: 'Review the changes',
        blockedPrompt: null,
      } as any)
    )
    track(spyOn(Squad, 'find').mockResolvedValue({ id: 's1', name: 'Ficus' } as any))
    track(
      spyOn(waitsModule, 'listOpenWaits').mockResolvedValue([
        { id: 'wait-review-1', workStreamId: 'ws1', type: 'review' } as any,
      ])
    )

    const event = await buildNotificationEvent('workStream.review', {
      workStreamId: 'ws1',
      squadId: 's1',
      waitId: 'wait-review-1',
    })

    expect(event).toMatchObject({
      type: 'workStream.review',
      squadId: 's1',
      squadName: 'Ficus',
      workStreamId: 'ws1',
      waitId: 'wait-review-1',
      actionId: 'workstream-review:ws1:wait-review-1',
    })
    expect(
      await buildNotificationEvent('workStream.review', {
        workStreamId: 'ws1',
        squadId: 'forged-squad',
        waitId: 'wait-review-1',
      })
    ).toBeNull()
  })

  test('uses the exact concurrent manual wait message for the notification body', async () => {
    track(spyOn(WorkStream, 'find').mockResolvedValue({ id: 'ws1', squadId: 's1', title: 'Blocked stream' } as any))
    track(spyOn(Squad, 'find').mockResolvedValue({ id: 's1', name: 'Ficus' } as any))
    track(
      spyOn(waitsModule, 'listOpenWaits').mockResolvedValue([
        { id: 'newer', workStreamId: 'ws1', type: 'manual', message: 'Newer unrelated wait' } as any,
        { id: 'target', workStreamId: 'ws1', type: 'manual', message: 'Exact target wait' } as any,
      ])
    )

    expect(
      await buildNotificationEvent('workStream.blocked', { workStreamId: 'ws1', squadId: 's1', waitId: 'target' })
    ).toMatchObject({
      waitId: 'target',
      actionId: 'workstream-blocked:ws1:target',
      body: 'Exact target wait',
    })
  })

  test('builds no human channel notification for owner-actor manual waits', async () => {
    track(spyOn(WorkStream, 'find').mockResolvedValue({ id: 'ws1', squadId: 's1', title: 'Held stream' } as any))
    track(spyOn(Squad, 'find').mockResolvedValue({ id: 's1', name: 'Ficus' } as any))
    const listOpenWaits = track(spyOn(waitsModule, 'listOpenWaits'))
    for (const actor of ['owner']) {
      listOpenWaits.mockResolvedValue([
        { id: 'target', workStreamId: 'ws1', type: 'manual', actor, message: 'Held for #353' } as any,
      ])
      // Exact target known.
      expect(
        await buildNotificationEvent('workStream.blocked', { workStreamId: 'ws1', squadId: 's1', waitId: 'target' })
      ).toBeNull()
      // Legacy payload without a wait id: no human-actor manual wait is open.
      expect(await buildNotificationEvent('workStream.blocked', { workStreamId: 'ws1', squadId: 's1' })).toBeNull()
    }
    // A human wait alongside keeps the legacy (no wait id) notification and names the human wait.
    listOpenWaits.mockResolvedValue([
      { id: 'hold', workStreamId: 'ws1', type: 'manual', actor: 'owner', message: 'Held for #353' } as any,
      { id: 'key', workStreamId: 'ws1', type: 'manual', actor: 'human', message: 'Need the API key' } as any,
    ])
    expect(await buildNotificationEvent('workStream.blocked', { workStreamId: 'ws1', squadId: 's1' })).toMatchObject({
      type: 'workStream.blocked',
      body: 'Need the API key',
    })
  })

  test('adds the agent id to execution notification events', async () => {
    const { Agent } = await import('../../entities/Agent')
    const { Execution } = await import('../../entities/Execution')
    track(
      spyOn(Agent, 'find').mockResolvedValue({
        id: 'a1',
        agentTypeId: 'engineer',
        squadId: 's1',
        metadata: { name: 'Engineer' },
      } as any)
    )
    track(spyOn(Execution, 'find').mockResolvedValue({ id: 'e1', error: null } as any))
    track(spyOn(Squad, 'find').mockResolvedValue({ id: 's1', name: 'Ficus' } as any))

    const event = await buildNotificationEvent('execution.completed', { executionId: 'e1', agentId: 'a1' })

    expect(event).toMatchObject({
      type: 'execution.completed',
      squadId: 's1',
      squadName: 'Ficus',
      agentId: 'a1',
    })
  })

  test('adds message and sender routing fields to agent-sent inbox notification events', async () => {
    track(
      spyOn(InboxMessage, 'find').mockResolvedValue({
        id: 'm1',
        senderType: 'agent',
        senderId: 'a1',
        metadata: { sender: { squadId: 's1' } },
        subject: 'Question',
        content: 'Can you help?',
      } as any)
    )

    const event = await buildNotificationEvent('inbox.messageReceived', { messageId: 'm1' })

    expect(event).toMatchObject({
      type: 'inbox.messageReceived',
      messageId: 'm1',
      squadId: 's1',
      agentId: 'a1',
    })
  })

  test('links saved Assistant updates to the conversation without exposing content or the sender', async () => {
    process.env.APP_URL = 'https://ficus.example/app'
    const conversationId = '507a9ac0-164e-4f49-9441-e57522bdc52b'
    track(
      spyOn(InboxMessage, 'find').mockResolvedValue({
        id: 'm-assistant',
        recipientType: 'voice_assistant',
        recipientId: `assistant:${conversationId}`,
        senderType: 'agent',
        senderId: 'a1',
        subject: 'Secret subject',
        content: 'The API key is sk-not-really; deployment finished.',
        metadata: { sender: { squadId: 's1' }, inReplyTo: 'r1', assistantTaskStatus: 'completed' },
      } as any)
    )

    const event = await buildNotificationEvent('inbox.messageReceived', { messageId: 'm-assistant' })

    expect(event).toEqual({
      type: 'inbox.messageReceived',
      messageId: 'm-assistant',
      title: 'Assistant update',
      body: 'A task has an update. Open Assistant to view it.',
      url: `https://ficus.example/app/?chat=open&assistantConversation=${conversationId}`,
      timestamp: expect.any(Date),
    })
    expect(JSON.stringify(event)).not.toContain('sk-not-really')
    expect(event?.agentId).toBeUndefined()
    expect(event?.squadId).toBeUndefined()
  })

  test('copies exact Action Center targets only from trusted system inbox metadata', async () => {
    track(
      spyOn(InboxMessage, 'find').mockImplementation(
        async (id: string) =>
          ({
            id,
            senderType: id === 'trusted' ? 'system' : 'user',
            senderId: id === 'trusted' ? null : 'user-1',
            metadata: {
              workStreamId: 'ws1',
              waitId: 'wait1',
              questionId: '00000000-0000-4000-8000-000000000001',
              actionId: 'workstream-blocked:ws1:wait1',
            },
            subject: 'Needs attention',
            content: 'Open the exact action.',
          }) as any
      )
    )

    expect(await buildNotificationEvent('inbox.messageReceived', { messageId: 'trusted' })).toMatchObject({
      workStreamId: 'ws1',
      waitId: 'wait1',
      questionId: '00000000-0000-4000-8000-000000000001',
      actionId: 'workstream-blocked:ws1:wait1',
    })
    const spoofed = await buildNotificationEvent('inbox.messageReceived', { messageId: 'spoofed' })
    expect(spoofed?.workStreamId).toBeUndefined()
    expect(spoofed?.waitId).toBeUndefined()
    expect(spoofed?.questionId).toBeUndefined()
    expect(spoofed?.actionId).toBeUndefined()
  })

  test('uses the stored push presentation for system inbox messages and ignores it from other senders', async () => {
    const push = {
      title: 'Completed: #197 · Validate deletion',
      body: 'Next steps: ship it',
      subtitle: 'Platform',
      collapseKey: 'ws:abc',
      threadKey: 'squad:def',
      interruptionLevel: 'passive',
    }
    track(
      spyOn(InboxMessage, 'find').mockImplementation(
        async (id: string) =>
          ({
            id,
            senderType: id === 'system' ? 'system' : 'agent',
            senderId: id === 'system' ? null : 'a1',
            metadata: { push, ...(id === 'system' ? {} : { sender: { squadId: 's1' } }) },
            subject: 'Work Stream done: #197 · Validate deletion',
            content: 'Work stream "#197 · Validate deletion" has been completed.',
          }) as any
      )
    )

    expect(await buildNotificationEvent('inbox.messageReceived', { messageId: 'system' })).toMatchObject({
      title: push.title,
      body: push.body,
      subtitle: 'Platform',
      collapseKey: 'ws:abc',
      threadKey: 'squad:def',
      interruptionLevel: 'passive',
    })
    const agent = await buildNotificationEvent('inbox.messageReceived', { messageId: 'agent' })
    expect(agent).toMatchObject({ title: 'Work Stream done: #197 · Validate deletion' })
    expect(agent?.body).toBe('Work stream "#197 · Validate deletion" has been completed.')
    expect(agent?.subtitle).toBeUndefined()
    expect(agent?.collapseKey).toBeUndefined()
  })

  test('adds fleet alert squad routing while provider-global alerts remain squadless', async () => {
    track(
      spyOn(InboxMessage, 'find').mockImplementation(async (id: string) => {
        if (id === 'fleet-squad') {
          return {
            id,
            senderType: 'system',
            senderId: null,
            metadata: {
              source: 'fleet-alert',
              squadId: '11111111-1111-4111-8111-111111111111',
              incidentKind: 'squad_dead_fleet',
              phase: 'alert',
            },
            subject: 'Execution fleet stalled',
            content: 'No execution starts while actionable work is waiting.',
          } as any
        }
        if (id === 'fleet-manager') {
          return {
            id,
            senderType: 'system',
            senderId: null,
            recipientType: 'agent',
            recipientId: 'manager-1',
            metadata: {
              source: 'fleet-incident-manager',
              audience: 'manager',
              squadId: '11111111-1111-4111-8111-111111111111',
            },
            subject: 'Manager fleet alert',
            content: 'Manager-only work injection.',
          } as any
        }
        if (id === 'fleet-invalid') {
          return {
            id,
            senderType: 'system',
            senderId: null,
            metadata: { source: 'fleet-alert', squadId: 'not-a-uuid' },
            subject: 'Malformed fleet alert',
            content: 'Malformed squad routing must be ignored.',
          } as any
        }
        if (id === 'fleet-spoof') {
          return {
            id,
            senderType: 'user',
            senderId: 'user-1',
            metadata: { source: 'fleet-alert', squadId: '11111111-1111-4111-8111-111111111111' },
            subject: 'Spoofed fleet alert',
            content: 'This must not receive fleet routing.',
          } as any
        }
        return {
          id,
          senderType: 'system',
          senderId: null,
          metadata: { source: 'fleet-alert', provider: 'openai-codex', phase: 'alert' },
          subject: 'Provider unhealthy',
          content: 'Authentication requires operator attention.',
        } as any
      })
    )
    const squadFindSpy = track(
      spyOn(Squad, 'find').mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', name: 'Ficus' } as any)
    )

    const squadAlert = await buildNotificationEvent('inbox.messageReceived', { messageId: 'fleet-squad' })
    const providerAlert = await buildNotificationEvent('inbox.messageReceived', { messageId: 'fleet-provider' })
    const invalidAlert = await buildNotificationEvent('inbox.messageReceived', { messageId: 'fleet-invalid' })
    const managerAlert = await buildNotificationEvent('inbox.messageReceived', { messageId: 'fleet-manager' })
    const spoofAlert = await buildNotificationEvent('inbox.messageReceived', { messageId: 'fleet-spoof' })

    expect(squadAlert).toMatchObject({
      type: 'inbox.messageReceived',
      messageId: 'fleet-squad',
      source: 'fleet-alert',
      squadId: '11111111-1111-4111-8111-111111111111',
      squadName: 'Ficus',
    })
    expect(providerAlert).toMatchObject({
      type: 'inbox.messageReceived',
      messageId: 'fleet-provider',
      source: 'fleet-alert',
    })
    expect(providerAlert?.squadId).toBeUndefined()
    expect(providerAlert?.squadName).toBeUndefined()
    expect(invalidAlert && 'source' in invalidAlert ? invalidAlert.source : undefined).toBeUndefined()
    expect(invalidAlert?.squadId).toBeUndefined()
    expect(invalidAlert?.squadName).toBeUndefined()
    expect(spoofAlert && 'source' in spoofAlert ? spoofAlert.source : undefined).toBeUndefined()
    expect(spoofAlert?.squadId).toBeUndefined()
    expect(spoofAlert?.squadName).toBeUndefined()
    expect(managerAlert && 'source' in managerAlert ? managerAlert.source : undefined).toBeUndefined()
    expect(managerAlert?.squadId).toBeUndefined()
    expect(managerAlert?.squadName).toBeUndefined()
    expect(squadFindSpy).toHaveBeenCalledTimes(1)
  })

  test('does not add agent chat routing fields to non-agent inbox notification events', async () => {
    track(
      spyOn(InboxMessage, 'find').mockResolvedValue({
        id: 'm2',
        senderType: 'system',
        senderId: null,
        metadata: {},
        subject: 'System message',
        content: 'FYI',
      } as any)
    )

    const event = await buildNotificationEvent('inbox.messageReceived', { messageId: 'm2' })

    expect(event).toMatchObject({
      type: 'inbox.messageReceived',
      messageId: 'm2',
    })
    expect(event?.squadId).toBeUndefined()
    expect(event?.agentId).toBeUndefined()
  })
})

describe('getAppOrigin', () => {
  test('normalizes APP_URL to lowercase origin without a trailing slash, keeping a base path', () => {
    expect(getAppOrigin('https://Ficus.Example.com/')).toBe('https://ficus.example.com')
    expect(getAppOrigin('https://ficus.example.com')).toBe('https://ficus.example.com')
    expect(getAppOrigin('http://localhost:3000/tau/')).toBe('http://localhost:3000/tau')
  })

  test('is undefined when APP_URL is unset or not a URL', () => {
    delete process.env.APP_URL
    expect(getAppOrigin()).toBeUndefined()
    expect(getAppOrigin('')).toBeUndefined()
    expect(getAppOrigin('not a url')).toBeUndefined()
  })
})

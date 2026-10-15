import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { EventMap } from '@ficus/shared'
import { eq, inArray } from 'drizzle-orm'
import { agentQuestions, agents, db, messages } from '../../db'
import { Agent } from '../../entities/Agent'
import { eventEmitter } from '../../lib/infra/event-emitter'
import type { LightCompletionRequest } from '../model-tiers/light-completion'
import { getSettingsStore } from '../settings'
import { registerReplySuggestions, replySuggestionRuntimeDeps } from './runtime'
import {
  REPLY_SUGGESTIONS_SETTING,
  ReplySuggestionLimiter,
  suggestRepliesAfterTurn,
  type ReplySuggestionDeps,
} from './service'

const QUESTION = 'Found it: the handler reads an empty list.\n\nWant me to open a work stream for this?'
const agentIds: string[] = []
const cleanups: Array<() => void | Promise<void>> = []

beforeAll(async () => {
  await getSettingsStore().initialize()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds.splice(0)))
})

/** An idle agent whose person asked something and whose latest reply asks back. */
async function chat(agentText = QUESTION) {
  const agent = await Agent.create({ agentTypeId: 'system-manager', context: {} })
  agentIds.push(agent.id)
  const start = Date.now() - 60_000
  const [human, reply] = await db
    .insert(messages)
    .values([
      {
        agentId: agent.id,
        role: 'human' as const,
        content: 'The export crashes on an empty list.',
        pending: false,
        metadata: { source: 'user_chat', sender: { userId: 'u1', name: 'Pat' } },
        createdAt: new Date(start),
      },
      {
        agentId: agent.id,
        role: 'assistant' as const,
        content: agentText,
        pending: false,
        metadata: { executionId: 'exec-1', streamGroupId: 'group-1' },
        createdAt: new Date(start + 5_000),
      },
    ])
    .returning()
  return { agentId: agent.id, human: human!, reply: reply! }
}

function withFakeModel(answer = '["Yes, start it", "Not now"]') {
  const requests: LightCompletionRequest[] = []
  const deps: ReplySuggestionDeps = {
    ...replySuggestionRuntimeDeps,
    complete: async (request) => {
      requests.push(request)
      return { text: answer, model: 'anthropic:claude-haiku-4-5:off' }
    },
  }
  return { deps, requests }
}

async function metadataOf(messageId: string) {
  const [row] = await db.select({ metadata: messages.metadata }).from(messages).where(eq(messages.id, messageId))
  return row?.metadata as Record<string, unknown> | null
}

function captureUpdates() {
  const updates: Array<EventMap['message.updated']> = []
  cleanups.push(eventEmitter.on('message.updated', (data) => updates.push(data)))
  return updates
}

describe('reply suggestions against the database', () => {
  test('saves the replies on the agent message, keeps its metadata, and notifies clients', async () => {
    const { agentId, reply } = await chat()
    const updates = captureUpdates()
    const { deps, requests } = withFakeModel()
    expect(await suggestRepliesAfterTurn(agentId, deps, new ReplySuggestionLimiter())).toBe('saved')
    expect(requests[0].prompt).toContain('The export crashes on an empty list.')
    expect(requests[0].prompt).toContain('Want me to open a work stream for this?')
    expect(await metadataOf(reply.id)).toEqual({
      executionId: 'exec-1',
      streamGroupId: 'group-1',
      replySuggestions: ['Yes, start it', 'Not now'],
    })
    expect(updates).toEqual([{ messageId: reply.id, agentId, executionId: 'exec-1', streamGroupId: 'group-1' }])
    // Already answered: a second completion asks nothing.
    expect(await suggestRepliesAfterTurn(agentId, deps, new ReplySuggestionLimiter())).toBe('no-target')
    expect(requests).toHaveLength(1)
  })

  test('a human message that arrives while the model answers makes the save a no-op', async () => {
    const { agentId, reply } = await chat()
    const updates = captureUpdates()
    await db.insert(messages).values({
      agentId,
      role: 'human',
      content: 'Never mind, I fixed it.',
      pending: false,
      metadata: { source: 'user_chat' },
      createdAt: new Date(),
    })
    expect(await replySuggestionRuntimeDeps.save(agentId, reply.id, ['Yes', 'No'])).toBe(false)
    expect((await metadataOf(reply.id))?.replySuggestions).toBeUndefined()
    expect(updates).toHaveLength(0)
  })

  test('an open ask_human question means no chips and no model call', async () => {
    const { agentId } = await chat()
    await db.insert(agentQuestions).values({
      agentId,
      questionData: { questions: [{ id: 'q', type: 'text', question: 'Which region?' }] },
    })
    const { deps, requests } = withFakeModel()
    expect(await suggestRepliesAfterTurn(agentId, deps, new ReplySuggestionLimiter())).toBe('agent-not-ready')
    expect(requests).toHaveLength(0)
  })

  test('a turn started by an inbox delivery gets none', async () => {
    const { agentId } = await chat()
    await db.insert(messages).values({
      agentId,
      role: 'human',
      content: 'Flow step: execute',
      pending: false,
      metadata: { source: 'inbox', inboxMessageIds: ['m1'] },
      createdAt: new Date(Date.now() - 30_000),
    })
    await db.insert(messages).values({
      agentId,
      role: 'assistant',
      content: 'Should I start the build?',
      pending: false,
      metadata: {},
      createdAt: new Date(Date.now() - 20_000),
    })
    const { deps, requests } = withFakeModel()
    expect(await suggestRepliesAfterTurn(agentId, deps, new ReplySuggestionLimiter())).toBe('no-target')
    expect(requests).toHaveLength(0)
  })

  test('the Settings switch stops everything', async () => {
    const { agentId, reply } = await chat()
    await getSettingsStore().set(REPLY_SUGGESTIONS_SETTING, 'false', 'test')
    cleanups.push(() => getSettingsStore().delete(REPLY_SUGGESTIONS_SETTING))
    const { deps, requests } = withFakeModel()
    expect(await suggestRepliesAfterTurn(agentId, deps, new ReplySuggestionLimiter())).toBe('disabled')
    expect(requests).toHaveLength(0)
    expect((await metadataOf(reply.id))?.replySuggestions).toBeUndefined()
  })

  test('runs after a completed execution event, and not after other outcomes', async () => {
    const { agentId, reply } = await chat()
    const { deps, requests } = withFakeModel()
    const saved = new Promise<string>((resolve) => {
      cleanups.push(eventEmitter.on('message.updated', ({ messageId }) => resolve(messageId)))
    })
    cleanups.push(registerReplySuggestions(deps))
    eventEmitter.emit('execution.completed', { executionId: 'exec-0', agentId, status: 'failed' })
    expect(requests).toHaveLength(0)
    eventEmitter.emit('execution.completed', { executionId: 'exec-1', agentId, status: 'completed' })
    expect(await saved).toBe(reply.id)
    expect(requests).toHaveLength(1)
  })
})

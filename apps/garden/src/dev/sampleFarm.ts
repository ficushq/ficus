import type { PendingAction, WorkStream } from '@ficus/shared'
import type { FarmInput } from '../farm/layout'
import { at, makeAgent, makeAgentError, makeSquad, makeStream, makeWait } from '../farm/testFixtures'

/**
 * Sample farm for `bun run dev:garden` with `?demo`, so the scene can be
 * worked on (and screenshotted) without a running Core. Dev builds only.
 */
export function sampleFarm(): FarmInput {
  const squads = [
    makeSquad({ id: 'sq-platform', name: 'Platform', managerAgentId: 'mgr-platform', createdAt: at(0) }),
    makeSquad({ id: 'sq-docs', name: 'Docs', managerAgentId: 'mgr-docs', createdAt: at(1) }),
    makeSquad({ id: 'sq-mobile', name: 'Mobile', managerAgentId: 'mgr-mobile', createdAt: at(2) }),
  ]
  let n = 0
  const stream = (squadId: string, title: string, o: Partial<WorkStream> = {}) => {
    n += 1
    return makeStream({ id: `ws-${n}`, squadId, title, createdAt: at(10 + n), ...o })
  }
  const review = (id: string) => ({
    derivedState: 'in_review' as const,
    openWaits: [makeWait('review', { id: `rv-${id}`, workStreamId: id })],
  })
  const question = (id: string) => ({
    derivedState: 'waiting_on_answer' as const,
    openWaits: [makeWait('question', { id: `q-${id}`, workStreamId: id })],
  })

  const streams = [
    stream('sq-platform', 'Cache squad slugs in the sidebar', { agentIds: ['w-ada'] }),
    stream('sq-platform', 'Retry flaky webhook deliveries', { agentIds: ['w-bo'] }),
    stream('sq-platform', 'Squad settings: show the model tier', { ...review('ws-3'), agentIds: ['w-cy'] }),
    stream('sq-platform', 'Upgrade the sandbox base image', { status: 'queued', derivedState: 'queued' }),
    stream('sq-platform', 'Audit log export', {
      derivedState: 'paused',
      pause: { id: 'p1', pausedAt: at(30).toISOString(), reason: null, parkAt: null, agentIds: [] },
    }),
    stream('sq-platform', 'Trim the worker boot time', { derivedState: 'idle' }),
    stream('sq-platform', 'Rate limit the public API', { agentIds: ['w-dee'] }),
    stream('sq-docs', 'Write the plugin authoring guide', { ...review('ws-8'), agentIds: ['w-eli'] }),
    stream('sq-docs', 'Refresh the quick start', { agentIds: ['w-fox'] }),
    stream('sq-mobile', 'Offline drafts for replies', { ...question('ws-10'), agentIds: ['w-gus'] }),
    stream('sq-mobile', 'Push notification grouping', { agentIds: ['w-hal'] }),
    stream('sq-mobile', 'Fix the share sheet crash', { agentIds: ['w-ivy'] }),
  ]

  const agent = (id: string, squadId: string, o: Parameters<typeof makeAgent>[0] = {}) =>
    makeAgent({ id, squadId, metadata: { name: id.replace(/^\w+-/, '').replace(/^\w/, (c) => c.toUpperCase()) }, ...o })
  const agents = [
    agent('mgr-platform', 'sq-platform', { agentTypeId: 'manager', status: 'idle' }),
    agent('mgr-docs', 'sq-docs', { agentTypeId: 'manager', status: 'active' }),
    agent('mgr-mobile', 'sq-mobile', { agentTypeId: 'manager', status: 'idle' }),
    agent('w-ada', 'sq-platform'),
    agent('w-bo', 'sq-platform'),
    agent('w-cy', 'sq-platform', { status: 'idle' }),
    agent('w-dee', 'sq-platform'),
    agent('sub-dee-1', 'sq-platform', { parentAgentId: 'w-dee' }),
    agent('sub-dee-2', 'sq-platform', { parentAgentId: 'w-dee' }),
    agent('w-jo', 'sq-platform', { status: 'idle' }),
    agent('w-kai', 'sq-platform', { status: 'idle' }),
    agent('w-eli', 'sq-docs', { status: 'idle' }),
    agent('w-fox', 'sq-docs'),
    agent('c-lee', 'sq-docs', { agentTypeId: 'consultant', status: 'idle', updatedAt: new Date() }),
    agent('w-gus', 'sq-mobile', { status: 'waiting-input' }),
    agent('w-hal', 'sq-mobile'),
    agent('w-ivy', 'sq-mobile'),
  ]
  const action = (id: string, type: PendingAction['type']): PendingAction => ({
    id,
    type,
    priority: 0,
    createdAt: at(60).toISOString(),
    canRespond: true,
    data: {} as PendingAction['data'],
  })
  return {
    squads,
    streams,
    doneCount: 23,
    canceledCount: 2,
    agents,
    assistants: [
      makeAgent({
        id: 'assistant-1',
        agentTypeId: 'assistant',
        squadId: null,
        status: 'idle',
        metadata: { name: 'Assistant' },
      }),
    ],
    pendingActions: [
      action('a1', 'workstream-review'),
      action('a2', 'workstream-review'),
      action('a3', 'agent-question'),
      makeAgentError('w-ivy', 'sq-mobile'),
    ],
  }
}

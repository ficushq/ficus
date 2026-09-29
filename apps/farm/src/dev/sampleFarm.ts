import type {
  AgentQuestion,
  AgentQuestionActionData,
  PendingAction,
  WorkStream,
  WorkStreamActionData,
} from '@ficus/shared'
import type { FarmInput } from '../farm/layout'
import { at, makeAgent, makeAgentError, makeSquad, makeStream, makeWait } from '../farm/testFixtures'

/**
 * Sample farm for `bun run dev:farm` with `?demo`, so the scene can be
 * worked on (and screenshotted) without a running Core. Dev builds only.
 */
export const SAMPLE_QUESTION: AgentQuestion = {
  id: 'q-ws-10',
  agentId: 'w-gus',
  squadId: 'sq-mobile',
  ownerUserId: null,
  questionData: {
    questions: [
      {
        id: 'storage',
        type: 'select',
        question: 'Where should offline drafts live?',
        context: 'Drafts are written while you have no signal. I can keep them on the phone or sync them.',
        options: [
          { label: 'On the device only', value: 'device' },
          { label: 'Synced to the server', value: 'server' },
        ],
      },
    ],
  },
  status: 'open',
  answer: null,
  answeredByUserId: null,
  createdAt: at(70).toISOString(),
  answeredAt: null,
}

/** A question the Docs farmer asked without stopping (ask_human): it keeps working, and wears a "?". */
export const SAMPLE_FARMER_QUESTION: AgentQuestion = {
  ...SAMPLE_QUESTION,
  id: 'q-mgr-docs',
  agentId: 'mgr-docs',
  squadId: 'sq-docs',
  questionData: {
    questions: [
      {
        id: 'tone',
        type: 'select',
        question: 'Should the new guides be casual or formal?',
        context: 'I am drafting three guides this week and want them to sound the same.',
        options: [
          { label: 'Casual', value: 'casual' },
          { label: 'Formal', value: 'formal' },
        ],
      },
    ],
  },
}

export function sampleFarm(): FarmInput {
  const squads = [
    makeSquad({ id: 'sq-platform', name: 'Platform', managerAgentId: 'mgr-platform', createdAt: at(0) }),
    makeSquad({ id: 'sq-docs', name: 'Docs', managerAgentId: 'mgr-docs', createdAt: at(1) }),
    makeSquad({ id: 'sq-mobile', name: 'Mobile', managerAgentId: 'mgr-mobile', createdAt: at(2) }),
  ]
  let n = 0
  const stream = (squadId: string, title: string, o: Partial<WorkStream> = {}) => {
    n += 1
    return makeStream({ id: `ws-${n}`, number: n, squadId, title, createdAt: at(10 + n), ...o })
  }
  const review = (id: string) => ({
    derivedState: 'in_review' as const,
    openWaits: [makeWait('review', { id: `rv-${id}`, workStreamId: id })],
  })
  const question = (id: string) => ({
    derivedState: 'waiting_on_answer' as const,
    openWaits: [
      makeWait('question', { id: `q-${id}`, workStreamId: id, referenceId: `q-${id}`, createdByAgentId: 'w-gus' }),
    ],
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
    agent('c-lee', 'sq-docs', {
      agentTypeId: 'consultant',
      status: 'idle',
      updatedAt: new Date(),
      context: { scope: { type: 'consultant', id: 'sq-docs' }, origin: 'user' },
    }),
    agent('c-max', 'sq-platform', {
      agentTypeId: 'consultant',
      status: 'waiting-input',
      context: { scope: { type: 'consultant', id: 'sq-platform' }, origin: 'user' },
      metadata: { name: 'Max', purpose: 'Onboarding checklist idea' },
    }),
    agent('c-slack', 'sq-platform', {
      agentTypeId: 'consultant',
      status: 'idle',
      context: { scope: { type: 'consultant' }, origin: 'channel' },
    }),
    agent('w-gus', 'sq-mobile', { status: 'waiting-input' }),
    agent('w-hal', 'sq-mobile'),
    agent('w-ivy', 'sq-mobile'),
  ]
  const reviewAction = (ws: WorkStream, squadName: string, assignee: string): PendingAction => {
    const wait = ws.openWaits![0]!
    const data: WorkStreamActionData = {
      workStreamId: ws.id,
      workStreamTitle: ws.title,
      squadId: ws.squadId,
      squadName,
      waitId: wait.id,
      wait: { ...wait, message: 'Finished and tested. Take a look before it ships?' },
      focus: { kind: 'workstream-wait', workStreamId: ws.id, waitId: wait.id },
      assigneeAgentId: assignee,
      assigneeName: assignee.replace(/^w-/, ''),
      completionMode: 'pr-merge',
      prompt: { type: 'text', message: 'Finished and tested. Take a look before it ships?' },
    }
    return {
      id: `workstream-review:${ws.id}:${wait.id}`,
      type: 'workstream-review',
      priority: 1,
      createdAt: at(60).toISOString(),
      canRespond: true,
      squadId: ws.squadId,
      squadName,
      data,
    }
  }
  const questionFor = streams.find((ws) => ws.id === 'ws-10')!
  const questionData: AgentQuestionActionData = {
    questionId: 'q-ws-10',
    agentId: 'w-gus',
    agentName: 'Gus',
    agentTypeId: 'coder',
    squadId: 'sq-mobile',
    squadName: 'Mobile',
    ownerUserId: null,
    questionData: SAMPLE_QUESTION.questionData,
  }
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
      reviewAction(streams[2]!, 'Platform', 'w-cy'),
      reviewAction(streams[7]!, 'Docs', 'w-eli'),
      {
        id: `agent-question:${questionData.questionId}`,
        type: 'agent-question',
        priority: 2,
        createdAt: at(70).toISOString(),
        canRespond: true,
        squadId: questionFor.squadId,
        squadName: 'Mobile',
        data: questionData,
      },
      {
        id: `agent-question:${SAMPLE_FARMER_QUESTION.id}`,
        type: 'agent-question',
        priority: 2,
        createdAt: at(72).toISOString(),
        canRespond: true,
        squadId: 'sq-docs',
        squadName: 'Docs',
        data: {
          ...questionData,
          questionId: SAMPLE_FARMER_QUESTION.id,
          agentId: 'mgr-docs',
          agentName: 'Docs farmer',
          agentTypeId: 'manager',
          squadId: 'sq-docs',
          squadName: 'Docs',
          questionData: SAMPLE_FARMER_QUESTION.questionData,
        },
      },
      makeAgentError('w-ivy', 'sq-mobile'),
    ],
  }
}

import type {
  AgentQuestionActionData,
  PendingAction,
  PendingActionType,
  WorkStreamActionData,
  WorkStreamWait,
} from '@ficus/shared'

/** Pending-action fixtures for the Needs-you notice tests. */

export function questionAction(
  id: string,
  overrides: Partial<PendingAction> = {},
  data: Partial<AgentQuestionActionData> = {}
): PendingAction {
  return {
    id: `agent-question:${id}`,
    type: 'agent-question',
    priority: 1,
    createdAt: '2026-11-26T12:00:00.000Z',
    canRespond: true,
    alerts: true,
    squadId: 'squad-1',
    squadName: 'Product Engineering',
    data: {
      questionId: id,
      agentId: 'agent-1',
      agentName: 'Payments Engineer',
      agentTypeId: 'engineer',
      squadId: 'squad-1',
      squadName: 'Product Engineering',
      ownerUserId: null,
      questionData: { questions: [{ id: 'q', type: 'text', question: 'Retry on 409 as well?' }] },
      workStream: { id: 'ws-uuid-8', number: 8, title: 'Make every payment retry safe' },
      ...data,
    } satisfies AgentQuestionActionData,
    ...overrides,
  }
}

export function waitAction(
  id: string,
  {
    type = 'workstream-review',
    wait = {},
    ...overrides
  }: Partial<Omit<PendingAction, 'type'>> & { type?: PendingActionType; wait?: Partial<WorkStreamWait> } = {},
  data: Partial<WorkStreamActionData> = {}
): PendingAction {
  return {
    id: `${type}:ws-uuid-8:${id}`,
    type,
    priority: 2,
    createdAt: '2026-11-26T12:00:00.000Z',
    canRespond: true,
    alerts: true,
    squadId: 'squad-1',
    squadName: 'Product Engineering',
    data: {
      workStreamId: 'ws-uuid-8',
      workStreamNumber: 8,
      workStreamTitle: 'Make every payment retry safe',
      squadId: 'squad-1',
      squadName: 'Product Engineering',
      waitId: id,
      wait: {
        id,
        workStreamId: 'ws-uuid-8',
        type: type === 'workstream-review' ? 'review' : 'manual',
        referenceId: null,
        message: null,
        createdBy: 'agent',
        createdByAgentId: 'agent-1',
        createdByUserId: null,
        completesOnApproval: true,
        openedAt: '2026-11-26T12:00:00.000Z',
        closedAt: null,
        resolution: null,
        resolutionNote: null,
        ...wait,
      } as WorkStreamWait,
      focus: { kind: 'workstream-wait', workStreamId: 'ws-uuid-8', waitId: id },
      assigneeAgentId: 'agent-1',
      assigneeName: 'Payments Engineer',
      completionMode: 'review-approval',
      prompt: { type: 'text', message: 'Review this' },
      ...data,
    } as WorkStreamActionData,
    ...overrides,
  }
}

export function otherAction(type: PendingActionType, id: string): PendingAction {
  return {
    id: `${type}:${id}`,
    type,
    priority: 0,
    createdAt: '2026-11-26T12:00:00.000Z',
    canRespond: true,
    alerts: true,
    data: {} as PendingAction['data'],
  }
}

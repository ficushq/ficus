import type {
  Agent,
  AgentErrorActionData,
  PendingAction,
  Squad,
  WorkStream,
  WorkStreamWait,
  WorkStreamWaitType,
} from '@ficus/shared'

const EPOCH = new Date('2026-09-01T00:00:00Z')

export function makeStream(overrides: Partial<WorkStream> = {}): WorkStream {
  return {
    id: 'ws-1',
    squadId: 'squad-1',
    title: 'A work stream',
    description: '',
    status: 'active',
    priority: 'normal',
    assigneeAgentId: null,
    ownerAgentId: null,
    creatorAgentId: null,
    requestingUserId: null,
    agentIds: null,
    dependsOn: [],
    dependedOnBy: [],
    derivedState: 'in_progress',
    openWaits: [],
    handoffMessage: null,
    files: [],
    metadata: {},
    createdAt: EPOCH,
    updatedAt: EPOCH,
    completionMode: 'pr-merge',
    ...overrides,
  }
}

export function makeWait(type: WorkStreamWaitType, overrides: Partial<WorkStreamWait> = {}): WorkStreamWait {
  return {
    id: `wait-${type}`,
    workStreamId: 'ws-1',
    type,
    referenceId: null,
    message: null,
    createdBy: 'agent',
    createdByAgentId: null,
    createdByUserId: null,
    completesOnApproval: true,
    openedAt: EPOCH.toISOString(),
    closedAt: null,
    resolution: null,
    resolutionNote: null,
    ...overrides,
  }
}

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    agentTypeId: 'coder',
    squadId: 'squad-1',
    parentAgentId: null,
    status: 'active',
    persist: true,
    modelOverride: null,
    metadata: null,
    context: {},
    questionData: null,
    sessionUsage: null,
    dormantAt: null,
    terminatedAt: null,
    lastMessageAt: null,
    lastHumanMessageAt: null,
    lastMessagePreview: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    amtpHandle: null,
    identityPublicKey: null,
    inboundOpen: false,
    ...overrides,
  }
}

export function makeSquad(overrides: Partial<Squad> = {}): Squad {
  return {
    id: 'squad-1',
    name: 'Squad',
    purpose: '',
    status: 'active',
    squadPresetId: null,
    defaultAgents: [],
    managerAgentId: null,
    context: null,
    typeContext: null,
    isAnonymous: false,
    globalCollaborationEnabled: false,
    order: 0,
    metadata: {},
    sandboxStatus: 'none',
    maxConcurrentWorkStreams: null,
    blockedGraceMinutes: null,
    hostWorkspacePath: null,
    avatarImageId: null,
    avatarUrl: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    archivedAt: null,
    ...overrides,
  }
}

/** A pending `agent-error` action: the agent is halted by a provider error. */
export function makeAgentError(agentId: string, squadId: string | null = 'squad-1'): PendingAction {
  const data: AgentErrorActionData = {
    agentId,
    agentName: null,
    agentTypeId: 'coder',
    squadId,
    squadName: null,
    ownerUserId: null,
    reason: 'rate limited',
  }
  return {
    id: `err-${agentId}`,
    type: 'agent-error',
    priority: 0,
    createdAt: EPOCH.toISOString(),
    canRespond: true,
    data,
  }
}

/** A Date `minutes` after the fixture epoch, for ordering tests. */
export function at(minutes: number): Date {
  return new Date(EPOCH.getTime() + minutes * 60_000)
}

/** Deterministic Fisher–Yates shuffle (for "input order doesn't matter" tests). */
export function shuffled<T>(list: readonly T[], seed = 1): T[] {
  const out = [...list]
  let s = seed >>> 0 || 1
  for (let index = out.length - 1; index > 0; index--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const other = s % (index + 1)
    ;[out[index], out[other]] = [out[other]!, out[index]!]
  }
  return out
}

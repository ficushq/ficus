import type { AgentStatus, AgentType } from '@ficus/shared'
import type { AgentSessionEvent, SessionStats } from '@earendil-works/pi-coding-agent'

import type { SessionUsage, MessageMetadata } from '@ficus/shared'
import { Execution } from '../../entities/Execution'
import { AgentRunner } from '../../entities/agent-runners/base'
import { AgentSession } from '../../entities/AgentSession'
import { Agent } from '../../entities/Agent'

// ---------------------------------------------------------------------------
// Mock AgentSession
// ---------------------------------------------------------------------------

type EventListener = (event: AgentSessionEvent) => void

export class MockPiAgentSession {
  private listeners: EventListener[] = []
  promptCalls: Array<{ text: string; options?: any }> = []
  steerCalls: string[] = []
  followUpCalls: string[] = []
  abortCalled = false
  abortBashCalled = false
  promptError: Error | null = null
  setModelCalls: any[] = []
  setThinkingLevelCalls: any[] = []
  private promptWaiters: Array<{ count: number; resolve: () => void }> = []
  /** Structural Pi agent surface: hook slots the runner wires stored-secret containment onto. */
  agent: {
    beforeToolCall?: (context: any, signal?: AbortSignal) => Promise<any>
    afterToolCall?: (context: any, signal?: AbortSignal) => Promise<any>
  } = {}

  subscribe(listener: EventListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  async prompt(text: string, options?: any): Promise<void> {
    this.promptCalls.push({ text, options })
    for (const waiter of this.promptWaiters) {
      if (this.promptCalls.length >= waiter.count) waiter.resolve()
    }
    this.promptWaiters = this.promptWaiters.filter((waiter) => this.promptCalls.length < waiter.count)
    if (this.promptError) throw this.promptError
  }

  async waitForPromptCalls(count: number): Promise<void> {
    if (this.promptCalls.length >= count) return
    await new Promise<void>((resolve) => this.promptWaiters.push({ count, resolve }))
  }

  async setModel(model: any): Promise<void> {
    this.setModelCalls.push(model)
  }

  setThinkingLevel(level: any): void {
    this.setThinkingLevelCalls.push(level)
  }

  async abort(): Promise<void> {
    this.abortCalled = true
  }

  async steer(text: string): Promise<void> {
    this.steerCalls.push(text)
  }

  async followUp(text: string): Promise<void> {
    this.followUpCalls.push(text)
  }

  get isBashRunning(): boolean {
    return false
  }

  abortBash(): void {
    this.abortBashCalled = true
  }

  async reload(): Promise<void> {}

  getSessionStats(): SessionStats {
    return {
      sessionFile: undefined,
      sessionId: 'test-session',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0.01,
    }
  }

  getContextUsage(): { tokens: number; contextWindow: number; percent: number } | undefined {
    return { tokens: 150, contextWindow: 200000, percent: 0.075 }
  }

  // --- Test helpers ---

  emit(event: AgentSessionEvent): void {
    for (const l of this.listeners) l(event)
  }

  /** Simulate a normal agent end with optional text */
  simulateNormalEnd(responseText = 'Test response'): void {
    // text_delta — uses `delta` field
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: responseText }],
      stopReason: 'end_turn',
    }
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: responseText },
      message,
    } as any)
    // message_end then session persistence confirmation
    this.emit({ type: 'message_end', message } as any)
    this.emit({ type: 'session_message_persisted', message, entryId: 'entry-1', sessionFile: 'test.jsonl' } as any)
    // turn_end
    this.emit({ type: 'turn_end', message, toolResults: [] } as any)
    // agent_end then AgentSession settled
    this.emit({ type: 'agent_end', messages: [message] } as any)
    this.emit({ type: 'agent_settled', outcome: 'complete', retried: false, compacted: false } as any)
  }

  /** Simulate agent_end with an error captured by auto_retry_end */
  simulateErrorEnd(errorMsg: string): void {
    // auto_retry_end with success=false sets collector.lastError
    this.emit({ type: 'auto_retry_end', success: false, finalError: errorMsg } as any)
    this.emit({ type: 'agent_end', messages: [] } as any)
    this.emit({
      type: 'agent_settled',
      outcome: 'error',
      retried: true,
      compacted: false,
      errorMessage: errorMsg,
    } as any)
  }

  /** Simulate just an agent_end (e.g. after abort) */
  simulateAbortEnd(): void {
    this.emit({ type: 'agent_end', messages: [] } as any)
    this.emit({ type: 'agent_settled', outcome: 'aborted', retried: false, compacted: false } as any)
  }

  /** Simulate compaction start followed by abort (user stop during compaction) */
  simulateCompactionStartThenAbort(): void {
    // The SDK emits agent_end first, then compaction_start
    this.emit({ type: 'agent_end', messages: [] } as any)
    this.emit({ type: 'compaction_start', reason: 'threshold' } as any)
    // Then the abort() call would trigger compaction_end with aborted=true
  }

  /** Simulate compaction end with aborted=true */
  simulateCompactionAborted(): void {
    this.emit({
      type: 'compaction_end',
      reason: 'threshold',
      willRetry: false,
      aborted: true,
      result: null,
    } as any)
  }

  /** Simulate successful compaction */
  simulateCompactionSuccess(willRetry = true): void {
    this.emit({
      type: 'compaction_end',
      reason: 'threshold',
      willRetry,
      aborted: false,
      result: 'compacted summary',
    } as any)
    if (!willRetry) {
      this.emit({ type: 'agent_settled', outcome: 'complete', retried: false, compacted: true } as any)
    }
  }

  async compact(_instructions?: string): Promise<void> {
    // Simulate successful compaction
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    return { steering: [], followUp: [] }
  }
}

export class MockAgentSession {
  public pi: MockPiAgentSession
  public switchedBack?: { from: string; to: string; reason: string }

  constructor() {
    this.pi = new MockPiAgentSession()
  }

  captureUsage(): SessionUsage {
    return {
      stats: {
        userMessages: 0,
        assistantMessages: 0,
        totalMessages: 0,
        tokens: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
        cost: 0,
      },
      context: null,
    }
  }
}

// ---------------------------------------------------------------------------
// Mock Runner
// ---------------------------------------------------------------------------

export class TestAgentRunner extends AgentRunner {
  mockSession: MockAgentSession
  private readonly errorHandled = Promise.withResolvers<void>()
  private failoverAttempts = 0
  private failoverWaiters: Array<{ count: number; resolve: () => void }> = []

  constructor(execution: Execution, agent: any, agentType: any, mockSession: MockAgentSession) {
    super(execution, agent, agentType)
    this.mockSession = mockSession
  }

  protected async createSession(): Promise<AgentSession> {
    return this.mockSession as any
  }

  /** Wait for session-file events already emitted by a test to finish persisting. */
  async waitForPersistence(): Promise<void> {
    await this.persistence.waitForAll()
  }

  /** Wait until the requested number of runtime failover attempts have fully completed. */
  async waitForFailoverAttempts(count: number): Promise<void> {
    if (this.failoverAttempts >= count) return
    await new Promise<void>((resolve) => this.failoverWaiters.push({ count, resolve }))
  }

  protected override async attemptFailover(errorMsg: string): Promise<boolean> {
    const result = await super.attemptFailover(errorMsg)
    this.failoverAttempts += 1
    for (const waiter of this.failoverWaiters) {
      if (this.failoverAttempts >= waiter.count) waiter.resolve()
    }
    this.failoverWaiters = this.failoverWaiters.filter((waiter) => this.failoverAttempts < waiter.count)
    return result
  }

  /** Wait until the runner has surfaced an error through its normal failure path. */
  async waitForError(): Promise<void> {
    await this.errorHandled.promise
  }

  protected override onError(error: string): void {
    super.onError(error)
    this.errorHandled.resolve()
  }

  protected async onComplete(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<void> {
    await this.completeNormally(response, metadata, sessionUsage)
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const id = crypto.randomUUID()
  return new Agent({
    id,
    agentTypeId: 'test-type',
    squadId: null,
    ownerUserId: null,
    parentAgentId: null,
    status: 'active' as AgentStatus,
    persist: false,
    modelOverride: null,
    selectedModel: null,
    metadata: null,
    context: {},
    questionData: null,
    sessionUsage: null,
    terminatedAt: null,
    pendingDormancyAt: null,
    lastMessageAt: null,
    lastHumanMessageAt: null,
    lastMessagePreview: null,
    amtpHandle: null,
    identityPublicKey: null,
    inboundOpen: false,
    cardJson: null,
    machineId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
    dormantAt: overrides.dormantAt ?? null,
  })
}

export function makeAgentType(overrides: Partial<AgentType> = {}): AgentType {
  return {
    id: 'test-type',
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Test Agent',
    description: null,
    systemPrompt: 'You are a test agent.',
    includes: [],
    skills: null,
    extensions: null,
    toolsAllow: null,
    toolsDeny: null,
    earlyMarginTokens: null,
    inFlightMarginTokens: null,
    yamlFieldOverrides: [],
    hasTemplate: false,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

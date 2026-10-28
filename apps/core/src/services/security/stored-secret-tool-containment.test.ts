import { randomUUID } from 'node:crypto'
import { describe, expect, mock, test } from 'bun:test'
import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import { ContentSafety } from './content-safety'
import type { StoredSecretToolAuditInput } from './stored-secret-tool-audit'
import { STORED_SECRET_TOOL_REFUSAL, StoredSecretToolContainment } from './stored-secret-tool-containment'

type AuditRow = StoredSecretToolAuditInput
type BeforeHook = (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>

function syntheticValue(): string {
  return `CANARY_SECRET_${randomUUID()}`
}

function contextWith(args: unknown, toolCallId = `call-${randomUUID()}`): BeforeToolCallContext {
  return {
    assistantMessage: { role: 'assistant' } as BeforeToolCallContext['assistantMessage'],
    toolCall: {
      type: 'toolCall',
      id: toolCallId,
      name: 'generated-tool',
      arguments: {},
    } as BeforeToolCallContext['toolCall'],
    args,
    context: {} as BeforeToolCallContext['context'],
  }
}

function fakeAgent(beforeToolCall?: BeforeHook) {
  return { beforeToolCall }
}

function containmentWithSink(sink: (input: StoredSecretToolAuditInput) => Promise<void>) {
  return new StoredSecretToolContainment({
    agentId: 'agent-id',
    executionId: 'execution-id',
    sink,
  })
}

describe('StoredSecretToolContainment pre-call denial', () => {
  test('denies a stored-value tool call before the previous hook runs and audits denied', async () => {
    const value = syntheticValue()
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const previousBefore = mock(async () => undefined)
    const agent = fakeAgent(previousBefore)
    const audits: AuditRow[] = []
    const containment = containmentWithSink(async (input) => {
      audits.push(input)
    })

    const detach = containment.attachBeforeToolCall(agent, safety)
    const decision = await agent.beforeToolCall!(contextWith({ command: value }))

    expect(decision).toEqual({ block: true, reason: STORED_SECRET_TOOL_REFUSAL })
    expect(previousBefore).not.toHaveBeenCalled()
    expect(audits).toEqual([
      { agentId: 'agent-id', executionId: 'execution-id', secretKey: 'SYNTHETIC_KEY', outcome: 'denied' },
    ])
    expect(JSON.stringify({ audits, decision })).not.toContain(value)
    expect('terminate' in (decision ?? {})).toBe(false)
    detach()
  })

  test('gives the agent an actionable stored-value refusal naming refusal and no retry', () => {
    expect(STORED_SECRET_TOOL_REFUSAL).not.toContain('Secret Store')
    expect(STORED_SECRET_TOOL_REFUSAL).toContain('refused')
    expect(STORED_SECRET_TOOL_REFUSAL).toContain('must not retry')
  })

  test('does not deny or audit safe or heuristic-only arguments', async () => {
    const credential = `ghp_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value: syntheticValue() }])
    const previousDecision: BeforeToolCallResult = { block: true, reason: 'extension policy' }
    const previousBefore = mock(async () => previousDecision)
    const agent = fakeAgent(previousBefore)
    const audits: AuditRow[] = []
    const containment = containmentWithSink(async (input) => {
      audits.push(input)
    })

    const detach = containment.attachBeforeToolCall(agent, safety)
    const decision = await agent.beforeToolCall!(contextWith({ token: credential }))

    expect(decision).toBe(previousDecision)
    expect(previousBefore).toHaveBeenCalledTimes(1)
    expect(audits).toEqual([])
    expect(JSON.stringify(decision)).not.toContain(credential)
    detach()
  })

  test('catches an extension mutating arguments into a stored value after the hook', async () => {
    const value = syntheticValue()
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const previousBefore = mock(async (context: BeforeToolCallContext) => {
      ;(context.args as { command?: string }).command = value
      return undefined
    })
    const agent = fakeAgent(previousBefore)
    const audits: AuditRow[] = []
    const containment = containmentWithSink(async (input) => {
      audits.push(input)
    })

    const detach = containment.attachBeforeToolCall(agent, safety)
    const decision = await agent.beforeToolCall!(contextWith({ command: 'safe' }))

    expect(decision).toEqual({ block: true, reason: STORED_SECRET_TOOL_REFUSAL })
    expect(audits).toEqual([
      { agentId: 'agent-id', executionId: 'execution-id', secretKey: 'SYNTHETIC_KEY', outcome: 'denied' },
    ])
    detach()
  })

  test('rethrows a non-secret hook failure unchanged', async () => {
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value: syntheticValue() }])
    const failure = new Error('extension failed, blocking execution')
    const previousBefore = mock(async () => {
      throw failure
    })
    const agent = fakeAgent(previousBefore)
    const audits: AuditRow[] = []
    const containment = containmentWithSink(async (input) => {
      audits.push(input)
    })

    const detach = containment.attachBeforeToolCall(agent, safety)
    await expect(agent.beforeToolCall!(contextWith({ command: 'safe' }))).rejects.toBe(failure)
    expect(audits).toEqual([])
    detach()
  })

  test('denies instead of propagating a hook failure that carries a stored value', async () => {
    const value = syntheticValue()
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const previousBefore = mock(async () => {
      throw new Error(`extension failed while handling ${value}`)
    })
    const agent = fakeAgent(previousBefore)
    const audits: AuditRow[] = []
    const containment = containmentWithSink(async (input) => {
      audits.push(input)
    })

    const detach = containment.attachBeforeToolCall(agent, safety)
    const decision = await agent.beforeToolCall!(contextWith({ command: 'safe' }))

    expect(decision).toEqual({ block: true, reason: STORED_SECRET_TOOL_REFUSAL })
    expect(audits).toEqual([
      { agentId: 'agent-id', executionId: 'execution-id', secretKey: 'SYNTHETIC_KEY', outcome: 'denied' },
    ])
    detach()
  })

  test('still denies when the audit sink rejects', async () => {
    const value = syntheticValue()
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const agent = fakeAgent(undefined)
    const containment = containmentWithSink(async () => {
      throw new Error('database unavailable')
    })

    const detach = containment.attachBeforeToolCall(agent, safety)
    const decision = await agent.beforeToolCall!(contextWith({ command: value }))

    expect(decision).toEqual({ block: true, reason: STORED_SECRET_TOOL_REFUSAL })
    await containment.waitForAuditWrites()
    detach()
  })

  test('detach restores the previous hook only while the wrapper still owns it', async () => {
    const safety = ContentSafety.fromSecretEntries([])
    const previousBefore = mock(async () => undefined)
    const agent = fakeAgent(previousBefore)
    const containment = containmentWithSink(async () => {})

    const detach = containment.attachBeforeToolCall(agent, safety)
    expect(agent.beforeToolCall).not.toBe(previousBefore)
    detach()
    expect(agent.beforeToolCall).toBe(previousBefore)

    const later = mock(async () => undefined)
    const detachSecond = containment.attachBeforeToolCall(agent, safety)
    const replaced = mock(async () => undefined)
    agent.beforeToolCall = replaced
    detachSecond()
    expect(agent.beforeToolCall).toBe(replaced)
    expect(later).not.toHaveBeenCalled()
  })
})

describe('StoredSecretToolContainment deduplication', () => {
  test('writes one row per key even when a key repeats in one call', async () => {
    const first = syntheticValue()
    const second = syntheticValue()
    const safety = ContentSafety.fromSecretEntries([
      { key: 'SYNTHETIC_A', value: first },
      { key: 'SYNTHETIC_B', value: second },
    ])
    const agent = fakeAgent(undefined)
    const audits: AuditRow[] = []
    const containment = containmentWithSink(async (input) => {
      audits.push(input)
    })

    const detach = containment.attachBeforeToolCall(agent, safety)
    await agent.beforeToolCall!(contextWith({ command: `${first}:${second}:${first}` }))

    expect(audits).toEqual([
      { agentId: 'agent-id', executionId: 'execution-id', secretKey: 'SYNTHETIC_A', outcome: 'denied' },
      { agentId: 'agent-id', executionId: 'execution-id', secretKey: 'SYNTHETIC_B', outcome: 'denied' },
    ])
    detach()
  })

  test('writes a second row when the same key appears in a different tool call', async () => {
    const value = syntheticValue()
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const agent = fakeAgent(undefined)
    const audits: AuditRow[] = []
    const containment = containmentWithSink(async (input) => {
      audits.push(input)
    })

    const detach = containment.attachBeforeToolCall(agent, safety)
    await agent.beforeToolCall!(contextWith({ command: value }, 'call-one'))
    await agent.beforeToolCall!(contextWith({ command: value }, 'call-two'))

    expect(audits).toHaveLength(2)
    expect(new Set(audits.map((row) => row.outcome))).toEqual(new Set(['denied']))
    detach()
  })

  test('recordAlreadyExecuted audits already_executed and dedups per call and key', async () => {
    const audits: AuditRow[] = []
    const containment = containmentWithSink(async (input) => {
      audits.push(input)
    })

    await containment.recordAlreadyExecuted('call-1', ['SYNTHETIC_KEY'])
    await containment.recordAlreadyExecuted('call-1', ['SYNTHETIC_KEY'])
    await containment.recordAlreadyExecuted('call-2', ['SYNTHETIC_KEY'])

    expect(audits).toEqual([
      { agentId: 'agent-id', executionId: 'execution-id', secretKey: 'SYNTHETIC_KEY', outcome: 'already_executed' },
      { agentId: 'agent-id', executionId: 'execution-id', secretKey: 'SYNTHETIC_KEY', outcome: 'already_executed' },
    ])
  })

  test('a denied pre-call and a post-execution report for the same call share one row', async () => {
    const audits: AuditRow[] = []
    const containment = containmentWithSink(async (input) => {
      audits.push(input)
    })

    await containment.recordAlreadyExecuted('call-1', ['SYNTHETIC_KEY'])

    const value = syntheticValue()
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const agent = fakeAgent(undefined)
    const detach = containment.attachBeforeToolCall(agent, safety)
    await agent.beforeToolCall!(contextWith({ command: value }, 'call-1'))
    detach()

    // Dedup is per (tool call, key): one row per key and call. A denied call
    // never executes, so the two outcomes cannot legitimately co-occur — the
    // first recorded outcome wins and no duplicate row is appended.
    expect(audits).toEqual([
      {
        agentId: 'agent-id',
        executionId: 'execution-id',
        secretKey: 'SYNTHETIC_KEY',
        outcome: 'already_executed',
      },
    ])
  })

  test('waitForAuditWrites resolves once every queued sink call settles', async () => {
    const releases: Array<() => void> = []
    const containment = new StoredSecretToolContainment({
      agentId: 'agent-id',
      executionId: 'execution-id',
      sink: () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        }),
    })

    const pending = containment.recordAlreadyExecuted('call-1', ['SYNTHETIC_KEY'])
    let settled = false
    void containment.waitForAuditWrites().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    for (const release of releases.splice(0)) release()
    await pending
    await containment.waitForAuditWrites()
    expect(settled).toBe(true)
  })
})

test('allows normal app env file writes with squad env values but refuses integration leaves', async () => {
  const env = syntheticValue()
  const token = syntheticValue()
  const safety = ContentSafety.fromSecretEntries([
    { key: 'ENV', value: env, outputOnly: true },
    { key: 'INTEGRATION', value: token },
  ])
  const audits: AuditRow[] = []
  const agent = fakeAgent()
  const containment = containmentWithSink(async (row) => {
    audits.push(row)
  })
  const detach = containment.attachBeforeToolCall(agent, safety)
  expect(
    await agent.beforeToolCall!(contextWith({ path: 'app/.env.local', content: `APP_KEY=${env}` }))
  ).toBeUndefined()
  expect(audits).toEqual([])
  expect(await agent.beforeToolCall!(contextWith({ command: `echo ${token}` }))).toEqual({
    block: true,
    reason: STORED_SECRET_TOOL_REFUSAL,
  })
  expect(audits.map((row) => row.secretKey)).toEqual(['INTEGRATION'])
  detach()
})

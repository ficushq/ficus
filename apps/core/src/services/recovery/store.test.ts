import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db, agents, agentTypes, agentExtraScopes, squads, workStreams, workStreamWaits, inbox } from '../../db'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { createTestAdmin, cleanupTestRbac } from '../../test-utils'
import type { WorkStream } from '../../entities/WorkStream'
import type { Execution } from '../../entities/Execution'

// Supply the SDK shell environment context; these fixtures do not use extension UI/session mutation APIs.
function executeTool(
  tool: Pick<ToolDefinition, 'execute'>,
  id: string,
  params: Parameters<ToolDefinition['execute']>[1]
) {
  return tool.execute(id, params, undefined, undefined, {
    sessionManager: { getSessionId: () => 'recovery-fixture', getSessionFile: () => undefined },
    model: undefined,
  } as ExtensionToolContext)
}

const prefix = `recovery-${crypto.randomUUID()}`
let squad: Squad
let worker: Agent
let execution: Execution
let stream: WorkStream
let ownerId: string
let ownerToken: string
beforeEach(async () => {
  const owner = await createTestAdmin({ prefix })
  ownerId = owner.id
  ownerToken = owner.token
  await AgentType.upsert({ id: prefix, name: 'Recovery fixture', model: 'test:model', systemPrompt: 'test' })
  squad = await Squad.create({ name: `${prefix}-${crypto.randomUUID()}`, purpose: 'test' })
  await db
    .insert(agentExtraScopes)
    .values(['workstreams:respond', 'agents:run'].map((permission) => ({ agentId: squad.managerAgentId!, permission })))
  worker = await Agent.create({ agentTypeId: prefix, squadId: squad.id })
  stream = await storedLegacyWorkStream({
    squadId: squad.id,
    title: 'Recovery fixture',
    assigneeAgentId: worker.id,
    agentIds: [worker.id],
    requestingUserId: ownerId,
  })
  execution = await worker.queueExecution({ message: 'test' })
})
afterEach(async () => {
  if (squad) {
    if (stream) await db.delete(inbox).where(sql`${inbox.metadata}->>'workStreamId' = ${stream.id}`)
    await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    await db.delete(agents).where(eq(agents.squadId, squad.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
  }
  await db.delete(agentTypes).where(eq(agentTypes.id, prefix))
  await cleanupTestRbac(prefix)
})
async function store() {
  const module = await import('./store')
  expect(typeof module.recordRecoveryFailure).toBe('function')
  return module
}

test('durably counts real failures once, opens manager wait on third and automatically escalates after its one extra cycle', async () => {
  const api = await store()
  // The recovery manager is not the work-stream owner.
  await db
    .update(workStreams)
    .set({ ownerAgentId: worker.id, description: 'PRIVATE_DESCRIPTION_NOT_FOR_RECOVERY_CARD' })
    .where(eq(workStreams.id, stream.id))
  const origin = { agentId: worker.id, executionId: execution.id }
  const input = (id: string) => ({
    operationKey: 'operation-fixture',
    attempted: 'Run project tests',
    invocationId: id,
    error: new Error('test process failed'),
  })
  let record = await api.recordRecoveryFailure(origin, input('one'))
  expect(record.state.failures).toBe(1)
  expect((await api.recordRecoveryFailure(origin, input('one'))).state.failures).toBe(1)
  expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))).toHaveLength(0)
  record = await api.recordRecoveryFailure(origin, input('two'))
  record = await api.recordRecoveryFailure(origin, input('three'))
  expect(record.state.state).toBe('waiting-manager')
  let [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, record.waitId!))
  expect(wait.actor).toBe('manager')
  await expect(
    stream.setWaitActor(wait.id, { actor: 'human', changedByAgentId: squad.managerAgentId })
  ).rejects.toThrow()
  const { listPendingActions } = await import('../agents/actions')
  expect((await listPendingActions()).some((action) => action.id.includes(stream.id))).toBe(false)
  const notices = await db
    .select()
    .from(inbox)
    .where(sql`${inbox.metadata}->>'workStreamId' = ${stream.id}`)
  expect(notices.map((notice) => notice.recipientId)).toEqual([squad.managerAgentId!])
  expect(wait.structured?.summary).toMatchObject({ attemptCount: 3, lastError: 'test process failed' })
  await expect(
    api.decideRecovery(record.id, { action: 'continue', expectedVersion: record.version }, { agentId: worker.id })
  ).rejects.toThrow('authorized')
  record = await api.decideRecovery(
    record.id,
    { action: 'continue', expectedVersion: record.version },
    { agentId: squad.managerAgentId! }
  )
  expect(record.state.managerCycles).toBe(1)
  for (const id of ['four', 'five', 'six']) record = await api.recordRecoveryFailure(origin, input(id))
  expect(record.state).toMatchObject({ state: 'waiting-owner', failures: 6, managerCycles: 1 })
  ;[wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, record.waitId!))
  expect(wait.actor).toBe('human')
  const action = (await listPendingActions()).find((action) => action.id.includes(stream.id))!
  expect(action).toBeDefined()
  expect((action.data as import('@ficus/shared').WorkStreamActionData).prompt).toEqual({
    type: 'select',
    message: wait.structured!.summary.text,
    options: ['Continue', 'Stop'],
  })
  const { evaluatePendingAction } = await import('../agents/pending-action-policy')
  const { EMPTY_USER_ATTENTION } = await import('../attention/resolver')
  expect(
    (await evaluatePendingAction({ type: 'user', userId: ownerId }, action, { attention: EMPTY_USER_ATTENTION }))
      .canRespond
  ).toBe(true)
  const other = await createTestAdmin({ prefix })
  expect(
    (await evaluatePendingAction({ type: 'user', userId: other.id }, action, { attention: EMPTY_USER_ATTENTION }))
      .visible
  ).toBe(false)
  const [ownerNotice] = await db.select().from(inbox).where(eq(inbox.recipientId, ownerId))
  expect(ownerNotice?.content).toBe(wait.structured!.summary.text)
  expect(ownerNotice?.content).not.toContain('PRIVATE_DESCRIPTION_NOT_FOR_RECOVERY_CARD')
  expect(wait.structured?.summary.text).toBe(
    'I tried to run project tests 6 times. The last error was: test process failed'
  )
  await expect(
    api.decideRecovery(
      record.id,
      { action: 'continue', expectedVersion: record.version },
      { agentId: squad.managerAgentId! }
    )
  ).rejects.toThrow('owner')
  record = await api.decideRecovery(
    record.id,
    { action: 'continue', expectedVersion: record.version },
    { userId: ownerId }
  )
  expect(record.state).toMatchObject({ state: 'recovering', managerCycles: 1, cycleFailures: 0 })
})

test('unknown or foreign recovery references cannot open an early wait and Stop retains the scoped hold', async () => {
  const api = await store()
  const origin = { agentId: worker.id, executionId: execution.id }
  const input = {
    operationKey: 'other-operation',
    attempted: 'Read project files',
    invocationId: 'one',
    error: new Error('read failed'),
  }
  let record = await api.recordRecoveryFailure(origin, input)
  await expect(api.openRecoveryWait(record.id, record.version, worker.id, stream.id)).rejects.toThrow('exhausted')
  await expect(api.recordRecoveryFailure({ ...origin, agentId: squad.managerAgentId! }, input)).rejects.toThrow(
    'execution'
  )
  record = await api.recordRecoveryFailure(origin, { ...input, invocationId: 'two' })
  record = await api.recordRecoveryFailure(origin, { ...input, invocationId: 'three' })
  record = await api.decideRecovery(
    record.id,
    { action: 'stop', expectedVersion: record.version },
    { agentId: squad.managerAgentId! }
  )
  const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, record.waitId!))
  expect(record.state.state).toBe('stopped')
  expect(wait.closedAt).toBeNull()
  expect(wait.structured?.stopped).toBe(true)
  const { listPendingActions } = await import('../agents/actions')
  expect((await listPendingActions()).some((action) => action.id.includes(stream.id))).toBe(false)
  await expect(stream.unblock()).rejects.toThrow('typed')
})

test('common wait and question writers reject free forensic asks, while typed task inputs and legacy resolution remain usable', async () => {
  await expect(
    stream.block({ message: 'Send host logs', createdBy: 'agent', createdByAgentId: worker.id })
  ).rejects.toThrow('typed')
  const { createAgentQuestion } = await import('../agents/questions')
  await expect(
    createAgentQuestion(
      { agentId: worker.id, executionId: execution.id },
      { questions: [{ id: 'logs', type: 'text', question: 'Please send journal output' }] },
      { blocking: true }
    )
  ).rejects.toThrow('not valid')
  const { requestStructuredInput, resolveStructuredInput } = await import('./structured-input')
  const wait = await requestStructuredInput(
    stream.id,
    {
      schemaVersion: 1,
      kind: 'decide',
      purpose: 'task-decision',
      subject: 'Choose a layout',
      options: [
        { id: 'compact', label: 'Compact' },
        { id: 'wide', label: 'Wide' },
      ],
    },
    { createdBy: 'agent', createdByAgentId: worker.id }
  )
  expect(wait.structured?.summary).toEqual({
    attempted: 'Choose a layout',
    attemptCount: 0,
    lastError: null,
    text: 'Choose an option for: Choose a layout.',
  })
  await expect(stream.resolveWait(wait.id, { resolution: 'cleared' })).rejects.toThrow('typed')
  await stream.setWaitActor(wait.id, { actor: 'owner', changedByAgentId: squad.managerAgentId })
  await stream.setWaitActor(wait.id, { actor: 'human', changedByAgentId: squad.managerAgentId })
  await expect(
    resolveStructuredInput(
      stream.id,
      wait.id,
      { action: 'choose', optionId: 'compact', expectedVersion: 0 },
      { userId: ownerId }
    )
  ).rejects.toThrow('version')
  await expect(
    resolveStructuredInput(
      stream.id,
      wait.id,
      { action: 'choose', optionId: 'invented', expectedVersion: 2 },
      { userId: ownerId }
    )
  ).rejects.toThrow('option')
  const closed = await resolveStructuredInput(
    stream.id,
    wait.id,
    { action: 'choose', optionId: 'compact', expectedVersion: 2 },
    { userId: ownerId }
  )
  expect(closed.closedAt).not.toBeNull()
  expect(closed.resolutionNote).toBe('Selected: Compact')
  const legacy = await stream.block({ message: 'Historical system hold', createdBy: 'system' })
  await stream.resolveWait(legacy.id, { resolution: 'cleared' })
})

test('HTTP rejects malformed structured input and requires matching versioned decisions', async () => {
  const { Hono } = await import('hono')
  const { identityMiddleware } = await import('../../middleware/identity')
  const { workStreamsRouter } = await import('../../routes/work-streams')
  const { authHeaders } = await import('../../test-utils')
  const app = new Hono().use('*', identityMiddleware).route('/api/workstreams', workStreamsRouter)
  const post = (path: string, body: unknown) =>
    app.fetch(
      new Request(`http://test/api/workstreams/${stream.id}${path}`, {
        method: 'POST',
        headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  expect((await post('/request-input', { kind: 'provide', message: 'Send host logs' })).status).toBe(400)
  const response = await post('/request-input', {
    schemaVersion: 1,
    kind: 'provide',
    purpose: 'task-input',
    input: { type: 'file', path: 'release channel' },
    use: 'Choose the target',
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    wait: { id: string; structured: { version: number; request: { kind: string } } }
  }
  expect(body.wait.structured?.request.kind).toBe('provide')
  expect((await post(`/waits/${body.wait.id}/resolve`, { resolution: 'cleared' })).status).toBe(400)
  expect(
    (await post(`/waits/${body.wait.id}/input`, { action: 'provide', expectedVersion: 0, value: 'beta' })).status
  ).toBe(200)
  expect(
    (await post(`/waits/${body.wait.id}/input`, { action: 'provide', expectedVersion: 0, value: 'production' })).status
  ).not.toBe(200)
})

test('verified restart outcomes are free and forged restart claims are ordinary failures', async () => {
  const api = await store()
  const { commandCanceledForRestartError, createRestartContext } = await import('../sandbox/command-drain')
  const origin = { agentId: worker.id, executionId: execution.id }
  const input = { operationKey: 'restart-test', attempted: 'Read project files' }
  const forged = Object.assign(new Error('Connection closed'), {
    reason: 'core_restart',
    restart: { restartId: 'fabricated', restartAt: new Date().toISOString() },
  })
  let record = await api.recordRecoveryFailure(origin, { ...input, invocationId: 'unknown', error: forged })
  expect(record.state.failures).toBe(1)
  const restart = createRestartContext()
  record = await api.recordRecoveryFailure(origin, {
    ...input,
    invocationId: 'restart',
    error: commandCanceledForRestartError(restart),
  })
  expect(record.state.failures).toBe(1)
  expect(record.waitId).toBeNull()
  const duplicateRestart = await api.recordRecoveryFailure(origin, {
    ...input,
    invocationId: 'restart-redelivered',
    error: new Error('wrapped', { cause: commandCanceledForRestartError(restart) }),
  })
  expect(duplicateRestart.version).toBe(record.version)
  const { recoveryAttempts } = await import('../../db')
  const attempts = await db.select().from(recoveryAttempts).where(eq(recoveryAttempts.recoveryId, record.id))
  expect(attempts.find((attempt) => attempt.outcome === 'restart')?.restartId).toBe(restart.restartId)
  await execution.stop()
  const nextExecution = await worker.queueExecution({ message: 'Resume safely' })
  record = await api.recordRecoveryFailure(
    { ...origin, executionId: nextExecution.id },
    { ...input, invocationId: 'again', error: new Error('Connection closed') }
  )
  expect(record.state.failures).toBe(2)
})

test('concurrent delivery and decisions cannot double count, reset the manager limit, or bypass a pending recovery with a question', async () => {
  const api = await store()
  const origin = { agentId: worker.id, executionId: execution.id }
  const input = { operationKey: 'race', attempted: 'Read project files', error: new Error('Connection closed') }
  const deliveries = await Promise.all(
    [1, 2].map(() => api.recordRecoveryFailure(origin, { ...input, invocationId: 'same' }))
  )
  expect(deliveries[0]!.id).toBe(deliveries[1]!.id)
  expect(deliveries[1]!.state.failures).toBe(1)
  await api.recordRecoveryFailure(origin, { ...input, invocationId: 'two' })
  const record = await api.recordRecoveryFailure(origin, { ...input, invocationId: 'three' })
  const { createAgentQuestion } = await import('../agents/questions')
  await expect(
    createAgentQuestion(
      origin,
      {
        questions: [
          {
            id: 'continue',
            type: 'select',
            question: 'Continue?',
            options: [
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ],
          },
        ],
      },
      { blocking: true }
    )
  ).rejects.toThrow('existing typed recovery')
  const attempts = await Promise.allSettled(
    [1, 2].map(() =>
      api.decideRecovery(
        record.id,
        { action: 'continue', expectedVersion: record.version },
        { agentId: squad.managerAgentId! }
      )
    )
  )
  expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
  expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
})

test('runtime tools enforce persistent backoff, stop the fourth unexplained attempt, and never replay a command automatically', async () => {
  const { Type } = await import('@sinclair/typebox')
  const { wrapToolWithRecovery } = await import('./runtime')
  let calls = 0
  const tool = wrapToolWithRecovery(
    {
      name: 'bash',
      label: 'Bash',
      description: 'fixture',
      parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
      execute: async () => {
        calls++
        throw new Error('Connection closed before a confirmed result')
      },
    },
    () => ({ agentId: worker.id, executionId: execution.id })
  )
  const started = Date.now()
  for (const [index, id] of ['one', 'two', 'three'].entries())
    await expect(executeTool(tool, id!, { command: 'external-side-effect', timeout: index + 1 })).rejects.toThrow(
      'Connection closed'
    )
  expect(Date.now() - started).toBeGreaterThanOrEqual(2900)
  expect(calls).toBe(3)
  await expect(executeTool(tool, 'four', { command: 'external-side-effect', timeout: 999 })).rejects.toThrow(
    'authorized decision'
  )
  expect(calls).toBe(3)
  const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))
  expect(wait.structured?.summary.attemptCount).toBe(3)
}, 10000) // Includes the required real 1s/2s backoff and fixture DB writes.

test('runtime restart is free, inspection remains possible, and a safe explicit retry resolves the record without a wait', async () => {
  const { Type } = await import('@sinclair/typebox')
  const { wrapToolWithRecovery } = await import('./runtime')
  const { createRestartContext, commandCanceledForRestartError } = await import('../sandbox/command-drain')
  let calls = 0
  let inspected = false
  const tool = wrapToolWithRecovery(
    {
      name: 'bash',
      label: 'Bash',
      description: 'fixture',
      parameters: Type.Object({ command: Type.String() }),
      execute: async () => {
        if (++calls === 1) throw commandCanceledForRestartError(createRestartContext())
        expect(inspected).toBe(true)
        return { content: [{ type: 'text' as const, text: 'Confirmed completion' }], details: {} }
      },
    },
    () => ({ agentId: worker.id, executionId: execution.id })
  )
  await expect(executeTool(tool, 'interrupted', { command: 'safe task' })).rejects.toThrow(
    'cancelled by a Ficus restart'
  )
  expect(calls).toBe(1)
  inspected = true
  await executeTool(tool, 'retry', { command: 'safe task' })
  expect(calls).toBe(2)
  expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))).toHaveLength(0)
  const { recoveryEpisodes } = await import('../../db')
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record.state).toMatchObject({ state: 'resolved', failures: 0 })
})

test('unexplained execution failures share a durable three-attempt budget across replacement executions', async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await execution.fail('Unexpected setup result', undefined, {
      failureClass: 'execution_failure',
      failureReason: 'setup_unclassified',
    })
    const waits = await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))
    expect(waits).toHaveLength(attempt === 3 ? 1 : 0)
    if (attempt < 3) execution = await worker.queueExecution({ message: 'Retry setup safely' })
  }
  const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))
  expect(wait.actor).toBe('manager')
  expect(wait.structured?.summary.attemptCount).toBe(3)
})

test('inner idempotent transport retries spend the same tool budget instead of multiplying it', async () => {
  const { Type } = await import('@sinclair/typebox')
  const { wrapToolWithRecovery } = await import('./runtime')
  const { runIdempotentSandboxOperation } = await import('../sandbox/vm/retry')
  const { SandboxTransportError } = await import('../sandbox/client/http-client')
  let calls = 0
  const tool = wrapToolWithRecovery(
    {
      name: 'read',
      label: 'Read',
      description: 'fixture',
      parameters: Type.Object({}),
      execute: async () =>
        runIdempotentSandboxOperation({
          sandboxId: 'fixture',
          operationClass: 'read',
          getClient: () => ({}),
          recoverClient: async (client) => client,
          operation: async () => {
            calls++
            throw new SandboxTransportError('connection_reset', 'response', new Error('fixture'))
          },
        }),
    },
    () => ({ agentId: worker.id, executionId: execution.id })
  )
  await expect(executeTool(tool, 'read-tool', {})).rejects.toThrow('Sandbox transport')
  expect(calls).toBe(3)
  const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))
  expect(wait.structured?.summary.attemptCount).toBe(3)
  await expect(executeTool(tool, 'read-again', {})).rejects.toThrow('authorized decision')
  expect(calls).toBe(3)
}, 10000) // Three real read attempts plus the mandatory 1s/2s backoff.

test('parallel duplicate operations cannot overrun a recovery budget or duplicate an unknown side effect', async () => {
  const { Type } = await import('@sinclair/typebox')
  const { wrapToolWithRecovery } = await import('./runtime')
  let calls = 0
  const tool = wrapToolWithRecovery(
    {
      name: 'bash',
      label: 'Bash',
      description: 'fixture',
      parameters: Type.Object({ command: Type.String() }),
      execute: async () => {
        calls++
        throw new Error('Connection closed')
      },
    },
    () => ({ agentId: worker.id, executionId: execution.id })
  )
  const outcomes = await Promise.allSettled(
    ['one', 'two', 'three', 'four'].map((id) => executeTool(tool, id, { command: 'external operation' }))
  )
  expect(calls).toBe(1)
  expect(
    outcomes.filter((outcome) => outcome.status === 'rejected' && String(outcome.reason).includes('already running'))
  ).toHaveLength(3)
  expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))).toHaveLength(0)
})

test('a recovery without a work stream still routes manager-first and exposes only the generated owner decision after the extra cycle', async () => {
  await db.delete(workStreams).where(eq(workStreams.id, stream.id))
  await db.update(agents).set({ ownerUserId: ownerId }).where(eq(agents.id, worker.id))
  const api = await store()
  const origin = { agentId: worker.id, executionId: execution.id }
  const input = { operationKey: 'standalone', attempted: 'Read project files', error: new Error('Connection closed') }
  let record = await api.recordRecoveryFailure(origin, { ...input, invocationId: 'one' })
  for (const invocationId of ['two', 'three'])
    record = await api.recordRecoveryFailure(origin, { ...input, invocationId })
  expect(record.workStreamId).toBeNull()
  expect(record.state.state).toBe('waiting-manager')
  const notices = await db.select().from(inbox).where(eq(inbox.recipientId, squad.managerAgentId!))
  expect(notices.some((notice) => notice.content.includes(record.id))).toBe(true)
  const { listPendingActions } = await import('../agents/actions')
  expect((await listPendingActions()).some((action) => action.id === `agent-recovery:${record.id}`)).toBe(false)
  record = await api.decideRecovery(
    record.id,
    { action: 'continue', expectedVersion: record.version },
    { agentId: squad.managerAgentId! }
  )
  for (const invocationId of ['four', 'five', 'six'])
    record = await api.recordRecoveryFailure(origin, { ...input, invocationId })
  const action = (await listPendingActions()).find((action) => action.id === `agent-recovery:${record.id}`)!
  expect(action).toBeDefined()
  expect((action.data as import('@ficus/shared').AgentErrorActionData).recovery?.structured.summary).toMatchObject({
    attemptCount: 6,
    lastError: 'Connection closed',
  })
  record = await api.decideRecovery(record.id, { action: 'stop', expectedVersion: record.version }, { userId: ownerId })
  expect((await listPendingActions()).some((action) => action.id === `agent-recovery:${record.id}`)).toBe(false)
})

test('Continue preserves provider and other manual gates while recording a scoped continuation', async () => {
  const api = await store()
  const origin = { agentId: worker.id, executionId: execution.id }
  let record
  for (const invocationId of ['one', 'two', 'three'])
    record = await api.recordRecoveryFailure(origin, {
      operationKey: 'other-gates',
      attempted: 'Read project files',
      invocationId,
      error: new Error('Connection closed'),
    })
  const other = await stream.block({ message: 'Independent system input', createdBy: 'system' })
  const questionData = {
    questions: [
      {
        id: 'rate_limit',
        type: 'select' as const,
        question: 'Provider unavailable',
        options: [{ value: 'Continue', label: 'Continue' }],
      },
    ],
  }
  await db.update(agents).set({ status: 'waiting-input', questionData }).where(eq(agents.id, worker.id))
  await api.decideRecovery(
    record!.id,
    { action: 'continue', expectedVersion: record!.version },
    { agentId: squad.managerAgentId! }
  )
  const [held] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, other.id))
  expect(held.closedAt).toBeNull()
  const [agent] = await db.select().from(agents).where(eq(agents.id, worker.id))
  expect(agent.status).toBe('waiting-input')
  expect(agent.questionData).toEqual(questionData)
})

test('standalone HTTP decisions enforce owner, scope, kind and version instead of generic Continue', async () => {
  const api = await store()
  await db.update(agents).set({ ownerUserId: ownerId }).where(eq(agents.id, worker.id))
  await db.update(workStreams).set({ assigneeAgentId: null }).where(eq(workStreams.id, stream.id))
  let record
  for (const invocationId of ['one', 'two', 'three'])
    record = await api.recordRecoveryFailure(
      { agentId: worker.id, executionId: execution.id },
      {
        operationKey: 'standalone-http',
        attempted: 'Read project files',
        invocationId,
        error: new Error('Connection closed'),
      }
    )
  const { Hono } = await import('hono')
  const { identityMiddleware } = await import('../../middleware/identity')
  const { agentsRouter } = await import('../../routes/agents')
  const { authHeaders } = await import('../../test-utils')
  const app = new Hono().use('*', identityMiddleware).route('/api/agents', agentsRouter)
  const post = (body: unknown) =>
    app.fetch(
      new Request(`http://test/api/agents/${worker.id}/recoveries/${record!.id}/input`, {
        method: 'POST',
        headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  expect((await post({ action: 'continue', expectedVersion: record!.version })).status).toBe(400)
  record = await api.decideRecovery(
    record!.id,
    { action: 'forward', expectedVersion: record!.version },
    { agentId: squad.managerAgentId! }
  )
  expect((await post({ action: 'choose', expectedVersion: record.version, optionId: 'anything' })).status).toBe(400)
  expect((await post({ action: 'stop', expectedVersion: record.version })).status).toBe(200)
  expect((await post({ action: 'continue', expectedVersion: record.version })).status).toBe(400)
})

test('unexplained pre-model startup failures automatically retry twice with persistent backoff and then hold', async () => {
  const runners = await import('../../entities/agent-runners')
  const { spyOn } = await import('bun:test')
  const runner = spyOn(runners, 'createRunner').mockRejectedValue(new Error('Unexplained launch failure'))
  const { Execution } = await import('../../entities/Execution')
  const { recoveryEpisodes } = await import('../../db')
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const active = await worker.getActiveExecution()
      expect(active).not.toBeNull()
      const current = await Execution.mustFind(active!.id)
      expect(await current.start()).toBe(true)
      await current.run()
      const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
      expect(record!.state.failures).toBe(attempt + 1)
      if (attempt < 2) {
        expect(record!.state.nextRetryAt).toBeGreaterThan(Date.now() - 500)
        expect((await worker.getActiveExecution())?.id).not.toBe(current.id)
      } else {
        expect(record!.state.state).toBe('waiting-manager')
        expect(await worker.getActiveExecution()).toBeNull()
      }
    }
    expect(runner).toHaveBeenCalledTimes(3)
  } finally {
    runner.mockRestore()
  }
}, 15000)

test('a replacement process clock cannot skip the persisted database backoff', async () => {
  const api = await store()
  const origin = { agentId: worker.id, executionId: execution.id }
  await api.recordRecoveryFailure(origin, {
    operationKey: 'clock',
    invocationId: 'first',
    attempted: 'read files',
    error: new Error('Connection closed'),
  })
  const { spyOn } = await import('bun:test')
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
  try {
    expect(await api.recoveryRetryDelay(origin, 'clock')).toBeGreaterThan(0)
  } finally {
    clock.mockRestore()
  }
})

test('real bash nonzero exits, confirmed timeouts and file validation never consume unknown-outcome budget', async () => {
  const { EventEmitter } = await import('node:events')
  const { createK8sSandboxedBashTool, createK8sSandboxedReadTool } = await import('../../tools/sandbox-tools')
  const { createVerifiedEditTool } = await import('../../tools/verified-edit')
  const { SandboxClient } = await import('../sandbox/client/http-client')
  const { wrapToolWithRecovery } = await import('./runtime')
  const { recoveryEpisodes } = await import('../../db')
  const origin = () => ({ agentId: worker.id, executionId: execution.id })
  const client = new SandboxClient('feedback-fixture')
  let timeout = false
  client.bash = () => {
    const emitter = new EventEmitter()
    queueMicrotask(() => {
      emitter.emit('data', timeout ? { error: 'Deadline reached', exitCode: 124 } : { exitCode: 1 })
      emitter.emit('end')
    })
    return Object.assign(emitter, {
      invocationId: 'feedback',
      cancel: () => {},
      cancelAndWait: async () => {},
    }) as ReturnType<typeof client.bash>
  }
  const manager = {
    getClientForSandbox: () => client,
    getSandboxStatus: async () => ({ status: 'running' }),
    resolveToolApiUrl: () => 'http://fixture',
  }
  const bash = wrapToolWithRecovery(createK8sSandboxedBashTool('/workspace', 'fixture', manager), origin)
  for (let index = 0; index < 3; index++) {
    const result = await executeTool(bash, `poll-${index}`, { command: 'test -f pending' })
    expect(result).toMatchObject({ isError: true, structuredContent: { exit_code: 1 } })
  }
  timeout = true
  for (let index = 0; index < 3; index++)
    await expect(executeTool(bash, `timeout-${index}`, { command: 'wait' })).rejects.toThrow('Deadline reached')
  const edit = wrapToolWithRecovery(
    createVerifiedEditTool('/workspace', {
      readFile: async () => Buffer.from('original'),
      access: async () => {},
      commitFile: async () => {
        throw new Error('must not write')
      },
    }),
    origin
  )
  for (let index = 0; index < 3; index++)
    await expect(
      executeTool(edit, `edit-${index}`, { path: '/workspace/file', oldText: 'absent', newText: 'replacement' })
    ).rejects.toThrow('match was not found')
  client.stat = async () => ({ exists: true, isReadable: true, isWritable: true, isDirectory: false, size: 3 })
  client.read = async () => ({ content: Buffer.from('one').toString('base64'), totalSize: 3, isBinary: false })
  const read = wrapToolWithRecovery(createK8sSandboxedReadTool('/workspace', 'fixture', manager), origin)
  for (let index = 0; index < 3; index++)
    await expect(executeTool(read, `read-${index}`, { path: '/workspace/file', offset: 100 })).rejects.toThrow(
      'beyond end of file'
    )
  expect(await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))).toHaveLength(0)
  expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))).toHaveLength(0)
})

test.each(['no-manager', 'self-manager', 'no-squad'] as const)(
  'recovery routes %s directly to an eligible owner',
  async (mode) => {
    const api = await store()
    if (mode === 'no-squad') {
      await db.update(agents).set({ squadId: null, ownerUserId: ownerId }).where(eq(agents.id, worker.id))
      await db.update(workStreams).set({ assigneeAgentId: null, agentIds: [] }).where(eq(workStreams.id, stream.id))
    } else
      await db
        .update(squads)
        .set({ managerAgentId: mode === 'self-manager' ? worker.id : null })
        .where(eq(squads.id, squad.id))
    try {
      let record
      for (let n = 0; n < 3; n++)
        record = await api.recordRecoveryFailure(
          { agentId: worker.id, executionId: execution.id },
          {
            operationKey: 'fallback',
            invocationId: `fallback-${n}`,
            attempted: 'start the task',
            error: new Error('Connection closed'),
          }
        )
      expect(record!.state).toMatchObject({ state: 'waiting-owner', ownerEscalated: true, managerCycles: 0 })
      const { listPendingActions } = await import('../agents/actions')
      const { evaluatePendingAction } = await import('../agents/pending-action-policy')
      const { EMPTY_USER_ATTENTION } = await import('../attention/resolver')
      const action = (await listPendingActions()).find((a) =>
        a.id.includes(mode === 'no-squad' ? record!.id : stream.id)
      )!
      expect(action).toBeDefined()
      expect(
        (await evaluatePendingAction({ type: 'user', userId: ownerId }, action, { attention: EMPTY_USER_ATTENTION }))
          .canRespond
      ).toBe(true)
      expect(
        (
          await api.decideRecovery(
            record!.id,
            { action: 'continue', expectedVersion: record!.version },
            { userId: ownerId }
          )
        ).state.state
      ).toBe('recovering')
    } finally {
      await db.update(agents).set({ squadId: squad.id }).where(eq(agents.id, worker.id))
    }
  }
)

test('an agent-created stream uses the same eligible admin fallback for notice, visibility and decision', async () => {
  await db.update(workStreams).set({ requestingUserId: null }).where(eq(workStreams.id, stream.id))
  const api = await store()
  let record
  for (let n = 0; n < 3; n++)
    record = await api.recordRecoveryFailure(
      { agentId: worker.id, executionId: execution.id },
      {
        operationKey: 'owner-fallback',
        invocationId: `owner-fallback-${n}`,
        attempted: 'start the task',
        error: new Error('Connection closed'),
      }
    )
  record = await api.decideRecovery(
    record!.id,
    { action: 'forward', expectedVersion: record!.version },
    { agentId: squad.managerAgentId }
  )
  const { listPendingActions } = await import('../agents/actions')
  const { evaluatePendingAction } = await import('../agents/pending-action-policy')
  const { EMPTY_USER_ATTENTION } = await import('../attention/resolver')
  const action = (await listPendingActions()).find((a) => a.id.includes(stream.id))!
  expect(
    (await evaluatePendingAction({ type: 'user', userId: ownerId }, action, { attention: EMPTY_USER_ATTENTION }))
      .canRespond
  ).toBe(true)
  expect(
    (await db.select().from(inbox).where(eq(inbox.recipientId, ownerId))).some(
      (row) => row.content === record.state.attempted || row.content === api.recoveryWaitSnapshot(record).summary.text
    )
  ).toBe(true)
  expect(
    (await api.decideRecovery(record.id, { action: 'stop', expectedVersion: record.version }, { userId: ownerId }))
      .state.state
  ).toBe('stopped')
})

test('unroutable recovery emits one durable diagnostic without granting another identity authority', async () => {
  await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, squad.id))
  const permissions = await import('../rbac/permissions')
  const { spyOn } = await import('bun:test')
  const permission = spyOn(permissions, 'hasUserPermissionWithExecutor').mockResolvedValue(false)
  try {
    const api = await store()
    let record
    const input = (id: string) => ({
      operationKey: 'unroutable',
      invocationId: id,
      attempted: 'start the task',
      error: new Error('Connection closed'),
    })
    for (let n = 0; n < 3; n++)
      record = await api.recordRecoveryFailure(
        { agentId: worker.id, executionId: execution.id },
        input(`unroutable-${n}`)
      )
    expect(record!.state.state).toBe('waiting-owner')
    await api.publishRecoveryDecision(record!.id)
    await expect(
      api.decideRecovery(record!.id, { action: 'continue', expectedVersion: record!.version }, { userId: ownerId })
    ).rejects.toThrow('authorized owner')
    expect(
      await db
        .select()
        .from(inbox)
        .where(eq(inbox.idempotencyKey, `recovery-unroutable:${record!.id}`))
    ).toHaveLength(1)
  } finally {
    permission.mockRestore()
  }
})

test('argument variations share one normalized tool budget and cannot buy extra manager cycles', async () => {
  const { Type } = await import('@sinclair/typebox')
  const { wrapToolWithRecovery } = await import('./runtime')
  const { recoveryEpisodes } = await import('../../db')
  const api = await store()
  const tool = wrapToolWithRecovery(
    {
      name: 'bash',
      label: 'Bash',
      description: 'fixture',
      parameters: Type.Object({ command: Type.String() }),
      execute: async () => {
        throw new Error('Lost outcome')
      },
    },
    () => ({ agentId: worker.id, executionId: execution.id })
  )
  for (const [n, command] of ['npm test', ' npm test ', 'npm  test'].entries())
    await expect(executeTool(tool, `variant-${n}`, { command })).rejects.toThrow('Lost outcome')
  let [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record!.state.state).toBe('waiting-manager')
  await api.decideRecovery(
    record!.id,
    { action: 'continue', expectedVersion: record!.version },
    { agentId: squad.managerAgentId }
  )
  for (const [n, command] of ['npm\ttest', ' npm  test', 'npm test  '].entries())
    await expect(executeTool(tool, `more-variant-${n}`, { command })).rejects.toThrow('Lost outcome')
  ;[record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record!.state).toMatchObject({ state: 'waiting-owner', managerCycles: 1, failures: 6 })
}, 15000)

test('confirmed successor episodes inherit the manager allowance and owner escalation', async () => {
  const api = await store()
  const origin = { agentId: worker.id, executionId: execution.id }
  const input = (id: string) => ({
    operationKey: 'successor',
    invocationId: id,
    attempted: 'read project files',
    error: new Error('Lost outcome'),
  })
  let record
  for (let n = 0; n < 3; n++) record = await api.recordRecoveryFailure(origin, input(`first-${n}`))
  record = await api.decideRecovery(
    record!.id,
    { action: 'continue', expectedVersion: record!.version },
    { agentId: squad.managerAgentId }
  )
  await api.settleRecoveryOperation(origin, 'successor', 'confirmed')
  for (let n = 0; n < 3; n++) record = await api.recordRecoveryFailure(origin, input(`next-${n}`))
  expect(record!.state).toMatchObject({ state: 'waiting-owner', managerCycles: 1 })
})

test.each([1, 2, 3])('a %i-failure unresolved episode gates task inputs only in its own stream', async (count) => {
  const api = await store()
  const { requestStructuredInput } = await import('./structured-input')
  let record
  for (let n = 0; n < count; n++)
    record = await api.recordRecoveryFailure(
      { agentId: worker.id, executionId: execution.id },
      {
        operationKey: 'scoped-question',
        invocationId: `scope-${n}`,
        attempted: 'read files',
        error: new Error('Lost outcome'),
      }
    )
  const input = {
    schemaVersion: 1,
    kind: 'decide',
    purpose: 'task-decision',
    subject: 'Choose a layout',
    options: [
      { id: 'a', label: 'Compact' },
      { id: 'b', label: 'Spacious' },
    ],
  } as const
  const attribution = { createdBy: 'agent' as const, createdByAgentId: worker.id }
  await expect(
    requestStructuredInput(stream.id, { ...input, options: [...input.options] }, attribution)
  ).rejects.toThrow('existing typed recovery')
  if (count === 3)
    await api.decideRecovery(
      record!.id,
      { action: 'stop', expectedVersion: record!.version },
      { agentId: squad.managerAgentId }
    )
  const other = await storedLegacyWorkStream({
    squadId: squad.id,
    title: 'Unrelated scope',
    assigneeAgentId: worker.id,
    agentIds: [worker.id],
  })
  const wait = await requestStructuredInput(other.id, { ...input, options: [...input.options] }, attribution)
  expect(wait.workStreamId).toBe(other.id)
})

test('healthy parallel tools never need a recovery transaction and survive an accounting read outage', async () => {
  const { spyOn } = await import('bun:test')
  const { Type } = await import('@sinclair/typebox')
  const { wrapToolWithRecovery } = await import('./runtime')
  let calls = 0
  const tool = wrapToolWithRecovery(
    {
      name: 'read',
      label: 'Read',
      description: 'fixture',
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => {
        calls++
        await Bun.sleep(1)
        return { content: [{ type: 'text' as const, text: 'confirmed' }], details: {} }
      },
    },
    () => ({ agentId: worker.id, executionId: execution.id })
  )
  const transactions = spyOn(db, 'transaction').mockImplementation(() => {
    throw new Error('Accounting unavailable')
  })
  try {
    expect(
      await Promise.all([
        executeTool(tool, 'parallel-a', { path: 'a' }),
        executeTool(tool, 'parallel-b', { path: 'b' }),
      ])
    ).toHaveLength(2)
    expect(transactions).not.toHaveBeenCalled()
  } finally {
    transactions.mockRestore()
  }
  const reads = spyOn(db, 'select').mockImplementation(() => {
    throw new Error('Accounting unavailable')
  })
  try {
    expect((await executeTool(tool, 'outage', { path: 'c' })).content).toEqual([{ type: 'text', text: 'confirmed' }])
  } finally {
    reads.mockRestore()
  }
  expect(calls).toBe(3)
})

test('an accounting outage cannot bypass an already observed recovery hold', async () => {
  const { spyOn } = await import('bun:test')
  const { Type } = await import('@sinclair/typebox')
  const { wrapToolWithRecovery } = await import('./runtime')
  let calls = 0
  const tool = wrapToolWithRecovery(
    {
      name: 'read',
      label: 'Read',
      description: 'fixture',
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => {
        calls++
        throw new Error('Lost outcome')
      },
    },
    () => ({ agentId: worker.id, executionId: execution.id })
  )
  for (let n = 0; n < 3; n++)
    await expect(executeTool(tool, `held-${n}`, { path: 'a' })).rejects.toThrow('Lost outcome')
  const transactions = spyOn(db, 'transaction').mockImplementation(() => {
    throw new Error('Accounting unavailable')
  })
  try {
    await expect(executeTool(tool, 'must-not-run', { path: 'b' })).rejects.toThrow('Recovery is held')
  } finally {
    transactions.mockRestore()
  }
  expect(calls).toBe(3)
}, 10000)

test('a verified restart alone does not suppress a legitimate task decision', async () => {
  const api = await store()
  const { commandCanceledForRestartError } = await import('../sandbox/command-drain')
  await api.recordRecoveryFailure(
    { agentId: worker.id, executionId: execution.id },
    {
      operationKey: 'restart-only',
      invocationId: 'interrupted',
      attempted: 'Read files',
      error: commandCanceledForRestartError({ restartId: crypto.randomUUID(), restartedAt: new Date().toISOString() }),
    }
  )
  expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))).toHaveLength(0)
  const { requestStructuredInput } = await import('./structured-input')
  const wait = await requestStructuredInput(
    stream.id,
    {
      schemaVersion: 1,
      kind: 'decide',
      purpose: 'task-decision',
      subject: 'Choose the layout',
      options: [
        { id: 'compact', label: 'Compact' },
        { id: 'wide', label: 'Wide' },
      ],
    },
    { createdBy: 'agent', createdByAgentId: worker.id }
  )
  expect(wait.structured?.request.kind).toBe('decide')
})

test('the first model tool settles replay-safe startup recovery before a legitimate task question', async () => {
  const api = await store()
  const origin = { agentId: worker.id, executionId: execution.id }
  const record = await api.recordRecoveryFailure(origin, {
    operationKey: 'execution:run',
    invocationId: 'startup',
    attempted: 'start the task',
    error: new Error('Startup lost'),
    retryStartupMessage: 'Retained task',
  })
  await execution.start()
  const { Type } = await import('@sinclair/typebox')
  const { wrapToolWithRecovery } = await import('./runtime')
  const { requestStructuredInput } = await import('./structured-input')
  const tool = wrapToolWithRecovery(
    {
      name: 'ask_human',
      label: 'Ask',
      description: 'fixture',
      parameters: Type.Object({}),
      execute: async () => {
        await requestStructuredInput(
          stream.id,
          {
            schemaVersion: 1,
            kind: 'decide',
            purpose: 'task-decision',
            subject: 'Choose the layout',
            options: [
              { id: 'a', label: 'Compact' },
              { id: 'b', label: 'Wide' },
            ],
          },
          { createdBy: 'agent', createdByAgentId: worker.id }
        )
        return { content: [{ type: 'text' as const, text: 'Question created' }], details: {} }
      },
    },
    () => origin
  )
  expect((await executeTool(tool, 'question', {})).content).toEqual([{ type: 'text', text: 'Question created' }])
  const { recoveryEpisodes } = await import('../../db')
  expect((await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, record.id)))[0]!.state.state).toBe(
    'resolved'
  )
})

test('model-tool progress cannot settle an unexplained post-startup execution failure', async () => {
  const api = await store()
  const origin = { agentId: worker.id, executionId: execution.id }
  const record = await api.recordRecoveryFailure(origin, {
    operationKey: 'execution:run',
    invocationId: 'post-startup',
    attempted: 'complete the task',
    error: new Error('Settlement lost'),
  })
  await execution.start()
  await api.settleRecoveryOnModelTool(origin)
  const { recoveryEpisodes } = await import('../../db')
  expect((await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, record.id)))[0]!.state.state).toBe(
    'recovering'
  )
  await expect(api.assertNoPendingRecovery(db, worker.id, stream.id)).rejects.toThrow('unresolved recovery')
})

test('work-stream detail projects the same current owner fallback as the decision surface', async () => {
  const { recordRecoveryFailure } = await store()
  const { computeDerivedStates } = await import('../work-streams/derived-state')
  for (const invocationId of ['projection-1', 'projection-2', 'projection-3'])
    await recordRecoveryFailure(
      { agentId: worker.id, executionId: execution.id },
      { operationKey: 'projection', attempted: 'Run the task', invocationId, error: new Error('task failed') }
    )
  expect((await computeDerivedStates([stream])).get(stream.id)?.openWaits[0]?.actor).toBe('manager')
  expect((await computeDerivedStates([stream])).get(stream.id)?.derivedState).toBe('blocked')
  await db.update(agents).set({ status: 'waiting-input' }).where(eq(agents.id, squad.managerAgentId!))
  const projection = (await computeDerivedStates([stream])).get(stream.id)!
  expect(projection.openWaits[0]?.actor).toBe('human')
  expect(projection.derivedState).toBe('blocked')
  // Presentation changes do not rewrite the historical wait/audit or grant a cycle.
  expect((await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id)))[0]?.actor).toBe(
    'manager'
  )
})

test('manager prose compatibility does not bypass its own unresolved same-scope recovery', async () => {
  await db.update(squads).set({ managerAgentId: worker.id }).where(eq(squads.id, squad.id))
  await (
    await store()
  ).recordRecoveryFailure(
    { agentId: worker.id, executionId: execution.id },
    {
      operationKey: 'manager-task',
      attempted: 'Run the task',
      invocationId: 'manager-first',
      error: new Error('unknown outcome'),
    }
  )
  await expect(
    stream.block({ createdBy: 'manager', createdByAgentId: worker.id, message: 'Choose a release target' })
  ).rejects.toThrow('unresolved recovery')
  const other = await storedLegacyWorkStream({
    squadId: squad.id,
    title: 'Independent manager task',
    assigneeAgentId: worker.id,
  })
  expect(
    (await other.block({ createdBy: 'manager', createdByAgentId: worker.id, message: 'Choose a release target' })).type
  ).toBe('manual')
})

test.each(['bash', 'edit'])(
  '%s unrelated success does not reset the failing target budget',
  async (name) => {
    const { Type } = await import('@sinclair/typebox')
    const { wrapToolWithRecovery } = await import('./runtime')
    const { recoveryEpisodes } = await import('../../db')
    const target = name === 'bash' ? { command: 'npm test' } : { path: 'src/task.ts' }
    const inspection = name === 'bash' ? { command: 'git status' } : { path: 'notes.md' }
    const tool = wrapToolWithRecovery(
      {
        name,
        label: name,
        description: 'fixture',
        parameters: Type.Any(),
        execute: async (_id, params) => {
          if (JSON.stringify(params) === JSON.stringify(inspection))
            return { content: [{ type: 'text' as const, text: 'Inspected' }], details: {} }
          throw new Error('Lost outcome')
        },
      },
      () => ({ agentId: worker.id, executionId: execution.id })
    )
    await expect(executeTool(tool, 'failed-one', target)).rejects.toThrow('Lost outcome')
    await executeTool(tool, 'inspection', inspection)
    await expect(executeTool(tool, 'failed-two', target)).rejects.toThrow('Lost outcome')
    await expect(executeTool(tool, 'failed-three', target)).rejects.toThrow('Lost outcome')
    const records = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
    expect(records).toHaveLength(1)
    expect(records[0]!.state).toMatchObject({ failures: 3, state: 'waiting-manager' })
  },
  10000
)

test('explained feedback is not confirmation that a previously failing operation succeeded', async () => {
  const { Type } = await import('@sinclair/typebox')
  const { wrapToolWithRecovery } = await import('./runtime')
  const { ToolFeedbackError } = await import('../../tools/tool-feedback')
  const { recoveryEpisodes } = await import('../../db')
  let mode = 'unknown'
  const tool = wrapToolWithRecovery(
    {
      name: 'bash',
      label: 'Bash',
      description: 'fixture',
      parameters: Type.Any(),
      execute: async () => {
        if (mode === 'unknown') throw new Error('Lost outcome')
        if (mode === 'input') throw new ToolFeedbackError('input', 'Correct the input')
        return {
          content: [{ type: 'text' as const, text: '' }],
          details: {},
          isError: mode !== 'success',
          structuredContent: { exit_code: mode === 'success' ? 0 : 1 },
        }
      },
    },
    () => ({ agentId: worker.id, executionId: execution.id })
  )
  await expect(executeTool(tool, 'unknown', { command: 'npm test' })).rejects.toThrow('Lost outcome')
  mode = 'input'
  await expect(executeTool(tool, 'input', { command: 'npm test' })).rejects.toThrow('Correct the input')
  mode = 'exit'
  await executeTool(tool, 'exit', { command: 'npm test' })
  let [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record!.state).toMatchObject({ state: 'recovering', failures: 1 })
  mode = 'success'
  await executeTool(tool, 'success', { command: 'npm test' })
  ;[record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record!.state.state).toBe('resolved')
}, 10000)

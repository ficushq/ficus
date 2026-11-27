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
  await api.recordRecoveryFailure(origin, input('two'))
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
  expect(notices[0]!.content).toContain('one extra cycle per normalized recovery scope')
  expect(notices[0]!.content).toContain('Inspect only authorized environments')
  expect(notices[0]!.content).toContain('Stop retains the hold')
  expect(notices[0]!.content).toContain('expectedVersion')
  expect(notices[0]!.content).toContain('never bypasses')
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
  await expect(api.openRecoveryWait(record.id, record.version, worker.id, stream.id)).rejects.toThrow(
    'not awaiting a decision'
  )
  await expect(api.recordRecoveryFailure({ ...origin, agentId: squad.managerAgentId! }, input)).rejects.toThrow(
    'execution'
  )
  await api.recordRecoveryFailure(origin, { ...input, invocationId: 'two' })
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
  // Approval for a restart the agent runs itself is valid, even quoting the command beside unrelated "you".
  const restartApproval = await createAgentQuestion(
    { agentId: worker.id, executionId: execution.id },
    {
      questions: [
        {
          id: 'restart',
          type: 'select',
          question: 'May I gracefully restart xion.service once to recover it?',
          context:
            '1. Restart it once (recommended, about the same as the restart you already accepted): run `systemctl restart xion` once. ' +
            'The graceful stop closes the FIFO, so PM2 restarts the tracer automatically (on the same bcc56f8 build), and the node ' +
            "reopens the FIFO when it starts. I'll verify replay of 19,635,624, catch-up, export continuity and queues, and stop it " +
            'gracefully again if it panics during catch-up.',
          options: [
            { value: 'restart', label: 'Restart it once (recommended)' },
            { value: 'leave', label: 'Leave it stopped' },
          ],
        },
      ],
    }
  )
  expect(restartApproval.status).toBe('open')
  await expect(
    createAgentQuestion(
      { agentId: worker.id, executionId: execution.id },
      {
        questions: [
          {
            id: 'status',
            type: 'text',
            question: 'Is the node healthy?',
            context: 'Can you run systemctl status xion and paste the output?',
          },
        ],
      }
    )
  ).rejects.toThrow("Rejected text: the context of question 'status'.")
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
            // The box cannot be reached at all: not an interrupted call, so a read spends the budget too.
            throw new SandboxTransportError('connection_refused', 'connect', new Error('fixture'))
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

// Unary sandbox reads label every transport failure `connect` today, so this response-phase loss is
// the rule's contract for when they report one, not something a read produces yet.
test('an interrupted call to a safe tool spends no budget; the same interruption of an unsafe tool still does', async () => {
  const { Type } = await import('@sinclair/typebox')
  const { wrapToolWithRecovery } = await import('./runtime')
  const { runIdempotentSandboxOperation } = await import('../sandbox/vm/retry')
  const { BashOutcomeUnknownError, SandboxTransportError } = await import('../sandbox/client/http-client')
  const { recoveryEpisodes } = await import('../../db')
  const origin = () => ({ agentId: worker.id, executionId: execution.id })
  let reads = 0
  const read = wrapToolWithRecovery(
    {
      name: 'read',
      label: 'Read',
      description: 'fixture',
      parameters: Type.Object({ path: Type.String() }),
      execute: async () =>
        runIdempotentSandboxOperation({
          sandboxId: 'fixture',
          operationClass: 'read',
          getClient: () => ({}),
          recoverClient: async (client) => client,
          sleep: async () => {},
          operation: async () => {
            reads++
            // The connection breaks off while the response streams.
            throw new SandboxTransportError('connection_reset', 'response', new Error('fixture'))
          },
        }),
    },
    origin
  )
  expect(read.ficus).toEqual({ replay: 'safe', label: 'direct' })
  // More interruptions than the budget allows, and still no hold: each one is free.
  for (const id of ['read-1', 'read-2'])
    await expect(executeTool(read, id, { path: 'notes.md' })).rejects.toThrow(
      'This tool only reads, so it is safe to run again. This interruption does not count toward the recovery budget.'
    )
  expect(reads).toBe(6)
  expect(await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))).toHaveLength(0)

  let commands = 0
  const bash = wrapToolWithRecovery(
    {
      name: 'bash',
      label: 'Bash',
      description: 'fixture',
      parameters: Type.Object({ command: Type.String() }),
      execute: async () => {
        commands++
        throw new BashOutcomeUnknownError('invocation-fixture', 'connection_reset')
      },
    },
    origin
  )
  expect(bash.ficus).toEqual({ replay: 'unsafe', label: 'direct' })
  const failure = await executeTool(bash, 'bash-1', { command: 'deploy' }).catch((error: Error) => error)
  expect(String(failure)).toContain('Inspect the affected state')
  expect(String(failure)).not.toContain('does not count toward the recovery budget')
  expect(commands).toBe(1)
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record?.state).toMatchObject({ state: 'recovering', failures: 1 })
})

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

test.each([1, 2])('a %i-failure automatic retry does not gate task inputs', async (count) => {
  const api = await store()
  const { requestStructuredInput } = await import('./structured-input')
  for (let n = 0; n < count; n++)
    await api.recordRecoveryFailure(
      { agentId: worker.id, executionId: execution.id },
      { operationKey: 'scoped-question', invocationId: `scope-${n}`, attempted: 'read files', error: new Error('Lost') }
    )
  // No typed decision exists while the runtime still retries, so a genuine task input is allowed.
  const wait = await requestStructuredInput(
    stream.id,
    {
      schemaVersion: 1,
      kind: 'decide',
      purpose: 'task-decision',
      subject: 'Choose a layout',
      options: [
        { id: 'a', label: 'Compact' },
        { id: 'b', label: 'Spacious' },
      ],
    },
    { createdBy: 'agent' as const, createdByAgentId: worker.id }
  )
  expect(wait.workStreamId).toBe(stream.id)
})

test.each([3])('a %i-failure held episode gates task inputs only in its own stream', async (count) => {
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
  // Still retrying automatically: there is no typed decision to bypass, so asking a person stays open.
  expect(await api.assertNoPendingRecovery(db, worker.id, stream.id)).toBeUndefined()
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

test('manager prose compatibility does not bypass its own held same-scope recovery', async () => {
  await db.update(squads).set({ managerAgentId: worker.id }).where(eq(squads.id, squad.id))
  const api = await store()
  const fail = (invocationId: string) =>
    api.recordRecoveryFailure(
      { agentId: worker.id, executionId: execution.id },
      { operationKey: 'manager-task', attempted: 'Run the task', invocationId, error: new Error('unknown outcome') }
    )
  await fail('manager-first')
  // One failure is still an automatic retry, not a held decision: it does not block asking a person.
  expect(await api.assertNoPendingRecovery(db, worker.id, stream.id)).toBeUndefined()
  await fail('manager-second')
  // The squad manager is the failing agent itself, so the held decision routes to the owner.
  expect((await fail('manager-third')).state.state).toBe('waiting-owner')
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

test('temporary manager unavailability escalates only the current record', async () => {
  const api = await store()
  const managerId = squad.managerAgentId!
  const [manager] = await db.select().from(agents).where(eq(agents.id, managerId))
  await db.update(agents).set({ status: 'waiting-input' }).where(eq(agents.id, managerId))
  const origin = { agentId: worker.id, executionId: execution.id }
  const failure = (invocationId: string) => ({
    operationKey: 'temporary-manager',
    attempted: 'Run the task',
    invocationId,
    error: new Error('Lost outcome'),
  })
  let record
  for (let n = 0; n < 3; n++) record = await api.recordRecoveryFailure(origin, failure(`first-${n}`))
  expect(record!.state.state).toBe('waiting-owner')
  await db.update(agents).set({ status: manager!.status }).where(eq(agents.id, managerId))
  await api.decideRecovery(record!.id, { action: 'continue', expectedVersion: record!.version }, { userId: ownerId })
  await api.settleRecoveryOperation(origin, 'temporary-manager', 'confirmed-success')
  for (let n = 0; n < 3; n++) record = await api.recordRecoveryFailure(origin, failure(`next-${n}`))
  expect(record!.state).toMatchObject({ state: 'waiting-manager', managerCycles: 0, ownerEscalated: false })
})

test('host timeout feedback retains output and does not consume recovery budget', async () => {
  const { createHostBashTool } = await import('../../tools/host-sandbox')
  const { ToolFeedbackError } = await import('../../tools/tool-feedback')
  const { wrapToolWithRecovery } = await import('./runtime')
  const { recoveryEpisodes } = await import('../../db')
  const tool = wrapToolWithRecovery(createHostBashTool('/tmp'), () => ({
    agentId: worker.id,
    executionId: execution.id,
  }))
  const error = await executeTool(tool, 'host-timeout', {
    command: 'printf before-timeout; sleep 20',
    timeout: 1,
  }).catch((error) => error)
  expect(error).toBeInstanceOf(ToolFeedbackError)
  expect(error.message).toContain('before-timeout')
  expect(error.message).toContain('Command timed out after 1 seconds')
  expect(await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))).toHaveLength(0)
})

test('executor error frames with exit 127 count; completed commands with exit 127 do not', async () => {
  const { EventEmitter } = await import('node:events')
  const { SandboxClient } = await import('../sandbox/client/http-client')
  const { createK8sSandboxedBashTool } = await import('../../tools/sandbox-tools')
  const { wrapToolWithRecovery } = await import('./runtime')
  const { recoveryEpisodes } = await import('../../db')
  const client = new SandboxClient('feedback-fixture')
  let failedStart = false
  client.bash = () => {
    const emitter = new EventEmitter()
    queueMicrotask(() => {
      emitter.emit(
        'data',
        failedStart ? { error: 'Failed to start bash invocation', exitCode: 127 } : { exitCode: 127 }
      )
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
  const tool = wrapToolWithRecovery(createK8sSandboxedBashTool('/workspace', 'fixture', manager), () => ({
    agentId: worker.id,
    executionId: execution.id,
  }))
  expect(await executeTool(tool, 'exit', { command: 'exit 127' })).toMatchObject({
    isError: true,
    structuredContent: { exit_code: 127 },
  })
  expect(await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))).toHaveLength(0)
  failedStart = true
  await expect(executeTool(tool, 'spawn-failure', { command: 'exit 127' })).rejects.toThrow('Failed to start')
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record!.state.failures).toBe(1)
  client.close()
})

const toolNameRejection =
  "Codex error: [ToolSearchOutputFunctionToolNameParam] [input[49].name] [invalid_string] Invalid 'input[49].name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_.-]+\\Z'. PRIVATE_PROMPT_AND_SECRET"

test('provider validation fails into a visible flow-attempt hold on the first failure without replay or duplicate notices', async () => {
  const { createBlankWorkflow, createWorkflowRun, resolveWorkflow } = await import('@ficus/shared')
  const { executions, recoveryEpisodes, workStreamFlowRuns, workflowBindings } = await import('../../db')
  const { classifyTurnFailure } = await import('../execution/failure-classification')
  const { computeDerivedStates } = await import('../work-streams/derived-state')
  const { workflowFingerprint } = await import('../workflows/catalog')
  const [snapshot] = await db.select().from(agentTypes).where(eq(agentTypes.id, prefix))
  const definition = createBlankWorkflow()
  await db.insert(workStreamFlowRuns).values({
    workStreamId: stream.id,
    activated: true,
    state: createWorkflowRun(definition),
    source: resolveWorkflow({ kind: 'inline', definition }),
    attemptAgents: { '1': worker.id },
    participantSnapshots: { worker: snapshot! },
    createRequestId: crypto.randomUUID(),
    createRequestHash: 'test',
    createdBy: 'test',
  })
  await db.insert(workflowBindings).values({
    agentId: worker.id,
    workStreamId: stream.id,
    participantId: 'worker',
    bindingKey: `worker:${workflowFingerprint(snapshot)}:reuse-0`,
    agentSnapshot: snapshot!,
  })
  // Queue against the active attempt to use the same origin capture as production.
  await execution.stop()
  execution = await worker.queueExecution({ message: 'Retained private task' })
  expect(execution.flowContext?.attemptId).toBe(1)
  await execution.fail(toolNameRejection, undefined, classifyTurnFailure(toolNameRejection, false))
  const api = await store()
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record?.state).toMatchObject({ state: 'waiting-manager', failures: 1, cycleFailures: 1 })
  expect(record?.flowAttemptId).toBe(1)
  const projection = (await computeDerivedStates([stream])).get(stream.id)!
  expect(projection.derivedState).toBe('blocked')
  expect(projection.openWaits[0]).toMatchObject({ flowAttemptId: 1, actor: 'manager' })
  const [failed] = await db.select().from(executions).where(eq(executions.id, execution.id))
  expect(failed.error).not.toContain('PRIVATE_PROMPT')
  expect(failed.failureReason).toBe('request_validation_tool_name')
  const { recoveryAttempts } = await import('../../db')
  const [outcome] = await db.select().from(recoveryAttempts).where(eq(recoveryAttempts.recoveryId, record!.id))
  expect(outcome!.outcome).toBe('explained')
  // Retried delivery of the same outcome is idempotent; another queued run cannot dispatch it.
  await execution.fail(toolNameRejection, undefined, classifyTurnFailure(toolNameRejection, false))
  const next = await worker.queueExecution({ message: 'Unchanged request' })
  await expect(api.recoveryRetryDelay({ agentId: worker.id, executionId: next.id }, 'execution:run')).rejects.toThrow(
    'Recovery is held'
  )
  const notices = await db
    .select()
    .from(inbox)
    .where(sql`${inbox.metadata}->>'recoveryId' = ${record!.id}`)
  expect(notices).toHaveLength(1)
  expect(notices[0]!.recipientId).toBe(squad.managerAgentId!)
  expect(notices[0]!.content).toContain('Correct the request or safely re-plan')
  expect(notices[0]!.content).not.toContain('PRIVATE_PROMPT')
  expect(notices[0]!.content).not.toContain('Retained private task')
  await next.stop()
  const continued = await api.decideRecovery(
    record!.id,
    { action: 'continue', expectedVersion: record!.version },
    { agentId: squad.managerAgentId! }
  )
  const [wake] = await db
    .select()
    .from(inbox)
    .where(eq(inbox.idempotencyKey, `recovery-continued:${continued.id}:${continued.version}`))
  expect(await api.recoveryContinuationIsCurrent(db, wake!.id, worker.id)).toBe(true)
  const [flow] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, stream.id))
  expect(flow!.state.attempts).toHaveLength(1)
  expect(flow!.state.attempts[0]!.status).toBe('running')
  const [closed] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, record!.waitId!))
  expect(closed!.closedAt).not.toBeNull()
})

test('a standalone validation hold permits only authorized versioned correction and re-holds at the next rejection', async () => {
  const { recoveryEpisodes } = await import('../../db')
  const { classifyTurnFailure } = await import('../execution/failure-classification')
  await db.delete(workStreams).where(eq(workStreams.id, stream.id))
  await db.update(agents).set({ ownerUserId: ownerId }).where(eq(agents.id, worker.id))
  await execution.fail(toolNameRejection, undefined, classifyTurnFailure(toolNameRejection, false))
  const api = await store()
  let [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record?.state).toMatchObject({ state: 'waiting-manager', failures: 1 })
  await expect(
    api.decideRecovery(record!.id, { action: 'continue', expectedVersion: record!.version }, { agentId: worker.id })
  ).rejects.toThrow('authorized manager')
  await expect(
    api.decideRecovery(
      record!.id,
      { action: 'continue', expectedVersion: record!.version - 1 },
      { agentId: squad.managerAgentId! }
    )
  ).rejects.toThrow('version changed')
  record = await api.decideRecovery(
    record!.id,
    { action: 'stop', expectedVersion: record!.version },
    { agentId: squad.managerAgentId! }
  )
  await expect(
    api.recoveryRetryDelay({ agentId: worker.id, executionId: execution.id }, 'execution:run')
  ).rejects.toThrow('Recovery is held')
  record = await api.decideRecovery(
    record.id,
    { action: 'continue', expectedVersion: record.version },
    { agentId: squad.managerAgentId! }
  )
  const [wake] = await db
    .select()
    .from(inbox)
    .where(eq(inbox.idempotencyKey, `recovery-continued:${record.id}:${record.version}`))
  expect(wake!.content).toContain('Correct the request or safely re-plan')
  expect(await api.recoveryContinuationIsCurrent(db, wake!.id, worker.id)).toBe(true)
  expect(await api.recoveryRetryDelay({ agentId: worker.id, executionId: execution.id }, 'execution:run')).toBe(0)
  const next =
    (await worker.getActiveExecution()) ?? (await worker.queueExecution({ message: 'Safe correction attempt' }))
  await next.fail(toolNameRejection, undefined, classifyTurnFailure(toolNameRejection, false))
  ;[record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record!.state).toMatchObject({ state: 'waiting-owner', failures: 2, managerCycles: 1 })
  const { listPendingActions } = await import('../agents/actions')
  const action = (await listPendingActions()).find((item) => item.id === `agent-recovery:${record!.id}`)
  expect(action).toBeDefined()
  await expect(
    api.decideRecovery(
      record!.id,
      { action: 'continue', expectedVersion: record!.version },
      { agentId: squad.managerAgentId! }
    )
  ).rejects.toThrow('authorized owner')
  record = await api.decideRecovery(
    record!.id,
    { action: 'continue', expectedVersion: record!.version },
    { userId: ownerId }
  )
  // A confirmed corrected result settles the episode; no session reset is needed.
  const corrected =
    (await worker.getActiveExecution()) ?? (await worker.queueExecution({ message: 'Corrected request' }))
  await corrected.complete()
  expect((await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, record.id)))[0]!.state.state).toBe(
    'resolved'
  )
})

test('validation Continue retains pauses, provider questions and other waits rather than admitting a blocked task', async () => {
  const { recoveryEpisodes } = await import('../../db')
  const { classifyTurnFailure } = await import('../execution/failure-classification')
  await execution.fail(toolNameRejection, undefined, classifyTurnFailure(toolNameRejection, false))
  const api = await store()
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record).toBeDefined()
  const other = await stream.block({ message: 'Independent approval', createdBy: 'system' })
  const pause = {
    reason: 'Owner pause',
    id: crypto.randomUUID(),
    pausedAt: new Date().toISOString(),
    parkAt: null,
    agentIds: [worker.id],
  }
  await db.update(workStreams).set({ pause }).where(eq(workStreams.id, stream.id))
  await db
    .update(agents)
    .set({
      status: 'waiting-input',
      questionData: { questions: [{ id: 'provider', type: 'text', question: 'Provider authorization required' }] },
    })
    .where(eq(agents.id, worker.id))
  const continued = await api.decideRecovery(
    record!.id,
    { action: 'continue', expectedVersion: record!.version },
    { agentId: squad.managerAgentId! }
  )
  const [wake] = await db
    .select()
    .from(inbox)
    .where(eq(inbox.idempotencyKey, `recovery-continued:${continued.id}:${continued.version}`))
  expect(await api.recoveryContinuationIsCurrent(db, wake!.id, worker.id)).toBe(false)
  expect((await db.select().from(workStreams).where(eq(workStreams.id, stream.id)))[0]!.pause).toEqual(pause)
  expect((await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, other.id)))[0]!.closedAt).toBeNull()
  expect((await db.select().from(agents).where(eq(agents.id, worker.id)))[0]!.status).toBe('waiting-input')
  await db.update(agents).set({ status: 'idle', questionData: null }).where(eq(agents.id, worker.id))
  expect(await api.recoveryContinuationIsCurrent(db, wake!.id, worker.id)).toBe(false) // Pause still applies.
  await db.update(workStreams).set({ pause: null }).where(eq(workStreams.id, stream.id))
  expect(await api.recoveryContinuationIsCurrent(db, wake!.id, worker.id)).toBe(false) // Independent wait still applies.
  await db
    .update(workStreamWaits)
    .set({ closedAt: new Date(), resolution: 'cleared' })
    .where(eq(workStreamWaits.id, other.id))
  const dependency = await storedLegacyWorkStream({ squadId: squad.id, title: 'Required dependency' })
  await stream.update({ dependsOn: [dependency.id] })
  expect(await api.recoveryContinuationIsCurrent(db, wake!.id, worker.id)).toBe(false)
})

test('late validation outcomes update real counts and versions without repeating the same hold notification', async () => {
  const api = await store()
  const { ProviderRequestValidationError } = await import('../execution/provider-request-validation')
  const origin = { agentId: worker.id, executionId: execution.id }
  let record: Awaited<ReturnType<typeof api.recordRecoveryFailure>>
  for (const invocationId of ['one', 'two', 'three']) {
    record = await api.recordRecoveryFailure(origin, {
      operationKey: 'execution:run',
      attempted: 'continue the task',
      invocationId,
      error: new ProviderRequestValidationError(),
    })
  }
  expect(record!.state).toMatchObject({ state: 'waiting-manager', failures: 3 })
  const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, record!.waitId!))
  expect(wait!.structured!.version).toBe(record!.version)
  expect(wait!.structured!.summary.attemptCount).toBe(3)
  const notices = await db
    .select()
    .from(inbox)
    .where(sql`${inbox.metadata}->>'recoveryId' = ${record!.id}`)
  expect(notices).toHaveLength(1)
})

async function failedSubagent(error = toolNameRejection) {
  const { spyOn } = await import('bun:test')
  const { SubagentRunner } = await import('../../entities/agent-runners/subagent-runner')
  const { classifyTurnFailure } = await import('../execution/failure-classification')
  const child = await Agent.create({ agentTypeId: prefix, squadId: squad.id, parentAgentId: worker.id, persist: false })
  const run = await child.queueExecution({ message: 'Narrow delegated task' })
  const runner = new SubagentRunner(run, child, await child.mustGetAgentType())
  let finalResult: Promise<void> | undefined
  const target = runner as unknown as { deliverResultAndSelfTerminate: (...args: any[]) => Promise<void> }
  const deliver = target.deliverResultAndSelfTerminate.bind(runner)
  const delivered = spyOn(target, 'deliverResultAndSelfTerminate').mockImplementation((...args) => {
    finalResult = deliver(...args)
    return finalResult
  })
  let settle!: () => void
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const original = run.fail.bind(run)
  const failed = spyOn(run, 'fail').mockImplementation(async (...args) => {
    try {
      return await original(...args)
    } finally {
      settle()
    }
  })
  ;(runner as any).buffer = { push() {}, close() {}, fail() {} }
  ;(runner as any).onError(error, classifyTurnFailure(error, false))
  await settled
  await finalResult
  failed.mockRestore()
  delivered.mockRestore()
  return { child, run, runner }
}

test('a validation-held subagent remains recoverable, notifies its parent without a final result, and delivers completion once after correction', async () => {
  const { recoveryEpisodes } = await import('../../db')
  const { SubagentRunner } = await import('../../entities/agent-runners/subagent-runner')
  const { Subagent } = await import('../../entities/Subagent')
  const { child, run } = await failedSubagent()
  expect((await Agent.mustFind(child.id)).status).toBe('idle')
  expect((await Agent.mustFind(child.id)).metadata?.completionDelivered).not.toBe(true)
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, child.id))
  expect(record!.state.state).toBe('waiting-manager')
  await expect(
    Subagent.dispatch({ parentAgentId: worker.id, subagents: [{ instructions: 'Replace held child' }] })
  ).rejects.toThrow('pending request-validation recovery')
  expect(await Subagent.listChildren(worker.id)).toHaveLength(1)
  await expect(
    Subagent.dispatch({
      parentAgentId: worker.id,
      subagents: Array.from({ length: 10 }, () => ({ instructions: 'Attempt replacement' })),
    })
  ).rejects.toThrow('Subagent cap exceeded: 9 slots free')
  const [parentNotice] = await db
    .select()
    .from(inbox)
    .where(
      sql`${inbox.metadata}->>'source' = 'subagent-recovery-held' AND ${inbox.metadata}->>'subagentId' = ${child.id}`
    )
  expect(parentNotice!.recipientId).toBe(worker.id)
  expect(parentNotice!.content).toContain('not a final result')
  expect(parentNotice!.content).not.toContain('PRIVATE')
  expect(parentNotice!.metadata?.resultStatus).toBeUndefined()
  await expect(
    Subagent.revive({ parentAgentId: worker.id, subagentId: child.id, instructions: 'Bypass hold' })
  ).rejects.toThrow('already live')
  const api = await store()
  await expect(api.recoveryRetryDelay({ agentId: child.id, executionId: run.id }, 'execution:run')).rejects.toThrow(
    'Recovery is held'
  )
  await api.decideRecovery(
    record!.id,
    { action: 'continue', expectedVersion: record!.version },
    { agentId: squad.managerAgentId! }
  )
  const next = (await child.getActiveExecution()) ?? (await child.queueExecution({ message: 'Corrected request' }))
  const corrected = new SubagentRunner(next, child, await child.mustGetAgentType())
  ;(corrected as any).buffer = { push() {}, close() {}, fail() {} }
  await (corrected as any).onComplete('Corrected final result', undefined, {})
  await (corrected as any).deliverResultAndSelfTerminate('completed', 'Duplicate final result')
  const final = await db.select().from(inbox).where(eq(inbox.senderId, child.id))
  expect(final).toHaveLength(1)
  expect(final[0]!.metadata?.resultStatus).toBe('completed')
  expect((await Agent.mustFind(child.id)).status).toBe('dormant')
})

test('a parent can cancel a validation-held child and an old continuation cannot revive it', async () => {
  const { recoveryEpisodes } = await import('../../db')
  const { Subagent } = await import('../../entities/Subagent')
  const { child } = await failedSubagent()
  expect((await Agent.mustFind(child.id)).status).toBe('idle')
  await Subagent.stop({ parentAgentId: worker.id, subagentId: child.id, reason: 'Task canceled' })
  expect((await Agent.mustFind(child.id)).status).toBe('dormant')
  await expect(
    Subagent.revive({ parentAgentId: worker.id, subagentId: child.id, instructions: 'Bypass stopped hold' })
  ).rejects.toThrow('pending request-validation recovery')
  await expect(
    Subagent.dispatch({ parentAgentId: worker.id, subagents: [{ instructions: 'Replace canceled child' }] })
  ).rejects.toThrow('pending request-validation recovery')
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, child.id))
  const api = await store()
  const continued = await api.decideRecovery(
    record!.id,
    { action: 'continue', expectedVersion: record!.version },
    { agentId: squad.managerAgentId! }
  )
  const [wake] = await db
    .select()
    .from(inbox)
    .where(eq(inbox.idempotencyKey, `recovery-continued:${continued.id}:${continued.version}`))
  expect(await api.recoveryContinuationIsCurrent(db, wake!.id, child.id)).toBe(false)
  expect(await child.getActiveExecution()).toBeNull()
  await Subagent.stop({ parentAgentId: worker.id, subagentId: child.id })
  const final = await db.select().from(inbox).where(eq(inbox.senderId, child.id))
  expect(final).toHaveLength(1)
  expect(final[0]!.metadata?.resultStatus).toBe('stopped')
})

test('parent task cancellation cascades to a validation-held child and fences recovery delivery', async () => {
  const { recoveryEpisodes } = await import('../../db')
  const { requestAgentLifecycle } = await import('../agent/lifecycle')
  const { child } = await failedSubagent()
  await requestAgentLifecycle(worker, { target: 'dormant', reason: 'Parent task canceled', stopActive: true })
  expect((await Agent.mustFind(child.id)).status).toBe('dormant')
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, child.id))
  const api = await store()
  const continued = await api.decideRecovery(
    record!.id,
    { action: 'continue', expectedVersion: record!.version },
    { agentId: squad.managerAgentId! }
  )
  const [wake] = await db
    .select()
    .from(inbox)
    .where(eq(inbox.idempotencyKey, `recovery-continued:${continued.id}:${continued.version}`))
  expect(await api.recoveryContinuationIsCurrent(db, wake!.id, child.id)).toBe(false)
  expect(await child.getActiveExecution()).toBeNull()
})

test('unrelated subagent provider failures still deliver a final failure and become dormant rather than opening validation holds', async () => {
  const { recoveryEpisodes } = await import('../../db')
  const { child } = await failedSubagent('Unrelated model error')
  expect((await Agent.mustFind(child.id)).status).toBe('dormant')
  const final = await db.select().from(inbox).where(eq(inbox.senderId, child.id))
  expect(final).toHaveLength(1)
  expect(final[0]!.metadata?.resultStatus).toBe('failed')
  expect(final[0]!.content).toContain('Unrelated model error')
  expect(await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, child.id))).toHaveLength(0)
})

test.each(['flow', 'standalone'] as const)(
  'foreground transport losses retain invocation identity and issue an actionable native %s recovery while execution continues',
  async (mode) => {
    const { createBlankWorkflow, createWorkflowRun, resolveWorkflow } = await import('@ficus/shared')
    const { executions, recoveryEpisodes, recoveryAttempts, workStreamFlowRuns, workflowBindings } =
      await import('../../db')
    const { SandboxClient, bashOutcomeUnknownForError } = await import('../sandbox/client/http-client')
    const { createK8sSandboxedBashTool } = await import('../../tools/sandbox-tools')
    const { wrapToolWithRecovery } = await import('./runtime')
    if (mode === 'flow') {
      const definition = createBlankWorkflow()
      const { workflowFingerprint } = await import('../workflows/catalog')
      const [snapshot] = await db.select().from(agentTypes).where(eq(agentTypes.id, prefix))
      await db.insert(workStreamFlowRuns).values({
        workStreamId: stream.id,
        activated: true,
        state: createWorkflowRun(definition),
        source: resolveWorkflow({ kind: 'inline', definition }),
        attemptAgents: { '1': worker.id },
        participantSnapshots: { worker: snapshot! },
        createRequestId: crypto.randomUUID(),
        createRequestHash: 'test',
        createdBy: 'test',
      })
      await db.insert(workflowBindings).values({
        agentId: worker.id,
        workStreamId: stream.id,
        participantId: 'worker',
        bindingKey: `worker:${workflowFingerprint(snapshot)}:reuse-0`,
        agentSnapshot: snapshot!,
      })
    } else {
      await db.update(workStreams).set({ assigneeAgentId: null }).where(eq(workStreams.id, stream.id))
      await db.update(agents).set({ ownerUserId: ownerId }).where(eq(agents.id, worker.id))
    }
    await db
      .update(executions)
      .set({
        status: 'running',
        flowContext: mode === 'flow' ? { workStreamId: stream.id, attemptId: 1, stepId: 'work' } : null,
      })
      .where(eq(executions.id, execution.id))
    const invocationIds: string[] = []
    const cancellations: string[] = []
    const client = new SandboxClient('transport-fixture', undefined, {
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body))
        if (String(url).endsWith('/bash/cancel')) {
          cancellations.push(body.invocationId)
          return Response.json({ remainingPids: [] })
        }
        if (body.command === 'git status') return new Response('data: {"exitCode":0}\n\n')
        invocationIds.push(body.invocationId)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(Object.assign(new Error('PRIVATE_ENDPOINT_AND_TOKEN'), { code: 'ECONNRESET' }))
            },
          })
        )
      },
    })
    const manager = {
      getClientForSandbox: () => client,
      getSandboxStatus: async () => ({ status: 'running' }),
      resolveToolApiUrl: () => 'http://fixture',
    }
    let currentExecutionId = execution.id
    const source = () => ({ agentId: worker.id, executionId: currentExecutionId })
    const bash = createK8sSandboxedBashTool('/workspace', 'fixture', manager)
    bash.name = 'squad_bash'
    const tool = wrapToolWithRecovery(bash, source)
    const errors: Error[] = []
    try {
      for (let n = 0; n < 3; n++) {
        const error = await executeTool(tool, `loss-${n}`, { command: 'npm test', timeout: 10 + n }).catch((e) => e)
        expect(error).toBeInstanceOf(Error)
        expect(error.message).toContain('Ficus stopped it')
        expect(error.message).not.toContain('PRIVATE_ENDPOINT')
        expect(bashOutcomeUnknownForError(error)).toMatchObject({
          invocationId: invocationIds[n],
          failureClass: 'connection_reset',
          code: 'BASH_OUTCOME_UNKNOWN',
        })
        errors.push(error)
        if (n === 0) await executeTool(tool, 'inspection', { command: 'git status' })
      }
      let [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
      expect(record!.state).toMatchObject({ failures: 3, cycleFailures: 3, state: 'waiting-manager' })
      expect(cancellations).toEqual(invocationIds)
      const attempts = await db.select().from(recoveryAttempts).where(eq(recoveryAttempts.recoveryId, record!.id))
      expect(attempts.map((a) => a.invocationId).sort()).toEqual([...invocationIds].sort())
      expect(attempts.every((a) => a.outcome === 'unknown')).toBe(true)
      expect(record!.state.lastError).toBe('Bash transport connection reset; command outcome is unknown.')
      expect(errors[2]!.message).toContain(record!.id)
      expect(errors[2]!.message).toContain(`expectedVersion ${record!.version}`)
      if (mode === 'flow') {
        const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, record!.waitId!))
        expect(wait).toMatchObject({ actor: 'manager', flowAttemptId: 1 })
        expect(wait!.structured!.request).toMatchObject({
          recoveryId: record!.id,
          expectedRecoveryVersion: record!.version,
        })
        expect(errors[2]!.message).toContain(record!.waitId!)
      } else expect(record!.waitId).toBeNull()
      const [active] = await db.select().from(executions).where(eq(executions.id, execution.id))
      expect(active!.status).toBe('running')
      await expect(executeTool(tool, 'blocked', { command: 'npm test' })).rejects.toThrow('authorized decision')
      expect(invocationIds).toHaveLength(3)
      const api = await store()
      const { recoveryOperationKey } = await import('./operation')
      const duplicate = await api.recordRecoveryFailure(source(), {
        operationKey: recoveryOperationKey('squad_bash', { command: 'npm test' }),
        attempted: 'run the requested command',
        invocationId: invocationIds[2]!,
        error: errors[2],
      })
      expect(duplicate.version).toBe(record!.version)
      expect(duplicate.state.failures).toBe(3)
      const notices = await db.select().from(inbox).where(eq(inbox.recipientId, squad.managerAgentId!))
      expect(notices.filter((notice) => notice.metadata?.recoveryId === record!.id)).toHaveLength(1)
      await expect(
        api.decideRecovery(
          record!.id,
          {
            action: 'continue',
            expectedVersion: record!.version,
          },
          { agentId: worker.id }
        )
      ).rejects.toThrow('authorized')
      record = await api.decideRecovery(
        record!.id,
        {
          action: 'continue',
          expectedVersion: record!.version,
        },
        { agentId: squad.managerAgentId! }
      )
      expect(record!.state).toMatchObject({ managerCycles: 1, cycleFailures: 0, failures: 3 })
      // A replacement model execution/turn must not buy a fresh allowance.
      await db
        .update(executions)
        .set({ status: 'completed', endedAt: new Date() })
        .where(eq(executions.id, execution.id))
      const [next] = await db
        .insert(executions)
        .values({
          agentId: worker.id,
          status: 'running',
          flowContext: mode === 'flow' ? { workStreamId: stream.id, attemptId: 1, stepId: 'work' } : null,
        })
        .returning()
      currentExecutionId = next!.id
      for (let n = 3; n < 6; n++)
        await expect(executeTool(tool, `loss-${n}`, { command: ' npm  test ', timeout: 10 + n })).rejects.toThrow(
          'Lost the connection'
        )
      ;[record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, record!.id))
      expect(record!.state).toMatchObject({ failures: 6, cycleFailures: 3, managerCycles: 1, state: 'waiting-owner' })
      expect(await db.select().from(recoveryAttempts).where(eq(recoveryAttempts.recoveryId, record!.id))).toHaveLength(
        6
      )
      expect(await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))).toHaveLength(1)
      const waits = await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))
      expect(waits.filter((w) => !w.closedAt)).toHaveLength(mode === 'flow' ? 1 : 0)
      if (mode === 'flow') expect(waits.find((w) => !w.closedAt)!.actor).toBe('human')
      await expect(
        api.decideRecovery(
          record!.id,
          {
            action: 'continue',
            expectedVersion: record!.version,
          },
          { agentId: squad.managerAgentId! }
        )
      ).rejects.toThrow('owner')
      await api.decideRecovery(
        record!.id,
        {
          action: 'stop',
          expectedVersion: record!.version,
        },
        { userId: ownerId }
      )
      await expect(executeTool(tool, 'stopped', { command: 'npm test' })).rejects.toThrow('stopped')
      expect(invocationIds).toHaveLength(6)
      const [stillRunning] = await db.select().from(executions).where(eq(executions.id, currentExecutionId))
      expect(stillRunning!.status).toBe('running')
    } finally {
      client.close()
    }
  },
  15000 // Includes the existing real 1s/2s backoff and database fixture setup.
)

test('a lost foreground outcome never invents a recovery decision when accounting is unavailable', async () => {
  const { spyOn } = await import('bun:test')
  const { Type } = await import('@sinclair/typebox')
  const { BashOutcomeUnknownError } = await import('../sandbox/client/http-client')
  const { wrapToolWithRecovery } = await import('./runtime')
  const outcome = new BashOutcomeUnknownError('unrecorded-invocation', 'connection_reset')
  const tool = wrapToolWithRecovery(
    {
      name: 'squad_bash',
      label: 'Bash',
      description: 'fixture',
      parameters: Type.Any(),
      execute: async () => {
        throw outcome
      },
    },
    () => ({ agentId: worker.id, executionId: execution.id })
  )
  const transaction = spyOn(db, 'transaction').mockRejectedValue(new Error('accounting unavailable'))
  try {
    const error = await executeTool(tool, 'loss', { command: 'npm test' }).catch((e) => e)
    expect(error.message).toContain('Recovery accounting is unavailable')
    expect(error.message).toContain('No recovery reference is available in this result')
    expect(error.message).toContain('a durable record may already exist')
    expect(error.message).not.toContain('budget is exhausted')
    expect(error.message).not.toContain('expectedVersion')
    expect(error.cause).toBe(outcome)
  } finally {
    transaction.mockRestore()
  }
})

test('mapped outage reasons survive nested transport provenance in the generated recovery decision', async () => {
  const api = await store()
  const { BashOutcomeUnknownError } = await import('../sandbox/client/http-client')
  const { SandboxOutageError } = await import('../sandbox/outage')
  let record
  for (let n = 0; n < 3; n++) {
    const loss = new BashOutcomeUnknownError(`outage-${n}`, 'connection_reset', new Error('PRIVATE_ENDPOINT'))
    const outage = new SandboxOutageError(
      'fixture',
      'Sandbox unavailable (reason: OutOfMemory at /home/private/error.log)',
      {
        status: 'failed',
        reason: 'OutOfMemory',
        cause: loss,
      }
    )
    const wrapped = new Error('Tool wrapper', { cause: outage })
    expect(api.lastErrorLine(outage)).toContain('OutOfMemory')
    expect(api.lastErrorLine(wrapped)).toContain('OutOfMemory')
    expect(api.lastErrorLine(wrapped)).not.toContain('/home/private')
    expect(api.lastErrorLine(wrapped)).not.toContain('PRIVATE_ENDPOINT')
    record = await api.recordRecoveryFailure(
      { agentId: worker.id, executionId: execution.id },
      {
        operationKey: 'outage-summary',
        attempted: 'run the requested command',
        invocationId: loss.invocationId,
        error: wrapped,
      }
    )
  }
  const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, record!.waitId!))
  expect(wait!.structured!.summary.lastError).toBe('Sandbox unavailable (reason: OutOfMemory at [internal path])')
  expect(wait!.structured!.summary.attemptCount).toBe(3)
})

test.each(['flow', 'standalone'] as const)(
  'held %s guidance tells the worker to yield to the authorized decision maker',
  async (mode) => {
    const api = await store()
    if (mode === 'standalone') {
      await db.update(workStreams).set({ assigneeAgentId: null }).where(eq(workStreams.id, stream.id))
      await db.update(agents).set({ ownerUserId: ownerId }).where(eq(agents.id, worker.id))
    }
    let record
    for (let n = 0; n < 3; n++)
      record = await api.recordRecoveryFailure(
        { agentId: worker.id, executionId: execution.id },
        {
          operationKey: 'yield-guidance',
          attempted: 'run the requested command',
          invocationId: `yield-${n}`,
          error: new Error('Lost outcome'),
        }
      )
    const guidance = api.recoveryHoldGuidance(record!)
    expect(guidance).toContain(`Recovery ${record!.id} (expectedVersion ${record!.version})`)
    expect(guidance).toContain('The squad manager or an eligible owner decides Continue or Stop')
    expect(guidance).toContain('End your turn and wait for that authorized decision')
    expect(guidance).not.toContain('Use ficus')
    expect(guidance).not.toContain('resolve-input')
    expect(guidance).not.toContain('agent recovery')
    if (mode === 'flow') expect(guidance).toContain(record!.waitId!)
    else expect(guidance).toContain(record!.agentId)
    await expect(
      api.recoveryRetryDelay({ agentId: worker.id, executionId: execution.id }, 'yield-guidance')
    ).rejects.toThrow('End your turn')
  }
)

test('an execution at the requeue cap opens the native recovery hold at once, counted once per recovery notice', async () => {
  const { holdExecutionAtRequeueLimit } = await import('../execution/requeue-limit')
  const { recoveryAttempts } = await import('../../db')
  const api = await store()
  const hold = (noticeId: string) =>
    holdExecutionAtRequeueLimit({
      agentId: worker.id,
      interruption: {
        noticeId,
        executionId: execution.id,
        cause: 'core_restart',
        recoveredAt: new Date().toISOString(),
        executionStartedAt: new Date(0).toISOString(),
        interruptionCount: 5,
      },
    })
  let record = await hold('notice-5')
  // No retries with backoff first: running it again could take Core down again.
  expect(record.state).toMatchObject({ state: 'waiting-manager', failures: 1, cycleFailures: 3, nextRetryAt: null })
  expect(record.state).toMatchObject({ requestValidation: false, requeueLimit: true })
  const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, record.waitId!))
  expect(wait!.actor).toBe('manager')
  // This agent has no session file, so nothing was running a tool when it was cut off.
  const lastError =
    'The run was cut off 5 times without finishing, most recently because Core stopped unexpectedly. It was cut off between tool calls.'
  expect(wait!.structured?.summary).toEqual({
    attempted: 'continue the task',
    attemptCount: 1,
    lastError,
    text: `I stopped resuming this run. ${lastError} Continue starts it again in a new run, which may stop Core again; Stop keeps it held.`,
  })
  // A repeated pickup of the same requeue does not count again or notify again.
  expect((await hold('notice-5')).state.failures).toBe(1)
  const attempts = await db.select().from(recoveryAttempts).where(eq(recoveryAttempts.recoveryId, record.id))
  expect(attempts.map((attempt) => [attempt.invocationId, attempt.outcome])).toEqual([
    [`${execution.id}:requeue-limit:notice-5`, 'unknown'],
  ])
  const notices = await db
    .select()
    .from(inbox)
    .where(sql`${inbox.metadata}->>'recoveryId' = ${record.id}`)
  expect(notices.map((notice) => notice.recipientId)).toEqual([squad.managerAgentId!])
  // The hold refuses the run until someone decides.
  await expect(
    api.recoveryRetryDelay({ agentId: worker.id, executionId: execution.id }, 'execution:run')
  ).rejects.toThrow('Recovery is held')
  // Continue grants one cycle; reaching the cap again in it goes to the owner, as for any recovery.
  record = await api.decideRecovery(
    record.id,
    { action: 'continue', expectedVersion: record.version },
    { agentId: squad.managerAgentId! }
  )
  expect(record.state.state).toBe('recovering')
  record = await hold('notice-6')
  expect(record.state).toMatchObject({ state: 'waiting-owner', ownerEscalated: true, failures: 2 })
})

test('Continue after the requeue cap hands the continued run the repeated cut-off call, never a generic result', async () => {
  const { holdExecutionAtRequeueLimit } = await import('../execution/requeue-limit')
  const { openOrCreateSession } = await import('../../lib/infra/session-files')
  const { recordInterruptedToolCalls, createInterruptedToolCallsExtension } =
    await import('../agent/interrupted-tool-calls')
  const { findHardInterruption } = await import('../execution/startup-recovery')
  const { executions } = await import('../../db')
  const api = await store()
  const [{ startedAt }] = await db
    .select({ startedAt: executions.startedAt })
    .from(executions)
    .where(eq(executions.id, execution.id))
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  // The agent's session on Core, as its runner leaves it each time Core dies mid call.
  let session = openOrCreateSession(worker.id)
  session.appendMessage({ role: 'user', content: 'Summarize the log', timestamp: Date.now() })
  const interruptions = []
  for (let n = 1; n <= 5; n++) {
    // The model makes the same call again each time it resumes, and Core dies running it.
    session.appendMessage({
      role: 'assistant',
      content: [{ type: 'toolCall', id: `call-${n}`, name: 'read', arguments: { path: 'huge.log' } }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      usage,
      stopReason: 'toolUse',
      timestamp: Date.now(),
    })
    await Bun.sleep(5)
    const interruption = {
      noticeId: `notice-${n}-${crypto.randomUUID()}`,
      executionId: execution.id,
      cause: 'core_restart' as const,
      recoveredAt: new Date().toISOString(),
      executionStartedAt: startedAt.toISOString(),
      interruptionCount: n,
    }
    interruptions.push(interruption)
    if (n === 5) break
    // Interruptions 1 to 4 resume: the runner records the cut-off call, then prompts.
    recordInterruptedToolCalls(session, interruption)
    session.appendMessage({ role: 'user', content: 'Continue.', timestamp: Date.now() })
  }
  // The fifth is held at pickup; nothing starts, but the cut-off call is recorded and named.
  let record = await holdExecutionAtRequeueLimit({ agentId: worker.id, interruption: interruptions[4]! })
  expect(record.state.state).toBe('waiting-manager')
  expect(record.state.lastError).toBe(
    'The run was cut off 5 times without finishing, most recently because Core stopped unexpectedly. It cut off read (cut off before too).'
  )
  record = await api.decideRecovery(
    record.id,
    { action: 'continue', expectedVersion: record.version },
    { agentId: squad.managerAgentId! }
  )
  expect(record.state.state).toBe('recovering')

  // Continue starts a new execution, which has no interruption of its own...
  await execution.stop()
  const continued = await worker.queueExecution({ message: 'Continue the task.' })
  expect(await findHardInterruption(continued.id, worker.id)).toBeUndefined()
  // ...and opens the same session file, whose context answers the fifth call as a repeat.
  session = openOrCreateSession(worker.id)
  session.appendMessage({ role: 'user', content: 'Continue the task.', timestamp: Date.now() })
  const [handler] = createInterruptedToolCallsExtension().handlers.get('context')!
  const messages = session.buildSessionContext().messages
  const hooked = (await handler!({ type: 'context', messages }, { sessionManager: session } as never)) as {
    messages: typeof messages
  }
  const results = Object.fromEntries(
    hooked.messages
      .filter((message) => message.role === 'toolResult')
      .map((message) => [message.toolCallId, (message.content[0] as { text: string }).text])
  )
  expect(results['call-5']).toContain('This same call, with the same arguments, was interrupted by a restart before')
  expect(results['call-5']).toContain('Do not run it again as is')
  expect(Object.keys(results).sort()).toEqual(['call-1', 'call-2', 'call-3', 'call-4', 'call-5'])
  await continued.stop()
})

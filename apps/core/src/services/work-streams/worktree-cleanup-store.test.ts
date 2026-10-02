import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createWorkflowRun, resolveWorkflow, workflowPresetSchema } from '@ficus/shared'
import { ACTIVE_EXECUTION_STATUSES } from '../execution/status'
import { openWait } from './waits'
import {
  db,
  squads,
  workStreams,
  worktreeCleanupJobs,
  workStreamWorktrees,
  agents,
  agentTypes,
  executions,
  workflowBindings,
  workStreamFlowRuns,
} from '../../db'
import * as store from './worktree-cleanup-store'
import type { WorktreeOwnership } from './repository-setup'

let squadId: string
let streamId: string
let agentId: string
let typeId: string
const head = 'a'.repeat(40)
const ownership: WorktreeOwnership = {
  workspace: '/workspace',
  repository: '/workspace/repo',
  commonDirectory: '/workspace/repo/.git',
  gitDirectory: '/workspace/repo/.git/worktrees/feature',
  worktree: '/workspace/feature',
  directoryIdentity: '1:2',
  branch: 'feature',
}
const metadata = {
  git: { repository: ownership.repository, worktree: ownership.worktree, branch: ownership.branch },
  codeHost: { integration: 'github', repository: 'example/repo', changeRequest: { number: 1 } },
}
beforeEach(async () => {
  const [squad] = await db.insert(squads).values({ name: 'cleanup-store-fixture', purpose: 'test' }).returning()
  squadId = squad.id
  typeId = crypto.randomUUID()
  await db.insert(agentTypes).values({ id: typeId, name: 'cleanup fixture', model: 'test', systemPrompt: 'test' })
  const [agent] = await db.insert(agents).values({ agentTypeId: typeId, squadId }).returning()
  agentId = agent.id
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId, title: 'delivered', status: 'done', autoCleanupWorktree: true, agentIds: [agentId], metadata })
    .returning()
  streamId = stream.id
  await db.insert(workStreamWorktrees).values({ workStreamId: streamId, squadId, ownership })
  await db
    .insert(worktreeCleanupJobs)
    .values({ workStreamId: streamId, deliveredHead: head, deliveryMetadata: metadata })
})
afterEach(async () => {
  await db.delete(executions).where(eq(executions.agentId, agentId))
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(agents).where(eq(agents.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
})
const claim = async () => {
  expect(store.claimWorktreeCleanup).toBeDefined()
  return store.claimWorktreeCleanup(streamId, {
    generation: (await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId)))[0]!
      .generation,
    ownership,
    head,
    metadata,
  })
}

test('one concurrent claim wins and durably pins an exact removal input', async () => {
  const claims = await Promise.all([claim(), claim()])
  expect(claims.filter(Boolean)).toHaveLength(1)
  const [job] = await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId))
  expect(job).toMatchObject({ status: 'removing', removalInput: claims.find(Boolean) })
})

test('associated finishing execution defers cleanup; shutdown permits the next attempt', async () => {
  const [execution] = await db.insert(executions).values({ agentId, status: 'running' }).returning()
  expect(await claim()).toBeNull()
  await db.update(executions).set({ status: 'completed' }).where(eq(executions.id, execution.id))
  expect(await claim()).not.toBeNull()
})

test('unrelated workspace execution does not block a quiescent owned worktree', async () => {
  await db.update(workStreams).set({ agentIds: [] }).where(eq(workStreams.id, streamId))
  await db.insert(executions).values({ agentId, status: 'running' })
  expect(await claim()).not.toBeNull()
})

for (const reason of ['disabled', 'reopened', 'shared', 'dependent', 'metadata-changed'] as const) {
  test(`${reason} wins before the claim and prevents removal`, async () => {
    if (reason === 'disabled')
      await db.update(workStreams).set({ autoCleanupWorktree: false }).where(eq(workStreams.id, streamId))
    if (reason === 'reopened')
      await db.update(workStreams).set({ status: 'active' }).where(eq(workStreams.id, streamId))
    if (reason === 'shared')
      await db
        .insert(workStreams)
        .values({ squadId, title: 'shared', metadata: { git: { worktree: '/workspace/feature/../feature' } } })
    if (reason === 'dependent')
      await db.insert(workStreams).values({ squadId, title: 'dependent', dependsOn: [streamId] })
    if (reason === 'metadata-changed')
      await db
        .update(workStreams)
        .set({ metadata: { ...metadata, git: { ...metadata.git, branch: 'different' } } })
        .where(eq(workStreams.id, streamId))
    expect(await claim()).toBeNull()
  })
}

for (const action of ['disable', 'reopen', 'unbind', 'rebind-path', 'delete'] as const) {
  test(`a claimed removal prevents ${action} from releasing or changing its resource`, async () => {
    const { WorkStream } = await import('../../entities/WorkStream')
    expect(await claim()).not.toBeNull()
    const stream = await WorkStream.mustFind(streamId)
    const mutate = () => {
      if (action === 'disable') return stream.update({ autoCleanupWorktree: false })
      if (action === 'reopen') return stream.reopen()
      if (action === 'unbind') return stream.update({ agentIds: [] })
      if (action === 'rebind-path') return stream.update({ worktree: '/workspace/different' })
      return stream.delete()
    }
    await expect(mutate()).rejects.toThrow(/cleanup|removal/i)
    expect((await WorkStream.mustFind(streamId)).status).toBe('done')
  })
}

test('associated restart sees the durable removal guard but unrelated agents do not', async () => {
  expect(store.cleanupWorktreeForAgent).toBeDefined()
  expect(await claim()).not.toBeNull()
  expect(await store.cleanupWorktreeForAgent(agentId, db)).toBe(streamId)
  const [other] = await db.insert(agents).values({ agentTypeId: typeId, squadId }).returning()
  expect(await store.cleanupWorktreeForAgent(other.id, db)).toBeNull()
})

test('reopen after successful cleanup is actionable rather than dispatching to a missing path', async () => {
  const { WorkStream } = await import('../../entities/WorkStream')
  await db
    .update(worktreeCleanupJobs)
    .set({ status: 'succeeded' })
    .where(eq(worktreeCleanupJobs.workStreamId, streamId))
  await expect((await WorkStream.mustFind(streamId)).reopen()).rejects.toThrow(/worktree|cleanup/i)
})

for (const attachment of ['path', 'dependency'] as const) {
  test(`a new ${attachment} attachment cannot race a claimed removal`, async () => {
    const { WorkStream } = await import('../../entities/WorkStream')
    expect(await claim()).not.toBeNull()
    const [other] = await db.insert(workStreams).values({ squadId, title: 'other' }).returning()
    const stream = await WorkStream.mustFind(other.id)
    await expect(
      stream.update(attachment === 'path' ? { worktree: ownership.worktree } : { dependsOn: [streamId] })
    ).rejects.toThrow(/cleanup|removal/i)
  })
}

for (const action of ['add', 'remove'] as const) {
  test(`legacy ${action} agent mutation cannot bypass the cleanup guard`, async () => {
    const { WorkStream } = await import('../../entities/WorkStream')
    expect(await claim()).not.toBeNull()
    const stream = await WorkStream.mustFind(streamId)
    const [other] = await db.insert(agents).values({ agentTypeId: typeId, squadId }).returning()
    await expect(action === 'add' ? stream.addAgent(other.id) : stream.removeAgent(agentId)).rejects.toThrow(
      /cleanup|removal/i
    )
  })
}

test('repository provisioning cannot recreate a registered resource or replace its ownership', async () => {
  expect(store.assertRepositoryTargetAvailable).toBeDefined()
  await expect(store.assertRepositoryTargetAvailable(squadId, crypto.randomUUID(), ownership.worktree)).rejects.toThrow(
    /owned|registered/i
  )
  await expect(store.assertRepositoryTargetAvailable(squadId, streamId, '/workspace/replacement')).rejects.toThrow(
    /owned|registered/i
  )
  await expect(
    store.assertRepositoryTargetAvailable(squadId, crypto.randomUUID(), '/workspace/unrelated')
  ).resolves.toBeUndefined()
})

test('exceptional blockers notify the owner once without exposing raw runtime errors', async () => {
  const { processWorktreeCleanup } = await import('./worktree-cleanup-reconciler')
  const { inbox } = await import('../../db')
  await db.update(workStreams).set({ ownerAgentId: agentId }).where(eq(workStreams.id, streamId))
  const dependencies = {
    execForSquad: async () => async () => '',
    verify: async () => {
      throw Error('private remote credential output')
    },
  }
  await processWorktreeCleanup(streamId, dependencies)
  await processWorktreeCleanup(streamId, dependencies)
  const messages = await db.select().from(inbox).where(eq(inbox.recipientId, agentId))
  expect(messages).toHaveLength(1)
  expect(messages[0].content).toContain('No removal was dispatched')
  expect(messages[0].content).not.toContain('credential')
})

test('attached evidence and historical missing ownership both fail closed', async () => {
  await db
    .update(workStreams)
    .set({ files: [{ name: 'custody evidence', path: '/fixture/evidence' }] })
    .where(eq(workStreams.id, streamId))
  expect(await claim()).toBeNull()
  await db.update(workStreams).set({ files: [] }).where(eq(workStreams.id, streamId))
  await db.delete(workStreamWorktrees).where(eq(workStreamWorktrees.workStreamId, streamId))
  expect(await claim()).toBeNull()
  const [job] = await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId))
  expect(job).toMatchObject({ status: 'skipped', operationId: null })
})

test('another stream using the owned tree as its source repository prevents removal', async () => {
  await db.insert(workStreams).values({
    squadId,
    title: 'uses owned source',
    metadata: { git: { repository: ownership.worktree, worktree: '/workspace/other' } },
  })
  expect(await claim()).toBeNull()
})

test('provisioning rejects a registered worktree as source but allows its shared primary repository', async () => {
  await expect(
    store.assertRepositoryTargetAvailable(squadId, crypto.randomUUID(), '/workspace/new', ownership.worktree)
  ).rejects.toThrow(/owned|registered/i)
  await expect(
    store.assertRepositoryTargetAvailable(squadId, crypto.randomUUID(), '/workspace/new', ownership.repository)
  ).resolves.toBeUndefined()
})

test('stale or newly attached canonical observations cannot authorize deletion', async () => {
  const [other] = await db
    .insert(workStreams)
    .values({ squadId, title: 'new binding', metadata: { git: { worktree: '/workspace/alias' } } })
    .returning()
  const attachments = [
    { id: other.id, raw: { worktree: '/workspace/earlier' }, canonical: { worktree: '/workspace/unrelated' } },
  ]
  expect(
    await store.claimWorktreeCleanup(streamId, {
      generation: (
        await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId))
      )[0]!.generation,
      ownership,
      head,
      metadata,
      attachments,
    })
  ).toBeNull()
  expect(
    await store.claimWorktreeCleanup(streamId, {
      generation: (
        await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId))
      )[0]!.generation,
      ownership,
      head,
      metadata,
      attachments: [],
    })
  ).toBeNull()
})

test('a stale attachment writer cannot bypass a newly claimed resource fence', async () => {
  await claim()
  const input = {
    id: crypto.randomUUID(),
    squadId,
    metadata: { git: { worktree: '/workspace/new-alias' } },
    dependsOn: [],
  }
  await expect(store.assertWorktreeAttachmentsAvailable(db, input)).rejects.toThrow(/identity|resolved/i)
  await expect(
    store.assertWorktreeAttachmentsAvailable(db, {
      ...input,
      resolved: { id: input.id, raw: { worktree: '/workspace/old' }, canonical: { worktree: '/workspace/unrelated' } },
    })
  ).rejects.toThrow(/identity|changed/i)
})

test('retention-only changes remain available offline despite unrelated reclaimed worktrees', async () => {
  const { WorkStream } = await import('../../entities/WorkStream')
  const ensure = await import('../sandbox/ensure')
  await claim()
  await db
    .update(worktreeCleanupJobs)
    .set({ status: 'succeeded' })
    .where(eq(worktreeCleanupJobs.workStreamId, streamId))
  const [other] = await db
    .insert(workStreams)
    .values({
      squadId,
      title: 'retain offline',
      autoCleanupWorktree: true,
      metadata: { git: { worktree: '/workspace/unrelated' } },
    })
    .returning()
  const unavailable = spyOn(ensure, 'ensureSquadSandbox').mockRejectedValue(Error('offline'))
  try {
    await (await WorkStream.mustFind(other.id)).update({ autoCleanupWorktree: false })
    expect((await WorkStream.mustFind(other.id)).autoCleanupWorktree).toBe(false)
    expect(unavailable).not.toHaveBeenCalled()
  } finally {
    unavailable.mockRestore()
  }
})

for (const input of [
  { worktree: '/workspace/duplicate' },
  { branch: 'duplicate' },
  { metadata: { git: { repository: '/workspace/other' } } },
  { metadata: { git: { worktree: '/workspace/duplicate', branch: 'duplicate' } } },
  { metadata: { git: null } },
]) {
  test(`owned bindings cannot be silently overwritten: ${JSON.stringify(input)}`, async () => {
    const { WorkStream } = await import('../../entities/WorkStream')
    await expect((await WorkStream.mustFind(streamId)).update(input)).rejects.toThrow('platform-owned')
    expect((await WorkStream.mustFind(streamId)).metadata).toEqual(metadata)
  })
}

test('historical mismatches can be retained after delivery without rewriting ownership or delivery evidence', async () => {
  const { WorkStream } = await import('../../entities/WorkStream')
  const divergent = { ...metadata, git: { ...metadata.git, worktree: '/workspace/manual', branch: 'manual' } }
  await db.update(workStreams).set({ metadata: divergent }).where(eq(workStreams.id, streamId))
  await db.update(worktreeCleanupJobs).set({ status: 'deferred' }).where(eq(worktreeCleanupJobs.workStreamId, streamId))
  const before = await db.select().from(workStreamWorktrees).where(eq(workStreamWorktrees.workStreamId, streamId))
  const oldJob = (await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId)))[0]!
  const stream = await WorkStream.mustFind(streamId)
  await stream.update({ autoCleanupWorktree: false })
  expect(stream.status).toBe('done')
  expect(stream.metadata).toMatchObject(divergent)
  const job = (await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId)))[0]!
  expect(job).toMatchObject({ status: 'skipped', operationId: null, deliveryMetadata: oldJob.deliveryMetadata })
  expect(job.generation).not.toBe(oldJob.generation)
  expect(await db.select().from(workStreamWorktrees).where(eq(workStreamWorktrees.workStreamId, streamId))).toEqual(
    before
  )
  expect(
    await store.claimWorktreeCleanup(streamId, { generation: oldJob.generation, ownership, head, metadata })
  ).toBeNull()
  await stream.update({ metadata: { audit: 'Retained for manual inspection' } })
  expect(stream.metadata.git).toEqual(divergent.git)
})

test('retain and cleanup claim serialize: no successful retain can leave an in-flight removal', async () => {
  const { WorkStream } = await import('../../entities/WorkStream')
  const stream = await WorkStream.mustFind(streamId)
  const [retention, removal] = await Promise.allSettled([stream.update({ autoCleanupWorktree: false }), claim()])
  const job = (await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId)))[0]!
  if (retention.status === 'fulfilled') {
    expect(job.status).toBe('skipped')
    expect(job.operationId).toBeNull()
    expect(removal).toMatchObject({ status: 'fulfilled', value: null })
  } else {
    expect(String(retention.reason)).toContain('pending terminal proof')
    expect(job.status).toBe('removing')
    expect(removal.status === 'fulfilled' && removal.value).toBeTruthy()
  }
})

const dependent = async (status: 'done' | 'canceled' | 'active' | 'queued' = 'done') =>
  (
    await db
      .insert(workStreams)
      .values({ squadId, title: 'dependent', status, dependsOn: [streamId] })
      .returning()
  )[0]!

for (const status of ['done', 'canceled'] as const) {
  test(`settled ${status} dependent releases cleanup without deleting its dependency record`, async () => {
    const other = await dependent(status)
    await db.insert(executions).values({
      agentId,
      status: 'completed',
      flowContext: { workStreamId: other.id, attemptId: 1, stepId: 'implement' },
    })
    expect(await claim()).not.toBeNull()
    expect((await db.select().from(workStreams).where(eq(workStreams.id, other.id)))[0]!.dependsOn).toEqual([streamId])
  })

  for (const executionStatus of ACTIVE_EXECUTION_STATUSES) {
    test(`${status} dependent with ${executionStatus} execution protects cleanup until settlement`, async () => {
      const other = await dependent(status)
      // No assignment or binding: immutable flow provenance must still protect use.
      await db.update(workStreams).set({ agentIds: [] }).where(eq(workStreams.id, streamId))
      const [execution] = await db
        .insert(executions)
        .values({
          agentId,
          status: executionStatus,
          flowContext: { workStreamId: other.id, attemptId: 1, stepId: 'implement' },
        })
        .returning()
      expect(await claim()).toBeNull()
      await db.update(executions).set({ status: 'stopped' }).where(eq(executions.id, execution.id))
      expect(await claim()).not.toBeNull()
    })
  }
}

for (const kind of ['active', 'queued', 'paused', 'parked', 'external-wait'] as const) {
  test(`${kind} dependent continues to protect cleanup`, async () => {
    const other = await dependent(kind === 'queued' || kind === 'parked' ? 'queued' : 'active')
    if (kind === 'paused' || kind === 'parked')
      await db
        .update(workStreams)
        .set({
          pause: {
            id: crypto.randomUUID(),
            pausedAt: new Date().toISOString(),
            reason: null,
            parkAt: null,
            agentIds: [],
          },
        })
        .where(eq(workStreams.id, other.id))
    if (kind === 'external-wait') await openWait(db, { workStreamId: other.id, type: 'manual', actor: 'owner' })
    expect(await claim()).toBeNull()
  })
}

for (const association of ['assignee', 'crew', 'binding', 'origin'] as const) {
  test(`terminal dependent ${association} remains execution-fenced after removal is claimed`, async () => {
    await db.update(workStreams).set({ agentIds: [] }).where(eq(workStreams.id, streamId))
    const other = await dependent()
    if (association === 'assignee' || association === 'crew')
      await db
        .update(workStreams)
        .set(association === 'assignee' ? { assigneeAgentId: agentId } : { agentIds: [agentId] })
        .where(eq(workStreams.id, other.id))
    if (association === 'binding') {
      const [snapshot] = await db.select().from(agentTypes).where(eq(agentTypes.id, typeId))
      await db.insert(workflowBindings).values({
        workStreamId: other.id,
        agentId,
        participantId: 'engineer',
        bindingKey: 'main',
        agentSnapshot: snapshot!,
      })
    }
    if (association === 'origin')
      await db.insert(executions).values({
        agentId,
        status: 'completed',
        flowContext: { workStreamId: other.id, attemptId: 1, stepId: 'implement' },
      })
    const [running] = await db.insert(executions).values({ agentId, status: 'running' }).returning()
    expect(await claim()).toBeNull()
    await db.update(executions).set({ status: 'completed' }).where(eq(executions.id, running.id))
    expect(await claim()).not.toBeNull()
    expect(await store.cleanupWorktreeForAgent(agentId)).toBe(streamId)
  })
}

for (const unsettled of ['attempt', 'pending-start'] as const) {
  test(`terminal dependent with an unsettled ${unsettled} retains protection`, async () => {
    const other = await dependent('canceled')
    const { definition } = workflowPresetSchema.parse(
      Bun.YAML.parse(
        await Bun.file(new URL('../../../../../config/workflows/solo-coding.yaml', import.meta.url)).text()
      )
    )
    const source = resolveWorkflow({ kind: 'inline', definition })
    const state = createWorkflowRun(definition)
    if (unsettled === 'pending-start') {
      state.attempts[0]!.status = 'canceled'
      state.activeAttemptId = null
      state.pendingStarts = [{ stepId: 'implement' }]
    }
    await db.insert(workStreamFlowRuns).values({
      workStreamId: other.id,
      createRequestId: crypto.randomUUID(),
      createRequestHash: 'a'.repeat(64),
      source,
      state,
      createdBy: 'fixture',
    })
    expect(await claim()).toBeNull()
    state.attempts[0]!.status = 'canceled'
    state.activeAttemptId = null
    state.pendingStarts = []
    await db.update(workStreamFlowRuns).set({ state }).where(eq(workStreamFlowRuns.workStreamId, other.id))
    expect(await claim()).not.toBeNull()
  })
}

test('multiple dependents release protection only after the last live one settles', async () => {
  await dependent('done')
  const last = await dependent('active')
  await db.insert(workStreams).values({ squadId, title: 'unrelated live stream', status: 'active' })
  expect(await claim()).toBeNull()
  await db.update(workStreams).set({ status: 'canceled' }).where(eq(workStreams.id, last.id))
  expect(await claim()).not.toBeNull()
})

for (const key of ['worktree', 'repository'] as const) {
  test(`settled dependency does not release explicit ${key} sharing`, async () => {
    const other = await dependent()
    await db
      .update(workStreams)
      .set({ metadata: { git: { [key]: ownership.worktree } } })
      .where(eq(workStreams.id, other.id))
    expect(await claim()).toBeNull()
  })
}

test('another squad cannot retain this resource through a dependency', async () => {
  const [otherSquad] = await db.insert(squads).values({ name: 'isolated-cleanup-squad', purpose: 'test' }).returning()
  try {
    await db.insert(workStreams).values({ squadId: otherSquad.id, title: 'foreign dependency', dependsOn: [streamId] })
    expect(await claim()).not.toBeNull()
  } finally {
    await db.delete(workStreams).where(eq(workStreams.squadId, otherSquad.id))
    await db.delete(squads).where(eq(squads.id, otherSquad.id))
  }
})

test('a settled dependent cannot reopen during an uncertain predecessor removal', async () => {
  const { WorkStream } = await import('../../entities/WorkStream')
  const other = await dependent()
  expect(await claim()).not.toBeNull()
  await expect((await WorkStream.mustFind(other.id)).reopen()).rejects.toThrow(/cleanup|removal/i)
  expect((await WorkStream.mustFind(other.id)).status).toBe('done')
})

for (const action of ['unlink', 'delete'] as const) {
  test(`a dependent cannot ${action} to evade an uncertain removal fence`, async () => {
    const { WorkStream } = await import('../../entities/WorkStream')
    const other = await dependent()
    expect(await claim()).not.toBeNull()
    const stream = await WorkStream.mustFind(other.id)
    await expect(action === 'unlink' ? stream.update({ dependsOn: [] }) : stream.delete()).rejects.toThrow(
      /cleanup|removal/i
    )
    expect((await WorkStream.mustFind(other.id)).dependsOn).toEqual([streamId])
  })
}

test('reopen and claim serialize: a live dependent always wins or sees the removal fence', async () => {
  const { WorkStream } = await import('../../entities/WorkStream')
  const other = await dependent()
  const stream = await WorkStream.mustFind(other.id)
  const [reopening, removal] = await Promise.allSettled([stream.reopen(), claim()])
  if (reopening.status === 'fulfilled') {
    expect(['active', 'queued']).toContain((await WorkStream.mustFind(other.id)).status)
    expect(removal).toMatchObject({ status: 'fulfilled', value: null })
  } else {
    expect(String(reopening.reason)).toMatch(/cleanup|removal/i)
    expect(removal.status === 'fulfilled' && removal.value).toBeTruthy()
    expect((await WorkStream.mustFind(other.id)).status).toBe('done')
  }
})

test('dependent fences retain uncertain errors but release after terminal removal proof', async () => {
  const { WorkStream } = await import('../../entities/WorkStream')
  await db.update(workStreams).set({ agentIds: [] }).where(eq(workStreams.id, streamId))
  const other = await dependent()
  await db
    .update(workStreams)
    .set({ agentIds: [agentId] })
    .where(eq(workStreams.id, other.id))
  expect(await claim()).not.toBeNull()
  await db.update(worktreeCleanupJobs).set({ status: 'error' }).where(eq(worktreeCleanupJobs.workStreamId, streamId))
  expect(await store.cleanupWorktreeForAgent(agentId)).toBe(streamId)
  await expect((await WorkStream.mustFind(other.id)).reopen()).rejects.toThrow(/cleanup|removal/i)
  await db
    .update(worktreeCleanupJobs)
    .set({ status: 'succeeded' })
    .where(eq(worktreeCleanupJobs.workStreamId, streamId))
  expect(await store.cleanupWorktreeForAgent(agentId)).toBeNull()
  // Dependency history is still valid; explicit sharing would need a new tree.
  await (await WorkStream.mustFind(other.id)).reopen()
  expect(['active', 'queued']).toContain((await WorkStream.mustFind(other.id)).status)
})

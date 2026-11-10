import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, like } from 'drizzle-orm'
import { type WorkflowDefinition, type WorkflowPreset, workflowPresetSchema } from '@ficus/shared'
import {
  agentTypes,
  db,
  modelTiers,
  squads,
  workStreams,
  workStreamFlowRuns,
  workStreamFlowTransitions,
  workflows,
} from '../../db'
import { WorkflowSync } from '../config-sync/workflow-sync'
import {
  createWorkflow,
  deleteWorkflow,
  replaceWorkflow,
  resolveStoredWorkflow,
  previewWorkflowRestore,
  revertWorkflow,
  serializeWorkflow,
  setWorkflowDisabled,
  workflowTemplateDifferences,
  workflowFingerprint,
  workflowRevision,
} from './catalog'
import { persistWorkflowTransition, prepareWorkStreamFlow } from './store'
import { describeWorkflowTemplateHold } from './template-hold'

const prefix = `workflow-${randomUUID()}`
const workerType = `${prefix}-workerType`
const tier = `${prefix}-tier`
const sync = new WorkflowSync()
let definition: WorkflowDefinition
let squadId: string
const identity = () => ({ requestId: randomUUID(), actorKey: 'test-owner' })
const preset = (suffix: string): WorkflowPreset => ({
  id: `${prefix}-${suffix}`,
  definition: structuredClone(definition),
})
async function stream() {
  const [row] = await db.insert(workStreams).values({ squadId, title: 'Flow fixture', status: 'queued' }).returning()
  return row!.id
}
async function readRun(id: string) {
  const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))
  return run!
}
const complete = (expectedVersion = 0, attemptId = 1) => ({
  expectedVersion,
  attemptId,
  action: 'complete',
  outcome: 'completed',
  evidence: 'Verified deliverable.',
})

beforeAll(async () => {
  definition = sync.parse(
    await Bun.file(new URL('../../../../../config/workflows/solo.yaml', import.meta.url)).text()
  ).definition
  definition.participants.worker!.agentTypeId = workerType
  await db.insert(agentTypes).values({ id: workerType, name: 'Test worker', model: '', systemPrompt: 'Test.' })
  await db.insert(modelTiers).values({ slug: tier, label: 'Test tier', chain: 'anthropic:claude-test' })
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Workflow tests' }).returning()
  squadId = squad!.id
})
afterAll(async () => {
  if (squadId) await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(workflows).where(like(workflows.id, `${prefix}%`))
  await db.delete(agentTypes).where(eq(agentTypes.id, workerType))
  await db.delete(modelTiers).where(eq(modelTiers.slug, tier))
})

describe('workflow catalog', () => {
  test('custom system-only types cannot be published or resolved as flow workers', async () => {
    const value = preset('system-only')
    await db.update(agentTypes).set({ systemOnly: true }).where(eq(agentTypes.id, workerType))
    try {
      await expect(createWorkflow(value)).rejects.toThrow('system-only')
      await expect(resolveStoredWorkflow({ kind: 'inline', definition: value.definition })).rejects.toThrow(
        'system-only'
      )
    } finally {
      await db.update(agentTypes).set({ systemOnly: false }).where(eq(agentTypes.id, workerType))
    }
    await expect(createWorkflow(value)).resolves.toMatchObject({ id: value.id })
  })
  test('revision survives JSON key ordering and excludes timestamps', async () => {
    expect(workflowFingerprint({ b: { z: 1, a: 2 }, a: [1, 2] })).toBe(
      workflowFingerprint({ a: [1, 2], b: { a: 2, z: 1 } })
    )
    const row = await createWorkflow(preset('revision'))
    expect(workflowRevision({ ...row, updatedAt: new Date(0) })).toBe(workflowRevision(row))
    expect(workflowRevision({ ...row, disabled: true })).not.toBe(workflowRevision(row))
  })
  test('duplicate creates and competing edits have exactly one winner', async () => {
    const value = preset('race')
    const created = await Promise.allSettled([createWorkflow(value), createWorkflow(value)])
    expect(created.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const [row] = await db.select().from(workflows).where(eq(workflows.id, value.id))
    const edits = await Promise.allSettled(
      ['First', 'Second'].map((description) =>
        replaceWorkflow(value.id, workflowRevision(row!), { ...value, description })
      )
    )
    expect(edits.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(edits.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
  })
  test('resolution rejects absent/disabled agent types, unavailable tiers, unknown customizations, disabled and stale presets', async () => {
    const value = preset('validation')
    const row = await createWorkflow(value)
    await expect(resolveStoredWorkflow({ kind: 'preset', id: row.id, revision: 'old' })).rejects.toMatchObject({
      status: 409,
    })
    await expect(
      resolveStoredWorkflow({ kind: 'preset', id: row.id, customizations: [{ op: 'remove-step', id: 'missing' }] })
    ).rejects.toMatchObject({ status: 400 })
    const invalid = structuredClone(value)
    invalid.definition.participants.worker!.agentTypeId = `${prefix}-missing`
    await expect(createWorkflow(invalid)).rejects.toThrow('does not exist')
    invalid.definition.participants.worker!.agentTypeId = workerType
    invalid.definition.participants.worker!.tier = `${prefix}-missing-tier`
    await expect(resolveStoredWorkflow({ kind: 'inline', definition: invalid.definition })).rejects.toThrow()
    const disabled = await setWorkflowDisabled(row.id, workflowRevision(row), true)
    await expect(resolveStoredWorkflow({ kind: 'preset', id: row.id })).rejects.toThrow('disabled')
    await db.update(agentTypes).set({ disabled: true }).where(eq(agentTypes.id, workerType))
    try {
      await expect(setWorkflowDisabled(row.id, workflowRevision(disabled), false)).rejects.toThrow('disabled')
    } finally {
      await db.update(agentTypes).set({ disabled: false }).where(eq(agentTypes.id, workerType))
    }
  })
  test('YAML reload preserves whole-definition overrides and reverts against the current template', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ficus-workflow-config-'))
    class FixtureSync extends WorkflowSync {
      override readonly directory = directory
    }
    const fixture = new FixtureSync()
    const value = preset('yaml')
    // Include any preexisting templates so this fixture does not remove another test's records.
    const existing = await db.select().from(workflows)
    for (const row of existing)
      if (row.yamlTemplate)
        await Bun.write(join(directory, `${row.id}.yaml`), sync.toYaml(row.yamlTemplate as Record<string, unknown>))
    try {
      await Bun.write(join(directory, 'fixture.yaml'), fixture.toYaml(value))
      await fixture.sync()
      const [row] = await db.select().from(workflows).where(eq(workflows.id, value.id))
      const custom = structuredClone(value)
      custom.definition.name = 'Custom workflow'
      const edited = await replaceWorkflow(value.id, workflowRevision(row!), custom)
      expect(edited.yamlFieldOverrides).toEqual(['definition'])
      value.definition.name = 'New template workflow'
      value.description = 'New upstream description'
      await Bun.write(join(directory, 'fixture.yaml'), fixture.toYaml(value))
      await fixture.sync()
      const [reloaded] = await db.select().from(workflows).where(eq(workflows.id, value.id))
      expect(reloaded!.definition.name).toBe('Custom workflow')
      expect(reloaded!.description).toBe(value.description)
      expect((await fixture.getTemplateDiff(value.id)).hasDrift).toBe(true)
      await expect(deleteWorkflow(value.id, workflowRevision(reloaded!))).rejects.toThrow('Disable')
      const reverted = await revertWorkflow(value.id, workflowRevision(reloaded!))
      expect(reverted.definition.name).toBe('New template workflow')
      expect(reverted.yamlFieldOverrides).toEqual([])
      expect(fixture.parse(fixture.toYaml(reverted))).toEqual(workflowPresetSchema.parse(value))
      expect(() => fixture.parse('id: broken\ndefinition: {}')).toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  test('a local tier edit no longer holds back code updates to the rest of the preset', async () => {
    await withFixtureSync(async (fixture, write) => {
      const value = preset('merge')
      await write(value)
      const [row] = await db.select().from(workflows).where(eq(workflows.id, value.id))
      const custom = structuredClone(value)
      custom.definition.participants.worker!.tier = tier
      const edited = await replaceWorkflow(value.id, workflowRevision(row!), custom)
      expect(edited.yamlFieldOverrides).toEqual(['definition'])

      // The code renames the step and rewrites its instructions; the tier edit must survive.
      const update = structuredClone(value)
      update.definition.entry = 'implement'
      update.definition.steps[0]!.id = 'implement'
      update.definition.steps[0]!.instructions = 'Upstream instructions.'
      await write(update)
      const [merged] = await db.select().from(workflows).where(eq(workflows.id, value.id))
      expect(merged!.definition.participants.worker!.tier).toBe(tier)
      expect(merged!.definition.entry).toBe('implement')
      expect(merged!.definition.steps.map((step) => step.id)).toEqual(['implement'])
      expect(merged!.definition.steps[0]!.instructions).toBe('Upstream instructions.')
      expect(workflowTemplateDifferences(merged!).map((item) => item.path)).toEqual([
        'definition/participants/worker/tier',
      ])
      expect(merged!.yamlFieldOverrides).toEqual(['definition'])

      // Restoring only the tier clears the drift.
      const restored = await revertWorkflow(value.id, workflowRevision(merged!), {
        paths: ['definition/participants/worker/tier'],
      })
      expect(restored.definition.participants.worker!.tier).toBeUndefined()
      expect(restored.yamlFieldOverrides).toEqual([])
    })
  })
  test('code updates and restores that break a squad customization are held back or need confirmation', async () => {
    await withFixtureSync(async (fixture, write) => {
      const value = preset('impact')
      await write(value)
      const [squad] = await db
        .insert(squads)
        .values({
          name: `${prefix} customizer`,
          purpose: 'Customizes a step',
          metadata: {
            workflow: {
              kind: 'preset',
              id: value.id,
              customizations: [{ op: 'update-step', id: 'execute', changes: { instructions: 'Ours.' } }],
            },
          },
        })
        .returning()
      try {
        const update = structuredClone(value)
        update.definition.entry = 'implement'
        update.definition.steps[0]!.id = 'implement'
        await write(update)
        const [held] = await db.select().from(workflows).where(eq(workflows.id, value.id))
        expect(held!.definition.steps.map((step) => step.id)).toEqual(['execute'])
        expect(held!.yamlFieldOverrides).toEqual(['definition'])
        expect((await fixture.getTemplateDiff(value.id)).hasDrift).toBe(true)

        const visible = await previewWorkflowRestore(value.id, { canSeeSquad: (id) => id === squad!.id })
        expect(visible.affectedSquads).toEqual([
          { squadId: squad!.id, squadName: `${prefix} customizer`, problems: ["Unknown step 'execute'"] },
        ])
        expect(visible.hiddenSquadCount).toBe(0)
        const hidden = await previewWorkflowRestore(value.id)
        expect(hidden).toMatchObject({ affectedSquads: [], hiddenSquadCount: 1 })

        const refusal = revertWorkflow(value.id, workflowRevision(held!), { canSeeSquad: () => true })
        await expect(refusal).rejects.toMatchObject({ status: 409, code: 'WORKFLOW_RESTORE_BREAKS_SQUADS' })
        await expect(refusal).rejects.toThrow(`${prefix} customizer`)
        const unchanged = await db.select().from(workflows).where(eq(workflows.id, value.id))
        expect(unchanged[0]!.definition.steps[0]!.id).toBe('execute')

        const restored = await revertWorkflow(value.id, workflowRevision(held!), { acknowledgeSquadImpact: true })
        expect(restored.definition.steps[0]!.id).toBe('implement')
        expect(restored.yamlFieldOverrides).toEqual([])
      } finally {
        await db.delete(squads).where(eq(squads.id, squad!.id))
      }
    })
  })
  describe('held-back code updates', () => {
    const customizing = (presetId: string, stepId = 'execute') => ({
      workflow: {
        kind: 'preset',
        id: presetId,
        customizations: [{ op: 'update-step', id: stepId, changes: { instructions: 'Ours.' } }],
      },
    })
    async function read(id: string) {
      const [row] = await db.select().from(workflows).where(eq(workflows.id, id))
      return row!
    }
    /** A preset whose code update renames step execute to implement, held back by one squad. */
    async function heldPreset(suffix: string, write: (value: WorkflowPreset) => Promise<void>) {
      const value = preset(suffix)
      await write(value)
      const [squad] = await db
        .insert(squads)
        .values({ name: `${prefix} ${suffix}`, purpose: 'Customizes a step', metadata: customizing(value.id) })
        .returning()
      const update = structuredClone(value)
      update.definition.entry = 'implement'
      update.definition.steps[0]!.id = 'implement'
      update.definition.steps[0]!.instructions = 'Renamed upstream.'
      update.definition.name = 'Upstream name'
      update.description = 'Upstream description'
      await write(update)
      return { value, update, squad: squad! }
    }

    test('a held-back update stays held and visible, and re-syncs are idempotent', async () => {
      await withFixtureSync(async (_fixture, write) => {
        const { value, update, squad } = await heldPreset('held-stays', write)
        try {
          const held = await read(value.id)
          expect(held.definition.steps.map((step) => step.id)).toEqual(['execute'])
          expect(held.description).toBe('Upstream description')
          expect(held.yamlTemplateHold).toMatchObject({ base: { definition: value.definition } })
          expect(serializeWorkflow(held).templateHeldBack).toBe(true)

          await write(update)
          const again = await read(value.id)
          expect(again.definition).toEqual(held.definition)
          expect(again.description).toBe(held.description)
          expect(again.yamlTemplateHold).toEqual(held.yamlTemplateHold)
          expect(again.yamlFieldOverrides).toEqual(['definition'])

          const view = await describeWorkflowTemplateHold(again, () => true)
          expect(view).toMatchObject({
            heldAt: held.yamlTemplateHold!.heldAt,
            blockedBy: 'squad-customizations',
            affectedSquads: [{ squadId: squad.id, problems: ["Unknown step 'execute'"] }],
            hiddenSquadCount: 0,
          })
          expect(view!.parts.map((part) => part.path)).toEqual(
            expect.arrayContaining(['definition/entry', 'definition/steps/execute', 'definition/steps/implement'])
          )
          expect(await describeWorkflowTemplateHold(again, () => false)).toMatchObject({
            affectedSquads: [],
            hiddenSquadCount: 1,
          })
        } finally {
          await db.delete(squads).where(eq(squads.id, squad.id))
        }
      })
    })

    test('a held-back update applies on a later sync once no squad depends on the old IDs', async () => {
      await withFixtureSync(async (_fixture, write) => {
        const { value, update, squad } = await heldPreset('held-applies', write)
        try {
          await db.update(squads).set({ metadata: {} }).where(eq(squads.id, squad.id))
          const unblocked = await describeWorkflowTemplateHold(await read(value.id), () => true)
          expect(unblocked).toMatchObject({ blockedBy: null, affectedSquads: [], hiddenSquadCount: 0 })

          await write(update)
          const applied = await read(value.id)
          expect(applied.definition).toEqual(update.definition)
          expect(applied.yamlTemplateHold).toBeNull()
          expect(applied.yamlFieldOverrides).toEqual([])
          expect(workflowTemplateDifferences(applied)).toEqual([])
        } finally {
          await db.delete(squads).where(eq(squads.id, squad.id))
        }
      })
    })

    test('a later code change to a held-back part is not treated as a local edit, and local edits still win', async () => {
      await withFixtureSync(async (_fixture, write) => {
        const { value, update, squad } = await heldPreset('held-later', write)
        try {
          // A local tier edit made while the update is held back.
          const held = await read(value.id)
          const custom = { id: value.id, description: held.description ?? undefined, definition: held.definition }
          custom.definition = structuredClone(custom.definition)
          custom.definition.participants.worker!.tier = tier
          await replaceWorkflow(value.id, workflowRevision(held), custom)

          // The code changes the held-back step again.
          const newer = structuredClone(update)
          newer.definition.steps[0]!.instructions = 'Changed again upstream.'
          await write(newer)
          const stillHeld = await read(value.id)
          expect(stillHeld.definition.steps.map((step) => step.id)).toEqual(['execute'])
          expect(stillHeld.yamlTemplateHold!.heldAt).toBe(held.yamlTemplateHold!.heldAt)

          await db.update(squads).set({ metadata: {} }).where(eq(squads.id, squad.id))
          await write(newer)
          const applied = await read(value.id)
          expect(applied.definition.steps.map((step) => step.id)).toEqual(['implement'])
          expect(applied.definition.steps[0]!.instructions).toBe('Changed again upstream.')
          expect(applied.definition.participants.worker!.tier).toBe(tier)
          expect(applied.yamlTemplateHold).toBeNull()
          expect(workflowTemplateDifferences(applied).map((item) => item.path)).toEqual([
            'definition/participants/worker/tier',
          ])
        } finally {
          await db.delete(squads).where(eq(squads.id, squad.id))
        }
      })
    })

    test('restoring held-back parts moves the merge base, and a full restore clears the hold', async () => {
      await withFixtureSync(async (_fixture, write) => {
        const { value, update, squad } = await heldPreset('held-restore', write)
        try {
          // Restoring only the name keeps the rename held back; the name now follows the template.
          const held = await read(value.id)
          const partial = await revertWorkflow(value.id, workflowRevision(held), { paths: ['definition/name'] })
          expect(partial.definition.name).toBe('Upstream name')
          expect(partial.definition.steps.map((step) => step.id)).toEqual(['execute'])
          expect(partial.yamlTemplateHold).toMatchObject({
            heldAt: held.yamlTemplateHold!.heldAt,
            base: { definition: { name: 'Upstream name', entry: 'execute' } },
          })

          // A later code change to the restored name is a code change, not a conflict with a local edit.
          const newer = structuredClone(update)
          newer.definition.name = 'Newest name'
          await db.update(squads).set({ metadata: {} }).where(eq(squads.id, squad.id))
          await write(newer)
          const applied = await read(value.id)
          expect(applied.definition).toEqual(newer.definition)
          expect(applied.yamlTemplateHold).toBeNull()

          // A full restore leaves nothing held back.
          await db
            .update(squads)
            .set({ metadata: customizing(value.id, 'implement') })
            .where(eq(squads.id, squad.id))
          const renamed = structuredClone(newer)
          renamed.definition.entry = 'build'
          renamed.definition.steps[0]!.id = 'build'
          await write(renamed)
          const heldAgain = await read(value.id)
          expect(heldAgain.yamlTemplateHold).not.toBeNull()
          const restored = await revertWorkflow(value.id, workflowRevision(heldAgain), { acknowledgeSquadImpact: true })
          expect(restored.definition).toEqual(renamed.definition)
          expect(restored.yamlTemplateHold).toBeNull()
        } finally {
          await db.delete(squads).where(eq(squads.id, squad.id))
        }
      })
    })
  })
})

/**
 * Runs a WorkflowSync over a scratch directory. `write` saves the preset as the only fixture
 * file and syncs. Existing templates are copied in so the sync does not remove other records.
 */
async function withFixtureSync(
  body: (fixture: WorkflowSync, write: (value: WorkflowPreset) => Promise<void>) => Promise<void>
) {
  const directory = await mkdtemp(join(tmpdir(), 'ficus-workflow-config-'))
  class FixtureSync extends WorkflowSync {
    override readonly directory = directory
  }
  const fixture = new FixtureSync()
  const existing = await db.select().from(workflows)
  for (const row of existing)
    if (row.yamlTemplate)
      await Bun.write(join(directory, `${row.id}.yaml`), sync.toYaml(row.yamlTemplate as Record<string, unknown>))
  try {
    await body(fixture, async (value) => {
      await Bun.write(join(directory, `${value.id}.yaml`), fixture.toYaml(value))
      await fixture.sync()
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('durable prepared flow storage', () => {
  test('inline flow is durable without publishing a catalog entry; preparation retries are idempotent', async () => {
    const id = await stream()
    const source = { kind: 'inline', definition }
    const request = identity()
    const before = await db.select().from(workflows)
    const [a, b] = await Promise.all([
      prepareWorkStreamFlow(id, source, request),
      prepareWorkStreamFlow(id, source, request),
    ])
    expect(a).toEqual(b)
    expect((await readRun(id)).source.definition).toEqual(definition)
    expect(await db.select().from(workflows)).toHaveLength(before.length)
    await expect(prepareWorkStreamFlow(id, source, identity())).rejects.toMatchObject({ status: 409 })
    await expect(prepareWorkStreamFlow(id, source, { ...request, actorKey: 'different' })).rejects.toMatchObject({
      status: 409,
    })
  })
  test('running snapshot survives preset editing and deletion', async () => {
    const row = await createWorkflow(preset('snapshot'))
    const id = await stream()
    await prepareWorkStreamFlow(id, { kind: 'preset', id: row.id, revision: workflowRevision(row) }, identity())
    const edited = await replaceWorkflow(row.id, workflowRevision(row), {
      id: row.id,
      definition: { ...definition, name: 'Replacement' },
    })
    await deleteWorkflow(row.id, workflowRevision(edited))
    const run = await readRun(id)
    expect(run.source.definition).toEqual(definition)
    expect(run.state.definition).toEqual(definition)
    expect(run.source.source).toMatchObject({ kind: 'preset', id: row.id, revision: workflowRevision(row) })
  })
  test('concurrent retry records one transition and never completes the work stream', async () => {
    const id = await stream()
    const run = await prepareWorkStreamFlow(id, { kind: 'inline', definition }, identity())
    const request = identity()
    const command = complete(run.version, run.state.activeAttemptId!)
    const results = await Promise.all([
      persistWorkflowTransition(id, command, request),
      persistWorkflowTransition(id, command, request),
    ])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({ version: 1, stateStatus: 'completion-ready' })
    expect(
      await db.select().from(workStreamFlowTransitions).where(eq(workStreamFlowTransitions.workStreamId, id))
    ).toHaveLength(1)
    expect((await readRun(id)).state.status).toBe('completion-ready')
    const [parent] = await db.select().from(workStreams).where(eq(workStreams.id, id))
    expect(parent!.status).toBe('queued')
    await expect(persistWorkflowTransition(id, { ...command, evidence: 'Changed' }, request)).rejects.toMatchObject({
      status: 409,
    })
    await expect(persistWorkflowTransition(id, command, identity())).rejects.toMatchObject({ status: 409 })
  })
  test('different commands racing on one version commit exactly once; failed commands roll back', async () => {
    const id = await stream()
    const run = await prepareWorkStreamFlow(id, { kind: 'inline', definition }, identity())
    const command = complete(0, run.state.activeAttemptId!)
    await expect(persistWorkflowTransition(id, { ...command, outcome: 'unknown' }, identity())).rejects.toThrow()
    expect((await readRun(id)).version).toBe(0)
    const results = await Promise.allSettled([
      persistWorkflowTransition(id, command, identity()),
      persistWorkflowTransition(id, { ...command, evidence: 'Other actor' }, identity()),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
  })
  test('return obligations survive reloads and old retries return their original receipt after later progress', async () => {
    const flow = sync.parse(
      await Bun.file(new URL('../../../../../config/workflows/builder-reviewer.yaml', import.meta.url)).text()
    ).definition
    // Exercise explicit direct-return persistence independently of the shipped preset default.
    flow.steps[1]!.outcomes['changes-requested'] = { returnTo: 'build', afterRework: 'return-to-requester' }
    for (const participant of Object.values(flow.participants)) participant.agentTypeId = workerType
    const id = await stream()
    const initial = await prepareWorkStreamFlow(id, { kind: 'inline', definition: flow }, identity())
    const request = identity()
    const firstCommand = complete(initial.version, initial.state.activeAttemptId!)
    const firstReceipt = await persistWorkflowTransition(id, firstCommand, request)
    async function advance(outcome: string) {
      const persisted = await readRun(id)
      await persistWorkflowTransition(
        id,
        { ...complete(persisted.version, persisted.state.activeAttemptId!), outcome },
        identity()
      )
      return (await readRun(id)).state
    }
    const returned = await advance('changes-requested')
    expect(returned.returns.map((entry) => entry.status)).toEqual(['open'])
    const rebuilt = await advance('completed')
    expect(rebuilt.returns[0]!.status).toBe('open')
    expect(await persistWorkflowTransition(id, firstCommand, request)).toEqual(firstReceipt)
    expect((await readRun(id)).version).toBe(3)
    const approved = await advance('approved')
    expect(approved.status).toBe('completion-ready')
    expect(approved.returns[0]!.status).toBe('resolved')
    expect(
      await db.select().from(workStreamFlowTransitions).where(eq(workStreamFlowTransitions.workStreamId, id))
    ).toHaveLength(4)
    await db.delete(workStreams).where(eq(workStreams.id, id))
    expect(
      await db.select().from(workStreamFlowTransitions).where(eq(workStreamFlowTransitions.workStreamId, id))
    ).toHaveLength(0)
    expect(await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))).toHaveLength(0)
  })
  test('cannot prepare active work or transition terminal work; parent deletion cleans history', async () => {
    const id = await stream()
    await db.update(workStreams).set({ status: 'active' }).where(eq(workStreams.id, id))
    await expect(prepareWorkStreamFlow(id, { kind: 'inline', definition }, identity())).rejects.toMatchObject({
      status: 409,
    })
    await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, id))
    const run = await prepareWorkStreamFlow(id, { kind: 'inline', definition }, identity())
    await db.update(workStreams).set({ status: 'canceled' }).where(eq(workStreams.id, id))
    await expect(persistWorkflowTransition(id, complete(0, run.state.activeAttemptId!), identity())).rejects.toThrow(
      'terminal'
    )
    await db.delete(workStreams).where(eq(workStreams.id, id))
    expect(await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))).toHaveLength(0)
    expect(
      await db.select().from(workStreamFlowTransitions).where(eq(workStreamFlowTransitions.workStreamId, id))
    ).toHaveLength(0)
  })
})

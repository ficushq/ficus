import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createBlankWorkflow } from '@ficus/shared'
import { db, agentTypes, agents, squads, squadPresets } from '../../db'
import { Squad } from '../../entities/Squad'
import { SquadPreset } from '../../entities/SquadPreset'

test('new squads inherit style recommendations without spawning participants, and explicit selections win', async () => {
  const id = `squad-styles-${randomUUID()}`
  const definition = createBlankWorkflow()
  definition.participants.worker!.agentTypeId = id
  const source = { kind: 'inline' as const, definition }
  const styles = {
    default: source,
    guidance: 'Use one worker for routine tasks.',
    choices: [{ when: 'Routine tasks', source }],
  }
  let created: Squad | undefined
  await db.insert(agentTypes).values({ id, name: 'Flow worker', model: 'openai:gpt-4.1', systemPrompt: 'Work.' })
  try {
    await SquadPreset.upsert({ id, name: 'Domain preset', defaultAgents: [], workflows: styles })
    const input = { name: id, purpose: 'Test recommendations', squadPresetId: id }
    const prepared = await Squad.prepareCreateInput(input)
    expect(prepared).toMatchObject({
      metadata: { workflow: source, workflowSetup: { guidance: styles.guidance, choices: styles.choices } },
    })
    const custom = { ...source, definition: { ...definition, name: 'Custom choice' } }
    const selected = await Squad.prepareCreateInput({ ...input, metadata: { workflow: custom, unrelated: true } })
    expect(selected.metadata.workflow).toEqual(custom)
    expect(selected.metadata.unrelated).toBe(true)
    created = await Squad.create(input)
    expect(created.metadata).toMatchObject({
      workflow: source,
      workflowSetup: { guidance: styles.guidance, choices: styles.choices },
    })
    const members = await db.select().from(agents).where(eq(agents.squadId, created.id))
    expect(members.map((member) => member.agentTypeId)).toEqual(['manager'])
    expect(members.some((member) => member.agentTypeId === id)).toBe(false)
    await SquadPreset.upsert({ id, name: 'Changed preset', workflows: { ...styles, default: custom } })
    expect((await Squad.mustFind(created.id)).metadata).toEqual(created.metadata)
  } finally {
    if (created) {
      await db.delete(agents).where(eq(agents.squadId, created.id))
      await db.delete(squads).where(eq(squads.id, created.id))
    }
    await db.delete(squadPresets).where(eq(squadPresets.id, id))
    await db.delete(agentTypes).where(eq(agentTypes.id, id))
    SquadPreset.invalidateCache()
  }
})

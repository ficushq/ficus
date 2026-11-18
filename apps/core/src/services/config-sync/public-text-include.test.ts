import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { agentTypes, db, sharedPrompts } from '../../db'
import { AgentType } from '../../entities/AgentType'
import { AgentTypeSync } from './agent-type-sync'
import { SharedPromptSync } from './shared-prompt-sync'
import { expandPublicTextInclude } from './public-text-include'

describe('expandPublicTextInclude', () => {
  test('adds public-text right after squad-rules', () => {
    expect(expandPublicTextInclude(['rules', 'squad-rules', 'slot-manager'])).toEqual([
      'rules',
      'squad-rules',
      'public-text',
      'slot-manager',
    ])
  })

  test('leaves a list alone when it already has public-text or has no squad-rules', () => {
    expect(expandPublicTextInclude(['squad-rules', 'public-text'])).toBeNull()
    expect(expandPublicTextInclude(['rules'])).toBeNull()
    expect(expandPublicTextInclude([])).toBeNull()
  })
})

/**
 * The "Public communication" section moved out of `squad-rules` into the
 * `public-text` include. Built-in types take the new lists from YAML; a custom
 * type or an overridden list gains `public-text` once, on the shared-prompt
 * sync that first stores it. Later admin edits are kept.
 */
describe('public-text include adoption', () => {
  const sharedPromptSync = new SharedPromptSync()
  const agentTypeSync = new AgentTypeSync()

  async function upgradeSync(): Promise<void> {
    await sharedPromptSync.sync()
    await agentTypeSync.sync()
    AgentType.invalidateCache()
  }

  test('runs once, on the sync that first stores public-text, and respects later edits', async () => {
    const customId = `custom-public-${crypto.randomUUID().slice(0, 8)}`
    const untouchedId = `custom-nosquad-${crypto.randomUUID().slice(0, 8)}`
    await upgradeSync()
    try {
      await db.delete(sharedPrompts).where(eq(sharedPrompts.id, 'public-text'))
      await db
        .update(agentTypes)
        .set({
          includes: ['entity-references', 'readable-text', 'rules', 'squad-rules'],
          yamlFieldOverrides: ['includes'],
        })
        .where(eq(agentTypes.id, 'engineer'))
      await db.insert(agentTypes).values([
        {
          id: customId,
          name: 'Custom public',
          model: '',
          systemPrompt: 'You are custom.',
          includes: ['readable-text', 'rules', 'squad-rules'],
        },
        { id: untouchedId, name: 'No squad rules', model: '', systemPrompt: 'You are custom.', includes: ['rules'] },
      ])

      await upgradeSync()
      const engineer = await AgentType.mustFind('engineer')
      expect(engineer.includes).toEqual(['entity-references', 'readable-text', 'rules', 'squad-rules', 'public-text'])
      const [custom] = await db.select().from(agentTypes).where(eq(agentTypes.id, customId))
      expect(custom.includes).toEqual(['readable-text', 'rules', 'squad-rules', 'public-text'])
      const [untouched] = await db.select().from(agentTypes).where(eq(agentTypes.id, untouchedId))
      expect(untouched.includes).toEqual(['rules'])

      // An admin later removes public-text on purpose; the next sync keeps that.
      await db
        .update(agentTypes)
        .set({ includes: ['readable-text', 'rules', 'squad-rules'] })
        .where(eq(agentTypes.id, customId))
      await upgradeSync()
      const [edited] = await db.select().from(agentTypes).where(eq(agentTypes.id, customId))
      expect(edited.includes).toEqual(['readable-text', 'rules', 'squad-rules'])
    } finally {
      await db.delete(agentTypes).where(eq(agentTypes.id, customId))
      await db.delete(agentTypes).where(eq(agentTypes.id, untouchedId))
      await agentTypeSync.revertToTemplate('engineer')
      AgentType.invalidateCache()
    }
  })

  test('built-in rows that follow their template end on exactly the new YAML list', async () => {
    await upgradeSync()
    await db.delete(sharedPrompts).where(eq(sharedPrompts.id, 'public-text'))
    await upgradeSync()
    const manager = await AgentType.mustFind('manager')
    expect(manager.includes.filter((id) => id === 'public-text')).toHaveLength(1)
    expect(manager.yamlFieldOverrides).toEqual([])
  })
})

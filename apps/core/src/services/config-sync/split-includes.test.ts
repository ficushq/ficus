import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { agentTypes, db, sharedPrompts } from '../../db'
import { AgentType } from '../../entities/AgentType'
import { AgentTypeSync } from './agent-type-sync'
import { SharedPromptSync } from './shared-prompt-sync'
import { expandSplitIncludes, READABLE_TEXT_INCLUDE } from './split-includes'

describe('expandSplitIncludes', () => {
  test('adds the includes split out of rules and squad-rules', () => {
    expect(expandSplitIncludes(['entity-references', 'rules', 'subagents', 'squad-rules'])).toEqual([
      'entity-references',
      'readable-text',
      'rules',
      'recovery-waits',
      'subagents',
      'squad-rules',
    ])
    // squad-rules never carried the recovery-wait protocol, only the readable-text paragraph.
    expect(expandSplitIncludes(['squad-rules'])).toEqual(['readable-text', 'squad-rules'])
    expect(expandSplitIncludes(['rules'])).toEqual(['readable-text', 'rules', 'recovery-waits'])
  })

  test('leaves a list alone when it already has readable-text or never had the old text', () => {
    expect(expandSplitIncludes(['readable-text', 'rules'])).toBeNull()
    expect(expandSplitIncludes(['entity-references'])).toBeNull()
    expect(expandSplitIncludes([])).toBeNull()
  })
})

/**
 * Built-in types take the new include lists from YAML. A type whose list was
 * overridden, or a custom type, still names only `rules`/`squad-rules` and
 * would silently lose the text that moved into `readable-text` and
 * `recovery-waits`. The shared-prompt sync that first stores `readable-text`
 * adds them in place, once; later admin edits are kept.
 */
describe('split include migration', () => {
  const sharedPromptSync = new SharedPromptSync()
  const agentTypeSync = new AgentTypeSync()

  async function upgradeSync(): Promise<void> {
    await sharedPromptSync.sync()
    await agentTypeSync.sync()
    AgentType.invalidateCache()
  }

  test('runs once, on the sync that first stores readable-text, and respects later edits', async () => {
    const customId = `custom-split-${crypto.randomUUID().slice(0, 8)}`
    await upgradeSync()
    try {
      // The database as it was before the split: no readable-text prompt, an
      // overridden built-in list and a custom type that name only the old ids.
      await db.delete(sharedPrompts).where(eq(sharedPrompts.id, READABLE_TEXT_INCLUDE))
      await db
        .update(agentTypes)
        .set({ includes: ['entity-references', 'rules', 'squad-rules'], yamlFieldOverrides: ['includes'] })
        .where(eq(agentTypes.id, 'engineer'))
      await db
        .insert(agentTypes)
        .values({ id: customId, name: 'Custom split', model: '', systemPrompt: 'You are custom.', includes: ['rules'] })

      await upgradeSync()
      const engineer = await AgentType.mustFind('engineer')
      expect(engineer.includes).toEqual([
        'entity-references',
        'readable-text',
        'rules',
        'recovery-waits',
        'squad-rules',
      ])
      expect(engineer.yamlFieldOverrides).toEqual(['includes'])
      const [custom] = await db.select().from(agentTypes).where(eq(agentTypes.id, customId))
      expect(custom.includes).toEqual(['readable-text', 'rules', 'recovery-waits'])

      // An admin later removes readable-text on purpose; the next sync keeps that.
      await db
        .update(agentTypes)
        .set({ includes: ['rules'] })
        .where(eq(agentTypes.id, customId))
      await upgradeSync()
      const [edited] = await db.select().from(agentTypes).where(eq(agentTypes.id, customId))
      expect(edited.includes).toEqual(['rules'])
    } finally {
      await db.delete(agentTypes).where(eq(agentTypes.id, customId))
      await agentTypeSync.revertToTemplate('engineer')
      AgentType.invalidateCache()
    }
  })
})

import { afterAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, sharedPrompts } from '../../db'
import { SharedPrompt } from '../../entities/SharedPrompt'
import { SharedPromptSync, parseSharedPromptMarkdown } from './shared-prompt-sync'

const sync = new SharedPromptSync()

describe('parseSharedPromptMarkdown', () => {
  test('names the block from its first heading and describes it from the first paragraph', () => {
    const parsed = parseSharedPromptMarkdown('## Squad rules\n\nHow squads coordinate.\n\nMore.', 'squad-rules')
    expect(parsed).toEqual({
      id: 'squad-rules',
      name: 'Squad rules',
      description: 'How squads coordinate.',
      content: '## Squad rules\n\nHow squads coordinate.\n\nMore.',
    })
  })
  test('falls back to the id when there is no heading', () => {
    expect(parseSharedPromptMarkdown('plain text', 'rules').name).toBe('rules')
  })
  test('rejects an empty block or an invalid id', () => {
    expect(() => parseSharedPromptMarkdown('', 'rules')).toThrow()
    expect(() => parseSharedPromptMarkdown('x', '../evil')).toThrow()
  })
})

describe('SharedPromptSync', () => {
  afterAll(async () => {
    await db.delete(sharedPrompts).where(eq(sharedPrompts.id, 'custom-block'))
  })

  test('loads every bundled include with its file stem as id', async () => {
    const ids = (await sync.loadFromDir()).map((i) => i.id).sort()
    expect(ids).toEqual([
      'assistant-task-reporting',
      'entity-references',
      'new-work-routing',
      'rules',
      'slot-manager',
      'squad-dynamic-context',
      'squad-rules',
      'subagents',
    ])
  })

  test('sync stores the blocks with a template and no overrides', async () => {
    await sync.sync()
    const rules = await SharedPrompt.mustFind('squad-rules')
    expect(rules.content).toContain('### Questions, waits, and pause')
    expect(rules.yamlFieldOverrides).toEqual([])
    expect(rules.toJson().hasTemplate).toBe(true)
  })

  test('an admin edit becomes a content override that survives resync; revert clears it', async () => {
    await sync.sync()
    const original = (await SharedPrompt.mustFind('subagents')).content
    await SharedPrompt.upsert({ id: 'subagents', name: 'Subagents', content: original + '\nLocal addition.' })
    await sync.recomputeFieldOverrides('subagents')
    await sync.sync()
    expect((await SharedPrompt.mustFind('subagents')).content).toContain('Local addition.')
    expect((await SharedPrompt.mustFind('subagents')).yamlFieldOverrides).toEqual(['content'])
    await sync.revertToTemplate('subagents')
    expect((await SharedPrompt.mustFind('subagents')).content).toBe(original)
  })

  test('a custom block without a template is kept across sync', async () => {
    await SharedPrompt.upsert({ id: 'custom-block', name: 'Custom', content: 'Be brief.' })
    await sync.sync()
    expect(await SharedPrompt.find('custom-block')).not.toBeNull()
  })
})

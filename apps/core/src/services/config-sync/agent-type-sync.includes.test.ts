import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { agentTypes, db } from '../../db'
import { AgentType } from '../../entities/AgentType'
import { AgentTypeSync, composeFromYaml, stripLegacyIncludeSuffix } from './agent-type-sync'
import { loadSharedPromptFiles } from './shared-prompt-sync'

const sync = new AgentTypeSync()

describe('agent type includes', () => {
  // Several tests below plant a doctored `engineer` row. Reset it to its
  // template first so each test starts from a clean row regardless of the
  // order they run in.
  beforeEach(async () => {
    await sync.sync()
    await sync.revertToTemplate('engineer')
    AgentType.invalidateCache()
  })

  test('loadFromDir keeps the include list and leaves systemPrompt free of include text', async () => {
    const sysops = (await sync.loadFromDir()).find((t) => t.id === 'sysops')!
    expect(sysops.includes).toEqual(['entity-references', 'rules', 'subagents', 'new-work-routing', 'squad-rules'])
    expect(sysops.systemPrompt).toContain('### Incident Response')
    expect(sysops.systemPrompt).not.toContain('### Questions, waits, and pause')
  })

  test('composeFromYaml reproduces the legacy merged prompt exactly', async () => {
    const sysops = (await sync.loadFromDir()).find((t) => t.id === 'sysops')!
    const files = await loadSharedPromptFiles()
    const composed = composeFromYaml(sysops, files)
    expect(composed).toBe(
      [
        sysops.systemPrompt,
        files.get('entity-references'),
        files.get('rules'),
        files.get('subagents'),
        files.get('new-work-routing'),
        files.get('squad-rules'),
      ].join('\n\n')
    )
  })

  test('loadFromDir rejects a type that names an include with no file', async () => {
    const bad = sync.parse(
      ['id: bad-inc', 'name: Bad', 'tier: standard', 'systemPrompt: hi', 'includes:', '  - nope'].join('\n'),
      'bad-inc.yaml'
    )
    await expect(sync.validateIncludes([bad], new Map())).rejects.toThrow(/Include 'nope' not found/)
  })

  test('loadFromDir rejects a type that lists the same include twice', async () => {
    const dup = sync.parse(
      ['id: dup-inc', 'name: Dup', 'tier: standard', 'systemPrompt: hi', 'includes:', '  - rules', '  - rules'].join(
        '\n'
      ),
      'dup-inc.yaml'
    )
    await expect(sync.validateIncludes([dup], new Map([['rules', 'text']]))).rejects.toThrow(
      /AgentType 'dup-inc': Include 'rules' is listed twice/
    )
  })

  test('sync stores includes on the row and the template', async () => {
    await sync.sync()
    const [row] = await db.select().from(agentTypes).where(eq(agentTypes.id, 'engineer'))
    expect(row.includes).toEqual(['entity-references', 'rules', 'subagents', 'new-work-routing', 'squad-rules'])
    expect((row.yamlTemplate as { includes?: string[] }).includes).toEqual([
      'entity-references',
      'rules',
      'subagents',
      'new-work-routing',
      'squad-rules',
    ])
    expect(row.systemPrompt).not.toContain('## Run Identity')
  })

  test('stripLegacyIncludeSuffix removes a verbatim appended block set and refuses anything else', () => {
    const own = 'You are X.'
    const a = '## A\nalpha'
    const b = '## B\nbeta'
    expect(stripLegacyIncludeSuffix(`${own}\n\n${a}\n\n${b}`, [a, b])).toBe(own)
    expect(stripLegacyIncludeSuffix(`${own}\n\n${a}\n\n${b}\nedited`, [a, b])).toBeNull()
    expect(stripLegacyIncludeSuffix(own, [])).toBe(own)
  })

  /**
   * An `includes` override means the row was edited after the split — the empty
   * list is what the admin asked for, not a pre-migration artifact. Repairing it
   * would overwrite a deliberate choice, and warning about it would nag on every
   * sync forever.
   */
  test('a deliberate empty includes override is left alone with no warning', async () => {
    const files = await loadSharedPromptFiles()
    const engineer = (await sync.loadFromDir()).find((t) => t.id === 'engineer')!
    const merged = composeFromYaml(engineer, files)
    await db
      .update(agentTypes)
      .set({ systemPrompt: merged, includes: [], yamlFieldOverrides: ['systemPrompt', 'includes'] })
      .where(eq(agentTypes.id, 'engineer'))
    AgentType.invalidateCache()

    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await sync.sync()
      const warnings = warn.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('engineer'))
      expect(warnings).toEqual([])
    } finally {
      warn.mockRestore()
    }

    const after = await AgentType.mustFind('engineer')
    expect(after.systemPrompt).toBe(merged)
    expect(after.includes).toEqual([])
    expect([...after.yamlFieldOverrides].sort()).toEqual(['includes', 'systemPrompt'])
  })

  /**
   * The shape a real pre-includes database actually has: the admin edit was
   * recorded before `includes` existed, so only `systemPrompt` is listed as an
   * override. The base sync fills `includes` from the template before the
   * repair gets to look, so the repair must decide what is legacy from the
   * pre-sync row, not the post-sync one.
   */
  test('a row overriding only systemPrompt is still recognized as a pre-migration merge', async () => {
    await sync.sync()
    const files = await loadSharedPromptFiles()
    const engineer = (await sync.loadFromDir()).find((t) => t.id === 'engineer')!
    const legacyMerged = composeFromYaml(engineer, files)
    await db
      .update(agentTypes)
      .set({ systemPrompt: legacyMerged, includes: [], yamlFieldOverrides: ['systemPrompt'] })
      .where(eq(agentTypes.id, 'engineer'))
    await sync.sync()
    const after = await AgentType.mustFind('engineer')
    expect(after.systemPrompt).toBe(engineer.systemPrompt)
    expect(after.includes).toEqual(engineer.includes!)
    expect(after.yamlFieldOverrides).toEqual([])
  })

  test('a hand-edited merged prompt keeps its text and drops its includes so nothing is appended twice', async () => {
    await sync.sync()
    const files = await loadSharedPromptFiles()
    const engineer = (await sync.loadFromDir()).find((t) => t.id === 'engineer')!
    const edited = `${composeFromYaml(engineer, files)}\n\nLocal addition.`
    await db
      .update(agentTypes)
      .set({ systemPrompt: edited, includes: [], yamlFieldOverrides: ['systemPrompt'] })
      .where(eq(agentTypes.id, 'engineer'))
    await sync.sync()
    const after = await AgentType.mustFind('engineer')
    expect(after.systemPrompt).toBe(edited)
    expect(after.includes).toEqual([])
    expect([...after.yamlFieldOverrides].sort()).toEqual(['includes', 'systemPrompt'])
  })
})

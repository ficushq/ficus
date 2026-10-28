import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { db, agentTypes } from '../../db'
import { eq } from 'drizzle-orm'
import { AgentTypeSync } from './agent-type-sync'

class TestAgentTypeSync extends AgentTypeSync {
  constructor(public override readonly directory: string) {
    super()
  }
}

const VALID_YAML = `
id: test-agent
name: Test Agent
model: anthropic:claude-sonnet-4-5
systemPrompt: You are a test agent.
`

describe('ConfigSync', () => {
  let tmpDir: string
  let sync: TestAgentTypeSync

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'config-sync-test-'))
    sync = new TestAgentTypeSync(tmpDir)
    await db.delete(agentTypes)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('fresh sync inserts with yaml template and no field overrides', async () => {
    writeFileSync(join(tmpDir, 'test.yaml'), VALID_YAML)
    const result = await sync.sync()
    expect(result.synced).toBe(1)
    const rows = await db.select().from(agentTypes)
    expect(rows).toHaveLength(1)
    expect(rows[0].yamlTemplate).toBeTruthy()
    expect(rows[0].yamlFieldOverrides).toEqual([])
  })

  test('re-sync overwrites records with no field overrides', async () => {
    writeFileSync(join(tmpDir, 'test.yaml'), VALID_YAML)
    await sync.sync()
    writeFileSync(join(tmpDir, 'test.yaml'), VALID_YAML.replace('Test Agent', 'Updated Agent'))
    await sync.sync()
    const rows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'test-agent'))
    expect(rows[0].name).toBe('Updated Agent')
    expect(rows[0].yamlFieldOverrides).toEqual([])
  })

  test('sync updates YAML-managed fields while preserving admin-overridden fields', async () => {
    writeFileSync(join(tmpDir, 'test.yaml'), VALID_YAML)
    await sync.sync()
    await db
      .update(agentTypes)
      .set({ model: 'openai/gpt-4.1', yamlFieldOverrides: ['model'] })
      .where(eq(agentTypes.id, 'test-agent'))

    writeFileSync(
      join(tmpDir, 'test.yaml'),
      VALID_YAML.replace('Test Agent', 'Updated Agent')
        .replace('anthropic:claude-sonnet-4-5', 'openai/gpt-4.1-mini')
        .replace('You are a test agent.', 'You are an updated test agent.')
    )

    await sync.sync()

    const rows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'test-agent'))
    expect(rows[0].name).toBe('Updated Agent')
    expect(rows[0].model).toBe('openai/gpt-4.1')
    expect(rows[0].systemPrompt).toBe('You are an updated test agent.')
    expect(rows[0].yamlFieldOverrides).toEqual(['model'])
    expect((rows[0].yamlTemplate as any).model).toBe('openai/gpt-4.1-mini')
  })

  test('recomputeFieldOverrides records fields changed by admin edits', async () => {
    writeFileSync(join(tmpDir, 'test.yaml'), VALID_YAML)
    await sync.sync()
    await db.update(agentTypes).set({ name: 'Admin Name' }).where(eq(agentTypes.id, 'test-agent'))

    await sync.recomputeFieldOverrides('test-agent')

    const rows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'test-agent'))
    expect(rows[0].yamlFieldOverrides).toEqual(['name'])
  })

  test('revertTemplateFields restores selected fields and keeps other overrides', async () => {
    writeFileSync(join(tmpDir, 'test.yaml'), VALID_YAML)
    await sync.sync()
    await db
      .update(agentTypes)
      .set({ name: 'Admin Name', model: 'openai/gpt-4.1', yamlFieldOverrides: ['name', 'model'] })
      .where(eq(agentTypes.id, 'test-agent'))

    await sync.revertTemplateFields('test-agent', ['model'])

    let rows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'test-agent'))
    expect(rows[0].name).toBe('Admin Name')
    expect(rows[0].model).toBe('anthropic:claude-sonnet-4-5')
    expect(rows[0].yamlFieldOverrides).toEqual(['name'])

    await sync.revertTemplateFields('test-agent', ['name'])

    rows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'test-agent'))
    expect(rows[0].name).toBe('Test Agent')
    expect(rows[0].yamlFieldOverrides).toEqual([])
  })

  test('template records removed from YAML are deleted when they have no field overrides', async () => {
    writeFileSync(join(tmpDir, 'test.yaml'), VALID_YAML)
    await sync.sync()
    rmSync(join(tmpDir, 'test.yaml'))
    const result = await sync.sync()
    expect(result.deleted).toBe(1)
    const rows = await db.select().from(agentTypes)
    expect(rows).toHaveLength(0)
  })

  test('custom records not in YAML are kept', async () => {
    await db.insert(agentTypes).values({
      id: 'admin-agent',
      name: 'Admin Agent',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
    })
    const result = await sync.sync()
    expect(result.deleted).toBe(0)
    const rows = await db.select().from(agentTypes)
    expect(rows).toHaveLength(1)
  })

  test('template records removed from YAML are kept when they have field overrides', async () => {
    writeFileSync(join(tmpDir, 'test.yaml'), VALID_YAML)
    await sync.sync()
    await db
      .update(agentTypes)
      .set({ yamlFieldOverrides: ['name'], name: 'Admin Name' })
      .where(eq(agentTypes.id, 'test-agent'))
    rmSync(join(tmpDir, 'test.yaml'))

    const result = await sync.sync()

    expect(result.deleted).toBe(0)
    const rows = await db.select().from(agentTypes)
    expect(rows).toHaveLength(1)
  })

  test('revert to template resets data', async () => {
    writeFileSync(join(tmpDir, 'test.yaml'), VALID_YAML)
    await sync.sync()
    await db
      .update(agentTypes)
      .set({ name: 'Admin Name', yamlFieldOverrides: ['name'] })
      .where(eq(agentTypes.id, 'test-agent'))
    await sync.revertToTemplate('test-agent')
    const rows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'test-agent'))
    expect(rows[0].name).toBe('Test Agent')
    expect(rows[0].yamlFieldOverrides).toEqual([])
  })

  test('template diff returns field overrides', async () => {
    writeFileSync(join(tmpDir, 'test.yaml'), VALID_YAML)
    await sync.sync()
    await db
      .update(agentTypes)
      .set({ name: 'Admin Name', yamlFieldOverrides: ['name'] })
      .where(eq(agentTypes.id, 'test-agent'))
    const diff = await sync.getTemplateDiff('test-agent')
    expect(diff.hasDrift).toBe(true)
    expect(diff.fieldOverrides).toEqual(['name'])
    expect((diff.current as any).name).toBe('Admin Name')
    expect((diff.template as any).name).toBe('Test Agent')
  })
})

test('template field collection refuses cardinality before loading a row', async () => {
  const sync = new AgentTypeSync()
  await expect(sync.revertTemplateFields('not-found', Array(101).fill('name'))).rejects.toThrow('Use at most 100')
})

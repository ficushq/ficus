import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { manualInputRequestSchema, taskInputSummary } from '@ficus/shared'
import { db, squads, workStreams, workStreamWaits } from '../../db'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { createTestAdmin, cleanupTestRbac } from '../../test-utils'
import { requestStructuredInput, resolveStructuredInput } from './structured-input'
import { validateConfigDeclaration, consumeConfigDeclarationProof, readRemoteDeclaration } from './task-declarations'
import * as factory from '../sandbox/factory'
import * as workspace from '../squad/workspace'
import { SandboxClient } from '../sandbox/client/http-client'
import type { WorkStream } from '../../entities/WorkStream'

const prefix = `declarations-${crypto.randomUUID()}`
let dir: string
let squadId: string
let ownerId: string
let stream: WorkStream
let runtimeSpy: ReturnType<typeof spyOn<typeof factory, 'isRemoteSandboxRuntime'>>
let rootSpy: ReturnType<typeof spyOn<typeof workspace, 'resolveSquadWorkspaceHostPath'>>
const request = (key = 'PUBLIC_BASE_URL', declaredIn = 'config.schema.json') =>
  manualInputRequestSchema.parse({
    schemaVersion: 1,
    kind: 'provide',
    purpose: 'task-input',
    input: { type: 'config-value', key, declaredIn },
    use: 'Configure the product URL',
  })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'task-declarations-'))
  await mkdir(join(dir, 'workspace'))
  await writeFile(
    join(dir, 'workspace/config.schema.json'),
    JSON.stringify({ properties: { PUBLIC_BASE_URL: { type: 'string' } } })
  )
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'test' }).returning()
  squadId = squad!.id
  ownerId = (await createTestAdmin({ prefix })).id
  stream = await storedLegacyWorkStream({ squadId, title: prefix, requestingUserId: ownerId })
  runtimeSpy = spyOn(factory, 'isRemoteSandboxRuntime').mockReturnValue(false)
  rootSpy = spyOn(workspace, 'resolveSquadWorkspaceHostPath').mockReturnValue(join(dir, 'workspace'))
})
afterEach(async () => {
  runtimeSpy?.mockRestore()
  rootSpy?.mockRestore()
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
  await cleanupTestRbac(prefix)
  await rm(dir, { recursive: true, force: true })
})

test('accepts an actual declared key and rejects undeclared, inherited, missing and non-JSON declarations', async () => {
  const accepted = await requestStructuredInput(stream.id, request(), {
    createdBy: 'operator',
    createdByUserId: ownerId,
  })
  expect(accepted.structured?.summary.text).toContain('PUBLIC_BASE_URL')
  await expect(requestStructuredInput(stream.id, request('UNKNOWN_KEY'), { createdBy: 'operator' })).rejects.toThrow(
    'not declared'
  )
  await expect(requestStructuredInput(stream.id, request('toString'), { createdBy: 'operator' })).rejects.toThrow(
    'not declared'
  )
  await expect(
    requestStructuredInput(stream.id, request('PUBLIC_BASE_URL', 'missing.json'), { createdBy: 'operator' })
  ).rejects.toThrow()
  await writeFile(join(dir, 'workspace/config.schema.json'), 'PRIVATE_DECLARATION_CONTENT')
  await expect(requestStructuredInput(stream.id, request(), { createdBy: 'operator' })).rejects.toThrow(
    'must be valid JSON'
  )
  expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))).toHaveLength(1)
})

test('rejects symlink escapes and oversized declarations without creating a wait', async () => {
  await writeFile(join(dir, 'outside.json'), JSON.stringify({ PUBLIC_BASE_URL: null }))
  await symlink(join(dir, 'outside.json'), join(dir, 'workspace/escape.json'))
  await expect(
    requestStructuredInput(stream.id, request('PUBLIC_BASE_URL', 'escape.json'), { createdBy: 'operator' })
  ).rejects.toThrow('inside the workspace')
  await writeFile(join(dir, 'workspace/config.schema.json'), JSON.stringify({ PUBLIC_BASE_URL: 'x'.repeat(65536) }))
  await expect(requestStructuredInput(stream.id, request(), { createdBy: 'operator' })).rejects.toThrow('small JSON')
  expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))).toHaveLength(0)
})

test('the common writer rejects forged declarations and proofs cannot move between streams or mutate content', async () => {
  const input = request()
  if (input.kind !== 'provide') throw new Error('Invalid fixture')
  await expect(
    stream.block({
      message: taskInputSummary(input).text,
      createdBy: 'system',
      structured: { request: input, summary: taskInputSummary(input), version: 0 },
    })
  ).rejects.toThrow('first validate')
  await validateConfigDeclaration(input, stream.id, squadId)
  expect(() => consumeConfigDeclarationProof(input, crypto.randomUUID(), squadId)).toThrow('first validate')
  await validateConfigDeclaration(input, stream.id, squadId)
  if (input.input.type !== 'config-value') throw new Error('Invalid fixture')
  input.input.key = 'UNDECLARED'
  expect(() => consumeConfigDeclarationProof(input, stream.id, squadId)).toThrow('first validate')
  expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream.id))).toHaveLength(0)
})

test('file responses remain workspace-relative instead of accepting host paths or diagnostic text', async () => {
  const input = manualInputRequestSchema.parse({
    schemaVersion: 1,
    kind: 'provide',
    purpose: 'task-input',
    input: { type: 'file', path: 'assets/logo.svg' },
    use: 'Render the product logo',
  })
  const wait = await requestStructuredInput(stream.id, input, { createdBy: 'operator' })
  for (const value of ['/etc/config.json', '../outside.json', 'executor stderr dump'])
    await expect(
      resolveStructuredInput(stream.id, wait.id, { action: 'provide', expectedVersion: 0, value }, { userId: ownerId })
    ).rejects.toThrow()
  const closed = await resolveStructuredInput(
    stream.id,
    wait.id,
    { action: 'provide', expectedVersion: 0, value: 'assets/approved-logo.svg' },
    { userId: ownerId }
  )
  expect(closed.resolutionNote).toBe('assets/logo.svg: assets/approved-logo.svg')
})

test('remote declaration reads require executor containment proof using only a read capability', async () => {
  const client = new SandboxClient('127.0.0.1:1')
  const declaration = JSON.stringify({ PUBLIC_BASE_URL: null })
  const content = Buffer.from(declaration).toString('base64')
  const read = spyOn(client, 'read').mockResolvedValue({ content, totalSize: 32, isBinary: false })
  try {
    await expect(readRemoteDeclaration(client, '/workspace', 'config.schema.json')).rejects.toThrow('workspace-bounded')
    expect(read).toHaveBeenCalledWith({ path: '/workspace/config.schema.json', root: '/workspace', limit: 65537 })
    read.mockImplementation(async (input) => ({ content, totalSize: 32, isBinary: false, verifiedRoot: input.root }))
    expect(await readRemoteDeclaration(client, '/workspace', 'config.schema.json')).toBe(declaration)
  } finally {
    read.mockRestore()
    client.close()
  }
})

test('server-declared git configuration remains requestable before a workspace exists', async () => {
  await rm(join(dir, 'workspace'), { recursive: true, force: true })
  const input = manualInputRequestSchema.parse({
    schemaVersion: 1,
    kind: 'provide',
    purpose: 'task-input',
    input: { type: 'config-value', key: 'git.worktree', declaredIn: 'ficus:work-stream' },
    use: 'Configure the dedicated worktree',
  })
  const wait = await requestStructuredInput(stream.id, input, { createdBy: 'operator' })
  expect(wait.structured?.summary.text).toContain('git.worktree')
  expect(
    (
      await resolveStructuredInput(
        stream.id,
        wait.id,
        { action: 'provide', expectedVersion: 0, value: '/workspace/project' },
        { userId: ownerId }
      )
    ).resolutionNote
  ).toBe('git.worktree: /workspace/project')
})

test('declared configuration values retain legitimate multiline task input', async () => {
  await writeFile(
    join(dir, 'workspace/config.schema.json'),
    JSON.stringify({ properties: { RELEASE_TARGETS: { type: 'string' } } })
  )
  const wait = await requestStructuredInput(stream.id, request('RELEASE_TARGETS'), { createdBy: 'operator' })
  const closed = await resolveStructuredInput(
    stream.id,
    wait.id,
    { action: 'provide', expectedVersion: 0, value: 'staging\npreview' },
    { userId: ownerId }
  )
  expect(closed.resolutionNote).toBe('RELEASE_TARGETS: staging\npreview')
})

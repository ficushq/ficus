import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray, like } from 'drizzle-orm'
import { workflowPresetSchema, type WorkflowDefinition } from '@ficus/shared'
import { agents, agentTypes, db, images, inbox, squads, workflowBindings, workStreams } from '../../db'
import { Agent } from '../../entities/Agent'
import { Image } from '../../entities/Image'
import { cleanupTestRbac, createTestAdmin, type TestUser } from '../../test-utils/rbac'
import { agentIdentity, createReadAttachmentTool } from '../../tools/read-attachment'
import { attachAttemptAsset, attachStreamAsset } from '../work-streams/asset-attachments'
import { advanceFlow, attachFlow, dispatchFlow, ensureFlowDispatch, getFlow } from './execution'

// Synthetic squad, agents, user and a generated 1x1 PNG; no model or sandbox starts.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const prefix = `asset-manifest-${randomUUID()}`
const agentTypeId = `${prefix}-worker`
const originalHome = process.env.HOME_DIR
let home: string
let squadId: string
let source: string
let admin: TestUser
let flow: WorkflowDefinition
let send: ReturnType<typeof spyOn<Agent, 'sendMessage'>>

beforeAll(async () => {
  flow = workflowPresetSchema.parse(
    Bun.YAML.parse(
      await Bun.file(new URL('../../../../../config/workflows/builder-reviewer.yaml', import.meta.url)).text()
    )
  ).definition
  for (const participant of Object.values(flow.participants)) participant.agentTypeId = agentTypeId
  await db.insert(agentTypes).values({
    id: agentTypeId,
    name: 'Manifest worker',
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Test.',
    extraScopes: ['workstreams:respond', 'workstreams:read', 'agents:read'],
  })
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Asset manifest fixtures' }).returning()
  squadId = squad!.id
  const [consultant] = await db.insert(agents).values({ agentTypeId, squadId }).returning({ id: agents.id })
  source = consultant!.id
  admin = await createTestAdmin({ prefix })
  send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({ success: true, status: 'queued', queued: true })
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asset-manifest-'))
  process.env.HOME_DIR = home
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

afterAll(async () => {
  send?.mockRestore()
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  const owned = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
  const ids = owned.map((row) => row.id)
  if (ids.length) {
    await db.delete(inbox).where(inArray(inbox.recipientId, ids))
    await db.delete(images).where(inArray(images.agentId, ids))
  }
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(agents).where(eq(agents.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(agentTypes).where(like(agentTypes.id, `${prefix}%`))
  await cleanupTestRbac(prefix)
})

async function conversationImage(agentId: string) {
  const [image] = await Image.createMany([{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }], {
    agentId,
  })
  await Image.markManyUsed([image!.id])
  return image!
}

async function assignments(id: string) {
  return db
    .select()
    .from(inbox)
    .where(like(inbox.idempotencyKey, `flow:${id}:%`))
}

test('stored inputs and incoming references reach real assignments, and the next agent can view them', async () => {
  // A queued stream gets its input before any participant exists, as creation-time inputs do.
  const [stream] = await db.insert(workStreams).values({ squadId, title: prefix, status: 'queued' }).returning()
  await db.transaction(async (tx) => {
    const run = await attachFlow(tx, stream!, { kind: 'inline', definition: flow })
    await dispatchFlow(tx, stream!, run, [])
  })
  const input = await conversationImage(source)
  const shared = await attachStreamAsset({
    identity: { type: 'user', userId: admin.id },
    streamId: stream!.id,
    source: { kind: 'image', imageId: input.id },
  })
  await db.update(workStreams).set({ status: 'active' }).where(eq(workStreams.id, stream!.id))
  await ensureFlowDispatch(stream!.id)

  const [first] = await assignments(stream!.id)
  expect(first!.content).toContain('Stored inputs:')
  expect(first!.content).toContain(
    `read_attachment with {"kind":"workstream-asset","workStreamId":"${stream!.id}","attachmentId":"${shared.attachment.id}"}`
  )
  expect(first!.content).toContain('--attach-image IMAGE_ID')

  // The builder attaches an image from its own conversation to its result, by ID.
  const [builderBinding] = await db.select().from(workflowBindings).where(eq(workflowBindings.workStreamId, stream!.id))
  const builder = (await Agent.find(builderBinding!.agentId))!
  const result = await conversationImage(builder.id)
  const run = (await getFlow(stream!.id))!
  const reference = await attachAttemptAsset({
    identity: agentIdentity(builder),
    streamId: stream!.id,
    attemptId: run.state.activeAttemptId!,
    source: { kind: 'image', imageId: result.id },
  })
  await advanceFlow(
    stream!.id,
    {
      expectedVersion: run.version,
      attemptId: run.state.activeAttemptId!,
      action: 'complete',
      outcome: Object.keys(flow.steps.find((step) => step.id === flow.entry)!.outcomes)[0]!,
      evidence: 'Built the synthetic change; screenshot attached by ID.',
    },
    randomUUID(),
    { type: 'legacy' }
  )

  const reviewerMessage = (await assignments(stream!.id)).find((message) => message.id !== first!.id)!
  expect(reviewerMessage.content).toContain('Attached by incoming results:')
  expect(reviewerMessage.content).toContain(`"attachmentId":"${reference.attachment.id}"`)
  expect(reviewerMessage.content).toContain(`"attachmentId":"${shared.attachment.id}"`)

  // The reviewer, which never had either image in its own conversation, views the result.
  const reviewerBinding = (
    await db.select().from(workflowBindings).where(eq(workflowBindings.workStreamId, stream!.id))
  ).find((binding) => binding.agentId !== builder.id)!
  const tool = createReadAttachmentTool({ agentId: reviewerBinding.agentId })
  type Execute = (
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown
  ) => Promise<{
    content: Array<{ type: string }>
  }>
  const viewed = await (tool.execute as unknown as Execute)(
    'call-1',
    { source: { kind: 'workstream-asset', workStreamId: stream!.id, attachmentId: reference.attachment.id } },
    undefined,
    undefined,
    { model: { input: ['text', 'image'] } }
  )
  expect(viewed.content.map((block) => block.type)).toEqual(['text', 'image'])
})

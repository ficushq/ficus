import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, images, messages } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Image } from '../../entities/Image'

// Synthetic data only: one agent, two generated image rows.
const originalHome = process.env.HOME_DIR

describe('session delivery and image status', () => {
  let typeId: string
  let agent: Agent
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pending-delivery-images-'))
    process.env.HOME_DIR = home
    typeId = `pending-images-${crypto.randomUUID()}`
    await AgentType.create({ id: typeId, name: 'Pending images', model: 'test:model', systemPrompt: 'test' })
    agent = await Agent.create({ agentTypeId: typeId })
  })

  afterEach(async () => {
    await db.delete(images).where(eq(images.agentId, agent.id))
    await db.delete(messages).where(eq(messages.agentId, agent.id))
    await db.delete(agents).where(eq(agents.agentTypeId, typeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    if (originalHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = originalHome
    await rm(home, { recursive: true, force: true })
  })

  it('marks a message’s images used once the session holds the message, not when the turn ends', async () => {
    const [delivered, queued] = await Image.createMany(
      [
        { type: 'image', data: Buffer.from('a').toString('base64'), mimeType: 'image/png' },
        { type: 'image', data: Buffer.from('b').toString('base64'), mimeType: 'image/png' },
      ],
      { agentId: agent.id }
    )
    const first = await agent.recordMessage({
      role: 'human',
      content: 'look',
      pending: true,
      metadata: { imageIds: [delivered!.id] },
    })
    await agent.recordMessage({ role: 'human', content: 'later', pending: true, metadata: { imageIds: [queued!.id] } })
    const owner = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
    const claim = await agent.claimPendingInterventionForSessionDelivery(first.id, owner)
    expect((await Image.find(delivered!.id))!.status).toBe('pending')

    const confirmed = await agent.confirmSessionDelivery(claim!.metadata!.sessionDelivery!.id, owner, 'entry-1', {
      executionId: owner.executionId,
      streamGroupId: 'group-1',
    })
    expect(confirmed.map((message) => message.id)).toEqual([first.id])
    const sent = (await Image.find(delivered!.id))!
    expect(sent.status).toBe('used')
    expect(sent.usedAt).not.toBeNull()
    // The message still waiting in the queue keeps its image pending.
    expect((await Image.find(queued!.id))!.status).toBe('pending')
  })
})

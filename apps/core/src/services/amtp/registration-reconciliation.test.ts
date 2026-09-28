import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { AmtpSignedAgentCard } from '@ficus/shared'
import { agents, db } from '../../db'
import { Agent } from '../../entities/Agent'
import { generateInstanceKeyPair } from './crypto'
import { reconcileKeylessAmtpRegistrations } from './registration-reconciliation'

const ids: string[] = []
afterEach(async () => {
  for (const id of ids.splice(0)) await db.delete(agents).where(eq(agents.id, id))
})

async function make(
  fields: Partial<{
    amtpHandle: string
    identityPublicKey: string
    inboundOpen: boolean
    cardJson: AmtpSignedAgentCard
  }>
) {
  const agent = await Agent.create({ agentTypeId: 'manager', squadId: null })
  ids.push(agent.id)
  await agent.update(fields)
  return agent
}

const card: AmtpSignedAgentCard = { v: 1, instanceId: 'i', handle: 'h', card: { name: 'Legacy' }, cardSig: 'sig' }

describe('reconcileKeylessAmtpRegistrations', () => {
  test('closes and clears only exposed keyless registrations and is idempotent', async () => {
    const legacy = await make({ amtpHandle: 'legacy', inboundOpen: true, cardJson: card })
    const ready = await make({
      amtpHandle: 'ready',
      identityPublicKey: generateInstanceKeyPair().publicKeyPem,
      inboundOpen: true,
      cardJson: card,
    })
    await make({ inboundOpen: true })

    expect(await reconcileKeylessAmtpRegistrations()).toContainEqual({ id: legacy.id, handle: 'legacy' })
    expect(await Agent.mustFind(legacy.id)).toMatchObject({ amtpHandle: 'legacy', inboundOpen: false, cardJson: null })
    expect(await Agent.mustFind(ready.id)).toMatchObject({ amtpHandle: 'ready', inboundOpen: true, cardJson: card })
    expect(await reconcileKeylessAmtpRegistrations()).toEqual([])
  })
})

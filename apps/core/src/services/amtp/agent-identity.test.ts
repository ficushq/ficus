import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import type { AmtpSignedAgentCard } from '@ficus/shared'
import { db, agents } from '../../db'
import { Agent } from '../../entities/Agent'
import { getAgentPrivateStoragePath } from '../sandbox/ensure'
import { getHomeDir } from '../../lib/utils/home'
import { ensureAgentIdentity } from './agent-identity'
import { generateInstanceKeyPair } from './crypto'

const created: string[] = []
const sandboxIds: string[] = []

afterEach(async () => {
  for (const sid of sandboxIds.splice(0)) {
    // Remove the whole per-agent private dir to avoid accumulating empty
    // directories (getAgentPrivateStoragePath has a mkdir side effect).
    rmSync(join(getHomeDir(), 'private', sid), { recursive: true, force: true })
  }
  for (const id of created.splice(0)) await db.delete(agents).where(eq(agents.id, id))
})

async function makeAgent(): Promise<Agent> {
  const agent = await Agent.create({ agentTypeId: 'manager', squadId: null })
  created.push(agent.id)
  return agent
}

describe('ensureAgentIdentity', () => {
  test('generates /private/.tau/identity.pem and records the SPKI public PEM', async () => {
    const agent = await makeAgent()
    const sandboxId = `agent_${agent.id}`
    sandboxIds.push(sandboxId)

    const pub = await ensureAgentIdentity(agent, sandboxId)
    expect(pub).toContain('BEGIN PUBLIC KEY')

    const keyPath = join(getAgentPrivateStoragePath(sandboxId), '.tau', 'identity.pem')
    expect(existsSync(keyPath)).toBe(true)
    expect(readFileSync(keyPath, 'utf-8')).toContain('BEGIN PRIVATE KEY')

    const reloaded = await Agent.find(agent.id)
    expect(reloaded!.identityPublicKey).toBe(pub)
  })

  test('is idempotent: a second call reuses the on-disk key (stable public PEM)', async () => {
    const agent = await makeAgent()
    const sandboxId = `agent_${agent.id}`
    sandboxIds.push(sandboxId)

    const first = await ensureAgentIdentity(agent, sandboxId)
    const second = await ensureAgentIdentity(await Agent.mustFind(agent.id), sandboxId)
    expect(second).toBe(first)
  })

  test('backfills an agent created without a key', async () => {
    const agent = await makeAgent()
    expect(agent.identityPublicKey).toBeNull()
    const sandboxId = `agent_${agent.id}`
    sandboxIds.push(sandboxId)
    await ensureAgentIdentity(agent, sandboxId)
    expect((await Agent.mustFind(agent.id)).identityPublicKey).toContain('BEGIN PUBLIC KEY')
  })

  test('generates over a corrupt private key only when no public identity is recorded', async () => {
    const agent = await makeAgent()
    const sandboxId = `agent_${agent.id}`
    sandboxIds.push(sandboxId)

    // Pre-seed a garbage (non-parseable) key file at the expected location.
    const tauDir = join(getAgentPrivateStoragePath(sandboxId), '.tau')
    mkdirSync(tauDir, { recursive: true })
    writeFileSync(join(tauDir, 'identity.pem'), 'NOT-A-REAL-KEY\n', { mode: 0o600 })

    // ensureAgentIdentity must not throw; it should regenerate a valid key.
    const pub = await ensureAgentIdentity(agent, sandboxId)
    expect(pub).toContain('BEGIN PUBLIC KEY')

    const keyPath = join(tauDir, 'identity.pem')
    expect(readFileSync(keyPath, 'utf-8')).toContain('BEGIN PRIVATE KEY')
    expect((await Agent.mustFind(agent.id)).identityPublicKey).toBe(pub)
  })

  test('does not rotate or clear the card when private and public keys mismatch', async () => {
    const agent = await makeAgent()
    const sandboxId = `agent_${agent.id}`
    sandboxIds.push(sandboxId)
    const recorded = await ensureAgentIdentity(agent, sandboxId)
    const cardJson: AmtpSignedAgentCard = {
      v: 1,
      instanceId: 'inst',
      handle: 'handle',
      card: { name: 'Test Agent' },
      cardSig: 'deadbeef',
    }
    await agent.update({ cardJson })
    const keyPath = join(getAgentPrivateStoragePath(sandboxId), '.tau', 'identity.pem')
    writeFileSync(keyPath, generateInstanceKeyPair().privateKeyPem, { mode: 0o600 })

    await expect(ensureAgentIdentity(await Agent.mustFind(agent.id), sandboxId)).rejects.toThrow(
      /mismatch|does not match/i
    )
    const reloaded = await Agent.mustFind(agent.id)
    expect(reloaded.identityPublicKey).toBe(recorded)
    expect(reloaded.cardJson).toEqual(cardJson)
  })

  test('does not rotate a recorded identity when the private key is missing', async () => {
    const agent = await makeAgent()
    const sandboxId = `agent_${agent.id}`
    sandboxIds.push(sandboxId)
    const recorded = generateInstanceKeyPair().publicKeyPem
    await agent.update({ identityPublicKey: recorded })

    await expect(ensureAgentIdentity(agent, sandboxId)).rejects.toThrow(/no usable private key|missing/i)
    expect((await Agent.mustFind(agent.id)).identityPublicKey).toBe(recorded)
  })
})

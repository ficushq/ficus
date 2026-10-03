import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { generateKeyPairSync } from 'crypto'
import { mkdirSync } from 'fs'
import { eq } from 'drizzle-orm'
import { db, agents } from '../../db'
import { Agent } from '../../entities/Agent'
import { ensureAgentIdentity, agentIdentityHostPath } from './agent-identity'
import { inspectAgentSigningIdentity } from './agent-signing-identity'
import { generateInstanceKeyPair } from './crypto'

const created: Agent[] = []
afterEach(async () => {
  for (const agent of created.splice(0)) {
    rmSync(dirname(dirname(agentIdentityHostPath(`agent_${agent.id}`))), { recursive: true, force: true })
    await db.delete(agents).where(eq(agents.id, agent.id))
  }
})

async function makeAgent(fields: { agentTypeId?: string; parentAgentId?: string } = {}) {
  const agent = await Agent.create({
    agentTypeId: fields.agentTypeId ?? 'manager',
    squadId: null,
    parentAgentId: fields.parentAgentId,
  })
  created.push(agent)
  return agent
}

describe('inspectAgentSigningIdentity', () => {
  test('reports ready only for matching provisioned Ed25519 custody', async () => {
    const agent = await makeAgent()
    await ensureAgentIdentity(agent, `agent_${agent.id}`)
    expect(await inspectAgentSigningIdentity(await Agent.mustFind(agent.id))).toMatchObject({
      status: 'ready',
      reason: null,
    })
  })

  test('reports a missing recorded public key', async () => {
    expect(await inspectAgentSigningIdentity(await makeAgent())).toMatchObject({
      status: 'unavailable',
      reason: 'missing_public_key',
    })
  })

  test('rejects shared system-manager custody before inspecting a manual key', async () => {
    const agent = await makeAgent({ agentTypeId: 'system-manager' })
    await agent.update({ identityPublicKey: generateInstanceKeyPair().publicKeyPem })
    expect(await inspectAgentSigningIdentity(agent)).toMatchObject({
      status: 'unsupported',
      reason: 'shared_system_manager_custody',
    })
  })

  test('rejects subagents sharing parent custody', async () => {
    const parent = await makeAgent()
    const child = await makeAgent({ parentAgentId: parent.id })
    expect(await inspectAgentSigningIdentity(child)).toMatchObject({
      status: 'unsupported',
      reason: 'shared_parent_custody',
    })
  })

  test('reports malformed and non-Ed25519 recorded public keys', async () => {
    const malformed = await makeAgent()
    await malformed.update({ identityPublicKey: 'not a pem' })
    expect(await inspectAgentSigningIdentity(malformed)).toMatchObject({ reason: 'invalid_public_key' })
    const rsa = await makeAgent()
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    await rsa.update({ identityPublicKey: publicKey.export({ type: 'spki', format: 'pem' }) as string })
    expect(await inspectAgentSigningIdentity(rsa)).toMatchObject({ reason: 'invalid_public_key' })
  })

  test('reports malformed and non-Ed25519 private keys', async () => {
    for (const privatePem of [
      'not a pem',
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    ]) {
      const agent = await makeAgent()
      await agent.update({ identityPublicKey: generateInstanceKeyPair().publicKeyPem })
      const path = agentIdentityHostPath(`agent_${agent.id}`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, privatePem, { mode: 0o600 })
      expect(await inspectAgentSigningIdentity(agent)).toMatchObject({ reason: 'invalid_private_key' })
    }
  })

  test('reports mismatched private material without changing the recorded key', async () => {
    const agent = await makeAgent()
    const recorded = generateInstanceKeyPair().publicKeyPem
    await agent.update({ identityPublicKey: recorded })
    const path = agentIdentityHostPath(`agent_${agent.id}`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, generateInstanceKeyPair().privateKeyPem, { mode: 0o600 })
    expect(await inspectAgentSigningIdentity(agent)).toMatchObject({
      status: 'unavailable',
      reason: 'public_private_mismatch',
    })
    expect((await Agent.mustFind(agent.id)).identityPublicKey).toBe(recorded)
  })
})

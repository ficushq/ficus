import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray, like, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTokens, agentTypes, sessions, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { User } from '../../entities/User'
import { createHash, randomUUID } from 'crypto'
import {
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestCredential,
  createTestUser,
} from '../../test-utils/rbac'
import { resetSecretStore } from '../secrets'
import { resolveToken, resolveTokenContext } from './resolve-token'
import { AGENT_TOKEN_PREFIX, SESSION_TOKEN_PREFIX } from './token-prefixes'

const PREFIX = 'resolve-token-test'

async function cleanup() {
  const testAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(like(agents.agentTypeId, `${PREFIX}%`))
  const agentIds = testAgents.map((agent) => agent.id)
  if (agentIds.length > 0) {
    await db.delete(agentTokens).where(inArray(agentTokens.agentId, agentIds))
  }
  await db.delete(agents).where(like(agents.agentTypeId, `${PREFIX}%`))
  await db.delete(agentTypes).where(like(agentTypes.id, `${PREFIX}%`))
  await db.delete(squads).where(like(squads.name, `${PREFIX}%`))
  await cleanupTestRbac(PREFIX)
}

async function createAgentFixture(suffix: string) {
  const [squad] = await db
    .insert(squads)
    .values({ name: `${PREFIX}-squad-${suffix}`, purpose: 'Resolve token test squad' })
    .returning()

  const agentTypeId = `${PREFIX}-agent-type-${suffix}`
  await AgentType.create({
    id: agentTypeId,
    model: 'anthropic:claude-sonnet-4-5',
    name: `Resolve Token Test ${suffix}`,
    systemPrompt: 'Test',
  })

  const agent = await Agent.create({ agentTypeId, squadId: squad.id })
  return { agent, squad }
}

beforeEach(cleanup)
afterEach(cleanup)

describe('resolveToken — disabled agent-token owner', () => {
  test('agent token owned by a disabled user is rejected', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const { agent, squad } = await createAgentFixture('owned')
    const { token } = await createTestAgentToken({ agentId: agent.id, squadId: squad.id, userId: user.id })

    expect(await resolveToken(token)).toMatchObject({ type: 'agent', agentId: agent.id, userId: user.id })
    expect(await resolveTokenContext(token)).toEqual({
      identity: {
        type: 'agent',
        agentId: agent.id,
        squadId: squad.id,
        userId: user.id,
      },
      deviceTokenId: null,
    })

    const owner = await User.findById(user.id)
    await owner!.disable()

    expect(await resolveToken(token)).toBeNull()
  })

  test('agent token owned by a missing user is rejected', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const { agent, squad } = await createAgentFixture('missing-owner')
    const { id, token } = await createTestAgentToken({ agentId: agent.id, squadId: squad.id, userId: user.id })

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`)
      await tx.update(agentTokens).set({ userId: randomUUID() }).where(eq(agentTokens.id, id))
    })

    expect(await resolveToken(token)).toBeNull()
  })

  test('agent token with no owner user is unaffected', async () => {
    const { agent, squad } = await createAgentFixture('ownerless')
    const { token } = await createTestAgentToken({ agentId: agent.id, squadId: squad.id })

    expect(await resolveToken(token)).toMatchObject({ type: 'agent', agentId: agent.id, squadId: squad.id })
  })
})

describe('resolveToken — FICUS_PASSWORD gated on admin passkey', () => {
  const originalPassword = process.env.FICUS_PASSWORD
  const testPassword = `resolve-token-pw-${randomUUID()}`

  beforeEach(() => {
    process.env.FICUS_PASSWORD = testPassword
    resetSecretStore()
  })

  afterEach(() => {
    if (originalPassword !== undefined) process.env.FICUS_PASSWORD = originalPassword
    else delete process.env.FICUS_PASSWORD
    resetSecretStore()
  })

  test('restored state: password resolves to legacy identity when admin rows exist but hold no passkey', async () => {
    // Cross-subdomain restore — admin/role rows survive, credentials stripped.
    await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })

    expect(await resolveToken(testPassword)).toEqual({ type: 'legacy' })
    expect(await resolveTokenContext(testPassword)).toEqual({
      identity: { type: 'legacy' },
      deviceTokenId: null,
    })
  })

  test('self-heals: password stops resolving the moment an admin registers a passkey', async () => {
    const admin = await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })
    expect(await resolveToken(testPassword)).toEqual({ type: 'legacy' })

    await createTestCredential({ userId: admin.id })
    expect(await resolveToken(testPassword)).toBeNull()
  })

  test('a wrong password never resolves, even in the restored state', async () => {
    await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })

    expect(await resolveToken('not-the-password')).toBeNull()
  })
})

describe('resolveToken — ficus_ prefixes only (no dual-accept)', () => {
  const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex')
  const inADay = () => new Date(Date.now() + 24 * 60 * 60 * 1000)

  test('Core mints ficus_sess_ sessions and ficus_agent_ agent tokens', async () => {
    expect(SESSION_TOKEN_PREFIX).toBe('ficus_sess_')
    expect(AGENT_TOKEN_PREFIX).toBe('ficus_agent_')
    const user = await User.create({ email: `${PREFIX}-mint-${randomUUID().slice(0, 8)}@test.local` })
    try {
      const session = await user.createSession()
      expect(session.startsWith('ficus_sess_')).toBe(true)
      expect(await resolveToken(session)).toEqual({ type: 'user', userId: user.id })
    } finally {
      await user.delete()
    }
    const { agent } = await createAgentFixture('mint')
    const { token } = await agent.createAgentToken()
    expect(token.startsWith('ficus_agent_')).toBe(true)
    expect(await resolveToken(token)).toMatchObject({ type: 'agent', agentId: agent.id })
  })

  test('a live old_sess_ session row does not authenticate', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const legacy = `old_sess_${randomUUID()}`
    await db.insert(sessions).values({ userId: user.id, tokenHash: sha256(legacy), expiresAt: inADay() })

    expect(await resolveToken(user.token)).toEqual({ type: 'user', userId: user.id })
    expect(await resolveToken(legacy)).toBeNull()
    expect(await resolveTokenContext(legacy)).toBeNull()
  })

  test('a live old_agent_ token row does not authenticate', async () => {
    const { agent, squad } = await createAgentFixture('legacy')
    const legacy = `old_agent_${randomUUID()}`
    await db.insert(agentTokens).values({ agentId: agent.id, squadId: squad.id, tokenHash: sha256(legacy) })

    expect(await resolveToken(legacy)).toBeNull()
  })

  test('a token is looked up only in the table its prefix names', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const { agent, squad } = await createAgentFixture('cross')
    // An agent-shaped value sitting in the sessions table, and a session-shaped value in
    // agent_tokens: neither may authenticate as the other kind.
    const agentShaped = `${AGENT_TOKEN_PREFIX}${randomUUID()}`
    const sessionShaped = `${SESSION_TOKEN_PREFIX}${randomUUID()}`
    await db.insert(sessions).values({ userId: user.id, tokenHash: sha256(agentShaped), expiresAt: inADay() })
    await db.insert(agentTokens).values({ agentId: agent.id, squadId: squad.id, tokenHash: sha256(sessionShaped) })

    expect(await resolveToken(agentShaped)).toBeNull()
    expect(await resolveToken(sessionShaped)).toBeNull()

    // Near-miss prefixes never widen into a real one.
    for (const raw of [`ficus_sessx${randomUUID()}`, `ficus_ses_${randomUUID()}`, `FICUS_SESS_${randomUUID()}`]) {
      await db.insert(sessions).values({ userId: user.id, tokenHash: sha256(raw), expiresAt: inADay() })
      expect(await resolveToken(raw)).toBeNull()
    }
    for (const raw of [`ficus_agentx${randomUUID()}`, `ficus_agen_${randomUUID()}`]) {
      await db.insert(agentTokens).values({ agentId: agent.id, squadId: squad.id, tokenHash: sha256(raw) })
      expect(await resolveToken(raw)).toBeNull()
    }
  })

  test('a session resolves only to the user who owns it', async () => {
    const alice = await createTestUser({ prefix: PREFIX })
    const bob = await createTestUser({ prefix: PREFIX })
    expect(await resolveToken(alice.token)).toEqual({ type: 'user', userId: alice.id })
    expect(await resolveToken(bob.token)).toEqual({ type: 'user', userId: bob.id })
  })
})

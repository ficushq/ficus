import { afterAll, beforeAll, afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { systemTokens } from '../../db/schema'
import {
  SYSTEM_TOKEN_PREFIX,
  createSystemToken,
  listSystemTokens,
  revokeSystemToken,
  resolveSystemToken,
  ensureWebhookToken,
  webhookScriptAuthEnv,
  DEFAULT_WEBHOOK_SCOPES,
} from './system-tokens'
import { resolveToken } from './resolve-token'
import { hasPermission } from '../rbac'
import { getSecretStore, resetSecretStore } from '../secrets'

const WEBHOOK_SECRET_KEY = '__SYSTEM_WEBHOOK_TOKEN'

/** Insert a system-token row for an arbitrary raw value, as a pre-rename Core would have stored it. */
async function seedSystemTokenRow(input: { raw: string; name: string; kind: 'manual' | 'webhook'; scopes?: string[] }) {
  const [row] = await db
    .insert(systemTokens)
    .values({
      name: input.name,
      tokenHash: createHash('sha256').update(input.raw).digest('hex'),
      scopes: input.scopes ?? DEFAULT_WEBHOOK_SCOPES,
      kind: input.kind,
    })
    .returning()
  return row
}

describe('system tokens', () => {
  let priorKey: string | undefined

  beforeAll(async () => {
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64) // 32-byte hex test key
    resetSecretStore()
    await getSecretStore().initialize()
  })

  afterEach(async () => {
    await db.delete(systemTokens)
    await getSecretStore()
      .delete(WEBHOOK_SECRET_KEY)
      .catch(() => {})
  })

  afterAll(() => {
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    resetSecretStore()
  })

  it('creates a token that resolves to its scopes, and revoking invalidates it', async () => {
    const { token, record } = await createSystemToken({ name: 'CI', scopes: ['inbox:system', 'workstreams:read'] })
    expect(SYSTEM_TOKEN_PREFIX).toBe('ficus_sys_')
    expect(token.startsWith('ficus_sys_')).toBe(true)

    const resolved = await resolveSystemToken(token)
    expect(resolved).toMatchObject({
      id: record.id,
      name: 'CI',
      scopes: ['inbox:system', 'workstreams:read'],
    })

    // resolveToken yields a scoped system identity with stable token ownership.
    const identity = await resolveToken(token)
    expect(identity).toEqual({
      type: 'system',
      systemTokenId: record.id,
      name: 'CI',
      scopes: ['inbox:system', 'workstreams:read'],
    })

    expect(await revokeSystemToken(record.id)).toBe(true)
    expect(await resolveSystemToken(token)).toBeNull()
    expect(await resolveToken(token)).toBeNull()
  })

  it("a system identity has exactly its assigned scopes (no '*' escalation)", async () => {
    const identity = {
      type: 'system' as const,
      systemTokenId: '00000000-0000-4000-8000-000000000001',
      name: 'test-token',
      scopes: ['inbox:system'],
    }
    expect(await hasPermission(identity, 'inbox:system')).toBe(true)
    expect(await hasPermission(identity, 'workstreams:create')).toBe(false)
    expect(await hasPermission(identity, 'users:read')).toBe(false)
  })

  it('hides webhook-kind tokens from the default list', async () => {
    await createSystemToken({ name: 'manual one', scopes: ['inbox:system'], kind: 'manual' })
    await createSystemToken({ name: 'a webhook', scopes: ['inbox:system'], kind: 'webhook' })

    const defaultList = await listSystemTokens()
    expect(defaultList.some((t) => t.kind === 'webhook')).toBe(false)
    expect(defaultList.some((t) => t.name === 'manual one')).toBe(true)

    const fullList = await listSystemTokens({ includeWebhook: true })
    expect(fullList.some((t) => t.kind === 'webhook')).toBe(true)
  })

  it('injects a scoped webhook identity bound to this Core listener', async () => {
    const previousPort = process.env.PORT
    const previousUrl = process.env.FICUS_API_URL
    try {
      process.env.PORT = '39994'
      process.env.FICUS_API_URL = 'https://another-instance.example'
      const env = await webhookScriptAuthEnv()
      expect(env.FICUS_WEBHOOK_CONTEXT).toBe('1')
      expect(env.FICUS_API_URL).toBe('http://127.0.0.1:39994')
      expect(env.FICUS_PASSWORD).toBe('')
      const identity = await resolveSystemToken(env.FICUS_TOKEN!)
      expect(identity?.scopes).toEqual(DEFAULT_WEBHOOK_SCOPES)
    } finally {
      if (previousPort === undefined) delete process.env.PORT
      else process.env.PORT = previousPort
      if (previousUrl === undefined) delete process.env.FICUS_API_URL
      else process.env.FICUS_API_URL = previousUrl
    }
  })

  it('provisions a webhook token with the default scopes and is idempotent', async () => {
    const first = await ensureWebhookToken()
    expect(first).toBeTruthy()
    const resolved = await resolveSystemToken(first!)
    expect(DEFAULT_WEBHOOK_SCOPES).toContain('agents:read')
    expect(resolved?.scopes).toEqual(DEFAULT_WEBHOOK_SCOPES)
    expect(resolved?.scopes).toContain('agents:read')
    expect(
      await hasPermission(
        { type: 'system', systemTokenId: resolved!.id, name: resolved!.name, scopes: resolved!.scopes },
        'agents:read'
      )
    ).toBe(true)

    // Same token returned while it remains valid (no churn/spam).
    const second = await ensureWebhookToken()
    expect(second).toBe(first)
  })

  it('self-heals an existing webhook token that is missing newly required default scopes', async () => {
    const legacyScopes = ['inbox:system', 'squads:read', 'workstreams:read', 'workstreams:create', 'workstreams:update']
    const { token } = await createSystemToken({ name: 'Webhook automation', scopes: legacyScopes, kind: 'webhook' })
    await getSecretStore().set(WEBHOOK_SECRET_KEY, token, 'system')

    const ensured = await ensureWebhookToken()

    expect(ensured).toBe(token)
    const resolved = await resolveSystemToken(token)
    expect(resolved?.scopes).toEqual(DEFAULT_WEBHOOK_SCOPES)
    expect(resolved?.scopes).toContain('agents:read')

    // Same healed token returned after scopes are current (no repeated writes/churn).
    const second = await ensureWebhookToken()
    expect(second).toBe(token)
  })

  it('rejects a pre-rename tau_sys_ token even though its row is live (no dual-accept)', async () => {
    const legacy = 'tau_sys_' + 'a'.repeat(43)
    await seedSystemTokenRow({ raw: legacy, name: 'platform-orchestrator', kind: 'manual' })
    expect(await resolveSystemToken(legacy)).toBeNull()
    expect(await resolveToken(legacy)).toBeNull()
  })

  it('never resolves a token whose prefix only resembles the system prefix', async () => {
    const secret = 'b'.repeat(43)
    for (const raw of [`ficus_sysx${secret}`, `ficus_sy_${secret}`, `ficus_dev_${secret}`, `FICUS_SYS_${secret}`]) {
      await seedSystemTokenRow({ raw, name: 'CI', kind: 'manual' })
      expect(await resolveSystemToken(raw)).toBeNull()
      expect(await resolveToken(raw)).toBeNull()
    }
  })

  it('webhook token with a legacy prefix is re-minted and the old row revoked', async () => {
    const legacy = 'tau_sys_' + 'a'.repeat(43)
    const stale = await seedSystemTokenRow({ raw: legacy, name: 'Webhook automation', kind: 'webhook' })
    await getSecretStore().set(WEBHOOK_SECRET_KEY, legacy, 'system')

    const fresh = await ensureWebhookToken()

    expect(fresh?.startsWith('ficus_sys_')).toBe(true)
    expect(await resolveSystemToken(legacy)).toBeNull()
    const [staleAfter] = await db.select().from(systemTokens).where(eq(systemTokens.id, stale.id))
    expect(staleAfter.revokedAt).not.toBeNull()
    expect(getSecretStore().get(WEBHOOK_SECRET_KEY)).toBe(fresh!)
    const resolved = await resolveSystemToken(fresh!)
    expect(resolved?.scopes).toEqual(DEFAULT_WEBHOOK_SCOPES)
    // The healed token is what webhook scripts now receive, and it is stable.
    expect((await webhookScriptAuthEnv()).FICUS_TOKEN).toBe(fresh!)
    expect(await ensureWebhookToken()).toBe(fresh!)
    const active = (await listSystemTokens({ includeWebhook: true })).filter((t) => !t.revokedAt)
    expect(active.map((t) => t.id)).toEqual([resolved!.id])
  })

  it('re-mints a stored webhook token that lacks the current prefix even when its row was already revoked', async () => {
    const legacy = 'tau_sys_' + 'c'.repeat(43)
    const stale = await seedSystemTokenRow({ raw: legacy, name: 'Webhook automation', kind: 'webhook' })
    await revokeSystemToken(stale.id)
    await getSecretStore().set(WEBHOOK_SECRET_KEY, legacy, 'system')

    const fresh = await ensureWebhookToken()

    expect(fresh?.startsWith(SYSTEM_TOKEN_PREFIX)).toBe(true)
    expect(await resolveSystemToken(fresh!)).not.toBeNull()
  })

  it('the webhook self-heal takes no caller input', () => {
    // It is reachable only from verified webhook handlers, and it can only replace the
    // stored secret with a fresh token it never returns to an HTTP caller.
    expect(ensureWebhookToken.length).toBe(0)
  })
})

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'bun:test'
import { db } from '../../db'
import { systemTokens } from '../../db/schema'
import {
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
})

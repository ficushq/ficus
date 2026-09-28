/**
 * Provider Auth API
 *
 * Manages AI provider credentials (API keys and OAuth tokens) stored
 * encrypted in the database via SecretStore. These credentials are used
 * by the ModelRuntime when creating agent sessions.
 *
 * Supports both API key and OAuth flows:
 * - API keys: PUT /:provider with { key: "..." }
 * - OAuth: POST /:provider/oauth/start → returns authUrl → user authenticates →
 *          POST /:provider/oauth/callback with { code: "..." } → credentials stored
 *
 * The underlying storage is a single JSON blob in PROVIDER_AUTH_DATA,
 * but this API exposes a per-provider interface.
 */
import { Hono } from 'hono'
import { isAccountUsable } from '../services/agent/account-usable'
import { asc } from 'drizzle-orm'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import {
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
} from '@earendil-works/pi-ai'
import { providerLabel, resolveProviderHealthRecord, type ProviderHealthKind } from '@ficus/shared'
import { db, modelTiers } from '../db'
import { detectLocalServers, probeOpenAICompatible } from '../services/model-selection/openai-compatible'
import { getModelRuntime, refreshModelRuntime, tryGetModelRuntime } from '../services/agent/auth-backend'
import {
  claudeCodeOffered,
  getClaudeCodeStatus,
  invalidateClaudeCodeStatus,
  type ClaudeCodeStatus,
} from '../services/agent/claude-code/availability'
import {
  CLAUDE_CODE_ACCOUNT_ID,
  claudeCodeAccount,
  setClaudeCodeAccountEnabled,
} from '../services/agent/claude-code/account'
import { SecretDecryptError } from '../services/secrets'
import {
  addAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  mutateAccountStore,
  persistOAuthCredential,
  isClaudeSubscriptionToken,
  readAccountStore,
  reorderAccounts,
  updateAccount,
  type Account,
  type OAuthPersistResult,
} from '../services/agent/account-store'
import {
  getOpenRouterExpansionStateForCurrentEnv,
  inspectOpenRouterFallbacks,
  isProviderDisabled,
  setOpenRouterTierExpansionEnabled,
  setProviderEnabled,
} from '../services/model-selection'
import { providerHealth } from '../services/provider-health/registry'
import { createLogger } from '../lib/infra/logger'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import { requirePermission } from '../middleware/require-permission'
import { auditActor, type Identity } from '../services/rbac'

const log = createLogger('provider-auth')

const app = new Hono()

class TransientCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>()

  async read(providerId: string): Promise<Credential | undefined> {
    return this.credentials.get(providerId)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.credentials.entries()].map(([providerId, credential]) => ({ providerId, type: credential.type }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    const current = this.credentials.get(providerId)
    const next = await fn(current)
    if (next === undefined) return current
    this.credentials.set(providerId, next)
    return next
  }

  async delete(providerId: string): Promise<void> {
    this.credentials.delete(providerId)
  }
}

async function createOAuthLoginRuntime(source: ModelRuntime): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ credentials: new TransientCredentialStore(), allowModelNetwork: false })
  for (const providerId of source.getRegisteredProviderIds()) {
    const config = source.getRegisteredProviderConfig(providerId)
    if (config) runtime.registerProvider(providerId, config)
  }
  return runtime
}

/**
 * Whether any form of auth (stored key, OAuth token, or environment variable)
 * is available for a provider. Uses the same ModelRuntime the model-selection
 * chokepoint uses, so the UI's `configured` flag stays consistent with which
 * providers fallback selection considers usable.
 */
export function isProviderConfigured(provider: string): boolean {
  const accounts = listAccounts(readAccountStore(), provider)
  return accounts.some(isAccountUsable) || (tryGetModelRuntime()?.hasConfiguredAuth(provider) ?? false)
}

export function accountSummary(provider: string, account: Account) {
  const health = resolveProviderHealthRecord({ provider, accountId: account.id }, providerHealth.snapshotRecords())
  return {
    id: account.id,
    label: account.label,
    enabled: account.enabled,
    type: account.credential.type,
    hasCredential: true,
    health: health ? 'exhausted' : 'available',
    retryAt: health?.retryAt,
    // The WHY behind an exhausted row — a rate limit and an invalid credential
    // need different operator responses, so the UI must not flatten them.
    healthReason: health?.kind,
    healthMessage: health?.message,
    lastUsedAt: account.lastUsedAt,
    kind: account.kind,
    providerId: account.providerId,
    baseUrl: account.baseUrl,
    model: account.model,
    capabilities: account.capabilities,
  }
}

function providerSummary(provider: string, accounts: Account[]) {
  const summaries = accounts.map((account) => accountSummary(provider, account))
  const first = accounts[0]
  const records = providerHealth.snapshotRecords()
  const providerRecord = resolveProviderHealthRecord({ provider }, records)
  const anyObservedAvailable = accounts.some(
    (account) => account.enabled && !resolveProviderHealthRecord({ provider, accountId: account.id }, records)
  )
  const exhausted = accounts.length > 0 ? !anyObservedAvailable : providerRecord != null
  // Report the record that actually makes the provider unusable: an exhausted
  // account first (that is what routing trips over), else the provider record.
  const exhaustedAccount = exhausted ? summaries.find((account) => account.health === 'exhausted') : undefined
  const retryAt = exhausted ? (exhaustedAccount?.retryAt ?? providerRecord?.retryAt) : undefined
  const healthReason = exhausted ? (exhaustedAccount?.healthReason ?? providerRecord?.kind) : undefined
  const healthMessage = exhausted ? (exhaustedAccount?.healthMessage ?? providerRecord?.message) : undefined
  return {
    provider,
    type: first?.credential.type,
    hasCredential: accounts.length > 0,
    configured: isProviderConfigured(provider),
    disabled: isProviderDisabled(provider),
    health: exhausted ? 'exhausted' : 'available',
    retryAt,
    healthReason,
    healthMessage,
    accounts: summaries,
  }
}

function apiKeyCredential(key: string): Credential {
  return { type: 'api_key', key }
}

const CLAUDE_SUBSCRIPTION_TOKEN_REFUSED = {
  error:
    'Claude subscription tokens (sk-ant-oat…) cannot be used here: Anthropic only permits them in its own apps. Add an Anthropic API key from platform.claude.com instead.',
}

// --- Pending OAuth flows ---
type OAuthNeed =
  | { kind: 'starting' }
  | { kind: 'code'; authUrl: string; instructions?: string }
  | { kind: 'device_code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { kind: 'select'; message: string; options: { id: string; label: string }[] }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

// When a user starts an OAuth flow, we stash promise resolvers so the
// callback/select endpoints can complete it, and track `need` — what the
// flow is currently waiting on — for the frontend to poll and render.
type PendingOAuth = {
  need: OAuthNeed
  // Intent for the completion write:
  // - set → REAUTHORIZE this exact existing account in place.
  // - undefined → ADD a new account (identity-dedupe may fold it into an
  //   existing same-upstream account; otherwise it is appended).
  accountId?: string
  /**
   * Set when this flow has been replaced by a newer one for the same provider.
   *
   * THE guarantee that a stale flow never writes. Cancelling by rejecting the
   * manual-code promise only aborts a login that is currently awaiting
   * `interaction.prompt` — device-code logins (xAI, codex's headless "Device
   * code login", radius) notify once and then poll, so they never await it and
   * would otherwise run to completion and persist against their now-irrelevant
   * target. The completion handler checks this flag and skips the persist
   * entirely, which needs no cooperation from the provider's login shape.
   */
  superseded?: boolean
  /** Why the flow was retired, surfaced to the user instead of a generic error. */
  supersededReason?: string
  /** Aborts the login itself (pi-ai honors it in its polling loops). */
  abort: AbortController
  resolveCode: (code: string) => void
  rejectCode: (err: Error) => void
  resolveSelect?: (optionId: string | undefined) => void
  rejectSelect?: (err: Error) => void
  completed: Promise<void>
  progress: string[]
  startedAt: number
}
const pendingFlows = new Map<string, PendingOAuth>()

/** Age at which an abandoned flow is swept. */
const STALE_FLOW_MS = 10 * 60 * 1000
/** How long /oauth/callback waits for the login to finish after the code is submitted. */
let oauthCallbackTimeoutMs = 30_000

/**
 * Test-only override for {@link oauthCallbackTimeoutMs}: a regression test for
 * the timeout path would otherwise cost 30s of wall clock. Returns a restore fn.
 */
export function setOAuthCallbackTimeoutForTests(ms: number): () => void {
  const previous = oauthCallbackTimeoutMs
  oauthCallbackTimeoutMs = ms
  return () => {
    oauthCallbackTimeoutMs = previous
  }
}

/**
 * THE ONLY way a flow may leave `pendingFlows`.
 *
 * Four review rounds each found a different code path that dropped a flow from
 * the map without retiring it, after which the still-running login completed and
 * wrote to an account the user never chose. The paths differed; the shape never
 * did. So removal and retirement are fused here and `pendingFlows.delete` appears
 * exactly once in this file (pinned by a test) — a future caller cannot express
 * "remove but forget to retire", because there is no such operation.
 *
 * Retiring:
 * - sets `superseded`, which the completion handler checks before persisting.
 *   This is THE guarantee, and it is the only part that holds for every provider
 *   shape (a device-code login notices neither of the next two promptly).
 * - aborts the login via its AbortSignal (pi-ai honors it in polling loops).
 * - rejects the code/select promises to unblock a cooperative login.
 *
 * Removal is identity-scoped: a predecessor's late callback must never evict the
 * successor flow the user is currently looking at.
 *
 * Safe on an already-completed flow: the completion handler has run by then, so
 * setting the flag is inert, and aborting/rejecting settled promises is a no-op.
 */
function retireAndRemove(provider: string, flow: PendingOAuth, reason: string) {
  flow.superseded = true
  flow.supersededReason = reason
  flow.abort.abort()
  flow.rejectCode(new Error(reason))
  flow.rejectSelect?.(new Error(reason))
  // The ONE sanctioned removal: retirement above has already happened, so the
  // login this entry owns can no longer persist. Every other call site is a lint
  // error (see eslint.config.mjs) precisely to keep that ordering non-optional.
  // eslint-disable-next-line no-restricted-syntax
  if (pendingFlows.get(provider) === flow) pendingFlows.delete(provider)
}

/**
 * Record a retired flow's outcome on the flow itself: nothing was written, and
 * the user needs to log in again. Used by both places that can observe the
 * retirement — the write-lock guard (login completed but lost the race) and the
 * login rejection (the abort from `retireAndRemove` surfaced first).
 */
function reportRetiredFlow(provider: string, flow: PendingOAuth) {
  const reason = flow.supersededReason ?? 'OAuth flow was superseded'
  flow.need = { kind: 'error', message: `${reason} — nothing was saved. Log in again to retry.` }
  log.warn(`OAuth flow discarded for ${provider}: ${flow.supersededReason ?? 'superseded'} before completion`)
}

/**
 * Retire the provider's pending flow when it targets an account that is being
 * deleted (or `any: true` when every account for the provider goes).
 *
 * Defence in depth, not the guarantee: persistOAuthCredential re-validates the
 * target under the write lock, so a flow that survives here still cannot write
 * to a stale or recycled id. This just stops a doomed login early and frees the
 * provider slot instead of leaving it parked until someone starts another flow.
 */
function retireFlowsTargeting(provider: string, accountId: string | undefined, options?: { any?: boolean }) {
  const flow = pendingFlows.get(provider)
  if (!flow) return
  if (!options?.any && flow.accountId !== accountId) return
  if (options?.any && flow.accountId == null) return // an ADD targets no account
  retireAndRemove(provider, flow, 'The account this login was re-authorizing was deleted')
}

// Clean up stale flows (older than 10 minutes)
function cleanupStaleFlows() {
  const now = Date.now()
  for (const [key, flow] of pendingFlows) {
    if (now - flow.startedAt > STALE_FLOW_MS) {
      retireAndRemove(key, flow, 'OAuth flow timed out')
    }
  }
}

/** Explicit opt-in and read-only coverage for universal OpenRouter tier fallbacks. */
app.get('/openrouter/routing', requirePermission('provider-auth:read'), async (c) => {
  const tiers = await db
    .select({ slug: modelTiers.slug, label: modelTiers.label, chain: modelTiers.chain, disabled: modelTiers.disabled })
    .from(modelTiers)
    .orderBy(asc(modelTiers.sortOrder))
  const summaries = tiers
    .filter((tier) => !tier.disabled)
    .map((tier) => ({
      slug: tier.slug,
      label: tier.label,
      fallbacks: inspectOpenRouterFallbacks(tier.chain).fallbacks,
    }))
  const vendors = [
    ...new Set(
      summaries.flatMap((tier) => tier.fallbacks.map((spec) => spec.slice('openrouter:'.length).split('/', 1)[0]))
    ),
  ]
  const auth = providerSummary('openrouter', listAccounts(readAccountStore(), 'openrouter'))
  const expansion = getOpenRouterExpansionStateForCurrentEnv()
  return c.json({
    enabled: expansion.enabled,
    active: expansion.active,
    configured: auth.configured,
    health: auth.health,
    tiers: summaries,
    vendors,
  })
})

app.put('/openrouter/routing', requirePermission('provider-auth:write'), async (c) => {
  const body = await c.req.json<{ enabled?: boolean }>()
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'Missing boolean "enabled" in request body' }, 400)
  await setOpenRouterTierExpansionEnabled(body.enabled, auditActor(c.get('identity') as Identity))
  return c.json({ enabled: body.enabled })
})

/** List available OAuth providers */
/**
 * The user's own Claude Code (`claude`) for agents: offered wherever Core runs on the user's machine
 * (not Ficus Cloud) as an account of the Anthropic provider, off until the owner turns it on.
 * Status only — Claude Code keeps its own sign-in; Ficus never sees it.
 */
function claudeCodeStatusJson(status: ClaudeCodeStatus) {
  return {
    offered: status.offered,
    enabled: status.enabled,
    installed: Boolean(status.executable),
    ...(status.executable ? { path: status.executable } : {}),
    loggedIn: status.loggedIn,
    ...(status.version ? { version: status.version } : {}),
    ...(status.authMethod ? { authMethod: status.authMethod } : {}),
    ...(status.subscriptionType ? { subscriptionType: status.subscriptionType } : {}),
    ...(status.reason ? { reason: status.reason } : {}),
  }
}

app.get('/claude-code/status', requirePermission('provider-auth:read'), async (c) => {
  const refresh = c.req.query('refresh') === '1'
  const status = await getClaudeCodeStatus({ refresh })
  if (refresh) {
    // A sign-in failure parks the Claude Code account; checking again after signing in clears it.
    if (status.loggedIn && claudeCodeAccount()) providerHealth.markAccountAvailable('anthropic', CLAUDE_CODE_ACCOUNT_ID)
    await refreshModelRuntime()
  }
  return c.json(claudeCodeStatusJson(status))
})

app.put('/claude-code/enabled', requirePermission('provider-auth:write'), async (c) => {
  const body = await parseOptionalJsonObjectBody<{ enabled?: unknown }>(c, {})
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'Missing boolean "enabled" in request body' }, 400)
  if (!claudeCodeOffered()) return c.json({ error: 'Claude Code is not available on Ficus Cloud' }, 409)
  try {
    await setClaudeCodeAccountEnabled(body.enabled, auditActor(c.get('identity') as Identity))
  } catch (error) {
    if (error instanceof SecretDecryptError)
      return c.json({ error: 'AI provider accounts cannot be updated: ' + error.message }, 500)
    throw error
  }
  const status = await getClaudeCodeStatus({ refresh: true })
  await refreshModelRuntime()
  return c.json(claudeCodeStatusJson(status))
})

app.get('/oauth/providers', requirePermission('provider-auth:read'), async (c) => {
  const runtime = await getModelRuntime()
  const oauthProviders = runtime.getProviders().filter((p) => p.auth.oauth)
  const providers = oauthProviders.map((p) => ({
    id: p.id,
    name: p.auth.oauth!.name,
  }))
  return c.json(providers)
})

/** List the full provider catalog from the model runtime. */
app.get('/catalog', requirePermission('provider-auth:read'), async (c) => {
  const runtime = await getModelRuntime()
  const oauthIds = new Set(
    runtime
      .getProviders()
      .filter((p) => p.auth.oauth)
      .map((p) => p.id)
  )
  const providers = runtime.getProviders().map((p) => ({
    id: p.id,
    label: providerLabel(p.id),
    modelCount: runtime.getModels(p.id).length,
    oauthAvailable: oauthIds.has(p.id),
    disabled: isProviderDisabled(p.id),
  }))
  providers.sort((a, b) => a.label.localeCompare(b.label))
  return c.json(providers)
})

/** List all providers with auth status (no keys/tokens exposed) */
app.get('/', requirePermission('provider-auth:read'), (c) => {
  const store = readAccountStore()
  const providers = Object.entries(store.accounts)
    .filter(([, accounts]) => accounts.length > 0)
    .map(([provider, accounts]) => providerSummary(provider, accounts))
  return c.json(providers)
})

/** List accounts for a provider (no secrets exposed). */
app.get('/:provider/accounts', requirePermission('provider-auth:read'), (c) => {
  const provider = c.req.param('provider')
  const accounts = listAccounts(readAccountStore(), provider).map((account) => accountSummary(provider, account))
  return c.json(accounts)
})

/** Add an API-key account for a provider. */
/** Explicit local discovery; never invoked by startup or a background task. */
app.post('/openai-compatible/detect', requirePermission('provider-auth:read'), async (c) =>
  c.json(await detectLocalServers())
)
app.post('/openai-compatible/probe', requirePermission('provider-auth:write'), async (c) => {
  const body = await c.req.json()
  if (!body.baseUrl || !body.model) return c.json({ error: 'baseUrl and model are required' }, 400)
  try {
    return c.json({
      ...(await probeOpenAICompatible({ baseUrl: body.baseUrl, model: body.model, apiKey: body.apiKey })),
      contextWindowFloor: Number(process.env.MODEL_CONTEXT_WINDOW_FLOOR ?? 16384),
    })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})
app.post('/openai-compatible/accounts', requirePermission('provider-auth:write'), async (c) => {
  const body = await c.req.json()
  if (!body.baseUrl || !body.model || !body.providerId)
    return c.json({ error: 'baseUrl, model, and providerId are required' }, 400)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.providerId))
    return c.json({ error: 'providerId must be kebab-case' }, 400)
  if (isClaudeSubscriptionToken(body.apiKey)) return c.json(CLAUDE_SUBSCRIPTION_TOKEN_REFUSED, 400)
  try {
    const result = await probeOpenAICompatible({ baseUrl: body.baseUrl, model: body.model, apiKey: body.apiKey })
    let created: Account | undefined
    await mutateAccountStore(
      (store) => {
        if (store.accounts[body.providerId]?.length) throw new Error(`Provider '${body.providerId}' already exists`)
        created = addAccount(store, body.providerId, apiKeyCredential(body.apiKey ?? ''), body.label)
        Object.assign(created!, {
          kind: 'openai-compatible',
          providerId: body.providerId,
          baseUrl: body.baseUrl,
          model: body.model,
          capabilities: result.capabilities,
        })
      },
      auditActor(c.get('identity') as Identity)
    )
    await refreshModelRuntime()
    return c.json({ account: accountSummary(body.providerId, created!), models: result.models }, 201)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.post('/:provider/accounts', requirePermission('provider-auth:write'), async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json<{ key?: string; label?: string }>()
  const key = body.key
  if (!key) return c.json({ error: 'Missing "key" in request body' }, 400)
  if (isClaudeSubscriptionToken(key)) return c.json(CLAUDE_SUBSCRIPTION_TOKEN_REFUSED, 400)

  let account!: Account
  await mutateAccountStore(
    (store) => {
      account = addAccount(store, provider, apiKeyCredential(key), body.label)
    },
    auditActor(c.get('identity') as Identity)
  )
  void refreshModelRuntime()
  return c.json(accountSummary(provider, account))
})

/**
 * Reorder a provider's accounts — array order is the user's selection
 * preference order (see account-selection.ts). `order` must be an exact
 * permutation of the provider's existing account ids. Registered before the
 * `/:provider/accounts/:accountId` route so `order` never matches as an id.
 */
app.put('/:provider/accounts/order', requirePermission('provider-auth:write'), async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json<{ order?: unknown }>()
  if (!Array.isArray(body.order) || !body.order.every((id) => typeof id === 'string')) {
    return c.json({ error: 'Missing "order" array of account ids in request body' }, 400)
  }
  const order = body.order as string[]

  let accounts: Account[] = []
  try {
    await mutateAccountStore(
      (store) => {
        reorderAccounts(store, provider, order)
        accounts = listAccounts(store, provider)
      },
      auditActor(c.get('identity') as Identity)
    )
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid account order' }, 400)
  }
  void refreshModelRuntime()
  return c.json(accounts.map((account) => accountSummary(provider, account)))
})

/** Update account metadata. */
app.put('/:provider/accounts/:accountId', requirePermission('provider-auth:write'), async (c) => {
  const provider = c.req.param('provider')
  const accountId = c.req.param('accountId')
  const body = await c.req.json<{ label?: string; enabled?: boolean }>()
  let account: Account | undefined
  await mutateAccountStore(
    (store) => {
      account = updateAccount(store, provider, accountId, { label: body.label, enabled: body.enabled })
      if (!account) return false // nothing to write
    },
    auditActor(c.get('identity') as Identity)
  )
  if (!account) return c.json({ error: 'Account not found' }, 404)
  void refreshModelRuntime()
  return c.json(accountSummary(provider, account))
})

/** Delete a single account. */
app.delete('/:provider/accounts/:accountId', requirePermission('provider-auth:write'), async (c) => {
  const provider = c.req.param('provider')
  const accountId = c.req.param('accountId')
  let deleted = false
  await mutateAccountStore(
    (store) => {
      deleted = deleteAccount(store, provider, accountId)
      return deleted // skip the write when nothing was removed
    },
    auditActor(c.get('identity') as Identity)
  )
  if (!deleted) return c.json({ error: 'Account not found' }, 404)
  // Account ids are recycled, so a pending reauthorize aimed at this id must not
  // be left running to meet a future account wearing the same id.
  retireFlowsTargeting(provider, accountId)
  void refreshModelRuntime()
  return c.json({ provider, accountId, deleted: true })
})

/**
 * Health kinds a reset must never clear.
 *
 * A bad or expired credential is not a cooldown waiting to elapse — routing
 * already treats those records as ready (see routeDecision), so the record is
 * purely the operator's remediation signal. Clearing it would hide the one
 * thing that tells them to re-authorize, and the account would still fail.
 */
const CREDENTIAL_HEALTH_KINDS: readonly ProviderHealthKind[] = ['invalid-credential', 'expired-oauth']
const CREDENTIAL_HEALTH_ERROR = {
  error: 'Re-authorize this account instead of resetting its health',
  code: 'credential_health',
} as const

function isCredentialHealth(provider: string, accountId?: string): boolean {
  const record = resolveProviderHealthRecord({ provider, accountId }, providerHealth.snapshotRecords())
  return record != null && CREDENTIAL_HEALTH_KINDS.includes(record.kind)
}

/**
 * Clear a provider's exhaustion records early.
 *
 * Cooldowns are an estimate: when a provider's window resets ahead of the
 * `retryAt` Ficus recorded, the operator would otherwise have to wait out a
 * window that is already over. This clears the provider record AND every one of
 * its accounts, since an exhausted account keeps the provider unusable on its
 * own. Nothing is asserted about the upstream state — the next failure re-marks
 * exhaustion immediately.
 *
 * Credential-kind records are left alone and reported back in
 * `skippedCredentialHealth` rather than failing the whole call, so one account
 * that needs re-authorizing does not block clearing the others.
 */
app.post('/:provider/health/reset', requirePermission('provider-auth:write'), (c) => {
  const provider = c.req.param('provider')
  const accounts = listAccounts(readAccountStore(), provider)
  // Env-var providers hold no account rows, yet failures still record
  // provider-level health against them — they must be resettable too.
  const known = accounts.length > 0 || isProviderConfigured(provider) || providerHealth.getRecord(provider) != null
  if (!known) return c.json({ error: 'Provider not found' }, 404)

  const skippedProvider = isCredentialHealth(provider)
  if (!skippedProvider) providerHealth.markAvailable(provider)
  const skippedAccounts: string[] = []
  for (const account of accounts) {
    if (isCredentialHealth(provider, account.id)) skippedAccounts.push(account.id)
    else providerHealth.markAccountAvailable(provider, account.id)
  }
  return c.json({
    ...providerSummary(provider, accounts),
    skippedCredentialHealth: { provider: skippedProvider, accounts: skippedAccounts },
  })
})

/** Clear one account's exhaustion record early (see the provider route above). */
app.post('/:provider/accounts/:accountId/health/reset', requirePermission('provider-auth:write'), (c) => {
  const provider = c.req.param('provider')
  const accountId = c.req.param('accountId')
  const accounts = listAccounts(readAccountStore(), provider)
  const account = accounts.find((candidate) => candidate.id === accountId)
  if (!account) return c.json({ error: 'Account not found' }, 404)
  // Claude Code has no credential to re-authorize here: it is fixed on this machine (sign in,
  // update), so its credential health may be reset directly, after a fresh status check.
  if (account.kind === 'claude-code') invalidateClaudeCodeStatus()
  else if (isCredentialHealth(provider, accountId)) return c.json(CREDENTIAL_HEALTH_ERROR, 409)
  providerHealth.markAccountAvailable(provider, accountId)
  return c.json(providerSummary(provider, accounts))
})

/** Get auth type for a specific provider (no key exposed) */
app.get('/:provider', requirePermission('provider-auth:read'), (c) => {
  const provider = c.req.param('provider')
  const accounts = listAccounts(readAccountStore(), provider)
  if (accounts.length === 0) return c.json({ provider, hasCredential: false }, 404)
  return c.json(providerSummary(provider, accounts))
})

/** Set an API key for a provider (legacy endpoint; upserts a default account). */
app.put('/:provider', requirePermission('provider-auth:write'), async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json<{ type?: string; key?: string }>()
  const key = body.key
  if (!key) {
    return c.json({ error: 'Missing "key" in request body' }, 400)
  }
  if (isClaudeSubscriptionToken(key)) return c.json(CLAUDE_SUBSCRIPTION_TOKEN_REFUSED, 400)

  await mutateAccountStore(
    (store) => {
      const accounts = listAccounts(store, provider)
      // Upsert the legacy single default account (`acc_migrated`) in place, but
      // ONLY when it is itself an api_key account. If the sole account is an
      // OAuth `acc_migrated` (a legacy migrated OAuth login), overwriting it
      // here would silently destroy the OAuth credential — append a separate
      // api_key account instead. Never clobber any OAuth account with an api key.
      const legacyApiKey =
        accounts.length === 1 && accounts[0].id === 'acc_migrated' && accounts[0].credential.type === 'api_key'
          ? accounts[0]
          : undefined
      if (accounts.length === 0) {
        store.accounts[provider] = [{ id: 'acc_migrated', enabled: true, credential: apiKeyCredential(key) }]
      } else if (legacyApiKey) {
        legacyApiKey.credential = apiKeyCredential(key)
        legacyApiKey.enabled = true
      } else {
        addAccount(store, provider, apiKeyCredential(key))
      }
    },
    auditActor(c.get('identity') as Identity)
  )
  void refreshModelRuntime()
  return c.json({ provider, updated: true })
})

/** Remove auth for a provider (legacy endpoint; deletes all accounts). */
app.delete('/:provider', requirePermission('provider-auth:write'), async (c) => {
  const provider = c.req.param('provider')
  await mutateAccountStore(
    (store) => {
      delete store.accounts[provider]
    },
    auditActor(c.get('identity') as Identity)
  )
  // Every account for this provider is gone, so any pending REAUTHORIZE is aimed
  // at an id that can only be recreated by recycling.
  retireFlowsTargeting(provider, undefined, { any: true })
  void refreshModelRuntime()
  return c.json({ provider, deleted: true })
})

/**
 * Enable or disable a provider globally for model fallback selection.
 * Disabling does NOT delete credentials; re-enabling reuses the existing
 * credential.
 */
app.put('/:provider/enabled', requirePermission('provider-auth:write'), async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json<{ enabled?: boolean }>()
  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'Missing boolean "enabled" in request body' }, 400)
  }
  await setProviderEnabled(provider, body.enabled)
  return c.json({ provider, enabled: body.enabled })
})

app.post('/:provider/oauth/cancel', requirePermission('provider-auth:write'), (c) => {
  const provider = c.req.param('provider')
  const flow = pendingFlows.get(provider)
  if (flow) retireAndRemove(provider, flow, 'OAuth login cancelled')
  return c.json({ ok: true })
})

/**
 * Start an OAuth login flow for a provider.
 *
 * Returns the authorization URL that the user should open in their browser.
 * After authenticating, the user receives a code to paste back via the
 * callback endpoint.
 *
 * The actual OAuth flow runs server-side via ModelRuntime.login() with an
 * AuthInteraction that bridges the SDK's prompt/notify callbacks onto the
 * existing HTTP-polling bridge (pendingFlows / resolveCode / resolveSelect).
 */
app.post('/:provider/oauth/start', requirePermission('provider-auth:write'), async (c) => {
  const provider = c.req.param('provider')
  cleanupStaleFlows()

  // Optional REAUTHORIZE intent: `accountId` targets an existing account whose
  // credential is refreshed in place on completion. Absent → ADD a new account.
  // POST body is optional (the ADD case sends none), so tolerate a missing body.
  const body = await parseOptionalJsonObjectBody<{ accountId?: string }>(c, {})
  const accountId = typeof body.accountId === 'string' && body.accountId.length > 0 ? body.accountId : undefined

  if (!(await getModelRuntime()).getProviders().some((p) => p.id === provider && p.auth.oauth))
    return c.json(
      provider === 'anthropic'
        ? {
            error:
              'Claude Pro/Max login is not available: Anthropic does not permit third-party products to use Claude subscriptions. Add an Anthropic API key instead.',
          }
        : { error: `Provider "${provider}" has no OAuth login` },
      400
    )

  // Fail fast on a reauthorize whose target cannot legally receive an OAuth
  // credential, rather than running a whole round-trip whose completion would
  // then destroy the account's real credential.
  if (accountId != null) {
    const target = getAccount(readAccountStore(), provider, accountId)
    if (!target) {
      return c.json({ error: `Account "${accountId}" not found for provider "${provider}"` }, 404)
    }
    // An OAuth login must never overwrite an api_key account — persisting one
    // here would silently destroy the stored key. (Mirror of the api-key PUT
    // guard, which likewise refuses to clobber an OAuth account.)
    if (target.credential.type !== 'oauth') {
      return c.json(
        {
          error: `Account "${accountId}" is an ${target.credential.type} account and cannot be re-authorized via OAuth`,
        },
        400
      )
    }
  }

  // Check if there's already a pending flow that has surfaced a need.
  //
  // pendingFlows is keyed by PROVIDER ONLY, but a flow now carries the intent
  // (which account the completion writes to). Reusing a pending flow across a
  // DIFFERENT intent would make the new caller inherit the old caller's target:
  // an abandoned "Re-authorize acc_PRIMARY" flow (for example, after closing
  // the tab without cancelling) would otherwise be handed to an "Add account" click,
  // and logging in as a DIFFERENT upstream account would replace the primary
  // credential — the very clobber this endpoint's intent plumbing exists to
  // prevent. Only reuse a flow whose intent matches; otherwise supersede it.
  //
  // Retiring does NOT rely on the login noticing: the abort signal and the
  // rejected code promise merely stop cooperative logins early (a device-code
  // login parked in its polling loop notices neither promptly). What actually
  // guarantees a retired flow never persists is the `superseded` flag, which the
  // completion handler checks before writing.
  const existing = pendingFlows.get(provider)
  if (existing) {
    if (existing.accountId === accountId && existing.need.kind !== 'starting') {
      return c.json({ provider, need: existing.need, status: 'already_started' })
    }
    // Either a different intent (stale/abandoned flow) or a same-intent restart
    // of a flow still stuck in 'starting'. Both are being replaced here, so
    // retire the old one — otherwise it is orphaned: dropped from the map (and
    // thus invisible to cleanupStaleFlows, which only sweeps the map) yet still
    // running, and still able to persist on completion.
    retireAndRemove(provider, existing, 'OAuth flow superseded by a new login request')
  }

  // Create a promise that will be resolved when the user provides the code
  let resolveCode!: (code: string) => void
  let rejectCode!: (err: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // A login that never prompts (device-code shapes) leaves this promise without
  // a consumer, so retiring the flow would reject it with nothing attached and
  // surface a bare unhandled-rejection line in the logs. Keep a no-op handler so
  // cancellation is silent; the real code path still awaits `codePromise` itself.
  codePromise.catch(() => {})

  const pending: PendingOAuth = {
    need: { kind: 'starting' },
    accountId,
    abort: new AbortController(),
    resolveCode,
    rejectCode,
    completed: Promise.resolve(), // will be replaced
    progress: [],
    startedAt: Date.now(),
  }

  // Claim the provider slot NOW, before the awaits below. `pendingFlows.get`
  // above and `.set` below are separated by a runtime build that measurably
  // takes milliseconds; a second /oauth/start landing inside that window would
  // otherwise find no existing flow to retire, and whichever call set the map
  // last would silently orphan the other — un-retired, and free to write.
  // Installing here makes the window a race that the loser DETECTS (below)
  // rather than one that silently drops a live flow.
  pendingFlows.set(provider, pending)

  // Use a transient credential store for the OAuth login runtime: pi-ai's
  // ModelRuntime.login persists into its CredentialStore, but provider-auth
  // must be the only durable writer so multi-account merges stay serialized and
  // existing accounts are never overwritten. Copy runtime-registered providers
  // from the singleton so test/custom OAuth providers remain visible.
  // If the build throws, the slot we just claimed would otherwise be left holding
  // a PHANTOM: need='starting', completed already resolved, never retired — so
  // /oauth/callback would report 200 "authenticated" having written nothing, and
  // the provider slot would stay occupied. Retire the placeholder before rethrowing.
  let loginRuntime: ModelRuntime
  try {
    loginRuntime = await createOAuthLoginRuntime(await getModelRuntime())
  } catch (err) {
    retireAndRemove(provider, pending, 'OAuth flow failed to start')
    throw err
  }
  const actor = auditActor(c.get('identity') as Identity)

  const interaction: AuthInteraction = {
    // Defense in depth alongside `superseded`: pi-ai honors this in its polling
    // loops, so a retired device-code login stops polling promptly instead of
    // running to its own timeout. The `superseded` flag remains the guarantee —
    // this only shortens the window, it does not depend on provider cooperation.
    signal: pending.abort.signal,
    notify: (event: AuthEvent) => {
      switch (event.type) {
        case 'auth_url':
          pending.need = { kind: 'code', authUrl: event.url, instructions: event.instructions }
          log.info(`OAuth flow started for ${provider}`)
          break
        case 'device_code':
          pending.need = {
            kind: 'device_code',
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            expiresInSeconds: event.expiresInSeconds,
          }
          log.info(`OAuth device-code flow started for ${provider}`)
          break
        case 'progress':
          pending.progress.push(event.message)
          break
        case 'info':
          // Ambient setup info — surface as a progress line so the UI can show it.
          pending.progress.push(event.message)
          break
      }
    },
    prompt: (prompt: AuthPrompt) => {
      if (prompt.type === 'select') {
        pending.need = {
          kind: 'select',
          message: prompt.message,
          options: prompt.options.map((o) => ({ id: o.id, label: o.label })),
        }
        return new Promise<string>((resolve, reject) => {
          pending.resolveSelect = (optionId) => {
            if (optionId === undefined) reject(new Error('Login cancelled'))
            else resolve(optionId)
          }
          pending.rejectSelect = reject
        }).finally(() => {
          pending.resolveSelect = undefined
          pending.rejectSelect = undefined
          if (pending.need.kind === 'select') pending.need = { kind: 'starting' }
        })
      }
      // text | secret | manual_code → the user pastes the code via /oauth/callback.
      return codePromise
    },
  }

  pending.completed = loginRuntime
    .login(provider, 'oauth', interaction)
    .then(async (credential) => {
      // Merge the returned credential into a FRESH store read inside the
      // serialized mutate queue: the OAuth flow can take minutes, and writing
      // a pre-login snapshot here used to clobber every account change made
      // while the flow was pending.
      //
      // ADD vs REAUTHORIZE is decided by `pending.accountId` (see
      // persistOAuthCredential):
      // - accountId set → refresh exactly that account in place (error if it
      //   was deleted mid-flow — never fall back to clobbering another).
      // - accountId absent → append a NEW account, unless the credential's
      //   upstream identity matches an existing account (identity dedupe).
      // A reauthorize whose login landed on a DIFFERENT upstream account is
      // refused outright rather than honoured (identity_mismatch).
      let result: OAuthPersistResult | undefined
      let retired = false
      await mutateAccountStore((store) => {
        // THE cancellation guard, deliberately the FIRST thing inside the mutate
        // callback so it is re-read UNDER THE SAME LOCK that guards the write.
        //
        // Checking `superseded` before this call is worthless: mutateAccountStore
        // does not run its callback inline — it queues on mutateQueue and then
        // runs inside db.transaction, after a row-locked `SELECT ... FOR UPDATE`
        // that every lastUsedAt stamp contends on. A flow retired anywhere in
        // that window would sail past an earlier check and still write. The
        // invariant is not "a retired flow is out of the map", it is "a retired
        // flow never writes" — so the guard belongs at the write, under its lock.
        if (pending.superseded) {
          retired = true
          return false
        }
        const r = persistOAuthCredential(store, provider, credential, pending.accountId)
        result = r
        // None of these outcomes may write.
        if (r.status !== 'added' && r.status !== 'reauthorized') return false
      }, actor)
      if (retired) {
        reportRetiredFlow(provider, pending)
        return
      }
      if (!result || result.status === 'account_not_found') {
        const message = `Account "${pending.accountId}" no longer exists — cannot re-authorize.`
        pending.need = { kind: 'error', message }
        log.error(`OAuth flow failed for ${provider}: ${message}`)
        return
      }
      if (result.status === 'wrong_type') {
        const message =
          `Account "${pending.accountId}" is now an ${result.actual} account, so nothing was saved. ` +
          'It was replaced while this login was in progress — use "Add account" to add an OAuth account instead.'
        pending.need = { kind: 'error', message }
        log.warn(`OAuth reauthorize rejected for ${provider}: target is now ${result.actual}, not oauth`)
        return
      }
      if (result.status === 'identity_mismatch') {
        const message =
          'You signed in as a different provider account than the one being re-authorized, so nothing was saved. ' +
          'Re-authorize using the original account, or use "Add account" to add this one alongside it.'
        pending.need = { kind: 'error', message }
        log.warn(`OAuth reauthorize rejected for ${provider}: upstream identity mismatch`)
        return
      }
      void refreshModelRuntime()
      pending.need = { kind: 'done' }
      log.info(`OAuth flow completed for ${provider} (${result.status})`)
    })
    .catch((err: unknown) => {
      // A retired flow is the expected reason for this rejection, not a provider
      // fault: `retireAndRemove` aborts `pending.abort` and rejects the
      // code/select promises, and since pi-ai 0.84 the login rejects on that
      // abort rather than running to completion. Reporting the raw
      // "The operation was aborted." would blame the provider for our own
      // cancellation and drop the "nothing was saved, log in again" guidance, so
      // retirement is reported the same way whether the login rejects or
      // completes-then-loses the write race.
      if (pending.superseded) {
        reportRetiredFlow(provider, pending)
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      pending.need = { kind: 'error', message }
      log.error(`OAuth flow failed for ${provider}: ${message}`)
    })

  // Re-check identity rather than blindly re-setting: if a concurrent start
  // displaced us while the runtime was building, that newer flow is the live one
  // and re-installing this one over it would resurrect a superseded flow on top
  // of the flow the user is actually looking at.
  if (pendingFlows.get(provider) !== pending) {
    retireAndRemove(provider, pending, 'OAuth flow superseded by a concurrent login request')
    return c.json({ error: 'Another OAuth login for this provider started concurrently. Try again.' }, 409)
  }

  // Wait briefly for the flow to surface its first need (select / code / device_code / error).
  const deadline = Date.now() + 5000
  while (pending.need.kind === 'starting' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }

  if (pending.need.kind === 'starting') {
    retireAndRemove(provider, pending, 'Timeout waiting for OAuth flow to start')
    return c.json({ error: 'Failed to start OAuth flow — no response received' }, 500)
  }

  return c.json({ provider, need: pending.need, status: 'started' })
})

/**
 * Complete an OAuth flow by providing the authorization code.
 *
 * The user authenticates in their browser, receives a code, and pastes
 * it here. The server-side flow exchanges it for tokens and stores them.
 */
app.post('/:provider/oauth/callback', requirePermission('provider-auth:write'), async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json<{ code: string }>()

  if (!body.code) {
    return c.json({ error: 'Missing "code" in request body' }, 400)
  }

  const pending = pendingFlows.get(provider)
  if (!pending) {
    return c.json({ error: 'No pending OAuth flow for this provider. Start one first.' }, 400)
  }

  // Resolve the code promise — this unblocks the login flow
  pending.resolveCode(body.code)

  // Wait for the flow to complete (with timeout). `pending.completed` never
  // rejects (its own .catch records the error onto `need`), so this race can only
  // lose to the timer — this catch IS the timeout path.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timeout')), oauthCallbackTimeoutMs)
  })

  try {
    await Promise.race([pending.completed, timeout])
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // The exchange outlived our patience but the login is STILL RUNNING. Merely
    // dropping it from the map would leave a zombie: un-superseded, invisible to
    // cleanupStaleFlows (which sweeps the map) and to any later /oauth/start, and
    // free to persist minutes later — landing on top of whatever credential the
    // user obtained from the retry they just made after seeing this error.
    retireAndRemove(provider, pending, 'OAuth flow timed out while completing')
    return c.json({ error: `OAuth flow failed: ${message}` }, 500)
  } finally {
    clearTimeout(timer)
  }

  // Check if the flow ended with an error
  if (pending.need.kind === 'error') {
    retireAndRemove(provider, pending, pending.need.message)
    return c.json({ error: `OAuth flow failed: ${pending.need.message}` }, 500)
  }

  retireAndRemove(provider, pending, 'OAuth flow completed')
  return c.json({ provider, status: 'authenticated' })
})

/** Select an option for a pending OAuth flow */
app.post('/:provider/oauth/select', requirePermission('provider-auth:write'), async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json<{ optionId?: string | null }>()
  const pending = pendingFlows.get(provider)

  if (!pending) {
    return c.json({ error: 'No pending OAuth flow for this provider. Start one first.' }, 400)
  }

  if (pending.need.kind !== 'select' || !pending.resolveSelect) {
    return c.json({ error: 'OAuth flow is not waiting for a selection.' }, 400)
  }

  if (body.optionId != null && !pending.need.options.some((option) => option.id === body.optionId)) {
    return c.json({ error: 'Invalid OAuth selection option.' }, 400)
  }

  pending.resolveSelect(body.optionId ?? undefined)
  return c.json({ ok: true })
})

/** Check the status of a pending OAuth flow */
app.get('/:provider/oauth/status', requirePermission('provider-auth:read'), (c) => {
  const provider = c.req.param('provider')
  const pending = pendingFlows.get(provider)

  if (!pending) {
    return c.json({ provider, status: 'none' })
  }

  return c.json({
    provider,
    status: 'pending',
    need: pending.need,
    progress: pending.progress,
  })
})

export default app

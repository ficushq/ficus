/**
 * Credential storage + ModelRuntime bootstrap.
 *
 * Provider credentials live in the SecretStore as a single JSON blob under
 * `PROVIDER_AUTH_DATA` (the multi-account store). This module exposes that
 * blob as a pi-ai `CredentialStore` (`SecretStoreCredentialStore`) and a
 * process-singleton `ModelRuntime` (`getModelRuntime`) built on top of it so
 * auth status, OAuth login, and request-time auth resolution all share one
 * live view of the stored accounts.
 *
 * The per-provider SecretStore key helpers (`providerToSecretKey` etc.) are
 * kept for the legacy env-migration path that mirrors individual provider
 * keys into the environment.
 */

import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { compatibleRuntimeProvider } from './openai-compatible-runtime'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { KeyedSerialQueue } from '../../lib/infra/inflight'
import { createLogger } from '../../lib/infra/logger'
import {
  mutateAccountStoreAsync,
  purgeClaudeSubscriptionCredentials,
  readAccountStore,
  type AccountStoreV1,
} from './account-store'

// pi-ai loads OAuth flow modules through deliberately bundler-opaque dynamic
// imports (auth/oauth/load.js), which cannot resolve from our bundled
// dist/index.js — every codex/anthropic OAuth login or token refresh fails
// with "Cannot find module './openai-codex.js'" / "OAuth auth derivation
// failed". Register the statically bundled flows instead; this is the
// mechanism pi ships for standalone/bundled runtimes and is a no-op override
// of the lazy path when running unbundled.
registerBunOAuthFlows()

const log = createLogger('auth-backend')

const PROVIDER_KEY_PREFIX = 'PROVIDER_AUTH_'

/**
 * Convert a provider name to a SecretStore key.
 * e.g., "anthropic" → "PROVIDER_AUTH_ANTHROPIC"
 */
export function providerToSecretKey(provider: string): string {
  return `${PROVIDER_KEY_PREFIX}${provider.toUpperCase()}`
}

/**
 * Check if a SecretStore key is a provider auth key.
 */
export function isProviderAuthKey(key: string): boolean {
  return key.startsWith(PROVIDER_KEY_PREFIX)
}

/**
 * Extract the provider name from a SecretStore key.
 * e.g., "PROVIDER_AUTH_ANTHROPIC" → "anthropic"
 */
export function secretKeyToProvider(key: string): string {
  return key.slice(PROVIDER_KEY_PREFIX.length).toLowerCase()
}

// Per-provider serialization for CredentialStore.modify/delete. The account
// store already serializes whole-blob writes via mutateAccountStore, but a
// CredentialStore.modify may perform a network OAuth refresh *inside* the
// lock — we must not let two concurrent refreshes for the same provider
// double-rotate. This queue keeps the modify callback's await window
// serialized per provider, on top of the blob-write serialization.
const credentialModifyQueue = new KeyedSerialQueue()

/**
 * pi-ai `CredentialStore` backed by the multi-account SecretStore blob.
 *
 * One credential per provider is the pi-ai contract; the multi-account store
 * holds several accounts per provider, so the "stored" credential for a
 * provider is the first enabled account's credential. Request-time account
 * selection (per-agent) is handled by `AccountScopedCredentialStore`, not this
 * store — this is the system-wide view used for status, OAuth login, and the
 * provider-health/fallback checks.
 *
 * `modify` may run a provider OAuth refresh (pi-ai calls it for token
 * rotation); it is serialized per provider, but the callback runs outside the
 * global account-store write lock. The result is persisted with a short
 * compare-and-swap write onto the first enabled account of the SAME credential
 * type for that provider, and dropped when the provider has no such account.
 */
export class SecretStoreCredentialStore implements CredentialStore {
  async read(providerId: string): Promise<Credential | undefined> {
    const accounts = readAccountStore().accounts[providerId]
    const account = accounts?.find((a) => a.enabled && a.credential != null) ?? accounts?.[0]
    return account?.credential
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const store = readAccountStore()
    const entries: CredentialInfo[] = []
    for (const [providerId, accounts] of Object.entries(store.accounts)) {
      const account = accounts.find((a) => a.enabled && a.credential != null)
      if (account) entries.push({ providerId, type: account.credential.type })
    }
    return entries
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return credentialModifyQueue.run(providerId, async () => {
      const observed = readProviderCredential(providerId)
      const next = await fn(observed)

      if (next === undefined) {
        // pi-ai CredentialStore contract: undefined means "leave unchanged"
        // and resolve the current/post-write credential. Deletion is only via
        // delete(providerId), never modify(... => undefined).
        return readProviderCredential(providerId)
      }

      let resolved: Credential | undefined
      await mutateAccountStoreAsync(async (store) => {
        const accounts = store.accounts[providerId] ?? []
        // Re-read the same TYPE we handed fn: on a mixed api_key + oauth
        // provider a type-blind re-read can return the other account's
        // credential and report a conflict that never happened.
        const current = firstProviderCredential(accounts, observed?.type)
        if (!credentialsEqual(current, observed)) {
          // Another writer changed this provider while fn was running. Do not
          // overwrite fresher user/account-store state with a stale refresh.
          resolved = current
          return false
        }
        if (!upsertProviderCredential(store.accounts, providerId, accounts, next)) {
          // No account of this credential's type: dropping the write is the
          // only safe outcome (the alternative overwrites a credential of the
          // other type). Never throw — this runs inside a token refresh.
          log.warn(
            `Dropped credential of type '${next.type}' for provider ${providerId}: no account of that type exists`
          )
          resolved = current
          return false
        }
        resolved = next
        return true
      }, 'system')
      return resolved ?? readProviderCredential(providerId)
    })
  }

  async delete(providerId: string): Promise<void> {
    await credentialModifyQueue.run(providerId, async () => {
      await mutateAccountStoreAsync(async (store) => {
        if (!store.accounts[providerId]) return false
        delete store.accounts[providerId]
        return true
      }, 'system')
    })
  }
}

/** {@link firstProviderCredential} over the live account store. */
function readProviderCredential(providerId: string, type?: Credential['type']): Credential | undefined {
  return firstProviderCredential(readAccountStore().accounts[providerId] ?? [], type)
}

/**
 * The provider's "current" credential: the first enabled account's, falling
 * back to the first account's.
 *
 * `type` narrows the search to accounts holding that credential type. A
 * provider can hold both an api_key and an OAuth account, and the type-blind
 * answer then hands an OAuth refresh callback the api_key (and makes the
 * compare-and-swap in `modify` compare across types) — see
 * {@link upsertProviderCredential}.
 */
export function firstProviderCredential(
  accounts: ReturnType<typeof readAccountStore>['accounts'][string],
  type?: Credential['type']
): Credential | undefined {
  const candidates = type == null ? accounts : accounts.filter((a) => a.credential?.type === type)
  return candidates.find((a) => a.enabled && a.credential != null)?.credential ?? candidates[0]?.credential
}

function credentialsEqual(a: Credential | undefined, b: Credential | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Write `credential` onto the provider's account of the SAME credential type,
 * preferring an enabled one. Returns false (writing nothing) when the provider
 * holds no account of that type.
 *
 * The type match is the whole point: a provider can hold an api_key account and
 * an OAuth account at once, and the credential arriving here is whatever the
 * caller's flow produced (pi-ai drives `modify` for OAuth token rotation).
 * Writing it onto "the first enabled account" DESTROYS an api_key when an OAuth
 * credential arrives. This mirrors the guard `persistOAuthCredential` already
 * applies in account-store.ts (`wrong_type`), whose comment names this call
 * site — including the `acc_migrated` id, which is deterministic and recycled,
 * so "the migrated account exists" never implies "it is OAuth".
 */
function upsertProviderCredential(
  allAccounts: ReturnType<typeof readAccountStore>['accounts'],
  providerId: string,
  accounts: ReturnType<typeof readAccountStore>['accounts'][string],
  credential: Credential
): boolean {
  if (accounts.length === 0) {
    allAccounts[providerId] = [{ id: 'acc_migrated', enabled: true, credential }]
    return true
  }
  if (accounts.length === 1 && accounts[0].id === 'acc_migrated') {
    if (accounts[0].credential?.type !== credential.type) return false
    accounts[0].credential = credential
    accounts[0].enabled = true
    return true
  }
  const target =
    accounts.find((a) => a.enabled && a.credential?.type === credential.type) ??
    accounts.find((a) => a.credential?.type === credential.type)
  if (!target) return false
  target.credential = credential
  return true
}

let modelRuntimePromise: Promise<ModelRuntime> | undefined
let modelRuntimeInstance: ModelRuntime | undefined

/**
 * Process-singleton `ModelRuntime` backed by {@link SecretStoreCredentialStore}.
 *
 * Memoized: the first caller triggers `ModelRuntime.create` (an offline
 * catalog refresh when `allowModelNetwork:false`); subsequent callers await
 * the same promise. Use {@link tryGetModelRuntime} for a synchronous peek at
 * the resolved instance.
 *
 * `allowModelNetwork:false` keeps auth/status resolution offline and fast —
 * OAuth login still works (it does its own network calls) and the builtin
 * catalog is read from the bundled metadata.
 */
export function getModelRuntime(): Promise<ModelRuntime> {
  if (!modelRuntimePromise) {
    modelRuntimePromise = (async () => {
      const runtime = await ModelRuntime.create({
        credentials: new SecretStoreCredentialStore(),
        allowModelNetwork: false,
      })
      registerOpenAICompatibleAccounts(runtime)
      modelRuntimeInstance = runtime
      return runtime
    })().catch((err) => {
      // A failed warmup must not poison the singleton forever; allow a retry.
      modelRuntimePromise = undefined
      throw err
    })
  }
  return modelRuntimePromise.then((runtime) => {
    registerOpenAICompatibleAccounts(runtime)
    return runtime
  })
}

/**
 * Rebuild the singleton's auth/config snapshot so `hasConfiguredAuth()` and
 * other snapshot-backed reads reflect the latest account-store writes.
 *
 * Status checks for STORED credentials consult the live account store
 * directly (see isProviderConfigured / model-selection), so they are never
 * stale. But the singleton keeps a cached `configuredProviders` snapshot used
 * for the env/runtime/fallback signal, and `getAuth()` consumers may read it
 * directly. Call this after any credential write that bypasses the runtime
 * (PUT/POST/DELETE account endpoints, OAuth callback, logout) so the next
 * status read is fresh. No-op if the singleton has not been created yet.
 */
export function refreshModelRuntime(): Promise<void> {
  if (!modelRuntimeInstance) return Promise.resolve()
  registerOpenAICompatibleAccounts(modelRuntimeInstance)
  return modelRuntimeInstance
    .refresh({ allowNetwork: false })
    .then(() => undefined)
    .catch(() => {})
}

/** Rebuild the executable provider catalog from explicitly verified persisted accounts. */
export function openAICompatibleRegistrations(store: AccountStoreV1) {
  return Object.entries(store.accounts).flatMap(([storedProviderId, accounts]) => {
    const account = accounts.find(
      (candidate) => candidate.enabled && candidate.kind === 'openai-compatible' && candidate.capabilities != null
    )
    if (!account?.baseUrl || !account.model) return []
    return [{ providerId: account.providerId || storedProviderId, account }]
  })
}
type CustomProviderRegistry = Pick<
  ModelRuntime,
  | 'getRegisteredProviderIds'
  | 'getRegisteredProviderConfig'
  | 'getRegisteredNativeProvider'
  | 'registerNativeProvider'
  | 'unregisterProvider'
>
const registrationSnapshots = new WeakMap<CustomProviderRegistry, string>()
export function registerOpenAICompatibleAccounts(
  runtime: CustomProviderRegistry,
  store: AccountStoreV1 = readAccountStore()
): void {
  const registrations = openAICompatibleRegistrations(store)
  // Cross-process secret refreshes update the account store, not this catalog.
  // Compare only model configuration; token rotation/lastUsedAt must not rebuild it.
  const snapshot = JSON.stringify(
    registrations.map(({ providerId, account }) => ({
      providerId,
      label: account.label,
      baseUrl: account.baseUrl,
      model: account.model,
      contextWindow: account.capabilities?.contextWindow ?? 32768,
    }))
  )
  if (registrationSnapshots.get(runtime) === snapshot) return
  for (const providerId of runtime.getRegisteredProviderIds()) {
    if (
      (
        runtime.getRegisteredProviderConfig(providerId)?.name ?? runtime.getRegisteredNativeProvider(providerId)?.name
      )?.startsWith('OpenAI Compatible:')
    )
      runtime.unregisterProvider(providerId)
  }
  for (const { providerId, account } of registrations) {
    runtime.registerNativeProvider(compatibleRuntimeProvider(providerId, account))
  }
  registrationSnapshots.set(runtime, snapshot)
}

/**
 * Synchronous accessor for the memoized runtime. Returns `undefined` before
 * the first `getModelRuntime()` has resolved (e.g. during early startup or in
 * a sync call path that runs before the eager warmup completes). Callers fall
 * back to account-store-only configuration checks in that case.
 */
export async function warmModelRuntimeForStartup(): Promise<void> {
  try {
    const purged = await purgeClaudeSubscriptionCredentials()
    if (purged) log.warn(`Removed ${purged} stored Claude subscription credential(s); add an Anthropic API key instead`)
  } catch (error) {
    log.warn('Could not purge stored Claude subscription credentials', error)
  }
  await getModelRuntime()
}

export function tryGetModelRuntime(): ModelRuntime | undefined {
  // Returns the resolved singleton if the eager warmup has completed. A pending
  // warmup yields undefined, which sync callers (model-selection) treat as
  // "not yet configured" and fall back to account-store-only checks.
  if (modelRuntimeInstance) registerOpenAICompatibleAccounts(modelRuntimeInstance)
  return modelRuntimeInstance
}

/**
 * Test-only: clear the process-singleton {@link ModelRuntime}.
 *
 * The singleton has no production reset — it is warmed once and lives for the
 * process. Tests that call `refresh()`/`refreshModelRuntime()` after storing
 * credentials permanently rebuild its `configuredProviders` snapshot, and that
 * leaked state changes `hasRuntimeRoute()` answers for EVERY later test in the
 * same bun process (observed: auth-backend.test.ts's getModelRuntime suite
 * flipping base.test.ts's real-selector failover test, a catalogued CI flake).
 * Mirror of the resetProviderHealthForTests pattern: call from afterEach in any
 * suite that mutates the runtime.
 */
export function resetModelRuntimeForTests(): void {
  modelRuntimePromise = undefined
  modelRuntimeInstance = undefined
}

// Eagerly warm the process-singleton ModelRuntime so sync callers
// (model-selection, provider-auth status) see a resolved instance without an
// explicit await at every call site. Failure is non-fatal — tryGetModelRuntime
// will simply return undefined and callers fall back to account-store checks.
void getModelRuntime().catch(() => {})

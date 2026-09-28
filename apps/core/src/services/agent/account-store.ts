import type { Credential } from '@earendil-works/pi-ai'
import { KeyedSerialQueue } from '../../lib/infra/inflight'
import { getSecretStore } from '../secrets'
import { notifyOnboardingChanged } from '../onboarding/events'

export interface Account {
  id: string
  label?: string
  enabled: boolean
  credential: Credential
  lastUsedAt?: number
  kind?: 'openai-compatible'
  providerId?: string
  baseUrl?: string
  model?: string
  capabilities?: { tools: boolean; contextWindow?: number; probedAt: string }
}

export interface AccountStoreV1 {
  version: 1
  accounts: Record<string, Account[]>
}

export const PROVIDER_AUTH_DATA_KEY = 'PROVIDER_AUTH_DATA'

export function readAccountStore(): AccountStoreV1 {
  const raw = getSecretStore().get(PROVIDER_AUTH_DATA_KEY)
  if (!raw) return emptyAccountStore()

  try {
    return parseAccountStore(raw)
  } catch {
    return emptyAccountStore()
  }
}

/** Parse/normalize a raw PROVIDER_AUTH_DATA blob. Throws on malformed JSON. */
function parseAccountStore(raw: string, removed?: RemovedCredentials): AccountStoreV1 {
  const parsed = JSON.parse(raw)
  if (isAccountStoreV1(parsed)) return normalizeAccountStore(parsed, removed)
  return normalizeAccountStore(migrateLegacyAuthData(parsed as Record<string, Credential>), removed)
}

type RemovedCredentials = { count: number }

/** A Claude subscription token (Claude Pro/Max OAuth access token, or a `claude setup-token` token). */
export const isClaudeSubscriptionToken = (key: unknown): boolean =>
  typeof key === 'string' && key.trim().startsWith('sk-ant-oat')

/**
 * Anthropic does not permit third-party products to store, or route requests through, Claude.ai
 * subscription credentials. The account store never holds one: an Anthropic OAuth login, or a
 * subscription token saved as any provider's API key, is dropped on read and purged on write.
 */
export function isClaudeSubscriptionCredential(provider: string, credential: Credential): boolean {
  if (credential.type === 'oauth') return provider === 'anthropic'
  return isClaudeSubscriptionToken(credential.key)
}

/** Delete stored Claude subscription credentials; returns how many were removed. */
export async function purgeClaudeSubscriptionCredentials(actor = 'system:claude-subscription-purge'): Promise<number> {
  let purged = 0
  await mutateAccountStore((_store, removed) => {
    purged = removed
    return false
  }, actor)
  return purged
}

export async function writeAccountStore(store: AccountStoreV1, actor: string): Promise<void> {
  await getSecretStore().set(PROVIDER_AUTH_DATA_KEY, JSON.stringify(normalizeAccountStore(store)), actor)
}

/**
 * Serialized, transactional read-modify-write of the account store.
 *
 * writeAccountStore overwrites the WHOLE store, so two concurrent
 * read-mutate-write cycles (e.g. a credential merge-back racing a lastUsedAt
 * stamp) silently lose whichever update commits first. All system-side
 * mutations must go through this path.
 *
 * Two layers of serialization:
 * - The in-process queue keeps concurrent local mutations from contending on
 *   the DB row lock.
 * - `mutateSecret` locks the secrets row (SELECT ... FOR UPDATE) and bases the
 *   mutation on the FRESH decrypted DB value — not the local cache, which in a
 *   two-process deployment (API + worker) can be arbitrarily stale and used to
 *   clobber the other process's writes (e.g. a worker lastUsedAt stamp erasing
 *   an account the API had just added via OAuth login).
 *
 * Return `false` from `mutate` to skip the write (nothing changed).
 * Rejects (writing nothing) if the stored blob is undecryptable or malformed —
 * never replaces an unreadable store with a fresh-empty one.
 */
const mutateQueue = new KeyedSerialQueue()

export function mutateAccountStore(
  mutate: (store: AccountStoreV1, removedClaudeSubscriptionCredentials: number) => boolean | void,
  actor: string
): Promise<void> {
  return mutateQueue.run(PROVIDER_AUTH_DATA_KEY, async () => {
    // Tracks whether the transaction actually wrote (vs. `mutate` returning
    // `false`, a no-op skip) — set from inside mutateSecret's callback, which
    // may run twice on a first-write insert race (see mutateSecret's retry),
    // so `wrote` is idempotent to set repeatedly.
    let wrote = false
    let fingerprintBefore = ''
    await getSecretStore().mutateSecret(
      PROVIDER_AUTH_DATA_KEY,
      (raw) => {
        // Malformed JSON throws → transaction rolls back, row untouched.
        const removed = { count: 0 }
        const store = raw ? parseAccountStore(raw, removed) : emptyAccountStore()
        fingerprintBefore = onboardingFingerprint(store)
        // A dropped Claude subscription credential is written out even when `mutate` skips.
        if (mutate(store, removed.count) === false && removed.count === 0) return undefined
        wrote = true
        return JSON.stringify(normalizeAccountStore(store))
      },
      actor
    )
    // THE chokepoint for every provider add/remove/OAuth path (routes/provider-auth.ts) —
    // covers the operator-reported case (an AI provider account added on the
    // Settings page) plus GitHub App installs and account reorder/enable toggles.
    //
    // Most writes through this chokepoint don't change the onboarding-relevant
    // signal at all (e.g. a bare `lastUsedAt` stamp on every agent session
    // create, or a reorder/health-retry write) — only notify when the
    // fingerprint (which providers have an enabled+credentialed account, and
    // how many) actually changed, so a fully-onboarded instance doesn't churn
    // the onboarding query forever.
    if (wrote && onboardingFingerprint(readAccountStore()) !== fingerprintBefore) notifyOnboardingChanged()
  })
}

/**
 * Account-store half of isProviderConfigured (routes/provider-auth.ts's
 * isProviderConfigured) — the count of enabled, credentialed accounts per
 * provider. Used to detect whether a write actually changed the
 * onboarding-relevant signal (vs. a `lastUsedAt` stamp, reorder, or
 * health/retry write that leaves it unchanged), so real transitions are never
 * missed while signal-inert writes don't trigger a notify.
 */
const onboardingFingerprint = (s: AccountStoreV1): string =>
  Object.entries(s.accounts)
    // JSON-encode each [provider, count] pair rather than joining raw strings:
    // a provider name containing the separators (':' / '|') could otherwise let
    // two DIFFERENT stores share a fingerprint — e.g. {'a:1|b': []} vs
    // {a:[cred], b:[]}. Unreachable today (no single mutation rewrites two
    // providers' keys at once, so such a delta can't appear across one compare),
    // but a future bulk-import routed through this gate would silently swallow
    // the transition, and encoding removes the class outright.
    .map(([p, accs]) => JSON.stringify([p, accs.filter((a) => a.enabled && a.credential != null).length]))
    .sort()
    .join('|')

/**
 * Async-mutation variant for callbacks that need to await a short local action
 * while holding the serialized blob-write lock. Do not run OAuth/network token
 * refresh callbacks inside this lock; read the observed credential first, run
 * the network callback outside the lock, then re-enter this mutation path for a
 * short compare-and-swap write.
 *
 * NOTE: unlike `mutateAccountStore` (row-locked `mutateSecret`, cross-process
 * safe), this variant serializes only in-process — `mutateSecret`'s mutator
 * must be synchronous, so an async callback cannot ride the row lock.
 *
 * Return `false` from `mutate` to skip the write (nothing changed).
 */
export function mutateAccountStoreAsync(
  mutate: (store: AccountStoreV1) => Promise<boolean | void>,
  actor: string
): Promise<void> {
  return mutateQueue.run(PROVIDER_AUTH_DATA_KEY, async () => {
    const store = readAccountStore()
    const fingerprintBefore = onboardingFingerprint(store)
    if ((await mutate(store)) === false) return
    await writeAccountStore(store, actor)
    // Same chokepoint as mutateAccountStore above — covers the OAuth login
    // round-trip's compare-and-swap write path. Same fingerprint gating: only
    // notify when the onboarding-relevant signal actually changed.
    if (onboardingFingerprint(store) !== fingerprintBefore) notifyOnboardingChanged()
  })
}

export function migrateLegacyAuthData(raw: Record<string, Credential>): AccountStoreV1 {
  const migrated = emptyAccountStore()
  for (const [provider, credential] of Object.entries(raw ?? {})) {
    if (!credential || typeof credential !== 'object' || !('type' in credential)) continue
    migrated.accounts[provider] = [
      {
        id: 'acc_migrated',
        enabled: true,
        credential,
      },
    ]
  }
  return migrated
}

export function listAccounts(store: AccountStoreV1, provider: string): Account[] {
  return store.accounts[provider] ?? []
}

export function addAccount(store: AccountStoreV1, provider: string, credential: Credential, label?: string): Account {
  const account: Account = {
    id: newAccountId(),
    enabled: true,
    credential,
    ...(label ? { label } : {}),
  }
  store.accounts[provider] ??= []
  store.accounts[provider].push(account)
  return account
}

export function updateAccount(
  store: AccountStoreV1,
  provider: string,
  accountId: string,
  patch: { label?: string; enabled?: boolean }
): Account | undefined {
  const account = getAccount(store, provider, accountId)
  if (!account) return undefined
  if ('label' in patch) {
    if (patch.label == null || patch.label === '') delete account.label
    else account.label = patch.label
  }
  if (typeof patch.enabled === 'boolean') account.enabled = patch.enabled
  return account
}

export function deleteAccount(store: AccountStoreV1, provider: string, accountId: string): boolean {
  const accounts = store.accounts[provider]
  if (!accounts) return false
  const index = accounts.findIndex((account) => account.id === accountId)
  if (index === -1) return false
  accounts.splice(index, 1)
  return true
}

export function getAccount(store: AccountStoreV1, provider: string, accountId: string): Account | undefined {
  return store.accounts[provider]?.find((account) => account.id === accountId)
}

/**
 * Extract a stable upstream-account identity from a credential, if the
 * credential carries one.
 *
 * Today only OpenAI Codex (ChatGPT) OAuth credentials carry an identity: pi-ai
 * decodes the ChatGPT `chatgpt_account_id` claim out of the access-token JWT
 * and stores it as `credential.accountId`
 * (see @earendil-works/pi-ai auth/oauth/openai-codex.js). Anthropic, xAI,
 * GitHub Copilot, Radius, etc. return only `{ access, refresh, expires }` with
 * no identity claim, so this returns `undefined` for them — callers then skip
 * the identity-dedupe guard and treat the write as a plain append.
 */
export function credentialIdentity(credential: Credential): string | undefined {
  if (credential.type !== 'oauth') return undefined
  const accountId = (credential as { accountId?: unknown }).accountId
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined
}

export type OAuthPersistResult =
  | { status: 'added'; account: Account }
  | { status: 'reauthorized'; account: Account }
  | { status: 'account_not_found' }
  | { status: 'wrong_type'; actual: Credential['type'] }
  | { status: 'identity_mismatch'; expected: string; actual: string }

/**
 * Persist an OAuth credential with explicit ADD vs REAUTHORIZE intent.
 *
 * - `accountId` present → REAUTHORIZE exactly that account in place, but only
 *   after re-validating every start-time precondition under the write lock (see
 *   the enumerated list in the body). If it no longer exists, returns
 *   `account_not_found` WITHOUT touching any other account (never falls back to
 *   clobbering a different one); if the id now resolves to a NON-oauth account
 *   (ids are recycled), returns `wrong_type` and writes nothing. If BOTH the stored
 *   and incoming credentials carry an upstream identity and they DIFFER, returns
 *   `identity_mismatch` and writes nothing: the user picked "Re-authorize" on one
 *   account but logged into a different upstream account, so honouring it would
 *   destroy the target's credential AND leave two accounts sharing one upstream
 *   identity (breaking the dedupe invariant, and per-account failover/health,
 *   which assume distinct upstream quotas).
 * - `accountId` absent → ADD. Runs the identity-dedupe guard first: if the new
 *   credential carries an upstream identity (see {@link credentialIdentity})
 *   that matches an existing account's stored credential, that same-upstream
 *   account is refreshed in place instead of duplicated. Otherwise a brand-new
 *   enabled account is appended, leaving every existing account untouched.
 *
 * Note: a dedupe/reauthorize match re-enables a DISABLED account. Re-authorizing
 * is taken as intent to use the account again; the user can disable it afresh.
 *
 * Mutates `store` in place; callers must invoke it inside the serialized
 * account-store writer (mutateAccountStore).
 */
export function persistOAuthCredential(
  store: AccountStoreV1,
  provider: string,
  credential: Credential,
  accountId?: string
): OAuthPersistResult {
  const accounts = listAccounts(store, provider)

  if (accountId != null) {
    // EVERY precondition that /oauth/start checked must be re-checked HERE.
    //
    // The rule (learned the hard way, repeatedly): a route-level check gates
    // STARTING a flow, but arbitrary time and arbitrary user actions pass before
    // the flow completes, and this is the only place that runs under the write
    // lock. A precondition validated only at start time is a precondition that
    // is false by the time it matters. The full set, all re-checked below:
    //
    //   1. the target account still exists          → account_not_found
    //   2. it is still an OAuth account             → wrong_type
    //   3. it is still the SAME upstream account    → identity_mismatch
    //   4. the flow itself was not cancelled        → checked by the caller as
    //      the first statement inside this same mutate callback (`superseded`)
    //
    // Add a fifth start-time check and it belongs in this list too.
    const target = accounts.find((account) => account.id === accountId)
    if (!target) return { status: 'account_not_found' }

    // Account ids are DETERMINISTIC and recycled — migrateLegacyAuthData,
    // upsertProviderCredential's empty-provider branch, and
    // salvageStrayCredentials all mint the fixed ids `acc_migrated`/
    // `acc_salvaged`. So "the id still resolves" does NOT mean "it is the same
    // account": deleting a legacy migrated OAuth account and then adding an API
    // key for that provider recreates `acc_migrated` as an api_key account, and
    // an in-flight reauthorize would otherwise overwrite — destroying — the key.
    // credentialIdentity is undefined for api_key, so identity_mismatch cannot
    // catch this; the type check must.
    if (target.credential.type !== 'oauth') {
      return { status: 'wrong_type', actual: target.credential.type }
    }

    // Only compare when BOTH sides carry an identity; providers without an
    // identity claim (anthropic, xai, copilot, radius) simply skip this.
    const targetIdentity = credentialIdentity(target.credential)
    const incomingIdentity = credentialIdentity(credential)
    if (targetIdentity != null && incomingIdentity != null && targetIdentity !== incomingIdentity) {
      return { status: 'identity_mismatch', expected: targetIdentity, actual: incomingIdentity }
    }
    target.credential = credential
    target.enabled = true
    return { status: 'reauthorized', account: target }
  }

  const identity = credentialIdentity(credential)
  if (identity != null) {
    const match = accounts.find((account) => credentialIdentity(account.credential) === identity)
    if (match) {
      match.credential = credential
      match.enabled = true
      return { status: 'reauthorized', account: match }
    }
  }

  // Label appended accounts distinguishably: a bare 'OAuth' on every row leaves
  // a multi-account codex user staring at two identical labels with no way to
  // tell which upstream account is which. When the credential carries an
  // identity, suffix a short tail of it (the full id is long and opaque; the
  // user can still rename via Edit label).
  return { status: 'added', account: addAccount(store, provider, credential, oauthAccountLabel(identity)) }
}

/** Display label for a newly appended OAuth account. */
function oauthAccountLabel(identity: string | undefined): string {
  return identity ? `OAuth (…${identity.slice(-6)})` : 'OAuth'
}

/**
 * Rewrite `store.accounts[provider]` in `order` — array order IS the user's
 * selection-preference order (see account-selection.ts). `order` must be an
 * exact permutation of the provider's existing account ids: same length, no
 * duplicates, no unknown ids, none missing. Throws otherwise; callers (the
 * route layer) map that to a 400.
 */
export function reorderAccounts(store: AccountStoreV1, provider: string, order: string[]): void {
  const accounts = store.accounts[provider]
  if (!accounts || accounts.length === 0) {
    throw new Error(`Unknown provider "${provider}"`)
  }

  const currentIds = new Set(accounts.map((account) => account.id))
  const seen = new Set<string>()
  for (const id of order) {
    if (!currentIds.has(id)) throw new Error(`"order" contains unknown account id "${id}" for provider "${provider}"`)
    if (seen.has(id)) throw new Error(`"order" contains duplicate account id "${id}"`)
    seen.add(id)
  }
  if (order.length !== accounts.length) {
    throw new Error(`"order" must include every account id for provider "${provider}" exactly once`)
  }

  const byId = new Map(accounts.map((account) => [account.id, account]))
  store.accounts[provider] = order.map((id) => byId.get(id)!)
}

function emptyAccountStore(): AccountStoreV1 {
  return { version: 1, accounts: {} }
}

function newAccountId(): string {
  return `acc_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function isAccountStoreV1(value: unknown): value is AccountStoreV1 {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as { version?: unknown }).version === 1 &&
    (value as { accounts?: unknown }).accounts != null &&
    typeof (value as { accounts?: unknown }).accounts === 'object'
  )
}

function normalizeAccountStore(store: AccountStoreV1, removed?: RemovedCredentials): AccountStoreV1 {
  const normalized = emptyAccountStore()
  for (const [provider, accounts] of Object.entries(store.accounts ?? {})) {
    if (!Array.isArray(accounts)) continue
    normalized.accounts[provider] = accounts
      .filter((account): account is Account => isAccount(account))
      .filter((account) => {
        if (!isClaudeSubscriptionCredential(provider, account.credential)) return true
        if (removed) removed.count++
        return false
      })
      .map((account) => ({
        ...account,
        enabled: account.enabled !== false,
      }))
  }
  salvageStrayCredentials(store, normalized, removed)
  return normalized
}

/**
 * Lift stray top-level provider->credential keys into accounts.
 *
 * A legacy writer (notably the SDK's fire-and-forget auth write during OAuth
 * login, before it ran against an in-memory backend) could race the serialized
 * account-store merge and land a bare `{ "some-provider": { type: ... } }` key
 * next to `version`/`accounts`. Dropping those keys silently lost real
 * credentials; instead, migrate each one into an account. Idempotent: uses
 * deterministic ids and skips providers that already hold a credential of the
 * same type.
 */
function salvageStrayCredentials(
  store: AccountStoreV1,
  normalized: AccountStoreV1,
  removed?: RemovedCredentials
): void {
  for (const [provider, value] of Object.entries(store as unknown as Record<string, unknown>)) {
    if (provider === 'version' || provider === 'accounts') continue
    if (value == null || typeof value !== 'object') continue
    const type = (value as { type?: unknown }).type
    if (type !== 'api_key' && type !== 'oauth') continue
    const credential = value as Credential
    if (isClaudeSubscriptionCredential(provider, credential)) {
      if (removed) removed.count++
      continue
    }
    const accounts = (normalized.accounts[provider] ??= [])
    if (accounts.some((account) => account.credential.type === credential.type)) continue
    const id = accounts.some((account) => account.id === 'acc_migrated') ? 'acc_salvaged' : 'acc_migrated'
    accounts.push({ id, enabled: true, credential })
  }
}

function isAccount(value: unknown): value is Account {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { credential?: unknown }).credential != null &&
    typeof (value as { credential?: unknown }).credential === 'object'
  )
}

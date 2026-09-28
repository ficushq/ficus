/**
 * Per-agent credential store: a pi-ai `CredentialStore` that projects a single
 * selected account per provider out of the shared multi-account SecretStore
 * blob. This is the account-scoped view handed to `ModelRuntime.create` for an
 * individual agent session, so request-time auth resolution sees exactly the
 * account the failover controller selected for that agent.
 *
 * Writes flow back onto the selected account via the serialized
 * `mutateAccountStoreAsync` writer, preserving the same merge semantics the
 * legacy `AuthStorageBackend`/`AccountScopedAuthBackend` had: a provider's selected account receives the
 * rotated/logged-in credential.
 */
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { routeDecision } from '@ficus/shared/provider-health'
import { KeyedSerialQueue } from '../../lib/infra/inflight'
import { providerHealth } from '../provider-health/registry'
import { selectAccount } from './account-selection'
import { getAccount, mutateAccountStoreAsync, readAccountStore } from './account-store'

export class AccountScopedCredentialStore implements CredentialStore {
  private selected = new Map<string, string>()
  private readonly modifyQueue = new KeyedSerialQueue()

  selectAccount(provider: string, accountId: string): void {
    this.selected.set(provider, accountId)
  }

  clearAccount(provider: string): void {
    this.selected.delete(provider)
  }

  getSelectedAccountId(provider: string): string | undefined {
    return this.selected.get(provider)
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const accountId = this.selected.get(providerId)
    if (!accountId) return undefined
    const account = getAccount(readAccountStore(), providerId, accountId)
    return account?.enabled ? account.credential : undefined
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const store = readAccountStore()
    const entries: CredentialInfo[] = []
    for (const [providerId, accountId] of this.selected) {
      const account = getAccount(store, providerId, accountId)
      if (account?.enabled && account.credential) entries.push({ providerId, type: account.credential.type })
    }
    return entries
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    const accountId = this.selected.get(providerId)
    if (!accountId) {
      // No selected account for this scoped view, so there is no stored
      // post-write credential to return even if fn produces one.
      return fn(undefined).then(() => undefined)
    }

    return this.modifyQueue.run(scopedCredentialQueueKey(providerId, accountId), async () => {
      // Observe inside the per-account queue so a second concurrent modify sees
      // the first one's stored refresh and pi-ai's double-check callback can
      // return undefined instead of performing a second network refresh.
      const observed = readEnabledSelectedCredential(providerId, accountId)
      const next = await fn(observed)
      if (next === undefined) return readEnabledSelectedCredential(providerId, accountId)
      let resolved: Credential | undefined
      await mutateAccountStoreAsync(async (store) => {
        const account = getAccount(store, providerId, accountId)
        const current = account?.enabled ? account.credential : undefined
        if (!account?.enabled || !credentialsEqual(current, observed)) {
          // The selected account was disabled/changed while fn was running.
          // Drop the stale update and return the live selected credential.
          resolved = current
          return false
        }
        account.credential = next
        resolved = next
        return true
      }, 'system')
      return resolved ?? readEnabledSelectedCredential(providerId, accountId)
    })
  }

  async delete(providerId: string): Promise<void> {
    const accountId = this.selected.get(providerId)
    if (!accountId) return
    await this.modifyQueue.run(scopedCredentialQueueKey(providerId, accountId), async () => {
      await mutateAccountStoreAsync(async (store) => {
        const account = getAccount(store, providerId, accountId)
        if (!account) return false
        // Logout should not remove the user's account entry, but it also must
        // not leave a keyless phantom credential that still counts as configured.
        // Disable the selected account and clear this scoped projection.
        account.enabled = false
        return true
      }, 'system')
      this.selected.delete(providerId)
    })
  }
}

export function createAccountScopedCredentialStore(providers: string[]): {
  credentials: AccountScopedCredentialStore
  backend: AccountScopedCredentialStore
} {
  const store = new AccountScopedCredentialStore()
  const accountStore = readAccountStore()
  const selected: Array<{ provider: string; accountId: string }> = []

  for (const provider of providers) {
    const account = selectAccount(provider, accountStore, {
      isAccountHealthy: (p, accountId) => isAccountHealthy(p, accountId),
    })
    if (!account) continue
    store.selectAccount(provider, account.id)
    selected.push({ provider, accountId: account.id })
  }

  // Stamp lastUsedAt through the serialized mutate queue — a snapshot write
  // here would race (and clobber) concurrent credential merge-backs.
  if (selected.length > 0) {
    mutateAccountStoreAsync(async (s) => {
      let touched = false
      for (const { provider, accountId } of selected) {
        const account = getAccount(s, provider, accountId)
        if (!account) continue
        account.lastUsedAt = Date.now()
        touched = true
      }
      return touched
    }, 'system').catch(() => {})
  }

  // `credentials` and `backend` are the same instance: callers pass
  // `credentials` to ModelRuntime.create and hold `backend` to drive
  // selectAccount / getSelectedAccountId during failover. Keeping both names
  // preserves the old { authStorage, backend } call-site shape.
  return { credentials: store, backend: store }
}

function scopedCredentialQueueKey(provider: string, accountId: string): string {
  return `${provider}:${accountId}`
}

function readEnabledSelectedCredential(provider: string, accountId: string): Credential | undefined {
  const account = getAccount(readAccountStore(), provider, accountId)
  return account?.enabled ? account.credential : undefined
}

function credentialsEqual(a: Credential | undefined, b: Credential | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function isAccountHealthy(provider: string, accountId: string): boolean {
  return routeDecision({ provider, accountId }, providerHealth.snapshotRecords(), Date.now()).state === 'ready'
}

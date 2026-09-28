import type { Account, AccountStoreV1 } from './account-store'
import { isAccountUsable } from './account-usable'

export interface AccountSelectionDeps {
  isAccountHealthy: (provider: string, accountId: string) => boolean
}

/**
 * Select the account to use for `provider`.
 *
 * Array order in `store.accounts[provider]` IS the user's preference order
 * (see `reorderAccounts` in account-store.ts) — this returns the first
 * enabled+healthy account, full stop. Disabled or unhealthy (exhausted)
 * accounts are skipped, so a multi-account provider fails over down the list
 * on exhaustion and returns to the preferred (first) account once it
 * recovers, rather than round-robining by lastUsedAt.
 */
export function selectAccount(provider: string, store: AccountStoreV1, deps: AccountSelectionDeps): Account | null {
  const accounts = store.accounts[provider] ?? []
  return accounts.find((account) => isAccountUsable(account) && deps.isAccountHealthy(provider, account.id)) ?? null
}

export function hasUsableAccount(provider: string, store: AccountStoreV1, deps: AccountSelectionDeps): boolean {
  return selectAccount(provider, store, deps) != null
}

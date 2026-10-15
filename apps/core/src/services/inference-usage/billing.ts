/** How a call was paid for, from the provider account that served it. */
import type { InferenceBilling } from '@ficus/shared'
import type { Account, AccountStoreV1 } from '../agent/account-store'

/** Billing for one stored account. */
export function accountBilling(account: Account): InferenceBilling {
  if (account.kind === 'claude-code') return 'subscription'
  if (account.kind === 'openai-compatible') return 'self-hosted'
  if (account.credential?.type === 'oauth') return 'subscription'
  if (account.credential?.type === 'api_key') return 'api'
  return 'unknown'
}

/** Whether an account is paid for by a monthly subscription (shown as a fee line item). */
export function isSubscriptionAccount(account: Account): boolean {
  return accountBilling(account) === 'subscription'
}

/**
 * Billing for a call: the stored account's kind and credential type when it is known; otherwise (an
 * environment key, or no account id) `api` when the model has a list price and `unknown` when not.
 */
export function classifyBilling(
  input: { provider?: string | null; accountId?: string | null; hasListPrice: boolean },
  deps: { store: AccountStoreV1 }
): InferenceBilling {
  if (input.provider && input.accountId) {
    const account = deps.store.accounts[input.provider]?.find((candidate) => candidate.id === input.accountId)
    if (account) return accountBilling(account)
  }
  return input.hasListPrice ? 'api' : 'unknown'
}

/** The account that serves a provider when the caller does not know which: the first usable one. */
export function accountForProvider(
  provider: string,
  store: AccountStoreV1,
  isUsable: (account: Account) => boolean
): Account | undefined {
  const accounts = store.accounts[provider] ?? []
  return accounts.find(isUsable) ?? accounts[0]
}

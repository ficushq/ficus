import type { ProviderRoute } from '@ficus/shared/provider-health'
import { parseModelSpec, splitModelPriorityList } from '../../lib/utils/model-spec'
import { isAccountUsable } from '../agent/account-usable'
import { listAccounts, type AccountStoreV1 } from '../agent/account-store'

export function buildProviderChains(
  chainSpecs: readonly string[],
  accountStore: AccountStoreV1,
  hasConfiguredAuth: (provider: string) => boolean
): ProviderRoute[][] {
  return chainSpecs.map((chain) =>
    splitModelPriorityList(chain).flatMap((candidate) => {
      const provider = parseModelSpec(candidate).provider
      const accounts = listAccounts(accountStore, provider).filter(isAccountUsable)
      if (accounts.length > 0) {
        return accounts.map((account) => ({ provider, accountId: account.id, credentialUsable: true }))
      }
      return [{ provider, credentialUsable: hasConfiguredAuth(provider) }]
    })
  )
}

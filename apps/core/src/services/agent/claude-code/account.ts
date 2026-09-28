/**
 * Claude Code as an account of the Anthropic provider. It holds no credential: its marker tells the
 * Anthropic provider to send the turn through the user's own signed-in `claude` instead of the API.
 * Like any account it takes part in the provider's order and per-account failover.
 */
import type { ApiKeyCredential } from '@earendil-works/pi-ai'
import { getAccount, mutateAccountStore, readAccountStore, type Account, type AccountStoreV1 } from '../account-store'

export const CLAUDE_CODE_ACCOUNT_ID = 'acc_claude_code'
export const CLAUDE_CODE_PROVIDER = 'anthropic'
/** Set on the account's credential env; the resolved auth carries it to the stream. */
export const CLAUDE_CODE_FLAG = 'FICUS_CLAUDE_CODE'

export const claudeCodeCredential = (): ApiKeyCredential => ({ type: 'api_key', env: { [CLAUDE_CODE_FLAG]: '1' } })

export function isClaudeCodeCredential(credential: { env?: Record<string, string | undefined> } | undefined) {
  return credential?.env?.[CLAUDE_CODE_FLAG] === '1'
}

export function claudeCodeAccount(store: AccountStoreV1 = readAccountStore()): Account | undefined {
  return getAccount(store, CLAUDE_CODE_PROVIDER, CLAUDE_CODE_ACCOUNT_ID)
}

/**
 * Turn Claude Code on or off for agents. Turning it on the first time adds it as the Anthropic
 * provider's first account, so the user's plan is tried before a paid API key; the order can be
 * changed like any account's.
 */
export async function setClaudeCodeAccountEnabled(enabled: boolean, actor: string): Promise<void> {
  await mutateAccountStore((store) => {
    const existing = getAccount(store, CLAUDE_CODE_PROVIDER, CLAUDE_CODE_ACCOUNT_ID)
    if (existing) {
      if (existing.enabled === enabled) return false
      existing.enabled = enabled
      return
    }
    if (!enabled) return false
    store.accounts[CLAUDE_CODE_PROVIDER] = [
      {
        id: CLAUDE_CODE_ACCOUNT_ID,
        label: 'Claude Code (your Claude plan)',
        enabled: true,
        kind: 'claude-code',
        credential: claudeCodeCredential(),
      },
      ...(store.accounts[CLAUDE_CODE_PROVIDER] ?? []),
    ]
  }, actor)
}

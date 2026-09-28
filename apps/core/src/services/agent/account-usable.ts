import type { Account } from './account-store'
import { claudeCodeReady } from './claude-code/availability'

/**
 * Whether an account can serve requests now. A Claude Code account holds no credential of its own;
 * it is usable while `claude` is installed and signed in on this machine.
 */
export function isAccountUsable(account: Account): boolean {
  if (!account.enabled || account.credential == null) return false
  return account.kind !== 'claude-code' || claudeCodeReady()
}

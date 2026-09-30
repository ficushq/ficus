/**
 * Claude Code failures that need the user to act on this machine. The bridge labels them so Core
 * records them against the Claude Code account and fails the turn over to the next account,
 * instead of stopping on a generic authentication error.
 */
export const CLAUDE_CODE_SIGN_IN_FAILED = 'Claude Code sign-in failed'
export const CLAUDE_CODE_TOO_OLD = 'Claude Code is too old'

const TOO_OLD = /does not support this model|or newer is required/i
const SIGN_IN = /failed to authenticate|oauth session expired|please run \/login|invalid api key|not logged in/i

/** The error text a failed Claude Code turn reports, naming the `claude` it ran. */
export function describeClaudeCodeFailure(text: string, code?: string, executable?: string): string {
  const ran = executable ? ` (ran ${executable})` : ''
  if (TOO_OLD.test(text)) return `${CLAUDE_CODE_TOO_OLD}${ran}: ${text} Update it with \`claude update\`.`
  if (code === 'authentication_failed' || SIGN_IN.test(text))
    return `${CLAUDE_CODE_SIGN_IN_FAILED}${ran}: ${text} Sign in again with \`claude auth login\`.`
  // Keep the structured upstream code when its prose alone is not recognizable.
  if (code === 'rate_limit') return `Claude Code rate limit: ${text}`
  return text
}

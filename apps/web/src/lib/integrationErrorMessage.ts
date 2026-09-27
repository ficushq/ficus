import { ApiError } from '../api/client'

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/
const MAX_MESSAGE_LENGTH = 300

/** Friendly text for authorization codes that Core returns without a message. */
const CODE_MESSAGES: Record<string, string> = {
  oauth_app_unconfigured:
    'No GitHub App is configured for this instance. Add your own app or switch back to the Ficus app.',
  client_authority_mismatch: "This instance's sign-in settings changed. Reload the page, then try again.",
  invalid_or_expired_state: 'This login expired. Start a new login.',
  broker_unconfigured: "Ficus's hosted sign-in isn't available for this instance yet. Try again later.",
}

/**
 * Codes for a caller that is not a person. Core's message for these names the
 * action ("Finish setting up your admin account to connect GitHub."), so it wins;
 * these texts only cover a body without one.
 */
const SESSION_CODE_MESSAGES: Record<string, string> = {
  first_admin_incomplete: 'Finish setting up your admin account to continue.',
  user_session_required: 'Sign in with your Ficus account to continue.',
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== 'object') return undefined
  const payload = error.payload as Record<string, unknown>
  return typeof payload.code === 'string' && CODE_PATTERN.test(payload.code) ? payload.code : undefined
}

/**
 * Whether a request failed because the browser is signed in with the instance
 * password while the first admin account still has no passkey. The app offers to
 * finish that setup rather than a plain Retry.
 */
export function isFirstAdminIncomplete(error: unknown): boolean {
  return errorCode(error) === 'first_admin_incomplete'
}

/**
 * Describe a failed integration request using the server's error body.
 *
 * Core answers `{ error: message, code }` for provider failures and
 * `{ error: code }` for authorization flow rejections. Show the message when
 * there is one, translate known codes, and otherwise keep the code visible next
 * to the fallback so the cause is not lost.
 */
export function integrationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== 'object') return fallback
  const payload = error.payload as Record<string, unknown>
  const detail = typeof payload.error === 'string' ? payload.error.trim() : ''
  const code =
    typeof payload.code === 'string' && CODE_PATTERN.test(payload.code)
      ? payload.code
      : CODE_PATTERN.test(detail)
        ? detail
        : undefined
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  if (detail && detail !== code) return detail.slice(0, MAX_MESSAGE_LENGTH)
  if (code && SESSION_CODE_MESSAGES[code]) return SESSION_CODE_MESSAGES[code]
  return code ? `${fallback} (${code})` : fallback
}

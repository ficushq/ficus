/**
 * Query parameters that carry credentials or one-time secrets on some Core-served URL:
 * - `token`, `ticket`: WebSocket, terminal, log-stream and webhook credentials.
 * - `code`, `state`: self-hosted OAuth callbacks (`/settings/integrations/oauth/callback...`).
 * - `handle`, `flow`: hosted broker callbacks; the handle redeems the authorization once.
 * - `sig`: signed image URLs, which work as bearer capabilities until they expire.
 * - the standard OAuth token and secret names, in case any caller ever sends one.
 */
const SENSITIVE_QUERY_PARAMETERS = [
  'token',
  'ticket',
  'code',
  'state',
  'handle',
  'flow',
  'sig',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
]

const SENSITIVE_QUERY_PATTERN = new RegExp(`([?&](?:${SENSITIVE_QUERY_PARAMETERS.join('|')})=)[^&#\\s]*`, 'gi')

/** Redact credentials and one-time secrets from Hono request-log lines before persistence. */
export function redactHttpLogCredentials(message: string): string {
  return message.replace(SENSITIVE_QUERY_PATTERN, '$1[REDACTED]')
}

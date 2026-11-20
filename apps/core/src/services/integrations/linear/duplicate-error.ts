import { createLogger } from '../../../lib/infra/logger'

/**
 * Linear's answer to a create under an ID it already holds. Ficus sends a deterministic activity ID,
 * so a retry after an unknown outcome (a timeout after Linear stored the activity) gets this answer,
 * and it means the activity is already there. Both the write-back outbox (`write-api.ts`) and the
 * session acknowledgment, disposition and binding posts (`app-api.ts`) count it as sent.
 */

const log = createLogger('linear-duplicate')

/**
 * Error codes that mean the record already exists. Linear has not been seen sending one for agent
 * activities (its refusal carries a generic code such as `INVALID_INPUT`, which says nothing about
 * duplicates); they are matched so that such a code is recognized whatever the message says. A bare
 * `CONFLICT` is left out: it could name a conflict other than the insert. The code Linear did send is
 * logged with each duplicate, to confirm or add one.
 */
const DUPLICATE_CODES = new Set(['DUPLICATE', 'ALREADY_EXISTS', 'DUPLICATE_ENTITY', 'UNIQUE_VIOLATION'])
/**
 * Message text Linear sends for a create under an ID it already holds. Live, a repeated
 * `agentActivityCreate` is answered HTTP 200 with "conflict on insert of AgentActivity".
 */
const DUPLICATE_MESSAGES = ['already exists', 'duplicate', 'conflict on insert']

/** A provider code reduced to a bounded token that is safe to log. */
function loggableCode(value: unknown) {
  return typeof value === 'string' ? value.replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 64) || 'none' : 'none'
}

/**
 * Whether GraphQL `errors` say the record already exists. When they do, Linear's error code and type
 * are logged, never its message text.
 */
export function isLinearDuplicateError(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false
  for (const error of errors) {
    const entry = error && typeof error === 'object' ? (error as Record<string, any>) : {}
    const code = typeof entry.extensions?.code === 'string' ? entry.extensions.code.toUpperCase() : ''
    const message = typeof entry.message === 'string' ? entry.message.toLowerCase() : ''
    if (DUPLICATE_CODES.has(code) || DUPLICATE_MESSAGES.some((text) => message.includes(text))) {
      log.info(
        `Linear reported the record already exists (code ${loggableCode(entry.extensions?.code)}, type ${loggableCode(entry.extensions?.type)})`
      )
      return true
    }
  }
  return false
}

/**
 * Thrown by `linearQuery` for that answer. The message stays `provider_query_failed`, so callers that
 * do not look for a duplicate see the same failure as before.
 */
export class LinearDuplicateError extends Error {
  constructor() {
    super('provider_query_failed')
    this.name = 'LinearDuplicateError'
  }
}

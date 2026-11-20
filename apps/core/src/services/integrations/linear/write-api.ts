import { createLogger } from '../../../lib/infra/logger'
import { LINEAR_GRAPHQL_ENDPOINT } from './cli'
import { isLinearScopeError, readGraphQLErrors } from './scope-error'

/**
 * Linear writes made by the write-back outbox, with failures classified so the outbox can decide
 * whether to retry, wait for the rate limit, refresh the token or give up. No token or provider text
 * is ever logged or returned; error codes are fixed strings.
 */

/**
 * `insufficient_scope` is Linear's `Invalid scope` refusal: the app token lacks a scope (for
 * example `write`). It is not permanent: the outbox marks the connection for reconnect and the
 * item waits for a usable connection.
 */
export type LinearWriteErrorCode =
  | 'rate_limited'
  | 'invalid_auth'
  | 'insufficient_scope'
  | 'forbidden'
  | 'not_found'
  | 'duplicate'
  | 'rejected'
  | 'unavailable'
  | 'timeout'

export class LinearWriteError extends Error {
  constructor(
    readonly code: LinearWriteErrorCode,
    readonly retryAfterMs?: number
  ) {
    super(code)
    this.name = 'LinearWriteError'
  }
  /** Retrying can never succeed: the outbox marks the item failed at once. */
  get permanent() {
    return this.code === 'forbidden' || this.code === 'not_found' || this.code === 'rejected'
  }
}

const log = createLogger('linear-write-api')

const MAX_RETRY_AFTER_MS = 3_600_000

/**
 * Error codes that mean the record Ficus asked Linear to create already exists. Linear has not been
 * seen sending one for agent activities (its refusal carries a generic code such as `INVALID_INPUT`,
 * which says nothing about duplicates); they are matched so that such a code is recognized whatever
 * the message says. The code Linear did send is logged with each duplicate, to confirm or add one.
 */
const DUPLICATE_CODES = new Set(['CONFLICT', 'DUPLICATE', 'ALREADY_EXISTS', 'DUPLICATE_ENTITY', 'UNIQUE_VIOLATION'])
/**
 * Message text Linear sends for a create under an ID it already holds. Live, a repeated
 * `agentActivityCreate` is answered HTTP 200 with "conflict on insert of AgentActivity".
 */
const DUPLICATE_MESSAGES = ['already exists', 'duplicate', 'conflict on insert']

/** A provider code reduced to a bounded token that is safe to log. */
function loggableCode(value: unknown) {
  return typeof value === 'string' ? value.replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 64) || 'none' : 'none'
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS) : undefined
}

function classifyGraphQLErrors(errors: unknown[]): LinearWriteError {
  // Checked before FORBIDDEN: Linear sends the scope refusal with that code, but it is about the
  // installation's scopes, not access to this session or issue.
  if (isLinearScopeError(errors)) return new LinearWriteError('insufficient_scope')
  const parts = errors.map((error) => {
    const entry = error && typeof error === 'object' ? (error as Record<string, any>) : {}
    const code = typeof entry.extensions?.code === 'string' ? entry.extensions.code.toUpperCase() : ''
    const message = typeof entry.message === 'string' ? entry.message.toLowerCase() : ''
    return { code, message, rawCode: entry.extensions?.code, rawType: entry.extensions?.type }
  })
  if (parts.some((part) => part.code === 'RATELIMITED')) return new LinearWriteError('rate_limited')
  if (parts.some((part) => part.code === 'AUTHENTICATION_ERROR' || part.message.includes('authentication required')))
    return new LinearWriteError('invalid_auth')
  const duplicate = parts.find(
    (part) => DUPLICATE_CODES.has(part.code) || DUPLICATE_MESSAGES.some((text) => part.message.includes(text))
  )
  if (duplicate) {
    // Only Linear's code and type are logged, never its message text.
    log.info(
      `Linear reported the record already exists (code ${loggableCode(duplicate.rawCode)}, type ${loggableCode(duplicate.rawType)})`
    )
    return new LinearWriteError('duplicate')
  }
  if (
    parts.some(
      (part) =>
        part.code === 'FORBIDDEN' ||
        part.message.includes('forbidden') ||
        part.message.includes('permission') ||
        part.message.includes('not authorized') ||
        part.message.includes('access')
    )
  )
    return new LinearWriteError('forbidden')
  if (parts.some((part) => part.message.includes('not found'))) return new LinearWriteError('not_found')
  return new LinearWriteError('rejected')
}

/** One Linear GraphQL mutation; resolves to `data` or rejects with a {@link LinearWriteError}. */
export async function linearWrite<T>(
  authorization: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  let response: Response
  try {
    response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ query, variables }),
      signal: signal ?? AbortSignal.timeout(10_000),
      redirect: 'error',
    })
  } catch (error) {
    const name = error && typeof error === 'object' ? (error as { name?: string }).name : undefined
    throw new LinearWriteError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable')
  }
  if (response.status === 429)
    throw new LinearWriteError('rate_limited', retryAfterMs(response.headers.get('Retry-After')))
  if (response.status === 401) throw new LinearWriteError('invalid_auth')
  if (response.status === 403)
    throw new LinearWriteError(
      isLinearScopeError(await readGraphQLErrors(response)) ? 'insufficient_scope' : 'forbidden'
    )
  // A server error is transient whatever its body says.
  if (response.status >= 500) throw new LinearWriteError('unavailable')
  let result: { data?: T | null; errors?: unknown[] }
  try {
    result = (await response.json()) as typeof result
  } catch {
    throw new LinearWriteError('unavailable')
  }
  if (result.errors?.length) {
    const classified = classifyGraphQLErrors(result.errors)
    if (classified.code === 'rate_limited')
      throw new LinearWriteError('rate_limited', retryAfterMs(response.headers.get('Retry-After')))
    throw classified
  }
  if (!response.ok) throw new LinearWriteError(response.status >= 500 ? 'unavailable' : 'rejected')
  if (!result.data) throw new LinearWriteError('rejected')
  return result.data
}

/** The activity content types Linear accepts (`AgentActivityCreateInput.content`). */
export type LinearAgentActivityContent =
  | { type: 'thought'; body: string }
  | { type: 'response'; body: string }
  | { type: 'error'; body: string }
  | { type: 'elicitation'; body: string }
  | { type: 'action'; action: string; parameter: string; result?: string }

export interface LinearActivityInput {
  agentSessionId: string
  id: string
  content: LinearAgentActivityContent
  ephemeral?: boolean
  signal?: 'select' | 'auth' | 'continue'
  signalMetadata?: Record<string, unknown>
}

function requireSuccess(value: { success?: boolean } | null | undefined) {
  if (value?.success !== true) throw new LinearWriteError('rejected')
}

export async function writeLinearActivity(authorization: string, input: LinearActivityInput, signal?: AbortSignal) {
  const data = await linearWrite<{ agentActivityCreate?: { success?: boolean } }>(
    authorization,
    'mutation FicusAgentActivity($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }',
    { input },
    signal
  )
  requireSuccess(data.agentActivityCreate)
}

export async function writeLinearSessionUrls(
  authorization: string,
  sessionId: string,
  urls: Array<{ label: string; url: string }>,
  signal?: AbortSignal
) {
  const data = await linearWrite<{ agentSessionUpdate?: { success?: boolean } }>(
    authorization,
    'mutation FicusAgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }',
    { id: sessionId, input: { addedExternalUrls: urls } },
    signal
  )
  requireSuccess(data.agentSessionUpdate)
}

/** Attach a GitHub pull request to an issue; Linear treats the URL as idempotent per issue. */
export async function writeLinearPullRequestAttachment(
  authorization: string,
  input: { issueId: string; url: string; linkKind: string; title?: string },
  signal?: AbortSignal
) {
  const data = await linearWrite<{ attachmentLinkGitHubPR?: { success?: boolean } }>(
    authorization,
    'mutation FicusAttachPullRequest($issueId: String!, $url: String!, $linkKind: GitLinkKind, $title: String) { attachmentLinkGitHubPR(issueId: $issueId, url: $url, linkKind: $linkKind, title: $title) { success } }',
    {
      issueId: input.issueId,
      url: input.url,
      linkKind: input.linkKind,
      ...(input.title ? { title: input.title } : {}),
    },
    signal
  )
  requireSuccess(data.attachmentLinkGitHubPR)
}

/** Open an agent session on an issue without a delegation or mention (`--linear-session`). */
export async function createLinearSessionOnIssue(authorization: string, issueId: string, signal?: AbortSignal) {
  const data = await linearWrite<{
    agentSessionCreateOnIssue?: { success?: boolean; agentSession?: { id?: string; url?: string | null } | null }
  }>(
    authorization,
    'mutation FicusCreateSession($input: AgentSessionCreateOnIssue!) { agentSessionCreateOnIssue(input: $input) { success agentSession { id url } } }',
    { input: { issueId } },
    signal
  )
  requireSuccess(data.agentSessionCreateOnIssue)
  const id = data.agentSessionCreateOnIssue?.agentSession?.id
  if (typeof id !== 'string' || !id) throw new LinearWriteError('rejected')
  const url = data.agentSessionCreateOnIssue?.agentSession?.url
  return { id, url: typeof url === 'string' && url ? url : undefined }
}

import { createHash } from 'node:crypto'
import { linearQuery } from './plugin'

/**
 * Linear API calls the agent app makes for a connection: agent activities, session updates and the
 * one enrichment probe per event. Every call takes the `Authorization` value from
 * `linearAuthorization`; no token is ever logged or returned.
 */

export type LinearActivityContent =
  { type: 'thought'; body: string } | { type: 'response'; body: string } | { type: 'error'; body: string }

/**
 * The activity ID Ficus sends to Linear for one projection of a session: a UUID v4 derived from the
 * session and a stable projection key (`ack`, `disposition`, `bound:<stream>`), so a retry after an
 * unknown outcome reuses it and Linear never shows the same activity twice.
 */
export function linearActivityId(sessionId: string, projectionKey: string): string {
  const bytes = createHash('sha256').update(`${sessionId}\u0000${projectionKey}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function createLinearAgentActivity(
  authorization: string,
  input: { sessionId: string; projectionKey: string; content: LinearActivityContent },
  signal?: AbortSignal
): Promise<void> {
  const result = await linearQuery<{ agentActivityCreate?: { success?: boolean } }>(
    authorization,
    'mutation FicusAgentActivity($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }',
    {
      input: {
        id: linearActivityId(input.sessionId, input.projectionKey),
        agentSessionId: input.sessionId,
        content: input.content,
      },
    },
    signal
  )
  if (result.agentActivityCreate?.success !== true) throw new Error('provider_query_failed')
}

export async function addLinearSessionExternalUrls(
  authorization: string,
  sessionId: string,
  urls: Array<{ label: string; url: string }>,
  signal?: AbortSignal
): Promise<void> {
  const result = await linearQuery<{ agentSessionUpdate?: { success?: boolean } }>(
    authorization,
    'mutation FicusAgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }',
    { id: sessionId, input: { addedExternalUrls: urls } },
    signal
  )
  if (result.agentSessionUpdate?.success !== true) throw new Error('provider_query_failed')
}

export interface LinearProbedUser {
  id: string
  app?: boolean | null
  guest?: boolean | null
  active?: boolean | null
}
export interface LinearAppProbe {
  issue?: {
    id: string
    number?: number | null
    identifier?: string | null
    url?: string | null
    team?: { id: string; key?: string | null } | null
    labels?: { nodes?: Array<{ name?: string | null }> | null } | null
    assignee?: { id: string } | null
    delegate?: { id: string } | null
  } | null
  comment?: {
    id: string
    parentId?: string | null
    user?: LinearProbedUser | null
    agentSession?: { id: string; appUser?: { id: string } | null } | null
    parent?: { agentSession?: { id: string; appUser?: { id: string } | null } | null } | null
  } | null
  user?: LinearProbedUser | null
}

const PROBE_QUERY = `query FicusLinearAppProbe($issueId: String!, $commentId: String!, $userId: String!, $withComment: Boolean!, $withUser: Boolean!) {
  issue(id: $issueId) { id number identifier url team { id key } labels { nodes { name } } assignee { id } delegate { id } }
  comment(id: $commentId) @include(if: $withComment) { id parentId user { id app guest active } agentSession { id appUser { id } } parent { agentSession { id appUser { id } } } }
  user(id: $userId) @include(if: $withUser) { id app guest active }
}`

/**
 * One live probe per connection and event, shared by every squad on the connection: the issue (with
 * its team, labels, assignee and delegate), the comment for comment events, and the acting user.
 * A GraphQL error (the app cannot read the issue) rejects with `provider_query_failed`.
 */
export async function probeLinearAppEvent(
  authorization: string,
  input: { issueId: string; commentId?: string; userId?: string },
  signal?: AbortSignal
): Promise<LinearAppProbe> {
  return linearQuery<LinearAppProbe>(
    authorization,
    PROBE_QUERY,
    {
      issueId: input.issueId,
      commentId: input.commentId ?? '',
      userId: input.userId ?? '',
      withComment: !!input.commentId,
      withUser: !!input.userId,
    },
    signal
  )
}

/** The account type rule conditions and audiences see, from a probed user. */
export function linearActorType(user: LinearProbedUser | null | undefined): 'user' | 'guest' | 'app' | 'unknown' {
  if (!user) return 'unknown'
  if (user.app) return 'app'
  if (user.guest) return 'guest'
  return 'user'
}

/** Decision 9.4: active, non-guest, non-app members of the connected workspace may start work and prompt. */
export function isTrustedLinearUser(user: LinearProbedUser | null | undefined): boolean {
  return !!user && user.active === true && user.guest !== true && user.app !== true
}

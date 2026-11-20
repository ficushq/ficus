/**
 * In-memory Linear for tests: a GraphQL responder installed as `fetch`, plus signed webhook payload
 * builders. No test calls Linear.
 *
 * It answers `viewer`, `organization`, `issue`, `comment`, `user`, `teams`, `agentSessions`,
 * `agentActivities`, `notifications`, `agentActivityCreate`, `agentSessionUpdate`,
 * `agentSessionCreateOnIssue` and `attachmentLinkGitHubPR`; records every call with the fake clock's
 * time; records each session's opening request as its first prompt, as Linear does; rejects a duplicate
 * client-supplied activity ID with Linear's live answer; keeps attachment URLs idempotent per issue;
 * and can be told to fail the next call with 401, 403, 429, a GraphQL error or a timeout.
 */
import { createHmac, randomUUID } from 'node:crypto'

export interface FakeLinearUser {
  id: string
  name?: string
  app?: boolean
  guest?: boolean
  active?: boolean
}
export interface FakeLinearIssue {
  id: string
  number: number
  identifier: string
  title: string
  url: string
  team: { id: string; key: string }
  labels?: string[]
  assigneeId?: string | null
  delegateId?: string | null
}
export interface FakeLinearComment {
  id: string
  issueId: string
  parentId?: string | null
  userId: string
  agentSessionId?: string | null
  parentAgentSessionId?: string | null
}
export interface FakeLinearCall {
  operation: string
  variables: Record<string, any>
  authorization: string
  at: number
}
export interface FakeLinearPrompt {
  id: string
  sessionId: string
  userId: string
  body: string
  createdAt: string
  signal?: 'stop'
}
export interface FakeLinearNotification {
  id: string
  type: string
  issueId: string
  actorId?: string
  createdAt: string
}
/** `scope` is Linear's answer to a token without a required scope, as recorded live (HTTP 400). */
export type FakeLinearFailure = 401 | 403 | 429 | 500 | 'graphql' | 'scope' | 'timeout'

export interface FakeLinearOptions {
  organization?: { id: string; name: string; urlKey: string }
  app?: FakeLinearUser
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  clock?: () => number
  /** Simulated latency added to the clock for each call, when the clock is a fake. */
  advance?: (ms: number) => void
  latencyMs?: number
  /** `Authorization` values the fake accepts; any value when empty. */
  tokens?: string[]
}

export function createFakeLinear(options: FakeLinearOptions = {}) {
  const clock = options.clock ?? Date.now
  const organization = options.organization ?? { id: 'org-uuid', name: 'Acme', urlKey: 'acme' }
  const app: FakeLinearUser = options.app ?? { id: 'app-user', name: 'Ficus', app: true, active: true }
  const users = new Map<string, FakeLinearUser>([[app.id, app]])
  const issues = new Map<string, FakeLinearIssue>()
  const comments = new Map<string, FakeLinearComment>()
  const sessions = new Map<
    string,
    {
      id: string
      issueId: string
      appUserId: string
      externalUrls: Array<{ label: string; url: string }>
      updatedAt: string
      createdAt: string
      status: string
      creatorId?: string
      commentId?: string
    }
  >()
  /** User prompts and the app's notifications, as the polling fallback reads them. */
  const prompts: FakeLinearPrompt[] = []
  const notifications: FakeLinearNotification[] = []
  const activities: Array<{ id: string; agentSessionId: string; content: Record<string, any>; at: number }> = []
  const attachments = new Map<string, { issueId: string; url: string; linkKind?: string }>()
  const teams: string[] = []
  const calls: FakeLinearCall[] = []
  const failures: Array<{ operation?: string; failure: FakeLinearFailure }> = []

  function failNext(failure: FakeLinearFailure, operation?: string) {
    failures.push({ operation, failure })
  }

  function userNode(id: string | null | undefined) {
    const user = id ? users.get(id) : undefined
    return user
      ? { id: user.id, name: user.name ?? user.id, app: !!user.app, guest: !!user.guest, active: user.active !== false }
      : null
  }
  function sessionNode(id: string | null | undefined) {
    const session = id ? sessions.get(id) : undefined
    return session ? { id: session.id, appUser: { id: session.appUserId } } : null
  }
  function issueNode(issue: FakeLinearIssue) {
    return {
      id: issue.id,
      number: issue.number,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      team: issue.team,
      labels: { nodes: (issue.labels ?? []).map((name) => ({ name })) },
      assignee: issue.assigneeId ? { id: issue.assigneeId } : null,
      delegate: issue.delegateId ? { id: issue.delegateId } : null,
    }
  }

  /** Whether the query asks for a root field, honoring `@include(if: $flag)`. */
  function asks(query: string, field: string, variables: Record<string, any>) {
    // Entity lookups take arguments; a nested selection such as `user { id }` is not a root field.
    const args = ['issue', 'comment', 'user'].includes(field) ? '(\\([^)]*\\))' : '(\\([^)]*\\))?'
    const match = new RegExp(`\\b${field}\\s*${args}\\s*(@include\\(if:\\s*\\$(\\w+)\\))?\\s*\\{`).exec(query)
    if (!match) return false
    return match[3] ? variables[match[3]] === true : true
  }

  function respond(query: string, variables: Record<string, any>): { data?: any; errors?: any[] } {
    const data: Record<string, any> = {}
    if (/\bmutation\b/.test(query)) {
      if (query.includes('agentActivityCreate')) {
        const input = variables.input ?? {}
        if (!sessions.has(input.agentSessionId)) return { errors: [{ message: 'Entity not found: AgentSession' }] }
        if (input.id && activities.some((activity) => activity.id === input.id))
          return { errors: [{ message: 'conflict on insert of AgentActivity' }] }
        activities.push({
          id: input.id ?? randomUUID(),
          agentSessionId: input.agentSessionId,
          content: input.content,
          at: clock(),
        })
        const session = sessions.get(input.agentSessionId)!
        session.updatedAt = new Date(clock()).toISOString()
        session.status =
          input.content?.type === 'response' ? 'complete' : input.content?.type === 'error' ? 'error' : 'active'
        data.agentActivityCreate = { success: true }
      }
      if (query.includes('agentSessionUpdate')) {
        const session = sessions.get(variables.id)
        if (!session) return { errors: [{ message: 'Entity not found: AgentSession' }] }
        for (const url of variables.input?.addedExternalUrls ?? [])
          if (!session.externalUrls.some((existing) => existing.url === url.url)) session.externalUrls.push(url)
        data.agentSessionUpdate = { success: true }
      }
      if (query.includes('agentSessionCreateOnIssue')) {
        const issueId = variables.input?.issueId ?? variables.issueId
        if (!issues.has(issueId)) return { errors: [{ message: 'Entity not found: Issue' }] }
        const id = randomUUID()
        sessions.set(id, {
          id,
          issueId,
          appUserId: app.id,
          externalUrls: [],
          updatedAt: new Date(clock()).toISOString(),
          createdAt: new Date(clock()).toISOString(),
          status: 'pending',
        })
        data.agentSessionCreateOnIssue = { success: true, agentSession: { id } }
      }
      if (query.includes('attachmentLinkGitHubPR')) {
        const key = `${variables.issueId}\u0000${variables.url}`
        attachments.set(key, { issueId: variables.issueId, url: variables.url, linkKind: variables.linkKind })
        data.attachmentLinkGitHubPR = { success: true }
      }
      return { data }
    }
    if (asks(query, 'viewer', variables)) data.viewer = { id: app.id, name: app.name ?? 'Ficus', app: !!app.app }
    if (asks(query, 'organization', variables)) data.organization = organization
    if (asks(query, 'issue', variables)) {
      const issue = issues.get(variables.issueId ?? variables.id)
      if (!issue) return { errors: [{ message: 'Entity not found: Issue' }], data: null }
      data.issue = issueNode(issue)
    }
    if (asks(query, 'comment', variables)) {
      const comment = comments.get(variables.commentId ?? variables.id)
      if (!comment) return { errors: [{ message: 'Entity not found: Comment' }], data: null }
      data.comment = {
        id: comment.id,
        parentId: comment.parentId ?? null,
        user: userNode(comment.userId),
        agentSession: sessionNode(comment.agentSessionId),
        parent: comment.parentId ? { agentSession: sessionNode(comment.parentAgentSessionId) } : null,
      }
    }
    if (asks(query, 'user', variables)) {
      const user = userNode(variables.userId ?? variables.id)
      if (!user) return { errors: [{ message: 'Entity not found: User' }], data: null }
      data.user = user
    }
    if (asks(query, 'teams', variables))
      data.teams = { nodes: teams.map((id) => ({ id })), pageInfo: { hasNextPage: false, endCursor: null } }
    // Linear pages newest first with `first` and oldest first with `last`.
    const page = <T>(items: T[], at: (item: T) => string) => {
      const sorted = [...items].sort((a, b) => Date.parse(at(b)) - Date.parse(at(a)))
      return typeof variables.last === 'number'
        ? sorted.slice(-variables.last).reverse()
        : sorted.slice(0, variables.first ?? 50)
    }
    const since = (value: string) => !variables.after || Date.parse(value) >= Date.parse(variables.after)
    if (asks(query, 'agentSessions', variables)) {
      // Relay paging, newest first: `cursor` is the previous page's `endCursor`, here the last session ID.
      const ordered = [...sessions.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      if (variables.cursor && !ordered.some((session) => session.id === variables.cursor))
        return { errors: [{ message: 'Invalid cursor' }], data: null }
      const start = variables.cursor ? ordered.findIndex((session) => session.id === variables.cursor) + 1 : 0
      const slice = ordered.slice(start, start + (variables.first ?? 50))
      data.agentSessions = {
        pageInfo: {
          hasNextPage: start + slice.length < ordered.length,
          endCursor: slice.at(-1)?.id ?? null,
        },
        nodes: slice.map((session) => {
          const issue = issues.get(session.issueId)
          return {
            id: session.id,
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            url: `https://linear.app/acme/agent-session/${session.id}`,
            appUser: { id: session.appUserId },
            creator: session.creatorId ? { id: session.creatorId } : null,
            comment: session.commentId ? { id: session.commentId } : null,
            issue: issue ? issueNode(issue) : null,
          }
        }),
      }
    }
    if (asks(query, 'agentActivities', variables))
      data.agentActivities = {
        nodes: page(
          prompts.filter((prompt) => since(prompt.createdAt)),
          (prompt) => prompt.createdAt
        ).map((prompt) => {
          const session = sessions.get(prompt.sessionId)
          const issue = session ? issues.get(session.issueId) : undefined
          // The session's own prompts, as `activities(first: 1)` (newest) and `activities(last: 1)`
          // (oldest) return them; the oldest is the prompt that opened the session.
          const own = prompts
            .filter((other) => other.sessionId === prompt.sessionId)
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
          const end = (entry: FakeLinearPrompt | undefined) => ({
            nodes: entry ? [{ id: entry.id, createdAt: entry.createdAt }] : [],
          })
          return {
            id: prompt.id,
            createdAt: prompt.createdAt,
            signal: prompt.signal ?? null,
            user: { id: prompt.userId },
            promptAuthor: { id: prompt.userId },
            sourceComment: null,
            content: { body: prompt.body },
            agentSession: {
              id: prompt.sessionId,
              url: `https://linear.app/acme/agent-session/${prompt.sessionId}`,
              appUser: { id: session?.appUserId ?? app.id },
              issue: issue ? issueNode(issue) : null,
              firstPrompt: end(own.at(-1)),
              lastPrompt: end(own[0]),
            },
          }
        }),
      }
    if (asks(query, 'notifications', variables))
      data.notifications = {
        nodes: page(
          notifications.filter((notification) => since(notification.createdAt)),
          (notification) => notification.createdAt
        ).map((notification) => {
          const issue = issues.get(notification.issueId)
          return {
            id: notification.id,
            type: notification.type,
            createdAt: notification.createdAt,
            actor: notification.actorId ? { id: notification.actorId } : null,
            issue: issue ? issueNode(issue) : null,
          }
        }),
      }
    return { data }
  }

  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string; variables?: Record<string, any> }
    const query = body.query ?? ''
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'anonymous'
    const authorization = new Headers(init?.headers).get('Authorization') ?? ''
    if (options.latencyMs) options.advance?.(options.latencyMs)
    calls.push({ operation, variables: body.variables ?? {}, authorization, at: clock() })
    const index = failures.findIndex((entry) => !entry.operation || entry.operation === operation)
    if (index >= 0) {
      const failure = failures.splice(index, 1)[0]!.failure
      if (failure === 'timeout') {
        const signal = init?.signal
        return new Promise<Response>((_, reject) => {
          const abort = () => reject(signal?.reason ?? new DOMException('The operation timed out.', 'TimeoutError'))
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      }
      if (failure === 'graphql') return Response.json({ errors: [{ message: 'Forbidden' }], data: null })
      if (failure === 'scope')
        return Response.json(
          {
            errors: [
              {
                message: 'Invalid scope: `write` required',
                extensions: { type: 'forbidden', code: 'FORBIDDEN', statusCode: 403, userError: true },
              },
            ],
          },
          { status: 400 }
        )
      return Response.json(
        { errors: [{ message: 'failure', extensions: { code: failure === 429 ? 'RATELIMITED' : 'FAILED' } }] },
        { status: failure, headers: failure === 429 ? { 'Retry-After': '30' } : {} }
      )
    }
    if (options.tokens?.length && !options.tokens.includes(authorization))
      return Response.json({ errors: [{ message: 'Authentication required' }] }, { status: 401 })
    return Response.json(respond(query, body.variables ?? {}))
  }) as unknown as typeof fetch

  return {
    fetch: fetchImpl,
    organization,
    app,
    users,
    issues,
    comments,
    sessions,
    activities,
    attachments,
    teams,
    calls,
    failNext,
    addUser(user: FakeLinearUser) {
      users.set(user.id, user)
      return user
    },
    addIssue(issue: FakeLinearIssue) {
      issues.set(issue.id, issue)
      if (!teams.includes(issue.team.id)) teams.push(issue.team.id)
      return issue
    },
    addSession(session: {
      id: string
      issueId: string
      appUserId?: string
      status?: string
      creatorId?: string
      commentId?: string
      at?: number
      /**
       * Linear records the request that opened a session as its first prompt activity. The ID
       * defaults to a random one; `false` leaves the session without one.
       */
      openingPrompt?: { id?: string; body?: string } | false
    }) {
      const { openingPrompt, ...fields } = session
      const at = new Date(session.at ?? clock()).toISOString()
      sessions.set(session.id, {
        ...fields,
        appUserId: session.appUserId ?? app.id,
        externalUrls: [],
        updatedAt: at,
        createdAt: at,
        status: session.status ?? 'pending',
      })
      if (openingPrompt === false) return { openingPromptId: undefined }
      const opening: FakeLinearPrompt = {
        id: openingPrompt?.id ?? randomUUID(),
        sessionId: session.id,
        userId: session.creatorId ?? 'member',
        body: openingPrompt?.body ?? 'Please take this issue',
        createdAt: at,
      }
      prompts.push(opening)
      return { openingPromptId: opening.id }
    },
    addPrompt(prompt: Omit<FakeLinearPrompt, 'createdAt'> & { at?: number }) {
      const { at, ...rest } = prompt
      prompts.push({ ...rest, createdAt: new Date(at ?? clock()).toISOString() })
    },
    addNotification(notification: Omit<FakeLinearNotification, 'createdAt'> & { at?: number }) {
      const { at, ...rest } = notification
      notifications.push({ ...rest, createdAt: new Date(at ?? clock()).toISOString() })
    },
    prompts,
    notifications,
    activitiesFor(sessionId: string) {
      return activities.filter((activity) => activity.agentSessionId === sessionId)
    },
  }
}
export type FakeLinear = ReturnType<typeof createFakeLinear>

/** Hex HMAC-SHA256 of the raw body, as Linear sends in `Linear-Signature`. */
export function signLinearWebhook(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/** Headers and raw body for a signed app delivery; `timestamp` is set into the body's `webhookTimestamp`. */
export function signedLinearDelivery(
  payload: Record<string, unknown>,
  secret: string,
  options: { timestamp?: number; deliveryId?: string; eventHeader?: string } = {}
) {
  const body = JSON.stringify({ ...payload, webhookTimestamp: options.timestamp ?? Date.now() })
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'linear-delivery': options.deliveryId ?? randomUUID(),
      'linear-event': options.eventHeader ?? String(payload.type),
      'linear-signature': signLinearWebhook(body, secret),
    },
  }
}

interface AppContext {
  organizationId: string
  oauthClientId: string
  appUserId: string
}

export function agentSessionCreatedPayload(
  context: AppContext,
  input: {
    sessionId: string
    issue?: FakeLinearIssue | null
    creatorId: string
    commentId?: string
    timestamp?: number
    /** The opening prompt activity, when the delivery names it. */
    activityId?: string
  }
) {
  return {
    type: 'AgentSessionEvent',
    action: 'created',
    createdAt: new Date(input.timestamp ?? Date.now()).toISOString(),
    organizationId: context.organizationId,
    oauthClientId: context.oauthClientId,
    appUserId: context.appUserId,
    agentSession: {
      id: input.sessionId,
      ...(input.issue
        ? {
            issueId: input.issue.id,
            issue: {
              id: input.issue.id,
              identifier: input.issue.identifier,
              number: input.issue.number,
              title: input.issue.title,
              url: input.issue.url,
              teamId: input.issue.team.id,
              team: input.issue.team,
            },
          }
        : {}),
      ...(input.commentId ? { commentId: input.commentId } : {}),
      creatorId: input.creatorId,
      url: `https://linear.app/acme/agent-session/${input.sessionId}`,
      status: 'pending',
    },
    promptContext: input.issue
      ? `<issue identifier="${input.issue.identifier}"><title>${input.issue.title}</title></issue>`
      : '',
    ...(input.activityId ? { agentActivity: { id: input.activityId, userId: input.creatorId, body: '' } } : {}),
    webhookTimestamp: input.timestamp ?? Date.now(),
  }
}

export function agentSessionPromptedPayload(
  context: AppContext,
  input: {
    sessionId: string
    issue: FakeLinearIssue
    userId: string
    activityId: string
    body: string
    signal?: 'stop'
  }
) {
  const created = agentSessionCreatedPayload(context, {
    sessionId: input.sessionId,
    issue: input.issue,
    creatorId: input.userId,
  })
  return {
    ...created,
    action: 'prompted',
    agentActivity: {
      id: input.activityId,
      userId: input.userId,
      body: input.body,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  }
}

export function permissionChangePayload(
  context: AppContext,
  input: { addedTeamIds?: string[]; removedTeamIds?: string[]; canAccessAllPublicTeams?: boolean }
) {
  return {
    type: 'PermissionChange',
    action: 'teamAccessChanged',
    createdAt: new Date().toISOString(),
    organizationId: context.organizationId,
    oauthClientId: context.oauthClientId,
    appUserId: context.appUserId,
    canAccessAllPublicTeams: input.canAccessAllPublicTeams ?? false,
    addedTeamIds: input.addedTeamIds ?? [],
    removedTeamIds: input.removedTeamIds ?? [],
    webhookTimestamp: Date.now(),
  }
}

export function oauthAppRevokedPayload(context: Omit<AppContext, 'appUserId'>) {
  return {
    type: 'OAuthApp',
    action: 'revoked',
    createdAt: new Date().toISOString(),
    organizationId: context.organizationId,
    oauthClientId: context.oauthClientId,
    webhookTimestamp: Date.now(),
  }
}

export function appUserNotificationPayload(context: AppContext, type = 'issueMention') {
  return {
    type: 'AppUserNotification',
    action: type,
    createdAt: new Date().toISOString(),
    organizationId: context.organizationId,
    oauthClientId: context.oauthClientId,
    appUserId: context.appUserId,
    notification: { id: randomUUID(), type },
    webhookTimestamp: Date.now(),
  }
}

export function issueWebhookPayload(
  organizationId: string,
  issue: FakeLinearIssue,
  input: { action?: 'create' | 'update'; updatedFrom?: Record<string, unknown>; actorId?: string } = {}
) {
  return {
    type: 'Issue',
    action: input.action ?? 'update',
    organizationId,
    actor: input.actorId ? { id: input.actorId, type: 'user' } : undefined,
    data: {
      id: issue.id,
      number: issue.number,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      teamId: issue.team.id,
      team: issue.team,
      assigneeId: issue.assigneeId ?? null,
      delegateId: issue.delegateId ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    ...(input.updatedFrom ? { updatedFrom: input.updatedFrom } : {}),
    webhookTimestamp: Date.now(),
  }
}

export function commentWebhookPayload(
  organizationId: string,
  comment: FakeLinearComment,
  input: { body?: string; issue?: FakeLinearIssue } = {}
) {
  return {
    type: 'Comment',
    action: 'create',
    organizationId,
    actor: { id: comment.userId, type: 'user' },
    data: {
      id: comment.id,
      body: input.body ?? 'A comment',
      issueId: comment.issueId,
      ...(input.issue ? { issue: { id: input.issue.id, title: input.issue.title } } : {}),
      parentId: comment.parentId ?? null,
      userId: comment.userId,
      url: `https://linear.app/acme/issue/x#comment-${comment.id}`,
      createdAt: new Date().toISOString(),
    },
    webhookTimestamp: Date.now(),
  }
}

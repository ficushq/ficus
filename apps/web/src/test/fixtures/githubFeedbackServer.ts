import type {
  GitHubFeedbackDetail,
  GitHubFeedbackListItem,
  GitHubFeedbackSummary,
  GitHubTrustedAuthorList,
} from '@ficus/shared'

/** Test-only in-memory moderation API. Mirrors the server contract shapes, not its logic. */
export const SQUAD = '00000000-0000-4000-8000-000000000001'
export const hash = (seed: string) =>
  seed
    .padEnd(64, '0')
    .replace(/[^0-9a-f]/g, 'a')
    .slice(0, 64)
export const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export function item(n: number, patch: Partial<GitHubFeedbackListItem> = {}): GitHubFeedbackListItem {
  return {
    id: rid(n),
    contentHash: hash(`a${n}`),
    decisionVersion: 0,
    decision: 'pending',
    releaseState: 'held',
    reason: 'untrusted_author',
    objectKind: 'issue_comment',
    repository: 'acme/widgets',
    number: 40 + n,
    isPullRequest: true,
    author: { accountId: String(1000 + n), login: `outsider${n}`, accountType: 'User' },
    editor: null,
    attribution: 'creation',
    byteCount: 120,
    contentAvailable: true,
    firstObservedAt: `2026-10-0${Math.min(n, 9)}T10:00:00.000Z`,
    updatedAt: `2026-10-0${Math.min(n, 9)}T10:00:00.000Z`,
    attempts: 0,
    ...patch,
  }
}

export function detailOf(row: GitHubFeedbackListItem, patch: Partial<GitHubFeedbackDetail> = {}): GitHubFeedbackDetail {
  return {
    ...row,
    content: {
      title: `PR ${row.number}`,
      body: `Body of ${row.id}`,
      reviewState: '',
      deliveryText: `Delivery text for ${row.id}`,
      deliveryTruncated: false,
    },
    contentWithheld: null,
    url: `https://github.com/${row.repository}/pull/${row.number}#issuecomment-1`,
    authorTrust: [],
    editorTrust: [],
    routes: [{ kind: 'work_stream', id: 'route-1', workStreamId: 'ws-1', recipientId: 'agent-1' }],
    decidedByUserId: null,
    decidedAt: null,
    canModerate: true,
    ...patch,
  }
}

export interface FakeModerationApi {
  pending: GitHubFeedbackListItem[]
  releasing: GitHubFeedbackListItem[]
  details: Map<string, GitHubFeedbackDetail>
  summary: Partial<GitHubFeedbackSummary>
  trusted: GitHubTrustedAuthorList
  canModerate: boolean
  requests: Array<{ method: string; path: string; body: unknown }>
  /** Override for the next POST decisions call. */
  decide?: (body: { requestId: string; action: string; selections: unknown[] }) => Response | Promise<Response>
  other?: (method: string, path: string, body: unknown) => Response | undefined
}

export function fakeModerationApi(initial: Partial<FakeModerationApi> = {}): FakeModerationApi {
  return {
    pending: [],
    releasing: [],
    details: new Map(),
    summary: {},
    trusted: { authors: [], canManage: true },
    canModerate: true,
    requests: [],
    ...initial,
  }
}

export function moderationFetch(api: FakeModerationApi): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const path = url.pathname.replace(`/api/squads/${SQUAD}/github-feedback`, '')
    api.requests.push({ method, path: `${path}${url.search}`, body })
    const extra = api.other?.(method, path, body)
    if (extra) return extra
    if (method === 'GET' && path === '/summary')
      return Response.json({
        authorFilterEnabled: true,
        pending: api.pending.length,
        releasing: api.releasing.length,
        failing: api.releasing.filter((row) => row.releaseState === 'retry').length,
        canModerate: api.canModerate,
        ...api.summary,
      })
    if (method === 'GET' && path === '/revisions') {
      const queue = url.searchParams.get('queue') === 'releasing' ? api.releasing : api.pending
      const limit = Number(url.searchParams.get('limit') ?? 25)
      const offset = Number(url.searchParams.get('cursor') ?? 0)
      const items = queue.slice(offset, offset + limit)
      return Response.json({
        items,
        nextCursor: offset + limit < queue.length ? String(offset + limit) : null,
        canModerate: api.canModerate,
      })
    }
    const detail = path.match(/^\/revisions\/([^/]+)$/)
    if (method === 'GET' && detail) {
      const found =
        api.details.get(detail[1]!) ??
        [...api.pending, ...api.releasing]
          .map((row) => detailOf(row, { canModerate: api.canModerate }))
          .find((row) => row.id === detail[1])
      return found ? Response.json(found) : Response.json({ code: 'revision_not_found' }, { status: 404 })
    }
    if (method === 'POST' && path === '/decisions') {
      if (api.decide) return api.decide(body)
      const ids = new Set((body.selections as Array<{ revisionId: string }>).map((selection) => selection.revisionId))
      api.pending = api.pending.filter((row) => !ids.has(row.id))
      return Response.json(
        { decisions: [...ids].map((revisionId) => ({ revisionId, action: body.action, decisionVersion: 1 })) },
        { status: 202 }
      )
    }
    const retry = path.match(/^\/revisions\/([^/]+)\/retry$/)
    if (method === 'POST' && retry) return Response.json({ queued: true }, { status: 202 })
    if (method === 'GET' && path === '/trusted-authors') return Response.json(api.trusted)
    return Response.json({ error: 'unexpected', path }, { status: 500 })
  }) as typeof fetch
}

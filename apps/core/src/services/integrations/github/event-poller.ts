import { githubDeliverySnapshot, type GitHubDeliverySnapshot } from './delivery-presentation'
import { createHash } from 'node:crypto'
import type { EventPollingCapability, EventPollingSignal, RuntimeConnection, VerifiedIngressEvent } from '../types'

const API_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'

type NativeObject = Record<string, unknown>

export interface GitHubPrPollingConfig {
  /** Extra bounded aggregate query for designated delivery PRs only. */
  deliveryPresentation?: boolean
  owner: string
  repo: string
  number: number
  /** Latest durable verified real delivery for replay-free polling resumption. */
  lastVerifiedWebhookDeliveryAt?: string
}

type CollectionKey = 'issueComments' | 'reviews' | 'reviewComments'

interface StoredObjectFingerprint extends NativeObject {
  fingerprint: string
  updatedAt?: string
}

interface CollectionScanState {
  nextPage: number
  fingerprints: Record<string, StoredObjectFingerprint>
  objects: Record<string, NativeObject>
  actions?: Record<string, string>
  pageFingerprints: Record<string, string>
  lastNonEmptyPage: number
  lastSize: number
  complete: boolean
  known?: { count: number; lastSize: number }
  validating?: boolean
  changedWhileValidating?: boolean
}

interface PendingGitHubScan {
  baseline: boolean
  /** Verified delivery this no-emission scan durably consumes. */
  baselineDeliveryAt?: string
  /** Valid provider clock only; absent clocks never manufacture ordering evidence. */
  startedAt?: string
  pullRequest: NativeObject
  issue: NativeObject
  collections: Partial<Record<CollectionKey, CollectionScanState>>
}

export interface GitHubPollingCursor extends Record<string, unknown> {
  deliveryPresentation?: GitHubDeliverySnapshot
  etags: Record<string, string>
  pr: { headSha: string | null; state: string | null; merged: boolean }
  issue: NativeObject
  pullRequest?: NativeObject
  issueComments: Record<string, StoredObjectFingerprint | NativeObject>
  reviews: Record<string, StoredObjectFingerprint | NativeObject>
  reviewComments: Record<string, StoredObjectFingerprint | NativeObject>
  lastIssueCommentUpdatedAt?: string
  lastSuccessfulPollAt?: string
  lastConsumedWebhookDeliveryAt?: string
  etagPaths?: Record<string, string>
  collectionPages?: Record<string, { count: number; lastSize: number }>
  pendingScan?: PendingGitHubScan
}

export type GitHubPollingFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface GitHubPrEventPollerOptions {
  resolveCredential: (connection: RuntimeConnection<GitHubPrPollingConfig>) => Promise<string | undefined>
  fetch?: GitHubPollingFetch
  apiBase?: string
}

interface EndpointResult {
  changed: boolean
  etag?: string
  body?: unknown
  hasNext: boolean
  serverDate?: string
}

interface CollectionResult {
  state: CollectionScanState
  requestsConsumed: number
}

function objectMap(items: unknown): Record<string, NativeObject> {
  const mapped: Record<string, NativeObject> = {}
  if (!Array.isArray(items)) return mapped
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const id = (item as NativeObject).id
    if (typeof id === 'number' || typeof id === 'string') mapped[String(id)] = item as NativeObject
  }
  return mapped
}

function canonicalIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalIdentity)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as NativeObject)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalIdentity(nestedValue)])
  )
}

function storedFingerprint(object: NativeObject): StoredObjectFingerprint {
  const updatedAt = object.updated_at ?? object.submitted_at
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([updatedAt ?? null, object.state ?? null, object.body ?? null]))
    .digest('base64url')
  return { fingerprint, ...(typeof updatedAt === 'string' ? { updatedAt } : {}) }
}

function collectionLogicalIdentity(object: NativeObject): NativeObject {
  const version = storedFingerprint(object)
  return { id: object.id, fingerprint: version.fingerprint, updatedAt: version.updatedAt ?? null }
}

function normalizeStoredMap(
  input: Record<string, StoredObjectFingerprint | NativeObject> | undefined,
  normalize: (object: NativeObject) => NativeObject = (object) => object
): Record<string, StoredObjectFingerprint> {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([id, value]) => [
      id,
      typeof value.fingerprint === 'string' ? (value as StoredObjectFingerprint) : storedFingerprint(normalize(value)),
    ])
  )
}

function pageFingerprint(items: NativeObject[]): string {
  return createHash('sha256')
    .update(JSON.stringify(items.map((item) => [String(item.id), storedFingerprint(item).fingerprint])))
    .digest('base64url')
}

function nested(object: NativeObject, ...path: string[]): unknown {
  let value: unknown = object
  for (const key of path) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as NativeObject)[key]
  }
  return value
}

function synthetic(
  type: string,
  payload: NativeObject,
  identity: NativeObject,
  versioned = true
): VerifiedIngressEvent {
  const action = typeof payload.action === 'string' ? payload.action : 'unknown'
  const nativeId = identity.id ?? nested(payload, 'pull_request', 'id') ?? nested(payload, 'issue', 'id')
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(canonicalIdentity(identity)))
    .digest('base64url')
  const logicalEventKey = createHash('sha256')
    .update(JSON.stringify(['github:v1', type, action, nativeId, ...(versioned ? [fingerprint] : [])]))
    .digest('hex')
  const event: VerifiedIngressEvent = {
    type,
    payload,
    metadata: { synthetic: true },
  }
  // Keep internal dedupe identity out of the native webhook-equivalent envelope.
  Object.defineProperty(event, 'logicalEventKey', { value: logicalEventKey, enumerable: false })
  return event
}

function afterCutoff(value: unknown, cutoff: string | undefined): boolean {
  const timestamp = normalizeTimestamp(typeof value === 'string' ? value : null)
  return Boolean(timestamp && cutoff && Date.parse(timestamp) > Date.parse(cutoff))
}

function collectionRecoveryAction(
  key: CollectionKey,
  existed: boolean,
  item: NativeObject,
  cutoff: string | undefined
): string | undefined {
  if (key === 'reviews') {
    if (existed || item.state === 'dismissed') return undefined
    return afterCutoff(item.submitted_at, cutoff) ? 'submitted' : undefined
  }
  if (existed) return afterCutoff(item.updated_at, cutoff) ? 'edited' : undefined
  const createdAt = normalizeTimestamp(typeof item.created_at === 'string' ? item.created_at : null)
  const normalizedCutoff = normalizeTimestamp(cutoff ?? null)
  if (!createdAt || !normalizedCutoff) return undefined
  if (Date.parse(createdAt) > Date.parse(normalizedCutoff)) return 'created'
  return afterCutoff(item.updated_at, normalizedCutoff) ? 'edited' : undefined
}

function repositoryFrom(pr: NativeObject, owner: string, repo: string): NativeObject {
  const native = nested(pr, 'base', 'repo')
  return native && typeof native === 'object'
    ? { ...(native as NativeObject), custom_properties: (native as NativeObject).custom_properties ?? {} }
    : { full_name: `${owner}/${repo}`, custom_properties: {} }
}

function senderFrom(object: NativeObject): unknown {
  return object.user
}

function webhookUser(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const user = { ...(value as NativeObject) }
  if (typeof user.avatar_url === 'string') {
    const avatar = new URL(user.avatar_url)
    avatar.searchParams.delete('u')
    user.avatar_url = avatar.toString()
  }
  return user
}

function webhookIssue(issue: NativeObject): NativeObject {
  const normalized: NativeObject = {
    ...issue,
    ...(issue.user === undefined ? {} : { user: webhookUser(issue.user) }),
    ...(issue.assignee === undefined ? {} : { assignee: webhookUser(issue.assignee) }),
    ...(Array.isArray(issue.assignees) ? { assignees: issue.assignees.map(webhookUser) } : {}),
  }
  delete normalized.closed_by
  return normalized
}

function webhookComment(comment: NativeObject): NativeObject {
  const normalized: NativeObject = {
    ...comment,
    ...(comment.user === undefined ? {} : { user: webhookUser(comment.user) }),
  }
  delete normalized.pin
  return normalized
}

function webhookReview(review: NativeObject): NativeObject {
  return {
    ...review,
    ...(typeof review.state === 'string' ? { state: review.state.toLowerCase() } : {}),
    ...(review.user === undefined ? {} : { user: webhookUser(review.user) }),
  }
}

function normalizeTimestamp(value: string | null): string | undefined {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

function replayBaselineDelivery(
  cursor: GitHubPollingCursor | null,
  configuredDelivery: string | undefined
): string | undefined {
  if (!cursor) return undefined
  const delivery = normalizeTimestamp(configuredDelivery ?? null)
  const successfulPoll = normalizeTimestamp(cursor.lastSuccessfulPollAt ?? null)
  const consumedDelivery = normalizeTimestamp(cursor.lastConsumedWebhookDeliveryAt ?? null)
  if (!delivery || !successfulPoll || Date.parse(delivery) <= Date.parse(successfulPoll)) return undefined
  if (consumedDelivery && Date.parse(delivery) <= Date.parse(consumedDelivery)) return undefined
  return delivery
}

/**
 * Never let a weaker or missing observation erase what the provider last proved.
 * REST cannot see GitHub's required-review decision, so a REST fallback keeps
 * the previous same-head aggregate decision instead of an invented `unknown`.
 * With no new observation at all, the previous snapshot is kept unchanged: its
 * original observation time lets consumers age its readiness facts.
 */
export function retainDeliveryEvidence(
  previous: GitHubDeliverySnapshot | undefined,
  next: GitHubDeliverySnapshot | undefined
): GitHubDeliverySnapshot | undefined {
  if (!next) return previous
  if (
    next.source === 'rest' &&
    previous &&
    previous.headSha === next.headSha &&
    previous.connectionId === next.connectionId &&
    previous.repository === next.repository &&
    previous.number === next.number
  )
    return { ...next, reviewDecision: previous.reviewDecision }
  return next
}

function overlapTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp - 1_000).toISOString() : value
}

/**
 * GitHub's first event-polling provider. REST objects are placed into the same
 * payload positions GitHub webhooks use without projecting or renaming fields.
 */
export class GitHubPrEventPoller implements EventPollingCapability<GitHubPrPollingConfig> {
  readonly #resolveCredential: GitHubPrEventPollerOptions['resolveCredential']
  readonly #fetch: GitHubPollingFetch
  readonly #apiBase: string

  constructor(options: GitHubPrEventPollerOptions) {
    this.#resolveCredential = options.resolveCredential
    this.#fetch = options.fetch ?? fetch
    this.#apiBase = options.apiBase ?? API_BASE
  }

  async poll(
    connection: RuntimeConnection<GitHubPrPollingConfig>,
    cursorValue: Readonly<Record<string, unknown>> | null,
    signal?: EventPollingSignal
  ) {
    const credential = await this.#resolveCredential(connection)
    if (!credential) throw new Error(`GitHub credential unavailable for squad ${connection.squadId}`)

    const cursor = cursorValue as GitHubPollingCursor | null
    const { owner, repo, number } = connection.configuration
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    let etags = { ...(cursor?.etags ?? {}) }
    let etagPaths = { ...(cursor?.etagPaths ?? {}) }
    let collectionPages = { ...(cursor?.collectionPages ?? {}) }
    let useCursorCollectionMetadata = true
    let requestsConsumed = 0
    const request = async (key: string, path: string) => {
      requestsConsumed++
      const etag = !etagPaths[key] || etagPaths[key] === path ? etags[key] : undefined
      const result = await this.#get(path, credential, etag, signal)
      if (result.etag) etags[key] = result.etag
      etagPaths[key] = path
      return result
    }

    let deliveryPresentation: GitHubDeliverySnapshot | undefined
    const deliveryToBaseline = replayBaselineDelivery(cursor, connection.configuration.lastVerifiedWebhookDeliveryAt)
    let scan = cursor?.pendingScan
    if (scan && deliveryToBaseline && scan.baselineDeliveryAt !== deliveryToBaseline) {
      // A verified delivery newer than this pending scan invalidates its live
      // pages. Restart unconditionally: validators cannot outlive bodies from
      // the discarded scan without letting 304 responses commit stale state.
      scan = undefined
      etags = {}
      etagPaths = {}
      collectionPages = {}
      useCursorCollectionMetadata = false
    }
    if (!scan) {
      const prPath = `${root}/pulls/${number}`
      let prResult = await request('pr', prPath)
      if (!prResult.changed && cursor && !cursor.pullRequest) {
        // Cursors written before native PR snapshots were persisted cannot safely
        // commit collection validators until the PR context has been recovered.
        requestsConsumed++
        prResult = await this.#get(prPath, credential, undefined, signal)
        if (prResult.etag) etags.pr = prResult.etag
        if (!prResult.changed) throw new Error('GitHub pull request snapshot unavailable for legacy cursor')
      }
      const issueResult = await request('issue', `${root}/issues/${number}`)
      const pullRequest = (prResult.changed ? prResult.body : cursor?.pullRequest) as NativeObject | undefined
      if (!pullRequest) throw new Error('GitHub pull request response was empty')
      // A 304 validates activity context, not GitHub's asynchronously computed
      // merge/review fields. Never extend a readiness proof from that old body.
      if (connection.configuration.deliveryPresentation && prResult.changed) {
        deliveryPresentation = githubDeliverySnapshot(connection, pullRequest, new Date().toISOString())
      }
      scan = {
        baseline: cursor === null || Boolean(deliveryToBaseline),
        ...(deliveryToBaseline ? { baselineDeliveryAt: deliveryToBaseline } : {}),
        startedAt: prResult.serverDate,
        pullRequest,
        issue: webhookIssue(
          ((issueResult.changed ? issueResult.body : cursor?.issue) as NativeObject | undefined) ?? {}
        ),
        collections: {},
      }
    }

    if (connection.configuration.deliveryPresentation) {
      requestsConsumed++
      // Read the policy/check aggregate after REST context. It can observe a
      // newer head than an in-progress activity scan and remains independent.
      deliveryPresentation = retainDeliveryEvidence(
        cursor?.deliveryPresentation,
        (await this.#deliveryPresentation(connection, credential, signal)) ?? deliveryPresentation
      )
    }

    const issueCommentQuery = new URLSearchParams({ per_page: '100' })
    if (cursor?.lastIssueCommentUpdatedAt) {
      // GitHub orders issue comments by ID rather than updated_at. Keep a
      // one-second overlap so timestamp ties cannot fall behind the watermark.
      issueCommentQuery.set('since', overlapTimestamp(cursor.lastIssueCommentUpdatedAt))
    }
    const specs: Array<[CollectionKey, string]> = [
      ['issueComments', `${root}/issues/${number}/comments?${issueCommentQuery}`],
      ['reviews', `${root}/pulls/${number}/reviews?per_page=100`],
      ['reviewComments', `${root}/pulls/${number}/comments?per_page=100`],
    ]
    for (const [key, path] of specs) {
      if (!scan.collections[key]?.complete) {
        const result = await this.#getCollection(
          key,
          path,
          credential,
          cursor,
          etags,
          etagPaths,
          scan.baseline,
          scan.baselineDeliveryAt,
          useCursorCollectionMetadata,
          scan.collections[key],
          signal
        )
        requestsConsumed += result.requestsConsumed
        scan.collections[key] = result.state
      }
      const state = scan.collections[key]!
      collectionPages[key] = { count: state.lastNonEmptyPage, lastSize: state.lastSize }
      if (!state.complete) {
        const currentPr = {
          headSha: (nested(scan.pullRequest, 'head', 'sha') as string | undefined) ?? null,
          state: (scan.pullRequest.state as string | undefined) ?? null,
          merged: scan.pullRequest.merged === true,
        }
        return {
          events: [],
          nextCursor: {
            etags,
            etagPaths,
            collectionPages,
            pr: cursor?.pr ?? currentPr,
            issue: cursor?.issue ?? scan.issue,
            pullRequest: cursor?.pullRequest ?? scan.pullRequest,
            deliveryPresentation: connection.configuration.deliveryPresentation
              ? deliveryPresentation
              : cursor?.deliveryPresentation,
            issueComments: cursor?.issueComments ?? {},
            reviews: cursor?.reviews ?? {},
            reviewComments: cursor?.reviewComments ?? {},
            ...(cursor?.lastIssueCommentUpdatedAt
              ? { lastIssueCommentUpdatedAt: cursor.lastIssueCommentUpdatedAt }
              : {}),
            ...(cursor?.lastSuccessfulPollAt ? { lastSuccessfulPollAt: cursor.lastSuccessfulPollAt } : {}),
            ...(cursor?.lastConsumedWebhookDeliveryAt
              ? { lastConsumedWebhookDeliveryAt: cursor.lastConsumedWebhookDeliveryAt }
              : {}),
            pendingScan: scan,
          },
          suggestedIntervalMs: 60_000,
          budgetUnitsConsumed: requestsConsumed,
        }
      }
    }

    const nextPr = scan.pullRequest

    const repository = repositoryFrom(nextPr, owner, repo)
    const currentPr = {
      headSha: (nested(nextPr, 'head', 'sha') as string | undefined) ?? null,
      state: (nextPr.state as string | undefined) ?? null,
      merged: nextPr.merged === true,
    }
    const nextIssue = scan.issue
    const previousIssueComments = normalizeStoredMap(cursor?.issueComments)
    const newIssueComments = objectMap(Object.values(scan.collections.issueComments!.objects).map(webhookComment))
    const nextIssueComments = { ...previousIssueComments, ...scan.collections.issueComments!.fingerprints }
    const previousReviews = normalizeStoredMap(cursor?.reviews, webhookReview)
    const newReviews = objectMap(Object.values(scan.collections.reviews!.objects).map(webhookReview))
    const nextReviews = { ...previousReviews, ...scan.collections.reviews!.fingerprints }
    const previousReviewComments = normalizeStoredMap(cursor?.reviewComments)
    const newReviewComments = objectMap(Object.values(scan.collections.reviewComments!.objects).map(webhookComment))
    const nextReviewComments = { ...previousReviewComments, ...scan.collections.reviewComments!.fingerprints }
    const events: VerifiedIngressEvent[] = []

    if (cursor) {
      if (cursor.pr.state !== currentPr.state || cursor.pr.merged !== currentPr.merged) {
        const action = currentPr.state === 'closed' ? 'closed' : 'reopened'
        const transitionAt = nextPr.merged === true ? (nextPr.merged_at ?? nextPr.closed_at) : nextPr.closed_at
        if (!scan.baseline || (action === 'closed' && afterCutoff(transitionAt, scan.baselineDeliveryAt))) {
          const identity = {
            id: nextPr.id,
            state: currentPr.state,
            merged: currentPr.merged,
            headSha: currentPr.headSha,
            transitionAt: action === 'closed' ? transitionAt : nextPr.updated_at,
          }
          events.push(synthetic('pull_request', { action, number, pull_request: nextPr, repository }, identity))
        }
      } else if (cursor.pr.headSha !== currentPr.headSha && !scan.baseline) {
        const identity = { id: nextPr.id, headSha: currentPr.headSha, transitionAt: nextPr.updated_at }
        events.push(
          synthetic('pull_request', { action: 'synchronize', number, pull_request: nextPr, repository }, identity)
        )
      }
    }

    for (const [id, comment] of Object.entries(newIssueComments)) {
      const previous = previousIssueComments[id]
      const action = scan.collections.issueComments!.actions?.[id] ?? (previous ? 'edited' : 'created')
      events.push(
        synthetic(
          'issue_comment',
          { action, issue: nextIssue, comment, repository, sender: senderFrom(comment) },
          collectionLogicalIdentity(comment),
          action === 'edited'
        )
      )
    }
    for (const [id, review] of Object.entries(newReviews)) {
      const previous = previousReviews[id]
      const action =
        scan.collections.reviews!.actions?.[id] ??
        (review.state === 'dismissed' ? 'dismissed' : previous ? 'edited' : 'submitted')
      events.push(
        synthetic(
          'pull_request_review',
          { action, review, pull_request: nextPr, repository, sender: senderFrom(review) },
          collectionLogicalIdentity(review),
          action !== 'submitted'
        )
      )
    }
    for (const [id, comment] of Object.entries(newReviewComments)) {
      const previous = previousReviewComments[id]
      const action = scan.collections.reviewComments!.actions?.[id] ?? (previous ? 'edited' : 'created')
      events.push(
        synthetic(
          'pull_request_review_comment',
          { action, comment, pull_request: nextPr, repository, sender: senderFrom(comment) },
          collectionLogicalIdentity(comment),
          action === 'edited'
        )
      )
    }

    const previousHighWater = normalizeTimestamp(cursor?.lastIssueCommentUpdatedAt ?? null) ?? new Date(0).toISOString()
    // A valid provider boundary advances ordering evidence. Missing/invalid
    // provider time preserves prior evidence rather than manufacturing it.
    const providerBoundary = normalizeTimestamp(scan.startedAt ?? null)
    const safeHighWater =
      providerBoundary && Date.parse(providerBoundary) > Date.parse(previousHighWater)
        ? providerBoundary
        : previousHighWater
    const previousSuccessfulPollAt = normalizeTimestamp(cursor?.lastSuccessfulPollAt ?? null)
    const lastSuccessfulPollAt =
      providerBoundary &&
      (!previousSuccessfulPollAt || Date.parse(providerBoundary) > Date.parse(previousSuccessfulPollAt))
        ? providerBoundary
        : previousSuccessfulPollAt
    const previousConsumedDelivery = normalizeTimestamp(cursor?.lastConsumedWebhookDeliveryAt ?? null)
    const consumedDelivery = normalizeTimestamp(scan.baselineDeliveryAt ?? null)
    const lastConsumedWebhookDeliveryAt =
      consumedDelivery &&
      (!previousConsumedDelivery || Date.parse(consumedDelivery) > Date.parse(previousConsumedDelivery))
        ? consumedDelivery
        : previousConsumedDelivery
    const nextCursor: GitHubPollingCursor = {
      etags,
      etagPaths,
      collectionPages,
      pr: currentPr,
      issue: nextIssue,
      pullRequest: nextPr,
      deliveryPresentation: connection.configuration.deliveryPresentation
        ? deliveryPresentation
        : cursor?.deliveryPresentation,
      issueComments: nextIssueComments,
      reviews: nextReviews,
      reviewComments: nextReviewComments,
      lastIssueCommentUpdatedAt: safeHighWater,
      ...(lastSuccessfulPollAt ? { lastSuccessfulPollAt } : {}),
      ...(lastConsumedWebhookDeliveryAt ? { lastConsumedWebhookDeliveryAt } : {}),
    }
    return { events, nextCursor, suggestedIntervalMs: 60_000, budgetUnitsConsumed: requestsConsumed }
  }

  async #getCollection(
    key: CollectionKey,
    basePath: string,
    credential: string,
    cursor: GitHubPollingCursor | null,
    etags: Record<string, string>,
    etagPaths: Record<string, string>,
    baseline: boolean,
    baselineCutoff: string | undefined,
    useCursorCollectionMetadata: boolean,
    resume?: CollectionScanState,
    signal?: EventPollingSignal
  ): Promise<CollectionResult> {
    const fingerprints = { ...(resume?.fingerprints ?? {}) }
    const objects = { ...(resume?.objects ?? {}) }
    const actions = { ...(resume?.actions ?? {}) }
    const pageFingerprints = { ...(resume?.pageFingerprints ?? {}) }
    const normalizeObject = key === 'reviews' ? webhookReview : webhookComment
    const previous = normalizeStoredMap(
      cursor?.[key] as Record<string, StoredObjectFingerprint | NativeObject> | undefined,
      normalizeObject
    )
    const legacyItemCount = cursor
      ? Object.keys((cursor[key as keyof GitHubPollingCursor] as Record<string, NativeObject> | undefined) ?? {}).length
      : 0
    const firstUrl = new URL(basePath, this.#apiBase)
    firstUrl.searchParams.set('page', '1')
    const firstPath = `${firstUrl.pathname}?${firstUrl.searchParams}`
    let known =
      resume?.known ??
      (useCursorCollectionMetadata && (!cursor?.etagPaths || cursor.etagPaths[`${key}:1`] === firstPath)
        ? (cursor?.collectionPages?.[key] ??
          (legacyItemCount >= 100
            ? { count: Math.ceil(legacyItemCount / 100), lastSize: legacyItemCount % 100 || 100 }
            : undefined))
        : undefined)
    let page = resume?.nextPage ?? 1
    let requestsConsumed = 0
    let lastNonEmptyPage = resume?.lastNonEmptyPage ?? 1
    let lastSize = resume?.lastSize ?? 0
    let validating = resume?.validating ?? false
    let changedWhileValidating = resume?.changedWhileValidating ?? false
    const scanState = (nextPage: number, complete: boolean): CollectionScanState => ({
      nextPage,
      fingerprints,
      objects,
      actions,
      pageFingerprints,
      lastNonEmptyPage,
      lastSize,
      complete,
      ...(known ? { known } : {}),
      ...(validating ? { validating: true } : {}),
      ...(changedWhileValidating ? { changedWhileValidating: true } : {}),
    })

    for (;;) {
      if (signal?.remainingBudgetUnits === 0) {
        return {
          state: scanState(page, false),
          requestsConsumed,
        }
      }
      const url = new URL(basePath, this.#apiBase)
      url.searchParams.set('page', String(page))
      const path = `${url.pathname}?${url.searchParams}`
      const etagKey = `${key}:${page}`
      const legacyEtag = useCursorCollectionMetadata && page === 1 ? cursor?.etags?.[key] : undefined
      const storedEtag = etagPaths[etagKey] === path ? etags[etagKey] : undefined
      const requestEtag = storedEtag ?? legacyEtag
      const result = await this.#get(path, credential, requestEtag, signal)
      requestsConsumed++
      if (result.etag) etags[etagKey] = result.etag
      etagPaths[etagKey] = path

      let size: number
      if (result.changed) {
        const pageItems = Array.isArray(result.body)
          ? result.body
              .filter((item): item is NativeObject => Boolean(item && typeof item === 'object'))
              .map(normalizeObject)
          : []
        const contentFingerprint = pageFingerprint(pageItems)
        if (validating && pageFingerprints[String(page)] !== contentFingerprint) changedWhileValidating = true
        pageFingerprints[String(page)] = contentFingerprint
        for (const item of pageItems) {
          const id = String(item.id)
          const fingerprint = storedFingerprint(item)
          fingerprints[id] = fingerprint
          const changed = previous[id]?.fingerprint !== fingerprint.fingerprint
          const recoveryAction = baseline
            ? collectionRecoveryAction(key, Boolean(previous[id]), item, baselineCutoff)
            : undefined
          if (changed && (!baseline || recoveryAction)) {
            objects[id] = item
            if (recoveryAction) actions[id] = recoveryAction
          } else {
            delete objects[id]
            delete actions[id]
          }
        }
        size = pageItems.length
      } else if (known && page <= known.count) {
        size = page === known.count ? known.lastSize : 100
      } else {
        size = 0
      }
      if (size > 0) {
        lastNonEmptyPage = page
        lastSize = size
      }

      const shouldContinue =
        result.hasNext || (known ? page < known.count || (page === known.count && known.lastSize === 100) : false)
      if (!shouldContinue) {
        if (key === 'issueComments' && lastNonEmptyPage > 1 && (!validating || changedWhileValidating)) {
          // A multi-page ID-ordered scan is not a snapshot. Revalidate every
          // page conditionally; if any page changed, repeat until one full pass
          // is stable before advancing the updated_at watermark.
          known = { count: lastNonEmptyPage, lastSize }
          validating = true
          changedWhileValidating = false
          page = 1
          continue
        }
        return { state: scanState(page + 1, true), requestsConsumed }
      }
      page++
    }
  }

  async #deliveryPresentation(
    connection: RuntimeConnection<GitHubPrPollingConfig>,
    credential: string,
    signal?: EventPollingSignal
  ): Promise<GitHubDeliverySnapshot | undefined> {
    signal?.reserveRequest()
    try {
      const response = await this.#fetch(`${this.#apiBase}/graphql`, {
        method: 'POST',
        signal,
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            'query DeliveryPresentation($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid headRefName baseRefName state isDraft mergeStateStatus reviewDecision reviewRequests(first:100){nodes{requestedReviewer{__typename}}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}',
          variables: {
            owner: connection.configuration.owner,
            repo: connection.configuration.repo,
            number: connection.configuration.number,
          },
        }),
      })
      if (!response.ok) return undefined
      const body = (await response.json()) as {
        errors?: unknown
        data?: { repository?: { pullRequest?: Record<string, unknown> } }
      }
      const pr = body.data?.repository?.pullRequest
      if (body.errors || !pr) return undefined
      return githubDeliverySnapshot(connection, pr, new Date().toISOString(), true)
    } catch (error) {
      if (signal?.aborted) throw error
      // Missing GraphQL permission never invents an approval requirement. The
      // ordinary REST poll can still provide a weaker, current PR snapshot.
      return undefined
    }
  }

  async #get(path: string, credential: string, etag?: string, signal?: EventPollingSignal): Promise<EndpointResult> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${credential}`,
      'x-github-api-version': API_VERSION,
    }
    if (etag) headers['if-none-match'] = etag
    signal?.reserveRequest()
    const response = await this.#fetch(`${this.#apiBase}${path}`, { headers, signal })
    const serverDate = normalizeTimestamp(response.headers.get('date'))
    if (response.status === 304) return { changed: false, hasNext: false, serverDate }
    if (!response.ok) throw new Error(`GitHub polling request failed (${response.status}) for ${path}`)
    return {
      changed: true,
      etag: response.headers.get('etag') ?? undefined,
      body: await response.json(),
      hasNext: /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? ''),
      serverDate,
    }
  }
}

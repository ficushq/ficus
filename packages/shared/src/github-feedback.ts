import { z } from 'zod'

/** GitHub's numeric account identity, never an editable login or association label. */
export const githubAccountIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value)), 'Invalid GitHub account ID')

export const githubFeedbackSelectionSchema = z
  .object({
    revisionId: z.string().uuid(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    decisionVersion: z.number().int().nonnegative(),
  })
  .strict()

/** All authority and content are read from storage, not supplied by the caller. */
export const moderateGitHubFeedbackSchema = z
  .object({
    requestId: z.string().uuid(),
    action: z.enum(['allow_once', 'deny', 'allow_trust']),
    selections: z.array(githubFeedbackSelectionSchema).min(1).max(50),
  })
  .strict()
  .refine(
    ({ selections }) => new Set(selections.map((selection) => selection.revisionId)).size === selections.length,
    'Select each revision only once'
  )

export type GitHubFeedbackSelection = z.infer<typeof githubFeedbackSelectionSchema>
export type ModerateGitHubFeedback = z.infer<typeof moderateGitHubFeedbackSchema>
/**
 * `screened`: a decision model judged held content from an untrusted author safe, in a squad that
 * opted into screening. Like a human "allow once" it releases exactly the screened snapshot and
 * trusts nobody; unlike it, no person decided.
 */
export type GitHubFeedbackDecision =
  | ModerateGitHubFeedback['action']
  | 'pending'
  | 'automatic'
  | 'historical'
  | 'screened'
export type GitHubFeedbackReleaseState = 'held' | 'ready' | 'retry' | 'retained' | 'delivered' | 'obsolete'
export type GitHubTrustOrigin = { kind: 'manual'; addedByUserId: string } | { kind: 'linked_user'; userId: string }

export interface GitHubAccountIdentity {
  accountId: string
  login: string
  accountType: 'User' | 'Bot'
}

/** Personal ownership is distinct from configuring any squad integration. */
export interface GitHubPersonalIdentityStatus {
  linked: { accountId: string; login: string; linkedAt: string } | null
  confirmation: { id: string; accountId: string; login: string; expiresAt: string } | null
  authorization: { configured: boolean; authority: 'local' | 'platform_broker'; mode: 'browser' | 'device' }
}

/**
 * Immutable review input. `delivery` contains only this content object's text, never its parent.
 * `action` is an issue/PR action (assign, review request, label, close/reopen) authored by the
 * verified webhook sender; its delivery is a fixed factual projection without parent title/body.
 */
export interface GitHubFeedbackContent {
  normalizationVersion: 1
  repositoryId: string | null
  objectKind: 'issue' | 'pull_request' | 'issue_comment' | 'review' | 'review_comment' | 'action'
  nativeId: string | null
  providerVersion: string | null
  author: GitHubAccountIdentity | null
  editor: GitHubAccountIdentity | null
  attribution: 'creation' | 'verified_edit' | 'unknown'
  contentHash: string
  byteCount: number
  reason: 'content_unavailable' | null
  delivery: import('./integration-outputs').IntegrationOutputFact | null
}
export interface GitHubFeedbackEnvelope {
  /** Checked against the source association table, never trusted as an approval hint. */
  revisionId?: string
  /** Provenance assigned by verified ingress, not provider text/metadata. */
  observation?: { kind: 'webhook' | 'poll'; deliveryId?: string }
  content: GitHubFeedbackContent | null
  /** Explicit content-free lifecycle projection. Never executes squad content rules/bindings. */
  status: import('./integration-outputs').IntegrationOutputFact | null
}

/** Server-captured routing authority. Hashes contain configuration, never external prose. */
export interface GitHubFeedbackRoute {
  kind: string
  id: string
  workStreamId?: string
  recipientId?: string
  fingerprint?: string
  authorityHash?: string
  runId?: string
  ownerId?: string | null
  consumers?: Array<{
    agentId?: string
    attemptId?: number
    version?: number
    stepId?: string
    participant?: string
    stepHash?: string
  }>
}

// ---------------------------------------------------------------------------
// Human moderation HTTP contracts. Every body is strict; the server derives author, squad,
// authority and content from storage. No DTO carries routing hashes or connection material.
// ---------------------------------------------------------------------------

/** Pending = awaiting a human decision; releasing = allowed but not yet delivered (incl. retries). */
export const githubFeedbackQueueSchema = z.enum(['pending', 'releasing'])
export type GitHubFeedbackQueue = z.infer<typeof githubFeedbackQueueSchema>

export const githubFeedbackPageQuerySchema = z
  .object({
    queue: githubFeedbackQueueSchema.default('pending'),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()

export const githubAuthorFilterUpdateSchema = z.object({ enabled: z.boolean() }).strict()

/**
 * What the author filter does with feedback from people the squad doesn't trust.
 * - `hold`: hold it for a person to review (the default).
 * - `screen`: ask a decision model first; release it once if confidently safe, otherwise hold it.
 */
export const GITHUB_UNTRUSTED_HANDLING = ['hold', 'screen'] as const
export type GitHubUntrustedHandling = (typeof GITHUB_UNTRUSTED_HANDLING)[number]
export const githubUntrustedHandlingUpdateSchema = z.object({ handling: z.enum(GITHUB_UNTRUSTED_HANDLING) }).strict()

/**
 * Why a screen ended the way it did. Only `safe` releases anything.
 * - `unsafe`: the model saw instructions aimed at an agent, or suspicious or malicious intent.
 * - `uncertain`: neither clearly safe nor clearly unsafe, or the model declined to answer.
 * - `unavailable` / `unconfigured`: no decision model answered, or none is set up.
 * - `too_long`: longer than Ficus screens; held without asking.
 * - `skipped`: a person decided first, the content changed, or the squad stopped screening.
 * - `source_unavailable`: no squad connection can still read the source, so it was not screened or
 *   released (the same rule as a human allow).
 */
export type GitHubFeedbackScreenOutcome =
  | 'safe'
  | 'unsafe'
  | 'uncertain'
  | 'unavailable'
  | 'unconfigured'
  | 'too_long'
  | 'skipped'
  | 'source_unavailable'

/** A decision model's verdict on one held revision, as stored and shown to moderators. */
export interface GitHubFeedbackScreening {
  /** `queued`/`running`: waiting for the model. `passed`: released. `held`: left for a person. */
  state: 'queued' | 'running' | 'passed' | 'held'
  outcome: GitHubFeedbackScreenOutcome | null
  /** Probability the text gives instructions to an agent reading it. */
  instructsAgent: number | null
  intent: 'benign' | 'suspicious' | 'malicious' | null
  /** Confidence in `intent`. */
  intentConfidence: number | null
  providerId: string | null
  model: string | null
  screenedAt: string | null
}
export const githubTrustedAuthorResolveSchema = z.object({ login: z.string().min(1).max(100) }).strict()
/** `accountId` is the account the human confirmed; the server re-resolves and refuses a mismatch. */
export const githubTrustedAuthorAddSchema = z
  .object({ login: z.string().min(1).max(100), accountId: githubAccountIdSchema })
  .strict()

export interface GitHubFeedbackSummary {
  authorFilterEnabled: boolean
  untrustedHandling: GitHubUntrustedHandling
  /** Some decision model is set up and enabled for the GitHub firewall. */
  decisionModelConfigured: boolean
  /** Held untrusted feedback that "screen what's pending now" would queue. */
  screenable: number
  pending: number
  /** Allowed by a human (or the filter switch) and still waiting for, or retrying, delivery. */
  releasing: number
  /** Subset of `releasing` whose last attempt failed and will be retried. */
  failing: number
  canModerate: boolean
}

/** Result of "screen what's pending now". `more`: eligible feedback beyond this batch remains. */
export interface GitHubFeedbackScreenPendingResult {
  queued: number
  skipped: number
  more: boolean
}

export interface GitHubFeedbackListItem {
  id: string
  contentHash: string
  decisionVersion: number
  decision: GitHubFeedbackDecision
  releaseState: GitHubFeedbackReleaseState
  reason: string | null
  objectKind: GitHubFeedbackContent['objectKind'] | null
  repository: string | null
  number: number | null
  isPullRequest: boolean
  author: GitHubAccountIdentity | null
  editor: GitHubAccountIdentity | null
  attribution: GitHubFeedbackContent['attribution']
  byteCount: number
  contentAvailable: boolean
  firstObservedAt: string
  updatedAt: string
  attempts: number
  /** The decision model's verdict, when the squad screens untrusted feedback. */
  screening: GitHubFeedbackScreening | null
}

export interface GitHubFeedbackPage {
  items: GitHubFeedbackListItem[]
  nextCursor: string | null
  canModerate: boolean
}

export interface GitHubFeedbackDetail extends GitHubFeedbackListItem {
  /** Exactly the reviewed (approval-bound) text. Null when withheld or unavailable. */
  content: {
    title: string
    body: string
    path?: string
    line?: number | null
    reviewState: string
    /** The agent-facing notification text a release delivers, verbatim. */
    deliveryText: string
    deliveryTruncated: boolean
  } | null
  /** Why `content` is null, if it is. */
  contentWithheld: 'content_unavailable' | 'source_access_unavailable' | null
  /** Canonical https://github.com link only; never another host. */
  url: string | null
  authorTrust: GitHubTrustOrigin[]
  editorTrust: GitHubTrustOrigin[]
  routes: Array<{ kind: string; id: string; workStreamId: string | null; recipientId: string | null }>
  decidedByUserId: string | null
  decidedAt: string | null
  canModerate: boolean
}

export interface GitHubTrustedAuthor extends GitHubAccountIdentity {
  origins: GitHubTrustOrigin[]
}
export interface GitHubTrustedAuthorList {
  authors: GitHubTrustedAuthor[]
  canManage: boolean
}

import { z } from 'zod'

/** Only web links: a `javascript:`/`data:` value would otherwise render as a clickable link. */
const WEB_URL = /^https?:\/\//i
const WEB_URL_MESSAGE = 'must be an http(s) URL'

/** Resource identity only. Access always comes from the integration's squad connection. */
export const codeHostReferenceSchema = z
  .object({
    integration: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(100),
    repository: z.string().trim().min(1).max(500),
    changeRequest: z
      .object({
        number: z.number().int().positive().safe(),
        url: z.string().url().regex(WEB_URL, WEB_URL_MESSAGE).max(2000).optional(),
      })
      .strict()
      .optional(),
    connectionId: z.string().uuid().optional(),
  })
  .strict()
export type CodeHostReference = z.infer<typeof codeHostReferenceSchema>

export type CodeHostReferenceDescription =
  | { status: 'absent' }
  | { status: 'invalid'; issues: string[] }
  | { status: 'valid'; reference: CodeHostReference }

/** Human-readable, path-qualified Zod issues; unknown keys also list the accepted keys. */
export function formatCodeHostIssues(error: z.ZodError): string[] {
  const allowed: Record<string, string[]> = {
    '': Object.keys(codeHostReferenceSchema.shape),
    changeRequest: Object.keys(codeHostReferenceSchema.shape.changeRequest.unwrap().shape),
  }
  return error.issues.map((issue) => {
    const path = issue.path.join('.')
    const where = path ? `codeHost.${path}` : 'codeHost'
    if (issue.code === 'unrecognized_keys') {
      const accepted = allowed[path] ?? []
      return `${where}: unknown keys ${issue.keys.map((key) => `\`${key}\``).join(', ')} (allowed: ${accepted.join(', ')})`
    }
    return `${where}: ${issue.message}`
  })
}

/**
 * An explicit canonical `codeHost` binding takes precedence over the legacy `github` shape,
 * including when it is invalid: an invalid binding is reported as such rather than falling back.
 */
export function describeCodeHostReference(metadata: unknown): CodeHostReferenceDescription {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { status: 'absent' }
  const record = metadata as Record<string, any>
  const value =
    record.codeHost !== undefined
      ? record.codeHost
      : record.github
        ? {
            integration: 'github',
            repository: record.github.repo,
            changeRequest:
              record.github.pr?.number != null
                ? {
                    number: Number(record.github.pr.number),
                    ...(record.github.pr.url ? { url: record.github.pr.url } : {}),
                  }
                : undefined,
            connectionId: record.github.connectionId,
          }
        : undefined
  if (value === undefined) return { status: 'absent' }
  const result = codeHostReferenceSchema.safeParse(value)
  return result.success
    ? { status: 'valid', reference: result.data }
    : { status: 'invalid', issues: formatCodeHostIssues(result.error) }
}

/** Resolve a usable binding, or null when the metadata carries none or an invalid one. */
export function resolveCodeHostReference(metadata: unknown): CodeHostReference | null {
  const described = describeCodeHostReference(metadata)
  return described.status === 'valid' ? described.reference : null
}

/**
 * The exact, copy-pasteable repair for a PR-delivery stream whose primary binding lacks a change
 * request. Placeholders stay literal because the number is exactly what the operator must fill
 * in; the stream id is always known. Single-quoted so the JSON survives POSIX shells unchanged.
 * The command matches the stream's recorded shape: merging `codeHost.changeRequest` into a
 * legacy `github`-shaped stream would mint an invalid partial `codeHost` that shadows the
 * valid legacy identity, so those streams bind through `github.pr` instead, and a stream with
 * no identity at all needs the full codeHost object.
 */
export function changeRequestBindCommand(streamId: string, metadata?: unknown): string {
  const record =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {}
  if (record.codeHost === undefined && record.github)
    return `ficus workstream set-meta ${streamId} github.pr '{"number":<pr-number>,"url":"<pr-url>"}'`
  if (record.codeHost === undefined && record.github === undefined)
    return `ficus workstream set-meta ${streamId} codeHost '{"integration":"github","repository":"<owner/repo>","changeRequest":{"number":<pr-number>,"url":"<pr-url>"}}'`
  return `ficus workstream set-meta ${streamId} codeHost.changeRequest '{"number":<pr-number>,"url":"<pr-url>"}'`
}

/** Same repair shape for the integration/repository half of the binding. */
export function codeHostBindingCommand(streamId: string): string {
  return `ficus workstream set-meta ${streamId} codeHost '{"integration":"github","repository":"<owner/repo>"}'`
}

/** One pull request a code host reported for a head branch, in provider-neutral form. */
export interface BranchChangeRequestCandidate {
  number: number
  url?: string
  merged: boolean
  state: string
  headBranch: string
  baseBranch: string
  /** Where the head ref lives when the provider reports it; mismatches are forks. */
  headRepository?: string
  headSha?: string
}

export type BranchChangeRequestResolution =
  | { status: 'chosen'; candidate: { number: number; url?: string } }
  | { status: 'no-branch' }
  | { status: 'no-candidates' }
  | { status: 'unclear'; candidates: string[] }
  | { status: 'lookup-failed' }

/**
 * Pick the delivery change request for a stream branch from the candidates a code host
 * reported. Provider-neutral and pure so the policy stays auditable: a closed-unmerged pull
 * request can never be the answer, a merged one wins over an open one, and anything not
 * uniquely identified stays unresolved because a wrong binding is worse than no binding.
 */
export function resolveBranchChangeRequest(input: {
  branch?: string
  baseBranch?: string
  repository: string
  candidates: BranchChangeRequestCandidate[] | null
}): BranchChangeRequestResolution {
  if (!input.branch) return { status: 'no-branch' }
  if (input.candidates === null) return { status: 'lookup-failed' }
  const repository = input.repository.trim().toLowerCase()
  const usable = input.candidates.filter(
    (candidate) =>
      candidate.headBranch === input.branch &&
      // The owner-namespace head filter already excludes forks; the reported head repository
      // is checked anyway so a provider slip cannot reintroduce one.
      (!candidate.headRepository || candidate.headRepository.trim().toLowerCase() === repository) &&
      (!input.baseBranch || !candidate.baseBranch || candidate.baseBranch === input.baseBranch) &&
      (candidate.merged || candidate.state === 'open')
  )
  const merged = usable.filter((candidate) => candidate.merged)
  const pick = (candidate: BranchChangeRequestCandidate) => ({
    number: candidate.number,
    ...(candidate.url ? { url: candidate.url } : {}),
  })
  if (merged.length === 1) return { status: 'chosen', candidate: pick(merged[0]!) }
  if (merged.length > 1) return { status: 'unclear', candidates: merged.map((candidate) => `PR #${candidate.number}`) }
  if (usable.length === 1) return { status: 'chosen', candidate: pick(usable[0]!) }
  if (usable.length > 1) return { status: 'unclear', candidates: usable.map((candidate) => `PR #${candidate.number}`) }
  return { status: 'no-candidates' }
}

export const TRACKED_RESOURCE_KINDS = ['issue', 'pull_request'] as const
export type TrackedResourceKind = (typeof TRACKED_RESOURCE_KINDS)[number]
const integrationName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(100)
export const trackedResourceOriginSchema = z
  .object({
    eventId: z.string().uuid(),
    resourceKey: z.string().min(1).max(500),
    output: z.string().min(1).max(100),
    occurredAt: z.string().max(64).optional(),
  })
  .strict()
/** Tracked resource identity. Access always comes from the squad's integration connection, never from this record. */
export const trackedResourceObjectSchema = z
  .object({
    integration: integrationName,
    repository: z.string().trim().min(1).max(500),
    kind: z.enum(TRACKED_RESOURCE_KINDS),
    number: z.number().int().positive().safe(),
    connectionId: z.string().uuid().optional(),
    url: z.string().url().regex(WEB_URL, WEB_URL_MESSAGE).max(2000).optional(),
    addedAt: z.string().max(64).optional(),
    origin: trackedResourceOriginSchema.optional(),
    /** Provider-native identity (e.g. a Linear issue UUID), for matching when repository/number aren't known. */
    externalId: z.string().min(1).max(200).optional(),
    // Only meaningful for kind 'pull_request'; flags a tracked PR as a delivery change request.
    delivery: z.literal(true).optional(),
  })
  .strict()
/** Same identity as {@link trackedResourceObjectSchema}, plus the cross-field delivery/kind constraint. */
export const trackedResourceSchema = trackedResourceObjectSchema.refine(
  (value) => !value.delivery || value.kind === 'pull_request',
  { message: 'delivery is only valid for pull requests', path: ['delivery'] }
)
export type TrackedResource = z.infer<typeof trackedResourceSchema>
export type TrackedResourceSource = 'delivery' | 'tracked'
export interface ResolvedTrackedResource extends Omit<TrackedResource, 'delivery'> {
  key: string
  source: TrackedResourceSource
  url?: string
  /** True for the codeHost PR and any tracked PR explicitly flagged as a delivery change request. */
  delivery: boolean
}
export const deliveryPullRequestStateSchema = z
  .object({
    state: z.enum(['open', 'merged', 'closed']),
    at: z.string().max(64),
    headSha: z.string().max(64).optional(),
    eventId: z.string().uuid().optional(),
  })
  .strict()
export const workStreamDeliveryStateSchema = z
  .object({
    pullRequests: z.record(z.string(), deliveryPullRequestStateSchema),
  })
  .strict()
export type WorkStreamDeliveryState = z.infer<typeof workStreamDeliveryStateSchema>
/** Parses the work stream's delivery state, defaulting to an empty map when absent or invalid. */
export function readDeliveryState(metadata: unknown): WorkStreamDeliveryState {
  const record =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {}
  const parsed = workStreamDeliveryStateSchema.safeParse(record.delivery)
  return parsed.success ? parsed.data : { pullRequests: {} }
}
export interface DeliveryPullRequestView {
  key: string
  repository: string
  number: number
  url?: string
  primary: boolean
  state: 'open' | 'merged' | 'closed'
  at?: string
  headSha?: string
}
export interface TrackedResourcesView {
  resources: Array<
    ResolvedTrackedResource & {
      subscriptionIds: string[]
      subscribed: boolean
      mergeState?: 'open' | 'merged' | 'closed'
    }
  >
  /** Why subscriptions may be inactive even though links exist. */
  subscriptions: 'active' | 'no-flow' | 'not-following' | 'ended'
  delivery: {
    pullRequests: DeliveryPullRequestView[]
    complete: boolean
  }
}
export function trackedResourceKey(r: Pick<TrackedResource, 'integration' | 'repository' | 'kind' | 'number'>) {
  return `${r.integration}:${r.repository.trim().toLowerCase()}:${r.kind}:${r.number}`
}
export function trackedResourceUrl(r: Pick<TrackedResource, 'integration' | 'repository' | 'kind' | 'number' | 'url'>) {
  if (r.url) return r.url
  if (r.integration !== 'github') return undefined
  return `https://github.com/${r.repository.trim()}/${r.kind === 'issue' ? 'issues' : 'pull'}/${r.number}`
}
/** Human-readable reference: GitHub `owner/repo#12`, Linear `KEY-12`. */
export function trackedResourceLabel(r: Pick<TrackedResource, 'integration' | 'repository' | 'number'>) {
  const repository = r.repository.trim()
  return r.integration === 'linear' ? `${repository.toUpperCase()}-${r.number}` : `${repository}#${r.number}`
}
export function resolveTrackedResources(metadata: unknown): ResolvedTrackedResource[] {
  const out: ResolvedTrackedResource[] = []
  const seen = new Set<string>()
  const push = (entry: TrackedResource, source: TrackedResourceSource, delivery: boolean) => {
    const key = trackedResourceKey(entry)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ ...entry, key, source, url: trackedResourceUrl(entry), delivery })
  }
  const reference = resolveCodeHostReference(metadata)
  if (reference?.changeRequest)
    push(
      {
        integration: reference.integration,
        repository: reference.repository,
        kind: 'pull_request',
        number: reference.changeRequest.number,
        ...(reference.connectionId ? { connectionId: reference.connectionId } : {}),
        ...(reference.changeRequest.url ? { url: reference.changeRequest.url } : {}),
      },
      'delivery',
      true
    )
  const tracked =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).tracked
      : undefined
  if (Array.isArray(tracked))
    for (const raw of tracked) {
      const parsed = trackedResourceSchema.safeParse(raw)
      if (parsed.success) push(parsed.data, 'tracked', !!parsed.data.delivery)
    }
  return out
}
/** Pull requests designated as delivery change requests: the codeHost binding plus any flagged tracked PRs, primary first. */
export function deliveryPullRequests(metadata: unknown): ResolvedTrackedResource[] {
  // resolveTrackedResources always yields the codeHost-bound delivery PR first, so this preserves primary-first order.
  return resolveTrackedResources(metadata).filter((resource) => resource.kind === 'pull_request' && resource.delivery)
}
/** The codeHost-bound delivery pull request, if any. */
export function primaryDeliveryPullRequest(metadata: unknown): ResolvedTrackedResource | null {
  return resolveTrackedResources(metadata).find((resource) => resource.source === 'delivery') ?? null
}
// A link copied out of a notification usually points at a comment, so a trailing `?query` or
// `#fragment` is part of the ordinary form. It is never part of the path: it cannot introduce a
// resource the path itself does not already name.
const GITHUB_RESOURCE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/([1-9][0-9]*)\/?(?:[?#].*)?$/i
const LINEAR_RESOURCE_URL =
  /^https:\/\/linear\.app\/[\w.-]+\/issue\/([A-Za-z][A-Za-z0-9]{0,9})-([1-9][0-9]*)(?:\/[^/?#]*)?\/?(?:[?#].*)?$/i
const TRACKED_RESOURCE_REFERENCE = /^([A-Za-z][A-Za-z0-9]{0,9})-([1-9]\d*)$/
export function parseTrackedResourceUrl(url: string) {
  const trimmed = url.trim()
  const github = GITHUB_RESOURCE_URL.exec(trimmed)
  if (github) {
    const number = Number(github[3])
    if (!Number.isSafeInteger(number)) return null
    return {
      integration: 'github' as const,
      repository: github[1]!.toLowerCase(),
      kind: (github[2]!.toLowerCase() === 'issues' ? 'issue' : 'pull_request') as TrackedResourceKind,
      number,
    }
  }
  const linear = LINEAR_RESOURCE_URL.exec(trimmed)
  if (linear) {
    const number = Number(linear[2])
    if (!Number.isSafeInteger(number)) return null
    return {
      integration: 'linear' as const,
      repository: linear[1]!.toLowerCase(),
      kind: 'issue' as const,
      number,
    }
  }
  return null
}
/**
 * Parses a bare textual reference (as typed by a person, not a URL): GitHub `owner/repo#12` (kind is
 * ambiguous, so the caller decides issue vs pull request) or Linear `KEY-12`.
 */
export function parseTrackedResourceReference(text: string) {
  const trimmed = text.trim()
  const github = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(trimmed)
  if (github) {
    const number = Number(github[2])
    if (!Number.isSafeInteger(number)) return null
    return { integration: 'github' as const, repository: github[1]!.toLowerCase(), number }
  }
  const linear = TRACKED_RESOURCE_REFERENCE.exec(trimmed)
  if (linear) {
    const number = Number(linear[2])
    if (!Number.isSafeInteger(number)) return null
    return { integration: 'linear' as const, repository: linear[1]!.toLowerCase(), kind: 'issue' as const, number }
  }
  return null
}
export function trackedResourceMatches(
  resource: Pick<TrackedResource, 'integration' | 'repository' | 'kind' | 'number' | 'connectionId'> & {
    externalId?: string
  },
  target: {
    integration: string
    repository?: string
    kind?: TrackedResourceKind
    number?: number
    connectionId?: string
    externalId?: string
  }
): boolean {
  const connectionPinned = resource.connectionId && target.connectionId && resource.connectionId !== target.connectionId
  if (connectionPinned) return false
  if (resource.externalId && target.externalId && resource.integration === target.integration)
    return resource.externalId === target.externalId
  return (
    resource.integration === target.integration &&
    resource.kind === target.kind &&
    resource.number === target.number &&
    target.repository !== undefined &&
    resource.repository.trim().toLowerCase() === target.repository.trim().toLowerCase()
  )
}

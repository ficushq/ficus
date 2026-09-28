import { eventRepositoryMatches } from '@ficus/shared'
import { githubRepositoryKey } from '@ficus/shared/integration-relay'
import type { EventPollingSignal } from '../types'
import type { GitHubPollingFetch } from './event-poller'

const API_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const DEFAULT_TTL_MS = 10 * 60_000
/** The hosted relay refuses more than 100 repositories per connection; a pattern must never approach that alone. */
const DEFAULT_MAX_REPOSITORIES_PER_PATTERN = 100
/** 100 repositories per page; an account past this is not one to enumerate blindly. */
const MAX_PAGES = 50

/** A repository selector is a pattern when it contains `*`; anything else is an exact `owner/repo`. */
export const isRepositoryPattern = (value: string): boolean => value.includes('*')

export type RepositoryExpansionWarningCode = 'too_many_matches' | 'enumeration_failed' | 'credential_unavailable'

export interface RepositoryExpansionWarning {
  connectionId: string
  /** The pattern(s) that contributed nothing because of this warning. */
  pattern: string
  code: RepositoryExpansionWarningCode
  matched?: number
  limit?: number
  detail?: string
}

export interface RepositoryEnumerationCredential {
  /** The connection's material revision: a re-auth or reconnect changes it and invalidates the listing. */
  revision: string
  accessToken: string
}

export interface GitHubRepositoryExpanderOptions {
  resolveCredential: (connectionId: string) => Promise<RepositoryEnumerationCredential | undefined>
  fetch?: GitHubPollingFetch
  apiBase?: string
  now?: () => number
  ttlMs?: number
  maxRepositoriesPerPattern?: number
  onWarning?: (warning: RepositoryExpansionWarning) => void
}

interface Listing {
  revision: string
  etag?: string
  repositories: string[]
  fetchedAt: number
}

class ListingUnavailableError extends Error {
  constructor(
    readonly reason: 'revoked' | 'transient',
    detail: string
  ) {
    super(detail)
    this.name = 'ListingUnavailableError'
  }
}

/**
 * Turns repository selectors from squad rules and stream metadata into the
 * exact `owner/repo` set a connection should watch. Exact selectors pass
 * through untouched. Patterns are matched against the repositories visible to
 * the connection (`GET /user/repos`), listed once per connection and cached
 * for `ttlMs`, refreshed with a conditional request, and discarded when the
 * connection's revision changes or its access is revoked.
 *
 * Fail closed: a pattern that cannot be resolved — no usable credential and
 * no cached listing, a revoked credential, an exhausted budget, or more
 * matches than the cap — contributes nothing and raises a warning, rather
 * than watching an arbitrary subset. Exact selectors on the same connection
 * are unaffected.
 */
export class GitHubRepositoryExpander {
  readonly #options: GitHubRepositoryExpanderOptions
  readonly #fetch: GitHubPollingFetch
  readonly #apiBase: string
  readonly #cache = new Map<string, Listing>()
  readonly #inflight = new Map<string, Promise<Listing | undefined>>()

  constructor(options: GitHubRepositoryExpanderOptions) {
    this.#options = options
    this.#fetch = options.fetch ?? fetch
    this.#apiBase = options.apiBase ?? API_BASE
  }

  async expand(connectionId: string, selectors: readonly string[], signal?: EventPollingSignal): Promise<string[]> {
    const result = new Set<string>()
    const patterns: string[] = []
    for (const selector of selectors) {
      if (isRepositoryPattern(selector)) {
        patterns.push(selector)
        continue
      }
      const key = githubRepositoryKey.safeParse(selector)
      if (key.success) result.add(key.data)
    }
    if (patterns.length > 0) {
      const listing = await this.#listing(connectionId, patterns.join(', '), signal)
      if (listing) {
        const limit = this.#options.maxRepositoriesPerPattern ?? DEFAULT_MAX_REPOSITORIES_PER_PATTERN
        for (const pattern of patterns) {
          const matched = listing.repositories.filter((repository) => eventRepositoryMatches(pattern, repository))
          if (matched.length > limit) {
            this.#warn({ connectionId, pattern, code: 'too_many_matches', matched: matched.length, limit })
            continue
          }
          for (const repository of matched) result.add(repository)
        }
      }
    }
    return [...result].sort()
  }

  #warn(warning: RepositoryExpansionWarning) {
    this.#options.onWarning?.(warning)
  }

  async #listing(connectionId: string, pattern: string, signal?: EventPollingSignal): Promise<Listing | undefined> {
    const now = this.#options.now?.() ?? Date.now()
    const cached = this.#cache.get(connectionId)
    const credential = await this.#options.resolveCredential(connectionId)
    if (!credential) {
      // A declared interest outlives a lapsed validation (see the relay
      // assignment resolver); so does the listing it was expanded from.
      if (cached) return cached
      this.#warn({ connectionId, pattern, code: 'credential_unavailable' })
      return undefined
    }
    const fresh = cached?.revision === credential.revision ? cached : undefined
    if (fresh && now - fresh.fetchedAt < (this.#options.ttlMs ?? DEFAULT_TTL_MS)) return fresh

    let pending = this.#inflight.get(connectionId)
    if (!pending) {
      pending = this.#refresh(connectionId, pattern, credential, fresh, now, signal).finally(() =>
        this.#inflight.delete(connectionId)
      )
      this.#inflight.set(connectionId, pending)
    }
    return pending
  }

  async #refresh(
    connectionId: string,
    pattern: string,
    credential: RepositoryEnumerationCredential,
    previous: Listing | undefined,
    now: number,
    signal?: EventPollingSignal
  ): Promise<Listing | undefined> {
    try {
      const listing = await this.#list(credential, previous, now, signal)
      this.#cache.set(connectionId, listing)
      return listing
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (error instanceof ListingUnavailableError && error.reason === 'revoked') {
        this.#cache.delete(connectionId)
        this.#warn({ connectionId, pattern, code: 'enumeration_failed', detail })
        return undefined
      }
      // Transient: keep serving the last listing taken with this credential.
      if (previous) return previous
      this.#warn({ connectionId, pattern, code: 'enumeration_failed', detail })
      return undefined
    }
  }

  async #list(
    credential: RepositoryEnumerationCredential,
    previous: Listing | undefined,
    now: number,
    signal?: EventPollingSignal
  ): Promise<Listing> {
    const repositories = new Set<string>()
    let etag: string | undefined
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL('/user/repos', this.#apiBase)
      url.searchParams.set('per_page', '100')
      url.searchParams.set('affiliation', 'owner,collaborator,organization_member')
      url.searchParams.set('sort', 'full_name')
      url.searchParams.set('page', String(page))
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${credential.accessToken}`,
        'x-github-api-version': API_VERSION,
      }
      if (page === 1 && previous?.etag) headers['if-none-match'] = previous.etag
      signal?.reserveRequest()
      const response = await this.#fetch(url.toString(), { headers, signal })
      if (page === 1 && response.status === 304 && previous) return { ...previous, fetchedAt: now }
      if (response.status === 401) throw new ListingUnavailableError('revoked', 'GitHub rejected the credential (401)')
      if (!response.ok) {
        throw new ListingUnavailableError('transient', `GitHub repository listing failed (${response.status})`)
      }
      if (page === 1) etag = response.headers.get('etag') ?? undefined
      const body: unknown = await response.json()
      if (!Array.isArray(body))
        throw new ListingUnavailableError('transient', 'GitHub repository listing was not a list')
      for (const item of body) {
        const key = githubRepositoryKey.safeParse((item as { full_name?: unknown })?.full_name)
        if (key.success) repositories.add(key.data)
      }
      if (!/<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '')) {
        return { revision: credential.revision, etag, repositories: [...repositories].sort(), fetchedAt: now }
      }
    }
    throw new ListingUnavailableError('transient', `GitHub repository listing exceeded ${MAX_PAGES} pages`)
  }
}

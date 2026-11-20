import type {
  LinearTeamDirectory,
  LinearTeamListingConnection,
  LinearTeamListingError,
  LinearTeamSummary,
} from '@ficus/shared'
import { createLogger } from '../../../lib/infra/logger'
import type { IntegrationConnectionRecord } from '../connection-repository'
import { LinearRateLimitedError, linearQuery } from './plugin'
import { LINEAR_INSUFFICIENT_SCOPE_CODE } from './scope-health'

const log = createLogger('linear-team-directory')

/** How long one connection's listing is reused. Short: it only spares Linear while someone edits routing. */
export const LINEAR_TEAM_CACHE_TTL_MS = 60_000
/** 250 teams per page and at most this many pages; a larger workspace is reported as truncated. */
export const LINEAR_TEAM_PAGE_SIZE = 250
export const LINEAR_TEAM_MAX_PAGES = 20

type AttachedConnection = IntegrationConnectionRecord & { isDefault: boolean }

export interface LinearTeamDirectoryDependencies {
  /** Every Linear connection attached to the squad, default or not. */
  listAttached(squadId: string): Promise<readonly AttachedConnection[]>
  /** The connection's `Authorization` value when it is usable now (API key verbatim, app token as Bearer). */
  authorize(connection: IntegrationConnectionRecord): Promise<{ authorization: string } | null>
  query?: typeof linearQuery
  now?: () => number
}

interface Listing {
  teams: Array<{ id: string; key: string; name: string }>
  truncated: boolean
}

interface CacheEntry {
  revision: string
  expiresAt: number
  listing: Promise<Listing>
}

function text(value: unknown, max = 200): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : ''
}

function listingError(error: unknown): LinearTeamListingError {
  if (error instanceof LinearRateLimitedError) return 'rate_limited'
  if (error instanceof Error && error.message === 'invalid_auth') return 'invalid_auth'
  return 'provider_unavailable'
}

/**
 * Lists the Linear teams a squad's attached connections can see, for the squad Integrations tab's team
 * picker. Each connection is queried with its own credential, in Core only; the response names teams
 * and connections and never carries credential material. A failing connection is reported beside the
 * teams the others listed, so one bad key does not hide every team.
 */
export function createLinearTeamDirectory(deps: LinearTeamDirectoryDependencies) {
  const query = deps.query ?? linearQuery
  const now = deps.now ?? Date.now
  const cache = new Map<string, CacheEntry>()

  async function fetchTeams(authorization: string): Promise<Listing> {
    const teams: Listing['teams'] = []
    let after: string | null = null
    for (let page = 0; page < LINEAR_TEAM_MAX_PAGES; page++) {
      const data: {
        teams?: {
          nodes?: Array<{ id?: unknown; key?: unknown; name?: unknown }>
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
        }
      } = await query(
        authorization,
        'query FicusLinearTeamDirectory($first: Int!, $after: String) { teams(first: $first, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } } }',
        { first: LINEAR_TEAM_PAGE_SIZE, after }
      )
      for (const node of data.teams?.nodes ?? []) {
        const id = text(node.id)
        if (id) teams.push({ id, key: text(node.key, 100), name: text(node.name) || id })
      }
      const next = data.teams?.pageInfo
      if (!next?.hasNextPage || !next.endCursor) return { teams, truncated: false }
      after = next.endCursor
    }
    return { teams, truncated: true }
  }

  function cachedListing(connection: IntegrationConnectionRecord, authorization: string): Promise<Listing> {
    const current = cache.get(connection.id)
    // A new credential (rotation, reconnect) is a new revision, so it never reuses the old listing.
    if (current && current.revision === connection.materialRevision && current.expiresAt > now()) return current.listing
    const listing = fetchTeams(authorization)
    const entry = { revision: connection.materialRevision, expiresAt: now() + LINEAR_TEAM_CACHE_TTL_MS, listing }
    cache.set(connection.id, entry)
    // Failures are not cached: the next open of the picker tries again.
    listing.catch(() => {
      if (cache.get(connection.id) === entry) cache.delete(connection.id)
    })
    return listing
  }

  return {
    async list(squadId: string): Promise<LinearTeamDirectory> {
      const attached = await deps.listAttached(squadId)
      const teams = new Map<string, LinearTeamSummary>()
      const connections = await Promise.all(
        attached.map(async (connection): Promise<LinearTeamListingConnection> => {
          const base = { id: connection.id, displayName: connection.displayName, isDefault: connection.isDefault }
          // Reconnect required (for example a missing scope) is a state an admin can fix: name it.
          if (connection.enabled && connection.authState === 'reauthorization_required')
            return {
              ...base,
              status: 'error',
              error:
                connection.lastErrorCode === LINEAR_INSUFFICIENT_SCOPE_CODE
                  ? 'insufficient_scope'
                  : 'reconnect_required',
            }
          const usable = connection.enabled ? await deps.authorize(connection) : null
          if (!usable) return { ...base, status: 'error', error: 'connection_unusable' }
          try {
            const listing = await cachedListing(connection, usable.authorization)
            for (const team of listing.teams) {
              const known = teams.get(team.id)
              if (known) known.connectionIds.push(connection.id)
              else teams.set(team.id, { ...team, connectionIds: [connection.id] })
            }
            return { ...base, status: 'ok', ...(listing.truncated ? { truncated: true } : {}) }
          } catch (error) {
            const code = listingError(error)
            log.warn(`Linear team listing failed for connection ${connection.id}: ${code}`)
            return { ...base, status: 'error', error: code }
          }
        })
      )
      return {
        teams: [...teams.values()].sort(
          (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key) || a.id.localeCompare(b.id)
        ),
        connections,
      }
    },
    clearCache() {
      cache.clear()
    },
  }
}

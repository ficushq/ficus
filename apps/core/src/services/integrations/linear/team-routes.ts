import type { LinearTeamDirectory } from '@ficus/shared'
import { matchLinearTeamValue } from '@ficus/shared'

/**
 * Squad Linear team routes (`metadata.linear[].teamId`) are matched against Linear team IDs, which are
 * UUIDs. A team key such as `ENG` never matches an event, so routes are stored as IDs: a key or ID is
 * accepted on save and resolved through the squad's attached Linear connections.
 */
const LINEAR_TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when the value has the shape of a Linear team ID (a UUID), not a team key. */
export function isLinearTeamId(value: string): boolean {
  return LINEAR_TEAM_ID.test(value.trim())
}

/** A route value that cannot be stored; the message is safe to show the person saving it. */
export class LinearTeamRouteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LinearTeamRouteError'
  }
}

type Route = Record<string, unknown>

function routeList(routes: unknown): Route[] {
  return (Array.isArray(routes) ? routes : [routes]).filter(
    (route): route is Route => !!route && typeof route === 'object' && !Array.isArray(route)
  )
}

function routeTeamId(route: Route): string | undefined {
  return typeof route.teamId === 'string' && route.teamId.trim().length > 0 ? route.teamId.trim() : undefined
}

/** Every non-empty team value in stored or submitted routes. */
export function linearRouteTeamValues(routes: unknown): string[] {
  return [...new Set(routeList(routes).flatMap((route) => routeTeamId(route) ?? []))]
}

/** True when every attached connection listed all of its teams, so a value absent from the list is unknown. */
function listingIsConclusive(directory: LinearTeamDirectory): boolean {
  return (
    directory.connections.length > 0 &&
    directory.connections.every((connection) => connection.status === 'ok' && !connection.truncated)
  )
}

function unresolvedReason(directory: LinearTeamDirectory): string {
  if (directory.connections.length === 0) return 'the squad has no Linear connection to look it up with'
  if (directory.connections.some((connection) => connection.status !== 'ok'))
    return 'the squad’s Linear connection could not list its teams'
  return 'it is not among the teams Ficus could list'
}

export interface ResolveLinearTeamRoutesInput {
  /** The submitted `metadata.linear` value. */
  routes: unknown
  /** Team values already stored for the squad. */
  stored: readonly string[]
  /** Lists the teams the squad's attached connections can see; called at most once, and only when needed. */
  listTeams(): Promise<LinearTeamDirectory>
}

/**
 * Rewrites submitted routes so every team value is a team ID: a key (any case) or ID of a listed team
 * becomes that team's ID. A new value that names no listed team is rejected with
 * {@link LinearTeamRouteError}. An already-stored value that cannot be resolved is kept unchanged, so an
 * unrelated metadata save never fails because Linear is unreachable or a team was deleted; the squad's
 * settings and setup status still flag it. Entries without a team value pass through untouched.
 */
export async function resolveLinearTeamRoutes(input: ResolveLinearTeamRoutesInput): Promise<unknown> {
  if (input.routes === null || input.routes === undefined) return input.routes
  const stored = new Set(input.stored)
  const pending = linearRouteTeamValues(input.routes).filter((value) => !(stored.has(value) && isLinearTeamId(value)))
  if (!pending.length) return input.routes

  const directory = await input.listTeams()
  const resolved = new Map<string, string>()
  for (const value of pending) {
    const match = matchLinearTeamValue(value, directory.teams)
    if (match.kind !== 'unknown') {
      resolved.set(value, match.team.id)
      continue
    }
    if (stored.has(value)) continue
    if (isLinearTeamId(value)) {
      if (listingIsConclusive(directory))
        throw new LinearTeamRouteError(
          `Linear team ${value} is not a team the squad's Linear connections can see. Choose a team key or ID from the squad's Linear settings.`
        )
      // The listing was partial, so an ID Ficus could not see may still be valid.
      continue
    }
    throw new LinearTeamRouteError(
      `Ficus could not resolve Linear team key ${value} to a team ID: ${unresolvedReason(directory)}. Use a team key or ID the squad's Linear connection can see.`
    )
  }

  const rewrite = (route: Route): Route => {
    const value = routeTeamId(route)
    const teamId = value ? resolved.get(value) : undefined
    return teamId ? { ...route, teamId } : route
  }
  if (!Array.isArray(input.routes)) {
    return input.routes && typeof input.routes === 'object' ? rewrite(input.routes as Route) : input.routes
  }
  // A key and its ID saved together collapse into one route.
  const seen = new Set<string>()
  return input.routes
    .map((route) => (route && typeof route === 'object' && !Array.isArray(route) ? rewrite(route as Route) : route))
    .filter((route) => {
      const key = JSON.stringify(route)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

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
  constructor(
    message: string,
    /** The submitted team value that could not be stored. */
    readonly value?: string
  ) {
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

interface ResolveLinearTeamValuesInput {
  /** Team values already stored for the squad. */
  stored: readonly string[]
  /** Lists the teams the squad's attached connections can see; called at most once, and only when needed. */
  listTeams(): Promise<LinearTeamDirectory>
}

export interface ResolveLinearTeamRoutesInput extends ResolveLinearTeamValuesInput {
  /** The submitted `metadata.linear` value. */
  routes: unknown
}

/**
 * Maps each submitted team value to its team ID: a key (any case) or ID of a listed team becomes that
 * team's ID. A new value that names no listed team is rejected with {@link LinearTeamRouteError}. An
 * already-stored value that cannot be resolved is left out of the map, so the caller keeps it unchanged.
 */
async function resolveLinearTeamValues(
  values: readonly string[],
  input: ResolveLinearTeamValuesInput
): Promise<Map<string, string>> {
  const stored = new Set(input.stored)
  const resolved = new Map<string, string>()
  const pending = values.filter((value) => !(stored.has(value) && isLinearTeamId(value)))
  if (!pending.length) return resolved

  const directory = await input.listTeams()
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
          `Linear team ${value} is not a team the squad's Linear connections can see. Choose a team key or ID from the squad's Linear settings.`,
          value
        )
      // The listing was partial, so an ID Ficus could not see may still be valid.
      continue
    }
    throw new LinearTeamRouteError(
      `Ficus could not resolve Linear team key ${value} to a team ID: ${unresolvedReason(directory)}. Use a team key or ID the squad's Linear connection can see.`,
      value
    )
  }
  return resolved
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
  const resolved = await resolveLinearTeamValues(linearRouteTeamValues(input.routes), input)
  if (!resolved.size) return input.routes

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

function ruleTeamFilter(rule: unknown): string | undefined {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return undefined
  const filters = (rule as Route).filters
  return filters && typeof filters === 'object' && !Array.isArray(filters) ? routeTeamId(filters as Route) : undefined
}

/** Every non-empty team filter in stored or submitted Linear event rules (`integrationRules.linear`). */
export function linearEventRuleTeamValues(rules: unknown): string[] {
  return Array.isArray(rules) ? [...new Set(rules.flatMap((rule) => ruleTeamFilter(rule) ?? []))] : []
}

/** Stored Linear event rules whose team filter is not a team ID, so they match no event. */
export function linearEventRuleTeamKeys(rules: unknown): Array<{ ruleId: string; value: string }> {
  if (!Array.isArray(rules)) return []
  return rules.flatMap((rule) => {
    const value = ruleTeamFilter(rule)
    if (!value || isLinearTeamId(value)) return []
    const id = (rule as Route).id
    return [{ ruleId: typeof id === 'string' ? id : 'unnamed', value }]
  })
}

export interface ResolveLinearEventRuleTeamsInput extends ResolveLinearTeamValuesInput {
  /** The submitted `integrationRules.linear` value. */
  rules: unknown
}

/**
 * Rewrites each submitted Linear event rule's team filter (`filters.teamId`) to the team ID, with the
 * same rules as {@link resolveLinearTeamRoutes}: a key or ID of a listed team becomes its ID, a new
 * unknown value is rejected with a message naming the rule, and an already-stored value that cannot
 * be resolved is kept. Rules without a team filter, and values that are not rule lists, pass through.
 */
export async function resolveLinearEventRuleTeams(input: ResolveLinearEventRuleTeamsInput): Promise<unknown> {
  if (!Array.isArray(input.rules)) return input.rules
  let resolved: Map<string, string>
  try {
    resolved = await resolveLinearTeamValues(linearEventRuleTeamValues(input.rules), input)
  } catch (error) {
    if (!(error instanceof LinearTeamRouteError)) throw error
    const rule = input.rules.find((item) => ruleTeamFilter(item) === error.value) as Route | undefined
    const ruleId = typeof rule?.id === 'string' ? rule.id : undefined
    throw new LinearTeamRouteError(
      `${ruleId ? `Linear event rule ${ruleId}` : 'A Linear event rule'} has an invalid team filter. ${error.message}`,
      error.value
    )
  }
  if (!resolved.size) return input.rules
  return input.rules.map((rule) => {
    const value = ruleTeamFilter(rule)
    const teamId = value ? resolved.get(value) : undefined
    if (!teamId) return rule
    const item = rule as Route
    return { ...item, filters: { ...(item.filters as Route), teamId } }
  })
}

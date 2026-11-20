/** One Linear team as the squad's attached connections list it. Never carries credential material. */
export interface LinearTeamSummary {
  id: string
  key: string
  name: string
  /** The attached connections that can see this team (a team shared by two workspaces' keys appears once). */
  connectionIds: string[]
}

/** Why an attached connection could not list its teams. */
export type LinearTeamListingError =
  /** The connection is disabled, unvalidated, expired or fenced, so Ficus does not call Linear with it. */
  | 'connection_unusable'
  /** The app lacks a Linear scope Ficus now needs; Reconnect asks Linear to update the installation. */
  | 'insufficient_scope'
  /** The connection is marked Reconnect required for another reason. */
  | 'reconnect_required'
  /** Linear refused the credential. */
  | 'invalid_auth'
  /** Linear rate-limited the request. */
  | 'rate_limited'
  /** Linear could not be reached or answered with an error. */
  | 'provider_unavailable'

export interface LinearTeamListingConnection {
  id: string
  displayName: string
  isDefault: boolean
  status: 'ok' | 'error'
  error?: LinearTeamListingError
  /** True when the connection sees more teams than Ficus lists; search narrows nothing past the cap. */
  truncated?: boolean
}

/** `GET /api/squads/:squadId/integrations/linear/teams`. */
export interface LinearTeamDirectory {
  teams: LinearTeamSummary[]
  connections: LinearTeamListingConnection[]
}

/**
 * How a saved routing value (`metadata.linear[].teamId` or a rule's team filter) relates to the listed
 * teams. Routing compares Linear team IDs exactly, so a value that only matches a team key is shown as
 * that team but flagged: it never routed anything.
 */
export type LinearTeamValueMatch =
  { kind: 'id'; team: LinearTeamSummary } | { kind: 'key'; team: LinearTeamSummary } | { kind: 'unknown' }

export function matchLinearTeamValue(value: string, teams: readonly LinearTeamSummary[]): LinearTeamValueMatch {
  const trimmed = value.trim()
  const byId = teams.find((team) => team.id === trimmed)
  if (byId) return { kind: 'id', team: byId }
  const byKey = teams.find((team) => team.key.toLowerCase() === trimmed.toLowerCase())
  return byKey ? { kind: 'key', team: byKey } : { kind: 'unknown' }
}

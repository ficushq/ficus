import { createHash } from 'node:crypto'
import { trackedResourceKey, trackedResourceLabel, type IntegrationSubscription } from '@ficus/shared'
import { resolveLinearAssignment, resolveLinearConnection } from '../linear/resolve-connection'
import { linearQuery } from '../linear/plugin'
import { TrackedResourceError } from '../../work-streams/tracked-resource-error'
import type { TrackedResourceAdapter } from './registry'

const ISSUE_EVENTS = ['assigned', 'unassigned', 'updated', 'comment']
/** A Linear team key is a short alphanumeric code such as `ENG`, never an `owner/repo` path. */
const TEAM_KEY = /^[a-z][a-z0-9]{0,9}$/i
const ISSUE_QUERY = 'query Issue($id: String!) { issue(id: $id) { id url number team { key } } }'

function text(value: unknown, max: number) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
}

export const linearTrackedResourceAdapter: TrackedResourceAdapter = {
  integration: 'linear',
  validateRepository: (repository) => TEAM_KEY.test(repository.trim()),
  // Linear tracks issues only. Any other kind gets fields no Linear fact can ever carry, so a
  // link that claims one is never identified by an issue's subscriptions.
  matchFields: (kind) =>
    kind === 'issue'
      ? { repository: 'teamKey', number: 'issue.number', externalId: 'issue.id' }
      : { repository: 'teamKey', number: 'pullRequest.number' },
  /** Ids hash the resource identity, so adding or removing a link never renumbers the others. */
  trackedSubscriptions(resource) {
    // Linear tracks issues only; a pull request lives on the code host, not here.
    if (resource.kind !== 'issue') return []
    const hash = createHash('sha256').update(trackedResourceKey(resource)).digest('hex').slice(0, 12)
    return ISSUE_EVENTS.map(
      (event): IntegrationSubscription => ({
        id: `tracked-${hash}-${event}`,
        source: {
          integration: 'linear',
          output: `issue.${event}`,
          version: 1,
          ...(resource.connectionId ? { connectionId: resource.connectionId } : {}),
        },
        // The provider id identifies the issue on its own; a comment fact carries nothing else.
        match: resource.externalId
          ? { 'issue.id': { value: resource.externalId } }
          : {
              teamKey: { value: resource.repository.trim().toLowerCase() },
              'issue.number': { value: resource.number },
            },
        deliver: { to: 'delivery-owner', whenInactive: 'retain' },
      })
    )
  },
  async authorizeSquad(squadId, connectionId) {
    const assignment = await resolveLinearAssignment(squadId)
    return !!assignment && (!connectionId || assignment.id === connectionId)
  },
  /**
   * Reads the squad's own connection. An issue this connection cannot see is reported as unknown
   * (null); a connection that cannot be used at all is a different answer, and says so.
   *
   * Linear's `issue(id:)` accepts either form of identity, so a resource that names only the
   * issue's UUID — all a comment delivery ever carries — is looked up by that UUID.
   */
  async describe(resource, squadId) {
    const id =
      resource.repository && resource.number
        ? trackedResourceLabel({ ...resource, repository: resource.repository, number: resource.number })
        : resource.externalId
    if (!id) return null
    const resolved = await resolveLinearConnection(squadId)
    // The squad still holds the assignment; what it lacks is a credential it may use right now.
    if (!resolved) throw new TrackedResourceError('Linear connection needs revalidation before linking', 409)
    let issue: Record<string, unknown> | null | undefined
    try {
      // Provider failures are identity answers here, not diagnostics: never leak provider text.
      ;({ issue } = await linearQuery<{ issue?: Record<string, unknown> | null }>(resolved.credential, ISSUE_QUERY, {
        id,
      }))
    } catch {
      return null
    }
    const externalId = text(issue?.id, 200)
    if (!externalId) return null
    const team = issue?.team && typeof issue.team === 'object' ? (issue.team as Record<string, unknown>) : undefined
    const key = text(team?.key, 100)
    const url = text(issue?.url, 2000)
    const number = typeof issue?.number === 'number' && Number.isSafeInteger(issue.number) ? issue.number : undefined
    return {
      externalId,
      ...(url ? { url } : {}),
      ...(key ? { repository: key.toLowerCase() } : {}),
      ...(number && number > 0 ? { number } : {}),
    }
  },
}

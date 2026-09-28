import { linearOutputCatalog } from '@ficus/shared'
import { createHash } from 'node:crypto'
import type { IntegrationOutputAdapter } from '../outputs/types'

const outputTitles = Object.fromEntries(linearOutputCatalog.map((event) => [event.output, event.title]))

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : undefined
}
function text(value: unknown, max = 500) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
function positive(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
/** The first value that reads as a timestamp; Linear omits fields on older payloads. */
function when(...values: unknown[]) {
  for (const value of values) {
    const stamp = text(value, 64)
    if (stamp && Number.isFinite(Date.parse(stamp))) return stamp
  }
  return ''
}

/** The adapter describes Linear facts. It knows nothing about Ficus agents or flow routing. */
export const linearOutputAdapter: IntegrationOutputAdapter = {
  integration: 'linear',
  catalog: linearOutputCatalog,
  workStreamBindings() {
    return { 'linear.issueId': { event: 'issue.id' }, 'linear.teamId': { event: 'teamId' } }
  },
  trackedResource(fact) {
    const issue = record(fact.data.issue)
    const externalId = text(issue?.id, 200)
    const repository = text(fact.data.teamKey, 100).trim().toLowerCase()
    const number = positive(issue?.number)
    // Comments carry only the issue UUID; those match through `trackedIdentity` instead.
    if (!externalId || !repository || number === undefined) return null
    return {
      integration: 'linear',
      repository,
      kind: 'issue',
      number,
      externalId,
      ...(fact.url ? { url: fact.url } : {}),
    }
  },
  trackedIdentity(fact) {
    const externalId = text(record(fact.data.issue)?.id, 200)
    return externalId ? { integration: 'linear', externalId } : null
  },
  normalize(event) {
    const payload = record(event.payload)
    const data = record(payload?.data)
    if (!payload || !data) return []
    const action = text(payload.action, 100)
    const comment = event.type === 'Comment'
    // The signature covers the body only, so a replay with a mutated `Linear-Event` header cannot re-type it.
    if (text(payload.type, 100) && payload.type !== event.type) return []
    if (comment ? action !== 'create' && action !== 'update' : event.type !== 'Issue' || action !== 'update') return []
    // Issue details live on the payload for issue events, and on the nested issue for comments.
    const source = comment ? (record(data.issue) ?? {}) : data
    const id = comment ? text(data.issueId, 200) || text(source.id, 200) : text(data.id, 200)
    if (!id) return []
    const updatedFrom = record(payload.updatedFrom) ?? {}
    const assigned = text(data.assigneeId, 200)
    let output = 'issue.comment'
    let verb = action
    let assignee = ''
    if (!comment) {
      if ('assigneeId' in updatedFrom) {
        output = assigned ? 'issue.assigned' : 'issue.unassigned'
        verb = assigned ? 'assigned' : 'unassigned'
        assignee = assigned || text(updatedFrom.assigneeId, 200)
        // An update that neither had nor gained an assignee identifies nobody to route on.
        if (!assignee) return []
      } else {
        output = 'issue.updated'
        verb =
          'stateId' in updatedFrom
            ? 'state'
            : 'title' in updatedFrom
              ? 'title'
              : 'labelIds' in updatedFrom
                ? 'labels'
                : 'updated'
        assignee = assigned
      }
    }
    const stamp = typeof payload.webhookTimestamp === 'number' && Math.abs(payload.webhookTimestamp) < 8.64e15
    const fallback = stamp ? new Date(payload.webhookTimestamp).toISOString() : ''
    // An edit is timed by the edit, so a later revision is its own fact rather than a duplicate of the first.
    const at = comment
      ? action === 'update'
        ? when(data.updatedAt, data.createdAt, fallback)
        : when(data.createdAt, data.updatedAt, fallback)
      : when(data.updatedAt, fallback)
    if (!at) return []
    const title = text(source.title)
    const number = positive(source.number)
    const identifier = text(source.identifier, 100)
    const team = record(source.team)
    const teamKey = text(team?.key, 100).toLowerCase()
    const state = text(record(source.state)?.type, 100)
    // Who acted on this delivery (the editor of an edited comment), not necessarily its author.
    const actor = text(record(payload.actor)?.id, 200) || text(data.userId, 200)
    const url = text(data.url, 2000)
    const details = comment ? text(data.body, 30000) : text(data.description, 30000) || title
    return [
      {
        output,
        version: 1,
        resourceKey: id,
        occurredAt: at,
        eventKey: createHash('sha256')
          // The comment id separates two comments on one issue that share a timestamp.
          .update(
            JSON.stringify([output, id, verb, actor, at, state, assignee, ...(comment ? [text(data.id, 200)] : [])])
          )
          .digest('hex'),
        data: {
          issue: { id, title, ...(number === undefined ? {} : { number }), ...(identifier ? { identifier } : {}) },
          teamId: text(source.teamId, 200) || text(team?.id, 200),
          ...(teamKey ? { teamKey } : {}),
          assignee,
          action: verb,
          actor,
          state,
          labels: Array.isArray(source.labels)
            ? source.labels
                .slice(0, 100)
                .map((label: unknown) => text(record(label)?.name, 200))
                .filter(Boolean)
            : [],
        },
        subject:
          `Linear ${(outputTitles[output] ?? 'issue updated').toLowerCase()}: ${`${identifier || id} ${title}`.trim()}`.slice(
            0,
            500
          ),
        body: [url, details].filter(Boolean).join('\n\n').slice(0, 30000),
        ...(url ? { url } : {}),
      },
    ]
  },
}

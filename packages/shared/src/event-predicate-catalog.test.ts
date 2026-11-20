import { describe, expect, test } from 'bun:test'
import {
  eventPredicateField,
  eventPredicateFields,
  linearOutputCatalog,
  githubOutputCatalog,
} from './event-predicate-catalog'

describe('linear output catalog', () => {
  const expectedOutputs: Record<string, string> = {
    'issue.assigned': 'Issue assigned',
    'issue.unassigned': 'Issue unassigned',
    'issue.updated': 'Issue updated',
    'issue.comment': 'Issue comment',
    'issue.delegated': 'Issue delegated',
    'issue.undelegated': 'Issue undelegated',
    'issue.mentioned': 'Agent mentioned',
    'issue.created': 'Issue created',
    'agent_session.created': 'Agent session created',
    'agent_session.prompted': 'Agent session prompted',
  }
  const sharedFieldTypes: Record<string, 'string' | 'number'> = {
    'issue.id': 'string',
    'issue.number': 'number',
    'issue.identifier': 'string',
    'issue.title': 'string',
    teamId: 'string',
    teamKey: 'string',
    assignee: 'string',
    action: 'string',
    actor: 'string',
    state: 'string',
    delegate: 'string',
    actorType: 'string',
  }
  const extras: Record<string, string[]> = {
    'issue.assigned': [],
    'issue.unassigned': [],
    'issue.updated': [],
    'issue.created': [],
    'issue.undelegated': [],
    'issue.comment': ['comment.id', 'comment.parentId', 'comment.inSession', 'session.id'],
    'issue.delegated': ['previousDelegate', 'session.id'],
    'issue.mentioned': ['comment.id', 'session.id'],
    'agent_session.created': [
      'session.id',
      'session.url',
      'session.trigger',
      'session.creator',
      'session.appUserId',
      'comment.id',
    ],
    'agent_session.prompted': ['session.id', 'session.appUserId', 'activity.id', 'prompt.signal', 'comment.id'],
  }

  test('has the ten Linear outputs at version 1 with the expected titles', () => {
    expect(linearOutputCatalog.map((entry) => entry.output).sort()).toEqual(Object.keys(expectedOutputs).sort())
    for (const entry of linearOutputCatalog) {
      expect(entry.integration).toBe('linear')
      expect(entry.version).toBe(1)
      expect(entry.title).toBe(expectedOutputs[entry.output])
    }
  })

  test('descriptions name the webhook source and the state field is the workflow state type', () => {
    for (const entry of linearOutputCatalog) {
      expect(entry.description).toMatch(new RegExp(`^${entry.title} from Linear (agent app )?webhooks\\.$`))
      expect(entry.fields.state?.description).toBe('Linear workflow state type (e.g. completed, canceled, started).')
    }
    expect(linearOutputCatalog.find((entry) => entry.output === 'agent_session.prompted')?.description).toContain(
      'agent app'
    )
  })

  test('every output carries the shared field set plus its own extras', () => {
    for (const entry of linearOutputCatalog) {
      expect(Object.keys(entry.fields).sort()).toEqual(
        [...Object.keys(sharedFieldTypes), ...extras[entry.output]!].sort()
      )
      for (const [path, type] of Object.entries(sharedFieldTypes)) expect(entry.fields[path]?.type).toBe(type)
      expect(entry.fields.teamKey?.normalize).toBe('lowercase')
    }
  })

  test('predicateFields is the field set plus a string[] labels field', () => {
    for (const entry of linearOutputCatalog) {
      expect(Object.keys(entry.predicateFields ?? {}).sort()).toEqual([...Object.keys(entry.fields), 'labels'].sort())
      expect(entry.predicateFields?.labels).toEqual({
        type: 'string[]',
        normalize: 'lowercase',
        description: expect.any(String),
      })
    }
  })

  test('eventPredicateFields/eventPredicateField resolve Linear outputs by integration/output/version', () => {
    const source = { integration: 'linear', output: 'issue.updated', version: 1 }
    expect(eventPredicateFields(source)).toBeDefined()
    expect(eventPredicateField(source, 'teamKey')?.type).toBe('string')
    expect(eventPredicateField(source, 'labels')?.type).toBe('string[]')
    expect(eventPredicateField(source, 'nope')).toBeUndefined()
    expect(eventPredicateField(source, 'session.id')).toBeUndefined()
    const prompted = { integration: 'linear', output: 'agent_session.prompted', version: 1 }
    expect(eventPredicateField(prompted, 'prompt.signal')?.type).toBe('string')
  })

  test("today's issue.assigned fields remain a subset of the new descriptor's fields", () => {
    const assigned = linearOutputCatalog.find((entry) => entry.output === 'issue.assigned')!
    for (const path of ['issue.id', 'issue.title', 'teamId', 'assignee']) {
      expect(assigned.fields[path]).toBeDefined()
    }
  })
})

test('GitHub labels are a case-insensitive collection on every event that exposes them', () => {
  const withLabels = githubOutputCatalog.filter((event) => eventPredicateField(event, 'labels'))
  expect(withLabels.length).toBeGreaterThan(0)
  for (const event of withLabels)
    expect(eventPredicateField(event, 'labels')).toMatchObject({ type: 'string[]', normalize: 'lowercase' })
})

test('PR author predicate fields are exposed only for GitHub PR events', () => {
  for (const event of githubOutputCatalog) {
    const author = eventPredicateField(event, 'pullRequest.author')
    const authorType = eventPredicateField(event, 'pullRequest.authorType')
    if (event.output.startsWith('pull_request.')) {
      expect(author).toMatchObject({ type: 'string', normalize: 'lowercase' })
      expect(authorType).toMatchObject({ type: 'string' })
    } else {
      expect(author).toBeUndefined()
      expect(authorType).toBeUndefined()
    }
  }
})

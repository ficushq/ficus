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
  }
  const expectedFieldTypes: Record<string, 'string' | 'number'> = {
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
  }

  test('has exactly the four Linear outputs at version 1 with the expected titles', () => {
    expect(linearOutputCatalog.map((entry) => entry.output).sort()).toEqual(Object.keys(expectedOutputs).sort())
    for (const entry of linearOutputCatalog) {
      expect(entry.integration).toBe('linear')
      expect(entry.version).toBe(1)
      expect(entry.title).toBe(expectedOutputs[entry.output])
    }
  })

  test('descriptions name the webhook source and the state field is the workflow state type', () => {
    for (const entry of linearOutputCatalog) {
      // Linear has no polling path; a missed webhook is not recovered by one.
      expect(entry.description).toBe(`${entry.title} from Linear webhooks.`)
      expect(entry.fields.state?.description).toBe('Linear workflow state type (e.g. completed, canceled, started).')
      expect(entry.predicateFields?.state?.description).toBe(
        'Linear workflow state type (e.g. completed, canceled, started).'
      )
    }
  })

  test('every output carries the shared field set', () => {
    for (const entry of linearOutputCatalog) {
      expect(Object.keys(entry.fields).sort()).toEqual(Object.keys(expectedFieldTypes).sort())
      for (const [path, type] of Object.entries(expectedFieldTypes)) {
        expect(entry.fields[path]?.type).toBe(type)
      }
      expect(entry.fields.teamKey?.normalize).toBe('lowercase')
    }
  })

  test('predicateFields is the field set plus a string[] labels field', () => {
    for (const entry of linearOutputCatalog) {
      expect(Object.keys(entry.predicateFields ?? {}).sort()).toEqual(
        [...Object.keys(expectedFieldTypes), 'labels'].sort()
      )
      expect(entry.predicateFields?.labels).toEqual({ type: 'string[]', description: expect.any(String) })
    }
  })

  test('eventPredicateFields/eventPredicateField resolve Linear outputs by integration/output/version', () => {
    const source = { integration: 'linear', output: 'issue.updated', version: 1 }
    expect(eventPredicateFields(source)).toBeDefined()
    expect(eventPredicateField(source, 'teamKey')?.type).toBe('string')
    expect(eventPredicateField(source, 'labels')?.type).toBe('string[]')
    expect(eventPredicateField(source, 'nope')).toBeUndefined()
  })

  test("today's issue.assigned fields remain a subset of the new descriptor's fields", () => {
    const assigned = linearOutputCatalog.find((entry) => entry.output === 'issue.assigned')!
    for (const path of ['issue.id', 'issue.title', 'teamId', 'assignee']) {
      expect(assigned.fields[path]).toBeDefined()
    }
  })
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

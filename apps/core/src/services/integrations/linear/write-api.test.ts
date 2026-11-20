import { afterEach, describe, expect, test } from 'bun:test'
import { createFakeLinear } from './testing/fake-linear'
import { createLinearAgentActivity } from './app-api'
import { linearQuery } from './plugin'
import { LinearWriteError, writeLinearActivity } from './write-api'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Answers every write with HTTP 200 and the given GraphQL errors, as Linear does for a refused insert. */
function answer(errors: unknown[]) {
  globalThis.fetch = (async () => Response.json({ data: null, errors }, { status: 200 })) as unknown as typeof fetch
}
async function failure() {
  const error = await writeLinearActivity('Bearer token', {
    agentSessionId: 'session-1',
    id: 'activity-1',
    content: { type: 'thought', body: 'Working on it' },
  }).catch((caught) => caught)
  expect(error).toBeInstanceOf(LinearWriteError)
  return error as LinearWriteError
}

describe('a repeated activity ID', () => {
  test('Linear’s live answer, HTTP 200 with "conflict on insert of AgentActivity", is a duplicate, not a permanent failure', async () => {
    answer([
      {
        message: 'conflict on insert of AgentActivity',
        extensions: { type: 'invalid input', code: 'INVALID_INPUT', userError: true },
      },
    ])
    const error = await failure()
    expect(error.code).toBe('duplicate')
    expect(error.permanent).toBe(false)
  })

  test('the fake Linear refuses a repeated ID the same way, so a retry after an unknown outcome counts as sent', async () => {
    const linear = createFakeLinear()
    linear.addIssue({
      id: 'issue-1',
      number: 1,
      identifier: 'ENG-1',
      title: 'Issue',
      url: 'https://linear.app/acme/issue/ENG-1',
      team: { id: 'team-1', key: 'ENG' },
    })
    linear.addSession({ id: 'session-1', issueId: 'issue-1' })
    globalThis.fetch = linear.fetch
    const input = { agentSessionId: 'session-1', id: 'activity-1', content: { type: 'thought' as const, body: 'Hi' } }
    await writeLinearActivity('Bearer token', input)
    const error = await writeLinearActivity('Bearer token', input).catch((caught) => caught)
    expect(error).toMatchObject({ code: 'duplicate' })
    expect(linear.activitiesFor('session-1')).toHaveLength(1)
  })

  test('a duplicate error code counts whatever the message says; a bare conflict code does not', async () => {
    for (const code of ['duplicate', 'ALREADY_EXISTS', 'UNIQUE_VIOLATION']) {
      answer([{ message: 'Something went wrong', extensions: { code } }])
      expect((await failure()).code).toBe('duplicate')
    }
    answer([{ message: 'Something went wrong', extensions: { code: 'CONFLICT' } }])
    expect((await failure()).code).toBe('rejected')
  })

  test('the earlier messages still count', async () => {
    for (const message of ['Agent activity with this id already exists', 'Duplicate key']) {
      answer([{ message }])
      expect((await failure()).code).toBe('duplicate')
    }
  })

  test('other refusals keep their classification', async () => {
    answer([{ message: 'Argument Validation Error', extensions: { code: 'INVALID_INPUT' } }])
    expect((await failure()).code).toBe('rejected')
    answer([{ message: 'Entity not found: AgentSession' }])
    expect((await failure()).code).toBe('not_found')
    answer([{ message: 'conflict', extensions: { code: 'RATELIMITED' } }])
    expect((await failure()).code).toBe('rate_limited')
  })
})

describe('session acknowledgment, disposition and binding posts', () => {
  const post = () =>
    createLinearAgentActivity('Bearer token', {
      sessionId: 'session-1',
      projectionKey: 'ack',
      content: { type: 'thought', body: 'Received' },
    })

  test('Linear’s duplicate answer counts as posted', async () => {
    answer([{ message: 'conflict on insert of AgentActivity', extensions: { code: 'INVALID_INPUT' } }])
    await expect(post()).resolves.toBeUndefined()
  })

  test('any other refusal still fails as before', async () => {
    answer([{ message: 'Entity not found: AgentSession' }])
    await expect(post()).rejects.toThrow('provider_query_failed')
  })

  test('a read that Linear refuses with the same text fails as before for other callers', async () => {
    answer([{ message: 'conflict on insert of AgentActivity' }])
    await expect(linearQuery('Bearer token', 'query { viewer { id } }')).rejects.toThrow('provider_query_failed')
  })
})

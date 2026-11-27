import { describe, expect, test } from 'bun:test'
import {
  LINEAR_HEARTBEAT_MS,
  LINEAR_PROJECTION_TEXT,
  linearStepLabel,
  projectionAttemptFloor,
  projectLinearSession,
  type LinearProjectionSnapshot,
} from './session-projection'

const now = new Date('2026-11-20T10:00:00.000Z')
const steps = [
  { id: 'implement', kind: 'agent' },
  { id: 'route', kind: 'decision' },
  { id: 'approve', kind: 'human-approval' },
]

function snapshot(overrides: Partial<LinearProjectionSnapshot> = {}): LinearProjectionSnapshot {
  return {
    stream: { status: 'active', pause: null },
    steps,
    attempts: [],
    attemptFloor: 1,
    questions: [],
    lastActivityAt: now,
    now,
    ...overrides,
  }
}
const keys = (value: LinearProjectionSnapshot) => projectLinearSession(value).map((item) => item.projectionKey)
const byKey = (value: LinearProjectionSnapshot, key: string) =>
  projectLinearSession(value).find((item) => item.projectionKey === key)

describe('Linear session projection', () => {
  test('step labels are fixed per kind with the position, never the squad-authored step name', () => {
    expect(linearStepLabel(steps, { id: 1, stepId: 'implement', status: 'running' })).toBe('Working (step 1 of 3)')
    expect(linearStepLabel(steps, { id: 2, stepId: 'route', status: 'running' })).toBe(
      'Choosing the next step (step 2 of 3)'
    )
    expect(linearStepLabel(steps, { id: 3, stepId: 'approve', status: 'running' })).toBe(
      'Waiting for approval in Ficus (step 3 of 3)'
    )
    expect(linearStepLabel(steps, { id: 4, stepId: 'secret-internal-step', status: 'running', kind: 'custom' })).toBe(
      'Working'
    )
  })

  test('an admitted stream says it started, and running and finished attempts become actions', () => {
    const items = projectLinearSession(
      snapshot({
        attempts: [
          { id: 1, stepId: 'implement', status: 'completed' },
          { id: 2, stepId: 'route', status: 'running' },
        ],
      })
    )
    expect(items.map((item) => item.projectionKey)).toEqual(['stream:started', 'flow:1:completed', 'flow:2:started'])
    expect(items[0]!.payload).toEqual({ content: { type: 'thought', body: LINEAR_PROJECTION_TEXT.started } })
    expect(items[1]!.payload).toEqual({
      content: { type: 'action', action: 'Finished', parameter: 'Working (step 1 of 3)' },
    })
    // Only thoughts and actions may be ephemeral; a running step's action is.
    expect(items[2]!.payload).toEqual({
      content: { type: 'action', action: 'Started', parameter: 'Choosing the next step (step 2 of 3)' },
      ephemeral: true,
    })
    expect(items.every((item) => item.collapsible)).toBe(true)
  })

  test('attempts below the binding baseline are never shown', () => {
    const value = snapshot({
      attemptFloor: 3,
      attempts: [
        { id: 1, stepId: 'implement', status: 'completed' },
        { id: 2, stepId: 'route', status: 'completed' },
        { id: 3, stepId: 'implement', status: 'running' },
      ],
    })
    expect(keys(value)).toEqual(['stream:started', 'flow:3:started'])
    expect(projectionAttemptFloor({ attempts: value.attempts })).toBe(3)
    expect(projectionAttemptFloor({ attempts: [{ id: 1, status: 'completed' }] })).toBe(2)
    expect(projectionAttemptFloor(null)).toBe(1)
  })

  test('a human approval step waits in Ficus; approval is never offered in Linear', () => {
    const item = byKey(snapshot({ attempts: [{ id: 4, stepId: 'approve', status: 'running' }] }), 'approval:4')
    expect(item?.payload).toEqual({ content: { type: 'thought', body: 'Waiting for approval in Ficus.' } })
  })

  test('the delivery pull request is an action plus a session external URL, never collapsed', () => {
    const url = 'https://github.com/acme/widgets/pull/7'
    const items = projectLinearSession(snapshot({ pullRequest: { url, label: 'acme/widgets#7' } }))
    const action = items.find((item) => item.projectionKey === `pr:${url}`)!
    expect(action.payload).toEqual({
      content: { type: 'action', action: 'Opened pull request', parameter: 'acme/widgets#7', result: url },
    })
    expect(action.collapsible).toBe(false)
    const update = items.find((item) => item.projectionKey === `pr-url:${url}`)!
    expect(update).toMatchObject({
      kind: 'session_update',
      payload: { addedExternalUrls: [{ label: 'Pull request', url }] },
    })
  })

  test('"Open in Ficus" and the done link appear only with a public stream URL', () => {
    expect(keys(snapshot())).not.toContain('open-in-ficus')
    const streamUrl = 'https://ficus.example.com/squads/s/work?ws=12'
    expect(byKey(snapshot({ streamUrl }), 'open-in-ficus')?.payload).toEqual({
      addedExternalUrls: [{ label: 'Open in Ficus', url: streamUrl }],
    })
    const done = { stream: { status: 'done' as const, pause: null } }
    expect(byKey(snapshot(done), 'stream:done')?.payload).toEqual({ content: { type: 'response', body: 'Done.' } })
    expect(byKey(snapshot({ ...done, streamUrl }), 'stream:done')?.payload).toEqual({
      content: { type: 'response', body: `Done. Details in Ficus: ${streamUrl}` },
    })
    const url = 'https://github.com/acme/widgets/pull/7'
    expect(byKey(snapshot({ ...done, pullRequest: { url, label: 'acme/widgets#7' } }), 'stream:done')?.payload).toEqual(
      {
        content: { type: 'response', body: `Done. Pull request: ${url}.` },
      }
    )
  })

  test('pause, cancellation and unrecoverable failure use fixed templates', () => {
    const running = [{ id: 1, stepId: 'implement', status: 'running' as const }]
    expect(
      byKey(snapshot({ stream: { status: 'active', pause: { id: 'p1' } }, attempts: running }), 'pause:p1')?.payload
    ).toEqual({ content: { type: 'thought', body: 'Paused.' } })
    // A stream created from an event waits paused for its owner: nothing has started or paused yet.
    expect(keys(snapshot({ stream: { status: 'active', pause: { id: 'p0' } } }))).toEqual([])
    expect(byKey(snapshot({ stream: { status: 'canceled', pause: null } }), 'stream:canceled')?.payload).toEqual({
      content: { type: 'response', body: 'Ficus stopped working on this request.' },
    })
    const failed = byKey(snapshot({ failedWaitId: 'w1' }), 'stream:failed:w1')!
    expect(failed.payload).toEqual({
      content: { type: 'error', body: 'Ficus hit a problem and a person on the team is looking at it.' },
    })
    expect(failed.collapsible).toBe(false)
  })

  test('a quiet active stream gets an ephemeral heartbeat before Linear marks the session stale', () => {
    const quiet = snapshot({
      lastActivityAt: new Date(now.getTime() - LINEAR_HEARTBEAT_MS),
      attempts: [{ id: 1, stepId: 'implement', status: 'running' }],
    })
    const heartbeat = projectLinearSession(quiet).find((item) => item.projectionKey.startsWith('heartbeat:'))!
    expect(heartbeat.payload).toEqual({
      content: { type: 'thought', body: 'Still working: Working (step 1 of 3).' },
      ephemeral: true,
    })
    expect(keys(snapshot()).some((key) => key.startsWith('heartbeat:'))).toBe(false)
    expect(
      keys({ ...quiet, stream: { status: 'active', pause: { id: 'p' } } }).some((key) => key.startsWith('heartbeat:'))
    ).toBe(false)
  })

  test('an open select question mirrors as an elicitation with the select signal and the reply hint', () => {
    const item = byKey(
      snapshot({
        questions: [
          {
            id: 'q1',
            status: 'open',
            data: {
              questions: [
                {
                  id: 'choice',
                  type: 'select',
                  question: 'Which database?',
                  context: 'Postgres is already deployed.',
                  options: [{ value: 'pg', label: 'Postgres' }, { value: 'sqlite' }],
                },
              ],
            },
          },
        ],
      }),
      'question:q1:asked'
    )!
    expect(item.payload).toEqual({
      content: {
        type: 'elicitation',
        body: 'Which database?\n\nPostgres is already deployed.\n\nReply here or answer in Ficus.',
      },
      signal: 'select',
      signalMetadata: {
        options: [
          { value: 'pg', label: 'Postgres' },
          { value: 'sqlite', label: 'sqlite' },
        ],
      },
    })
    expect(item.collapsible).toBe(false)
  })

  test('the recommended option and its reason follow the context, and the select options stay as they are', () => {
    const item = byKey(
      snapshot({
        questions: [
          {
            id: 'q1',
            status: 'open',
            data: {
              questions: [
                {
                  id: 'choice',
                  type: 'select',
                  question: 'Which database?',
                  context: 'Postgres is already deployed.',
                  options: [
                    { value: 'pg', label: 'Postgres', recommended: true, reason: 'It is already backed up nightly.' },
                    { value: 'sqlite' },
                  ],
                },
              ],
            },
          },
        ],
      }),
      'question:q1:asked'
    )!
    expect(item.payload).toEqual({
      content: {
        type: 'elicitation',
        body:
          'Which database?\n\nPostgres is already deployed.\n\n' +
          'Recommended: Postgres. It is already backed up nightly.\n\nReply here or answer in Ficus.',
      },
      signal: 'select',
      signalMetadata: {
        options: [
          { value: 'pg', label: 'Postgres' },
          { value: 'sqlite', label: 'sqlite' },
        ],
      },
    })
  })

  test('each question of several names its own recommendation, with or without a reason', () => {
    const item = byKey(
      snapshot({
        questions: [
          {
            id: 'q3',
            status: 'open',
            data: {
              questions: [
                {
                  id: 'env',
                  type: 'select',
                  question: 'Where?',
                  options: [{ value: 'staging', recommended: true }, { value: 'prod' }],
                },
                {
                  id: 'who',
                  type: 'text',
                  question: 'Who should I tell?',
                  context: 'Both teams use it.',
                  options: [
                    { value: 'support' },
                    { value: 'owners', label: 'Team owners', recommended: true, reason: 'They run it.' },
                  ],
                },
                { id: 'notes', type: 'text', question: 'Anything else?' },
              ],
            },
          },
        ],
      }),
      'question:q3:asked'
    )!
    expect((item.payload.content as { body: string }).body).toBe(
      'Where?\n\n- staging\n- prod\n\nRecommended: staging.\n\n' +
        'Who should I tell?\n\nBoth teams use it.\n\n- support\n- Team owners\n\nRecommended: Team owners. They run it.\n\n' +
        'Anything else?\n\nReply here or answer in Ficus.'
    )
    expect(item.payload).not.toHaveProperty('signal')
  })

  test('a recommended label that already ends a sentence gets no extra full stop', () => {
    const body = (id: string, label: string, reason?: string) =>
      (
        byKey(
          snapshot({
            questions: [
              {
                id,
                status: 'open',
                data: {
                  questions: [
                    {
                      id: 'ship',
                      type: 'select',
                      question: 'What now?',
                      options: [
                        { value: 'ship', label, recommended: true, ...(reason ? { reason } : {}) },
                        { value: 'wait' },
                      ],
                    },
                  ],
                },
              },
            ],
          }),
          `question:${id}:asked`
        )!.payload.content as { body: string }
      ).body
    expect(body('q4', 'Ship it now?', 'Tests passed.')).toBe(
      'What now?\n\nRecommended: Ship it now? Tests passed.\n\nReply here or answer in Ficus.'
    )
    expect(body('q5', 'Ship it!')).toBe('What now?\n\nRecommended: Ship it!\n\nReply here or answer in Ficus.')
    expect(body('q6', 'Ship it', 'Tests passed.')).toBe(
      'What now?\n\nRecommended: Ship it. Tests passed.\n\nReply here or answer in Ficus.'
    )
  })

  test('the account link request rides on the next elicitation as the auth signal', () => {
    const authLinkUrl = 'https://ficus.example.com/settings?setting=linear-account'
    const item = byKey(
      snapshot({
        authLinkUrl,
        questions: [{ id: 'q2', status: 'open', data: { questions: [{ id: 'a', type: 'text', question: 'Why?' }] } }],
      }),
      'question:q2:asked'
    )!
    expect(item.payload).toMatchObject({ signal: 'auth', signalMetadata: { url: authLinkUrl } })
  })

  test('a question resolved in Ficus posts its label once; one answered in Linear posts nothing', () => {
    const data = { questions: [{ id: 'a', type: 'select' as const, question: 'Pick', options: [{ value: 'x' }] }] }
    expect(
      byKey(
        snapshot({ questions: [{ id: 'q3', status: 'answered', data, answerLabel: 'X', mirrorState: 'open' }] }),
        'question:q3:resolved'
      )?.payload
    ).toEqual({ content: { type: 'thought', body: 'Answered in Ficus: X' } })
    // No label (free text, or several questions): no summary rather than a placeholder.
    expect(
      byKey(
        snapshot({ questions: [{ id: 'q6', status: 'answered', data, mirrorState: 'open' }] }),
        'question:q6:resolved'
      )?.payload
    ).toEqual({ content: { type: 'thought', body: 'Answered in Ficus.' } })
    expect(
      byKey(
        snapshot({ questions: [{ id: 'q4', status: 'dismissed', data, mirrorState: 'open' }] }),
        'question:q4:resolved'
      )?.payload
    ).toEqual({ content: { type: 'thought', body: 'Question withdrawn.' } })
    expect(
      keys(snapshot({ questions: [{ id: 'q5', status: 'answered', data, mirrorState: 'answered_in_linear' }] }))
    ).not.toContain('question:q5:resolved')
    // A question already posted is never posted again.
    expect(keys(snapshot({ questions: [{ id: 'q6', status: 'open', data, mirrorState: 'open' }] }))).not.toContain(
      'question:q6:asked'
    )
  })

  test('no heartbeat while a person is being waited on', () => {
    const quiet = { lastActivityAt: new Date(now.getTime() - LINEAR_HEARTBEAT_MS) }
    const question = {
      id: 'q9',
      status: 'open',
      data: { questions: [{ id: 'a', type: 'text' as const, question: 'Which?' }] },
      mirrorState: 'open' as const,
    }
    const heartbeats = (value: LinearProjectionSnapshot) => keys(value).filter((key) => key.startsWith('heartbeat:'))
    expect(heartbeats(snapshot({ ...quiet, questions: [question] }))).toEqual([])
    expect(heartbeats(snapshot({ ...quiet, attempts: [{ id: 1, stepId: 'approve', status: 'running' }] }))).toEqual([])
    expect(
      heartbeats(snapshot({ ...quiet, attempts: [{ id: 1, stepId: 'implement', status: 'running' }] }))
    ).toHaveLength(1)
  })

  test('a pause from a Linear stop gets no extra "Paused." thought, and nothing follows the final response', () => {
    const running = [{ id: 1, stepId: 'implement', status: 'running' as const }]
    const stopped = { id: 'p2', reason: 'Stopped from Linear by Mira' }
    expect(keys(snapshot({ stream: { status: 'active', pause: stopped }, attempts: running }))).not.toContain(
      'pause:p2'
    )
    const data = { questions: [{ id: 'a', type: 'select' as const, question: 'Pick', options: [{ value: 'x' }] }] }
    expect(
      keys(
        snapshot({
          stream: { status: 'done', pause: null },
          questions: [{ id: 'q7', status: 'dismissed', data, mirrorState: 'open' }],
        })
      )
    ).not.toContain('question:q7:resolved')
  })

  test('projecting the same state twice yields the same keys, so the outbox sends nothing new', () => {
    const value = snapshot({ attempts: [{ id: 1, stepId: 'implement', status: 'completed' }] })
    expect(keys(value)).toEqual(keys(value))
  })
})

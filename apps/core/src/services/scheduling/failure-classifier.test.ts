import { DrizzleQueryError } from 'drizzle-orm'
import { describe, expect, it } from 'bun:test'
import { classifyScheduleFailure, ScheduleExecutionError } from './failure-classifier'

describe('classifyScheduleFailure', () => {
  it('preserves bounded controlled permanent errors', () => {
    expect(
      classifyScheduleFailure(
        new ScheduleExecutionError('target_agent_terminated', 'permanent', 'Target agent is terminated.')
      )
    ).toEqual({ class: 'permanent', code: 'target_agent_terminated', summary: 'Target agent is terminated.' })
  })

  it('maps transport failures to a fixed safe result', () => {
    expect(classifyScheduleFailure(Object.assign(new Error('socket'), { code: 'ECONNRESET' }))).toEqual({
      class: 'transient',
      code: 'transport_error',
      summary: 'A transport error interrupted the scheduled action.',
    })
  })

  it('does not persist unknown raw errors or credentials', () => {
    const result = classifyScheduleFailure(new Error('Bearer secret postgres://u:p@db/x'))
    expect(result).toEqual({
      class: 'transient',
      code: 'action_failed',
      summary: 'Scheduled action failed. Inspect Core logs for details.',
    })
    expect(result.summary.length).toBeLessThanOrEqual(500)
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('bounds controlled summaries and normalizes invalid controlled codes', () => {
    const result = classifyScheduleFailure(
      new ScheduleExecutionError('unsafe code' as never, 'permanent', 'x'.repeat(1_000))
    )
    expect(result.code).toBe('action_failed')
    expect(result.summary).toHaveLength(500)
  })

  it('maps database and provider failures without exposing their messages', () => {
    expect(classifyScheduleFailure(Object.assign(new Error('password=secret'), { code: '40001' }))).toMatchObject({
      class: 'transient',
      code: 'database_error',
    })
    expect(
      classifyScheduleFailure(Object.assign(new Error('api key secret'), { status: 503, name: 'APIError' }))
    ).toMatchObject({ class: 'transient', code: 'provider_error' })
  })
})

it('recognizes wrapped driver failures without persisting SQL or parameters', () => {
  const error = new DrizzleQueryError(
    'insert into private_table values ($1)',
    ['private-value'],
    Object.assign(new Error('private driver detail'), { code: '40001' })
  )
  expect(classifyScheduleFailure(error)).toEqual({
    class: 'transient',
    code: 'database_error',
    summary: 'A database error interrupted the scheduled action.',
  })
})

it('preserves transport classification when Drizzle wraps a driver socket error', () => {
  const error = new DrizzleQueryError(
    'private SQL',
    ['private'],
    Object.assign(new Error('socket'), { code: 'ECONNRESET' })
  )
  expect(classifyScheduleFailure(error)).toEqual({
    class: 'transient',
    code: 'transport_error',
    summary: 'A transport error interrupted the scheduled action.',
  })
})

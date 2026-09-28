import type { ScheduleFailureClass } from '@ficus/shared'

export const SCHEDULE_FAILURE_CODES = [
  'scope_not_found',
  'scope_invalid',
  'target_agent_not_found',
  'target_agent_dormant',
  'target_agent_terminated',
  'squad_manager_missing',
  'squad_manager_terminated',
  'invalid_action_reference',
  'transport_error',
  'database_error',
  'provider_error',
  'execution_interrupted',
  'health_persistence_failed',
  'attempt_in_progress',
  'action_failed',
] as const

export type ScheduleFailureCode = (typeof SCHEDULE_FAILURE_CODES)[number]

export interface ClassifiedScheduleFailure {
  class: ScheduleFailureClass
  code: ScheduleFailureCode
  summary: string
}

const MAX_SUMMARY_LENGTH = 500
const TRANSPORT_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ETIMEDOUT',
])
const DATABASE_CODES = new Set(['40001', '40P01', '53300', '57P01', '57P02', '57P03', '08000', '08003', '08006'])

function safeCode(value: unknown): ScheduleFailureCode {
  return typeof value === 'string' && (SCHEDULE_FAILURE_CODES as readonly string[]).includes(value)
    ? (value as ScheduleFailureCode)
    : 'action_failed'
}

function boundedSummary(value: string): string {
  return value.slice(0, MAX_SUMMARY_LENGTH)
}

export class ScheduleExecutionError extends Error {
  constructor(
    readonly code: ScheduleFailureCode,
    readonly failureClass: ScheduleFailureClass,
    readonly safeSummary: string
  ) {
    super(safeSummary)
    this.name = 'ScheduleExecutionError'
  }
}

/** Convert an arbitrary action failure into the only bounded fields safe to persist or return. */
export function classifyScheduleFailure(error: unknown): ClassifiedScheduleFailure {
  if (error instanceof ScheduleExecutionError) {
    return {
      class: error.failureClass,
      code: safeCode(error.code),
      summary: boundedSummary(error.safeSummary),
    }
  }

  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined
  const code = record?.code
  if (typeof code === 'string' && TRANSPORT_CODES.has(code)) {
    return {
      class: 'transient',
      code: 'transport_error',
      summary: 'A transport error interrupted the scheduled action.',
    }
  }
  if (typeof code === 'string' && (DATABASE_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code))) {
    return {
      class: 'transient',
      code: 'database_error',
      summary: 'A database error interrupted the scheduled action.',
    }
  }
  const status = record?.status
  const name = record?.name
  if ((typeof status === 'number' && status >= 500) || name === 'APIError') {
    return {
      class: 'transient',
      code: 'provider_error',
      summary: 'A provider error interrupted the scheduled action.',
    }
  }

  return {
    class: 'transient',
    code: 'action_failed',
    summary: 'Scheduled action failed. Inspect Core logs for details.',
  }
}

export function publicScheduleError(error: ClassifiedScheduleFailure): ScheduleExecutionError {
  return new ScheduleExecutionError(error.code, error.class, error.summary)
}

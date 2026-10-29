import { AsyncLocalStorage } from 'node:async_hooks'
import type { RecoveryRecord } from './store'

/** Safe inner transport retries share their enclosing tool's durable budget. */
export interface ToolRecoveryContext {
  beforeAttempt(): Promise<void>
  failed(error: unknown): Promise<RecoveryRecord | undefined>
  observed(error: unknown): boolean
  latest?: RecoveryRecord
}
export const toolRecoveryContext = new AsyncLocalStorage<ToolRecoveryContext>()

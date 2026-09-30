import { afterEach, expect, test } from 'bun:test'
import type { Execution } from '../../entities/Execution'
import { attemptPickup, resetExecutionPickupForTests, stopExecutionPickup } from './pickup'

afterEach(() => resetExecutionPickupForTests())

test('a stopping worker starts no new turns and leaves queued executions for its successor', async () => {
  stopExecutionPickup()
  // Decided before any sandbox, admission, or database work.
  const queued = { id: 'exec-stopping', status: 'queued', agentId: 'agent-1' } as unknown as Execution
  expect(await attemptPickup(queued)).toBe('worker-stopping')
})

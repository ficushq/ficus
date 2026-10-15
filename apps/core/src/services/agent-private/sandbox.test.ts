import { describe, expect, test } from 'bun:test'
import type { Agent } from '../../entities/Agent'
import type { AgentPrivateTarget } from './access'
import { startAgentSandbox } from './sandbox'

const AGENT = '11111111-1111-4111-8111-111111111111'

function target(live: boolean): AgentPrivateTarget {
  return { agent: { id: AGENT } as unknown as Agent, sandboxId: `agent_${AGENT}`, squadId: null, live }
}

describe('startAgentSandbox', () => {
  test('never ensures a dormant agent’s box', async () => {
    let ensured = 0
    const outcome = await startAgentSandbox(target(false), async () => {
      ensured++
      return 'ensured'
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'dormant' })
    expect(ensured).toBe(0)
  })

  test('ensures a live agent’s box and reports refusals from the warmup path', async () => {
    expect(await startAgentSandbox(target(true), async () => 'ensured')).toEqual({ ok: true })
    expect(await startAgentSandbox(target(true), async () => 'skipped-work-stream-queued')).toMatchObject({
      ok: false,
      reason: 'skipped-work-stream-queued',
    })
  })
})

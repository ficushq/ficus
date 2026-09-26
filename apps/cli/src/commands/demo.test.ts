import { describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { registerDemoCommands, renderSeedSummary, type DemoSeedSummary } from './demo'

const summary: DemoSeedSummary = {
  version: 1,
  user: { id: 'u1', email: 'demo-reviewer@demo.invalid', role: 'demo-reviewer' },
  squads: [
    { id: 's1', name: 'Product Engineering', agents: 4, workStreams: 4 },
    { id: 's2', name: 'Growth', agents: 2, workStreams: 2 },
  ],
  transcriptMessages: 6,
  questions: 2,
  inboxMessages: 1,
  modelProviderConfigured: false,
  created: ['user demo-reviewer@demo.invalid', 'squad Growth'],
}

describe('ficus demo', () => {
  it('seed posts to the demo endpoint and prints the summary', async () => {
    const apiPost = mock(async () => summary)
    const output = mock(() => {})
    const program = new Command()
    registerDemoCommands(program, { apiPost: apiPost as never, output: output as never })
    await program.parseAsync(['demo', 'seed'], { from: 'user' })
    expect(apiPost).toHaveBeenCalledWith('/api/demo/seed')
    expect(output.mock.calls[0][0]).toBe(summary)
  })

  it('renders what changed and warns when no model provider is connected', () => {
    const text = renderSeedSummary(summary)
    expect(text).toContain('created 2 item(s)')
    expect(text).toContain('Product Engineering: 4 agents, 4 work streams')
    expect(text).toContain('+ squad Growth')
    expect(text).toContain('No model provider is connected')
    expect(renderSeedSummary({ ...summary, created: [], modelProviderConfigured: true })).not.toContain('provider')
  })

  it('revoke reports how many devices were signed out', async () => {
    const apiPost = mock(async () => ({ revoked: 2 }))
    const output = mock(() => {})
    const program = new Command()
    registerDemoCommands(program, { apiPost: apiPost as never, output: output as never })
    await program.parseAsync(['demo', 'revoke'], { from: 'user' })
    expect(apiPost).toHaveBeenCalledWith('/api/demo/revoke-devices')
    expect(output.mock.calls[0][1]).toBe('Revoked 2 reviewer device(s)')
  })
})

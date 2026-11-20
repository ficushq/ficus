import { describe, expect, it } from 'bun:test'
import {
  notifyToolchainFailure,
  renderToolchainFailureNotice,
  toolchainFailureNoticeKey,
  type ToolchainFailureNoticeDeps,
} from './failure-notice'

const input = {
  sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
  squadId: '11111111-1111-4111-8111-111111111111',
  desiredFingerprint: 'f'.repeat(64),
  errorCode: 'setup_failed' as const,
}

function fakeDeps(managerAgentId: string | null) {
  const sent: { input: Parameters<ToolchainFailureNoticeDeps['sendOnce']>[0]; key: string }[] = []
  const delivered: string[] = []
  const keys = new Set<string>()
  const deps: ToolchainFailureNoticeDeps = {
    findManagerAgentId: async () => managerAgentId,
    sendOnce: (async (message, key) => {
      sent.push({ input: message, key })
      const created = !keys.has(key)
      keys.add(key)
      return { message: { id: key } as any, created }
    }) as ToolchainFailureNoticeDeps['sendOnce'],
    deliver: async (agentId) => void delivered.push(agentId),
  }
  return { deps, sent, delivered }
}

describe('toolchain failure notice', () => {
  it('tells the squad manager once per toolchain declaration, whichever box failed', async () => {
    const { deps, sent, delivered } = fakeDeps('manager-agent')
    await notifyToolchainFailure(input, deps)
    await notifyToolchainFailure({ ...input, sandboxId: 'agent_22222222-2222-4222-8222-222222222222' }, deps)

    expect(new Set(sent.map((entry) => entry.key))).toEqual(new Set([toolchainFailureNoticeKey(input)]))
    expect(delivered).toEqual(['manager-agent'])
    expect(sent[0].input).toMatchObject({
      recipientType: 'agent',
      recipientId: 'manager-agent',
      senderType: 'system',
      wakeEligible: true,
      subject: 'Sandbox toolchain install failed',
      metadata: { source: 'toolchain', errorCode: 'setup_failed' },
    })

    // A changed declaration that fails again is a new notice.
    await notifyToolchainFailure({ ...input, desiredFingerprint: 'e'.repeat(64) }, deps)
    expect(delivered).toEqual(['manager-agent', 'manager-agent'])
  })

  it('names the failure, its effect on agents and how to retry', () => {
    const text = renderToolchainFailureNotice(input)
    expect(text).toContain('Toolchain setup failed (setup_failed)')
    expect(text).toContain('keep running with it')
    expect(text).toContain(`ficus squad toolchain apply ${input.squadId}`)
  })

  it('does nothing when the squad has no manager', async () => {
    const { deps, sent } = fakeDeps(null)
    await notifyToolchainFailure(input, deps)
    expect(sent).toEqual([])
  })
})

import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentSecretsStatus } from '../api/agents'
import { queryKeys } from '../queryKeys'
import { AgentSecretsPanel } from './AgentSecretsPanel'

const status: AgentSecretsStatus = {
  agentId: 'agent-1',
  exposedSecretKeys: ['SYNTH_CLOUD_TOKEN'],
  unsupportedReason: null,
  secretsFilePath: '/private/.ficus/agent-secrets.env',
  secrets: [
    { key: 'SYNTH_CLOUD_TOKEN', isSet: true, exposed: true, canExpose: true, updatedAt: null },
    { key: 'SYNTH_OTHER_KEY', isSet: true, exposed: false, canExpose: false, updatedAt: null },
  ],
}

function renderPanel(permissions: string[], data: AgentSecretsStatus = status): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  queryClient.setQueryData(queryKeys.agents.secrets('agent-1'), data)
  queryClient.setQueryData(queryKeys.auth.permissions('squad-1'), { permissions })
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AgentSecretsPanel agentId="agent-1" squadId="squad-1" />
    </QueryClientProvider>
  )
}

describe('AgentSecretsPanel', () => {
  test('is hidden without env:read', () => {
    expect(renderPanel([])).toBe('')
  })

  test('lists key names and the sandbox path, read-only for env:read', () => {
    const html = renderPanel(['env:read'])
    expect(html).toContain('Per-agent secrets')
    expect(html).toContain('SYNTH_CLOUD_TOKEN')
    expect(html).toContain('/private/.ficus/agent-secrets.env')
    expect(html).not.toContain('Save exposed secrets')
    expect(html).not.toContain('Add a secret for this agent')
  })

  test('offers exposure changes with env:write and a new value only with secrets:write too', () => {
    const exposeOnly = renderPanel(['env:read', 'env:write'])
    expect(exposeOnly).toContain('Save exposed secrets')
    expect(exposeOnly).not.toContain('Add a secret for this agent')

    expect(renderPanel(['env:read', 'env:write', 'secrets:write'])).not.toContain('Add a secret for this agent')

    const withSecrets = renderPanel(['env:read', 'env:write', 'secrets:write', 'secrets:read'])
    expect(withSecrets).toContain('Add a secret for this agent')
    expect(withSecrets).toContain('type="password"')
  })

  test('marks keys the user cannot read as not exposable', () => {
    const html = renderPanel(['env:read', 'env:write'])
    expect(html).toMatch(/SYNTH_OTHER_KEY<span[^>]*>you cannot read this secret<\/span>/)
    expect(html).toMatch(/aria-label="Expose SYNTH_OTHER_KEY to this agent"[^>]*disabled/)
  })

  test('explains why an agent cannot hold per-agent secrets', () => {
    const html = renderPanel(['env:read', 'env:write'], {
      ...status,
      exposedSecretKeys: [],
      unsupportedReason: 'This is a subagent. Expose the secret to the parent agent instead.',
      secretsFilePath: null,
    })
    expect(html).toContain('This is a subagent.')
    expect(html).not.toContain('Save exposed secrets')
  })
})

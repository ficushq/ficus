import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../queryKeys'
import type { SandboxStatus } from '../api/workspace'
import { AgentSandboxControls } from './AgentSandboxControls'

/**
 * Seed the status into the cache so useQuery resolves synchronously during the
 * static render (no effects run, so nothing fetches).
 */
function render(agentId: string, status: SandboxStatus): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.agents.sandboxStatus(agentId), status)
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AgentSandboxControls agentId={agentId} />
    </QueryClientProvider>
  )
}

describe('AgentSandboxControls', () => {
  test('shows Stop and Restart for a running, controllable sandbox', () => {
    const html = render('agent-1', { status: 'running', devboxReady: true, controllable: true })
    expect(html).toContain('Running')
    expect(html).toContain('>Stop<')
    expect(html).toContain('>Restart<')
    expect(html).not.toContain('not individually controllable')
  })

  test('hides controls and explains when the sandbox is shared (not controllable)', () => {
    const html = render('agent-2', { status: 'running', devboxReady: true, controllable: false })
    expect(html).toContain('Running')
    expect(html).not.toContain('>Stop<')
    expect(html).not.toContain('>Restart<')
    expect(html).toContain('not individually controllable')
  })

  test('offers Start (not Restart/Stop) when the box is controllable but not running', () => {
    const html = render('agent-3', { status: 'not_found', controllable: true })
    expect(html).toContain('Not running')
    expect(html).not.toContain('>Stop<')
    expect(html).not.toContain('>Restart<')
    expect(html).toContain('>Start<')
  })

  test('offers Start (not Restart) when a prior box failed', () => {
    const html = render('agent-4', { status: 'failed', controllable: true })
    expect(html).not.toContain('>Restart<')
    expect(html).toContain('>Start<')
  })
})

describe('AgentSandboxControls (VM runtime)', () => {
  // Operator-decided semantics: a VM sandbox is a unix account + per-box
  // server on a machine host. It should in general ALWAYS be running — Stop
  // is not a meaningful goal state there (stopSandbox just parks the account;
  // the next use lazily restarts it). So VM mode replaces the prominent
  // Stop/Restart controls with a chain-health status and demotes Restart to a
  // secondary troubleshooting action; Stop is hidden entirely.

  test('a healthy chain shows a plain "Running" with no Stop button', () => {
    const html = render('agent-vm-1', {
      status: 'running',
      controllable: true,
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
    })
    expect(html).toContain('Running')
    expect(html).not.toContain('>Stop<')
  })

  test('never shows Stop in VM mode, even for a controllable, running box', () => {
    const html = render('agent-vm-2', {
      status: 'running',
      controllable: true,
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
    })
    expect(html).not.toContain('Stop sandbox')
  })

  test('an unreachable machine surfaces "Machine unreachable", not a generic Failed', () => {
    const html = render('agent-vm-3', {
      status: 'failed',
      reason: 'box machine is gone or no longer ready',
      controllable: true,
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'unreachable', boxServer: 'unknown' },
    })
    expect(html).toContain('Machine unreachable')
    expect(html).not.toContain('>Stop<')
  })

  test('a parked box surfaces "Box server down — starts on next use"', () => {
    const html = render('agent-vm-4', {
      status: 'not_found',
      controllable: true,
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'unknown', boxServer: 'down' },
    })
    expect(html).toContain('Box server down')
    expect(html).toContain('starts on next use')
  })

  test('VM health stays visible without a Restart action, even when controllable', () => {
    const html = render('agent-vm-5', {
      status: 'running',
      controllable: true,
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
    })
    expect(html).toContain('Running')
    expect(html).not.toContain('>Restart<')
  })

  test('a shared (not controllable) VM box shows chain-health read-only, no Restart', () => {
    const html = render('agent-vm-6', {
      status: 'running',
      controllable: false,
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
    })
    expect(html).toContain('Running')
    expect(html).not.toContain('>Restart<')
    expect(html).not.toContain('>Stop<')
  })

  test('a non-vm runtime (k8s) keeps the classic Stop/Restart controls untouched', () => {
    const html = render('agent-k8s-1', { status: 'running', devboxReady: true, controllable: true, runtime: 'k8s' })
    expect(html).toContain('>Stop<')
    expect(html).toContain('>Restart<')
  })
})

describe('AgentSandboxControls (host runtime)', () => {
  test('renders the host explanation with no Stop/Restart/Start controls', () => {
    const html = render('agent-host-1', {
      status: 'running',
      devboxReady: true,
      controllable: true,
      runtime: 'host',
    })
    expect(html).toContain('Agents run directly on this machine as the Ficus process user')
    expect(html).not.toContain('>Stop<')
    expect(html).not.toContain('>Restart<')
    expect(html).not.toContain('>Start<')
    expect(html).not.toContain('Running')
  })
})

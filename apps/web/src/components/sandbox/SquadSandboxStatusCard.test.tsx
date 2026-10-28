import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import type { SandboxStatus } from '../../api/workspace'
import { SquadSandboxStatusCard } from './SquadSandboxStatusCard'

function render(squadId: string, status: SandboxStatus): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.sandbox.status(squadId), status)
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SquadSandboxStatusCard squadId={squadId} />
    </QueryClientProvider>
  )
}

describe('SquadSandboxStatusCard', () => {
  test('shows the squad box status read-only — no Stop/Restart controls', () => {
    const html = render('squad-1', { status: 'running', devboxReady: true })
    expect(html).toContain('Squad sandbox')
    expect(html).toContain('Running')
    expect(html).not.toContain('manage it on the squad page')
    expect(html).not.toContain('>Stop<')
    expect(html).not.toContain('>Restart<')
    expect(html).toMatch(/^<dl[\s\S]*<dt[^>]*>Squad sandbox<\/dt><dd[\s\S]*<\/dd><\/dl>$/)
  })

  test('shows bounded VM degradation reason, attempt, and retry timing', () => {
    const html = render('squad-1', {
      status: 'running',
      runtime: 'vm',
      readiness: 'ready_degraded',
      devboxReady: false,
      degradation: {
        reasons: ['transport_recovery_failed'],
        attemptCount: 2,
        nextAttemptAt: '2026-08-27T08:00:00.000Z',
      },
    })
    expect(html).toContain('Sandbox transport recovery pending')
    expect(html).toContain('Attempt 2')
    expect(html).toContain('2026-08-27T08:00:00.000Z')
    expect(html).toContain('Running — degraded')
    expect(html).toContain('text-status-attention-fg')
    expect(html).toContain('bg-status-attention-solid')
  })

  test('uses the VM chain label when the machine is unreachable', () => {
    const html = render('squad-1', {
      status: 'failed',
      runtime: 'vm',
      reason: 'box machine is gone or no longer ready',
      chain: { boxProvisioned: true, machine: 'unreachable', boxServer: 'unknown' },
    })
    expect(html).toContain('Machine unreachable')
    expect(html).toContain('text-status-attention-fg')
    expect(html).toContain('bg-status-attention-solid')
    expect(html).not.toContain('>Failed<')
  })

  test('uses the VM chain label when the box server is down', () => {
    const html = render('squad-1', {
      status: 'not_found',
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'unknown', boxServer: 'down' },
    })
    expect(html).toContain('Box server down')
    expect(html).toContain('starts on next use')
    expect(html).toContain('text-status-attention-fg')
    expect(html).toContain('bg-status-attention-solid')
    expect(html).not.toContain('Not running')
  })
})

describe('SquadSandboxStatusCard (host runtime)', () => {
  // AgentSandboxControls, directly above this card in AgentInfoPanel, already
  // carries the "no sandbox on host" explanation — rendering the identical
  // paragraph twice in one panel is noise, so this card stands down entirely.
  test('renders nothing at all', () => {
    for (const status of [
      { status: 'running', runtime: 'host', devboxReady: true } as const,
      { status: 'not_found', runtime: 'host' } as const,
    ]) {
      expect(render('squad-host-1', status)).toBe('')
    }
  })
})

describe('idle deferred assets display', () => {
  test('shows the refresh on next start without lifecycle actions', () => {
    const html = render('idle-assets', {
      status: 'starting',
      runtime: 'vm',
      readiness: 'pending',
      assetsRefreshPending: true,
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'idle' },
    })
    expect(html).toContain('Idle')
    expect(html).toContain('bg-status-neutral-solid')
    expect(html).toContain('assets refresh on next start')
    expect(html).not.toContain('Starting')
    expect(html).not.toContain('>Start<')
    expect(html).not.toContain('>Restart<')
  })
})

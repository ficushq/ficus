import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import type { SandboxStatus } from '../../api/workspace'
import { SandboxStatusIndicator } from './SandboxStatusIndicator'

/**
 * Seed the status into the cache so useQuery resolves synchronously during the
 * static render (no effects run, so nothing fetches).
 */
function render(squadId: string, status: SandboxStatus): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.sandbox.status(squadId), status)
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SandboxStatusIndicator squadId={squadId} />
    </QueryClientProvider>
  )
}

describe('SandboxStatusIndicator (VM runtime)', () => {
  // Operator-decided semantics: VM squad sandboxes should in general ALWAYS be
  // running, so Stop is hidden entirely and Start/Stop are replaced by the
  // chain-health status; Restart survives as a demoted troubleshooting action.

  test('a healthy chain shows a plain "Running" with no Stop or Start button', () => {
    const html = render('squad-vm-1', {
      status: 'running',
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
    })
    expect(html).toContain('Running')
    expect(html).not.toContain('>Stop<')
    expect(html).not.toContain('>Start<')
  })

  test('an unreachable machine surfaces "Machine unreachable"', () => {
    const html = render('squad-vm-2', {
      status: 'failed',
      reason: 'box machine is gone or no longer ready',
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'unreachable', boxServer: 'unknown' },
    })
    expect(html).toContain('Machine unreachable')
    expect(html).not.toContain('>Stop<')
  })

  test('a parked box surfaces "Box server down — starts on next use"', () => {
    const html = render('squad-vm-3', {
      status: 'not_found',
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'unknown', boxServer: 'down' },
    })
    expect(html).toContain('Box server down')
    expect(html).toContain('starts on next use')
  })

  test.each([
    ['failed', 'pending', 'Machine unreachable'],
    ['failed', 'installing', 'Machine unreachable'],
    ['failed', 'failed', 'Machine unreachable'],
    ['not_found', 'pending', 'Box server down'],
  ] as const)('keeps %s physical state primary over %s toolchain state', (physical, toolchain, primary) => {
    const html = render(`squad-vm-${physical}-${toolchain}`, {
      status: physical,
      reason: physical === 'failed' ? 'box machine is gone or no longer ready' : undefined,
      runtime: 'vm',
      chain:
        physical === 'failed'
          ? { boxProvisioned: true, machine: 'unreachable', boxServer: 'unknown' }
          : { boxProvisioned: true, machine: 'unknown', boxServer: 'down' },
      toolchain: { status: toolchain, reason: toolchain === 'failed' ? 'install failed' : undefined },
    })
    expect(html).toContain(primary)
    expect(html).not.toContain('Installing packages')
    expect(html).not.toContain('Toolchain pending')
  })

  test('keeps toolchain progress primary while the physical sandbox is running', () => {
    const html = render('squad-vm-running-installing', {
      status: 'running',
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
      toolchain: { status: 'installing' },
    })
    expect(html).toContain('Installing packages')
    expect(html).not.toContain('Running —')
  })

  test('VM health stays visible without a Restart action', () => {
    const html = render('squad-vm-4', {
      status: 'running',
      runtime: 'vm',
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
    })
    expect(html).toContain('Running')
    expect(html).not.toContain('>Restart<')
  })
})

describe('SandboxStatusIndicator (non-VM runtimes keep classic controls)', () => {
  test('docker mode keeps Start when not running (Stop absent, Start present)', () => {
    const html = render('squad-docker-1', { status: 'not_found', runtime: 'docker' })
    expect(html).toContain('>Start<')
    expect(html).not.toContain('>Stop<')
  })

  test('k8s mode keeps Stop when running', () => {
    const html = render('squad-k8s-1', { status: 'running', devboxReady: true, runtime: 'k8s' })
    expect(html).toContain('>Stop<')
  })

  test('an undefined runtime (back-compat) keeps the classic controls', () => {
    const html = render('squad-legacy-1', { status: 'running', devboxReady: true })
    expect(html).toContain('>Stop<')
  })
})

describe('SandboxStatusIndicator (host runtime)', () => {
  // On the host runtime there IS no sandbox: HostSandboxManager only keeps an
  // in-memory record, so "running" would mean "this process ensured the squad"
  // and Stop would merely forget that record. Nothing here is worth a chip in
  // the squad header, so the indicator renders nothing at all.
  test('renders nothing — no chip, no Start/Stop/Restart', () => {
    for (const [squadId, status] of [
      ['squad-host-1', { status: 'running', runtime: 'host', devboxReady: true } as const],
      ['squad-host-2', { status: 'not_found', runtime: 'host' } as const],
      ['squad-host-3', { status: 'running', runtime: 'host', toolchain: { status: 'installing' } } as const],
    ] as const) {
      const html = render(squadId, status as SandboxStatus)
      expect(html).toBe('')
    }
  })
})

describe('SandboxStatusIndicator (pill chrome)', () => {
  // The indicator owns its own pill so the squad header does not keep an empty
  // padded box when it renders nothing (host runtime).
  test('a docker chip carries the pill background itself', () => {
    const html = render('squad-pill-1', { status: 'running', runtime: 'docker', devboxReady: true })
    expect(html).toContain('bg-surface-secondary')
    expect(html).toContain('Sandbox running')
  })
})

describe('deferred assets header', () => {
  test('reads Idle with refresh on next start, not Starting', () => {
    const html = render('idle-assets', {
      status: 'starting',
      runtime: 'vm',
      readiness: 'pending',
      assetsRefreshPending: true,
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'idle' },
    })
    expect(html).toContain('Idle')
    expect(html).toContain('assets refresh on next start')
    expect(html).not.toContain('Starting')
    expect(html).not.toContain('animate-ping')
  })
})

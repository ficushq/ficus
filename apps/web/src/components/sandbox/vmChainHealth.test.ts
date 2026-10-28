import { describe, test, expect } from 'bun:test'
import type { SandboxStatus } from '../../api/workspace'
import { resolveVmChainDisplay } from './vmChainHealth'

/** Build a VM-mode SandboxStatus with the given status + chain facts. */
function vmStatus(partial: Partial<SandboxStatus>): SandboxStatus {
  return { status: 'not_found', runtime: 'vm', ...partial }
}

describe('resolveVmChainDisplay', () => {
  test('a usable VM with degraded setup is amber and never labeled plain Running', () => {
    const result = resolveVmChainDisplay(
      vmStatus({
        status: 'running',
        readiness: 'ready_degraded',
        degradation: { reasons: ['devbox_unavailable'], attemptCount: 3 },
        chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
      })
    )
    expect(result).toEqual({
      label: 'Running — degraded',
      detail: 'Devbox comfort tools unavailable; Attempt 3',
      healthy: false,
    })
  })

  test('healthy chain collapses to a plain "Running" — no chain breakdown surfaced', () => {
    const result = resolveVmChainDisplay(
      vmStatus({
        status: 'running',
        chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
      })
    )
    expect(result).toEqual({ label: 'Running', healthy: true })
  })

  test('an IDLE box (socket-activated, server stood down) reads as plain Running, not a fault', () => {
    // Core answers a status poll for an idle box without probing it — probing
    // would wake the server. The user's box is reachable and healthy; the pill
    // must not turn amber just because no live probe was made.
    const result = resolveVmChainDisplay(
      vmStatus({
        status: 'running',
        chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'idle' },
      })
    )
    expect(result).toEqual({ label: 'Running', healthy: true })
  })

  test('a never-provisioned box (first use) reads as "Not started", not a scary failure', () => {
    const result = resolveVmChainDisplay(
      vmStatus({
        status: 'not_found',
        chain: { boxProvisioned: false, machine: 'unknown', boxServer: 'unknown' },
      })
    )
    expect(result.label).toBe('Not started')
    expect(result.healthy).toBe(false)
  })

  test('a parked/stopped box reads as "Box server down — starts on next use" (the operator-reported case)', () => {
    const result = resolveVmChainDisplay(
      vmStatus({
        status: 'not_found',
        chain: { boxProvisioned: true, machine: 'unknown', boxServer: 'down' },
      })
    )
    expect(result.label).toBe('Box server down')
    expect(result.detail).toBe('starts on next use')
    expect(result.healthy).toBe(false)
  })

  test('an unreachable machine reads as "Machine unreachable"', () => {
    const result = resolveVmChainDisplay(
      vmStatus({
        status: 'failed',
        reason: 'box machine is gone or no longer ready',
        chain: { boxProvisioned: true, machine: 'unreachable', boxServer: 'unknown' },
      })
    )
    expect(result.label).toBe('Machine unreachable')
    expect(result.healthy).toBe(false)
  })

  test('a mid-provision box reads as "Starting…"', () => {
    const result = resolveVmChainDisplay(
      vmStatus({
        status: 'starting',
        chain: { boxProvisioned: true, machine: 'unknown', boxServer: 'unknown' },
      })
    )
    expect(result.label).toBe('Starting…')
    expect(result.healthy).toBe(false)
  })

  test('a provisioned box whose server is momentarily not answering reads as "Box server unresponsive — retrying…", not "Starting…"', () => {
    // status stays 'starting' (routes/recovery key on it to keep sessions
    // alive) but this state means "was ready, not answering right now" — not
    // "provisioning" — so the pill must not claim the box is starting up.
    const result = resolveVmChainDisplay(
      vmStatus({
        status: 'starting',
        chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'down' },
      })
    )
    expect(result.label).toBe('Box server unresponsive')
    expect(result.detail).toBe('retrying…')
    expect(result.healthy).toBe(false)
  })

  test('degrades honestly to the coarse status when the chain payload is missing entirely', () => {
    const missingChainFailed = resolveVmChainDisplay(vmStatus({ status: 'failed', reason: 'unknown' }))
    expect(missingChainFailed.label).toBe('Failed')
    expect(missingChainFailed.healthy).toBe(false)

    const missingChainStarting = resolveVmChainDisplay(vmStatus({ status: 'starting' }))
    expect(missingChainStarting.label).toBe('Starting…')

    const missingChainNotFound = resolveVmChainDisplay(vmStatus({ status: 'not_found' }))
    expect(missingChainNotFound.label).toBe('Not running')
  })
})

describe('deferred VM assets', () => {
  test('idle pending assets describe the next start, not active startup', () => {
    expect(
      resolveVmChainDisplay(
        vmStatus({
          status: 'starting',
          readiness: 'pending',
          assetsRefreshPending: true,
          chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'idle' },
        })
      )
    ).toEqual({ label: 'Idle', detail: 'assets refresh on next start', healthy: true })
  })
})

describe('deferred refresh never hides active toolchain work', () => {
  test.each([
    ['installing', 'Installing packages'],
    ['running_setup', 'Running setup'],
    ['failed', 'Toolchain failed'],
  ] as const)('%s stays visible', (toolchain, label) => {
    expect(
      resolveVmChainDisplay(
        vmStatus({
          status: 'starting',
          assetsRefreshPending: true,
          toolchain: { status: toolchain, desiredFingerprint: 'x' },
        })
      )
    ).toMatchObject({ label, healthy: false })
  })
})

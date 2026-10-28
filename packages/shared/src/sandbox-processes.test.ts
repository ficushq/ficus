import { describe, expect, test } from 'bun:test'
import * as pressure from './sandbox-processes'
import type { SandboxPressure } from './sandbox-processes'

const quiet = { avg10: 0, avg60: 0, avg300: 0 }
const busyHost: SandboxPressure = {
  cpus: 8,
  load: [35.8, 30, 20],
  memTotalMb: 16000,
  memAvailableMb: 2000,
  box: { cpuPercent: 20, sampleMs: 1000, cpuPressureSome: quiet, memoryPressureSome: quiet },
}

describe('shared pressure attribution', () => {
  test('host-only load does not accuse this sandbox', () => {
    expect(pressure.sandboxPressureLabel(busyHost)).toBe('Host overloaded')
    expect(pressure.sandboxPressureDetail(busyHost)).toContain('Host busy with other boxes')
    expect(pressure.sandboxPressureDetail(busyHost)).toContain('20.0% CPU')
    expect(pressure.sandboxPressureDetail(busyHost)).toContain('CPU PSI some 0.0/0.0/0.0%')
    expect(pressure.isSandboxOverloaded(busyHost)).toBe(true)
  })
  test('local CPU or reclaim stalls identify this sandbox even on a quiet host', () => {
    for (const metric of ['cpuPressureSome', 'memoryPressureSome'] as const) {
      const local = {
        ...busyHost,
        load: [1, 1, 1] as [number, number, number],
        box: { ...busyHost.box!, [metric]: { ...quiet, avg10: 20 } },
      }
      expect(pressure.sandboxPressureLabel(local)).toBe('This sandbox overloaded')
      expect(pressure.hasSandboxPressureWarning(local)).toBe(true)
      expect(pressure.isSandboxOverloaded(local)).toBe(false)
      expect(pressure.sandboxPressureDetail(local)).not.toContain('other boxes')
    }
  })
  test('old or partial data remains unknown, with no inference about other boxes', () => {
    for (const box of [
      undefined,
      { ...busyHost.box!, cpuPressureSome: null },
      { ...busyHost.box!, cpuPercent: null },
    ]) {
      const p = { ...busyHost, box }
      expect(pressure.sandboxPressureLabel(p)).toBe('Host overloaded')
      expect(pressure.sandboxPressureDetail(p)).toContain('unavailable')
      expect(pressure.sandboxPressureDetail(p)).not.toContain('other boxes')
    }
    expect(pressure.sandboxPressureLabel({ ...busyHost, load: [1, 1, 1] })).toBeUndefined()
  })
})

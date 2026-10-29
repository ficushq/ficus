import { describe, expect, test } from 'bun:test'
import * as pressure from './sandbox-processes'
import type { SandboxPressure } from './sandbox-processes'

const quiet = { avg10: 0, avg60: 0, avg300: 0 }
const busyHost: SandboxPressure = {
  cpus: 8,
  load: [35.8, 30, 20],
  memTotalMb: 16000,
  memAvailableMb: 2000,
  box: {
    cpuPercent: 20,
    sampleMs: 1000,
    cpuPressureSome: { ...quiet, avg10: 65 },
    memoryPressureSome: quiet,
    cpuQuotaCpus: 4,
    cpuQuotaPercent: 5,
    cpuThrottledPeriods: 0,
    cpuThrottledUsec: 0,
    memoryHighEvents: 0,
    memoryMaxEvents: 0,
  },
}

describe('shared pressure attribution', () => {
  test('host-only load does not accuse this sandbox', () => {
    expect(pressure.sandboxPressureLabel(busyHost)).toBe('Host overloaded')
    expect(pressure.sandboxPressureDetail(busyHost)).toContain('Host busy with other boxes')
    expect(pressure.sandboxPressureDetail(busyHost)).toContain('20.0% CPU')
    expect(pressure.sandboxPressureDetail(busyHost)).toContain('CPU PSI some 65.0/0.0/0.0%')
    expect(pressure.isSandboxOverloaded(busyHost)).toBe(true)
  })
  test('CPU PSI and normal quota saturation alone do not blame the sandbox', () => {
    const calmHost = { ...busyHost, load: [1, 1, 1] as [number, number, number] }
    expect(pressure.hasSandboxPressureWarning(calmHost)).toBe(false)
    expect(
      pressure.hasSandboxPressureWarning({
        ...calmHost,
        box: { ...busyHost.box!, cpuQuotaPercent: 100, cpuThrottledPeriods: 2, cpuThrottledUsec: 10000 },
      })
    ).toBe(false)
  })
  test('quota saturation plus throttling on a busy host, or local reclaim, identify local pressure', () => {
    for (const box of [
      { ...busyHost.box!, cpuQuotaPercent: 98, cpuThrottledPeriods: 8, cpuThrottledUsec: 200000 },
      { ...busyHost.box!, memoryPressureSome: { ...quiet, avg10: 20 } },
      { ...busyHost.box!, memoryHighEvents: 12 },
      { ...busyHost.box!, memoryMaxEvents: 1 },
    ]) {
      const local = { ...busyHost, box }
      expect(pressure.sandboxPressureLabel(local)).toBe('This sandbox overloaded')
      expect(pressure.sandboxPressureDetail(local)).not.toContain('other boxes')
    }
    expect(pressure.sandboxPressureDetail(busyHost)).toContain('5.0% of 4 CPU quota')
  })
  test('old or partial data remains unknown, with no inference about other boxes', () => {
    for (const box of [
      undefined,
      { ...busyHost.box!, cpuPressureSome: null },
      { ...busyHost.box!, cpuPercent: null, cpuQuotaPercent: null },
      { ...busyHost.box!, cpuQuotaCpus: null, cpuQuotaPercent: null },
      { ...busyHost.box!, cpuThrottledPeriods: null },
    ]) {
      const p = { ...busyHost, box }
      expect(pressure.sandboxPressureLabel(p)).toBe('Host overloaded')
      expect(pressure.sandboxPressureDetail(p)).toContain('unavailable')
      expect(pressure.sandboxPressureDetail(p)).not.toContain('other boxes')
    }
    expect(pressure.sandboxPressureLabel({ ...busyHost, load: [1, 1, 1] })).toBeUndefined()
  })
})

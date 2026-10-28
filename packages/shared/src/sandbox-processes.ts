/** Runtime diagnostics, separate from executor liveness and asset setup; not a native Bash admission gate. */
export interface SandboxRuntimeHealth {
  status: 'ready' | 'degraded'
  /** Non-secret, human-readable control-path failure; absent when ready. */
  reason?: string
}

export interface SandboxPressureAverages {
  avg10: number
  avg60: number
  avg300: number
}

export interface SandboxBoxPressure {
  /** cpu.stat usage_usec delta; 100% means one CPU, not percent of the quota. */
  cpuPercent: number | null
  /** Actual monotonic counter window. Null when no counters can be sampled. */
  sampleMs: number | null
  /** cpu.max quota / period; null for max, unsupported or unavailable. */
  cpuQuotaCpus?: number | null
  /** Usage as a percentage of the stable quota during the sample. */
  cpuQuotaPercent?: number | null
  /** Counter deltas over sampleMs; null for unavailable/reset/stale counters. */
  cpuThrottledPeriods?: number | null
  cpuThrottledUsec?: number | null
  memoryHighEvents?: number | null
  memoryMaxEvents?: number | null
  cpuPressureSome: SandboxPressureAverages | null
  memoryPressureSome: SandboxPressureAverages | null
}

/** Load and memory a sandbox reports. On a shared VM host the load is machine-wide. */
export interface SandboxPressure {
  cpus: number
  /** 1, 5 and 15 minute load averages. */
  load: [number, number, number]
  memTotalMb: number
  memAvailableMb: number
  /** Own user or system box slice, including short-lived tasks; absent on older executors. */
  box?: SandboxBoxPressure
}

export interface SandboxProcess {
  pid: number
  ppid: number
  /** /proc stat starttime, echoed on signals to reject stale-row PID reuse. Absent on older executors. */
  startTicks?: number
  /** Current CPU use over a short sample, as a percentage of one CPU. */
  cpuPercent: number
  memRssMb: number
  ageSeconds: number
  state: string
  command: string
  /** Fresh server-side role/cgroup classification; infrastructure cannot be signalled. */
  protected: boolean
  protectionReason?: 'Runs the sandbox' | 'Docker runtime' | 'Box listener' | 'Session bus'
}

export interface SandboxContainer {
  id: string
  name: string
  image: string
  state: string
  status: string
  cpuPercent?: number
  memUsage?: string
}

export type SandboxContainers =
  { available: true; containers: SandboxContainer[] } | { available: false; reason: string }

export interface SandboxProcesses {
  pressure: SandboxPressure | null
  processes: SandboxProcess[]
  containers: SandboxContainers
}

export const SANDBOX_PROCESS_SIGNALS = ['TERM', 'INT', 'KILL'] as const
export type SandboxProcessSignal = (typeof SANDBOX_PROCESS_SIGNALS)[number]

/** CPU PSI describes stalls, not their cause. Normal quota-bound parallel work
 * alone is not an overload warning; on an overloaded host, near-quota usage plus
 * actual throttling identifies a quota-bound box. Reclaim is a separate signal.
 */
export function sandboxPressureLabel(
  pressure: SandboxPressure | null | undefined
): 'Host overloaded' | 'This sandbox overloaded' | undefined {
  if (!pressure) return undefined
  const box = pressure.box
  const reclaim =
    (box?.memoryPressureSome?.avg10 ?? 0) >= 10 || (box?.memoryHighEvents ?? 0) > 0 || (box?.memoryMaxEvents ?? 0) > 0
  const quotaBound =
    (box?.cpuQuotaPercent ?? 0) >= 90 && (box?.cpuThrottledPeriods ?? 0) > 0 && (box?.cpuThrottledUsec ?? 0) > 0
  if (reclaim || (isSandboxOverloaded(pressure) && quotaBound)) return 'This sandbox overloaded'
  if (isSandboxOverloaded(pressure)) return 'Host overloaded'
  return undefined
}

/** Warning eligibility includes host overload; the label supplies attribution. */
export function hasSandboxPressureWarning(pressure: SandboxPressure | null | undefined): boolean {
  return sandboxPressureLabel(pressure) !== undefined
}

/** Legacy host-load predicate used by fleet incident hysteresis. Not local attribution. */
export function isSandboxOverloaded(pressure: SandboxPressure | null | undefined): boolean {
  return !!pressure && pressure.load[0] >= pressure.cpus * 2
}

/** Shared CLI/header/panel wording. Missing metrics never imply an idle box. */
export function sandboxPressureDetail(pressure: SandboxPressure): string {
  const box = pressure.box
  const averages = (value: SandboxPressureAverages | null | undefined) =>
    value ? `${value.avg10.toFixed(1)}/${value.avg60.toFixed(1)}/${value.avg300.toFixed(1)}%` : 'unavailable'
  const cpu =
    box?.cpuPercent == null
      ? 'CPU unavailable'
      : `${box.cpuPercent.toFixed(1)}% CPU (100% = one CPU; ${((box.sampleMs ?? 0) / 1000).toFixed(2)}s sample)`
  const elsewhere =
    sandboxPressureLabel(pressure) === 'Host overloaded' &&
    box?.cpuPercent != null &&
    box.cpuQuotaCpus != null &&
    box.cpuQuotaCpus > 0 &&
    box.cpuQuotaPercent != null &&
    box.cpuQuotaPercent < 50 &&
    box.cpuThrottledPeriods === 0 &&
    box.cpuThrottledUsec === 0 &&
    (box.cpuPressureSome?.avg10 ?? 0) >= 10 &&
    box.memoryPressureSome != null &&
    box.memoryHighEvents === 0 &&
    box.memoryMaxEvents === 0
  const quota =
    box?.cpuQuotaPercent == null || box.cpuQuotaCpus == null
      ? 'quota usage unavailable'
      : `${box.cpuQuotaPercent.toFixed(1)}% of ${box.cpuQuotaCpus} CPU quota`
  const count = (value: number | null | undefined) => (value == null ? 'unavailable' : String(value))
  return (
    `This sandbox: ${cpu} · ${quota} · CPU PSI some ${averages(box?.cpuPressureSome)} · Memory PSI some ${averages(box?.memoryPressureSome)} (10/60/300s) · Quota throttling ${count(box?.cpuThrottledPeriods)} periods / ${count(box?.cpuThrottledUsec)} µs · Memory events high/max ${count(box?.memoryHighEvents)}/${count(box?.memoryMaxEvents)} (sample deltas)` +
    (elsewhere
      ? ' · Host busy with other boxes; this sandbox is stalled below its quota without quota throttling.'
      : '')
  )
}

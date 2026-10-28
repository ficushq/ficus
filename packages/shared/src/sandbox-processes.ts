/** Runtime diagnostics, separate from executor liveness and asset setup; not a native Bash admission gate. */
export interface SandboxRuntimeHealth {
  status: 'ready' | 'degraded'
  /** Non-secret, human-readable control-path failure; absent when ready. */
  reason?: string
}

/** Load and memory a sandbox reports. On a shared VM host the load is machine-wide. */
export interface SandboxPressure {
  cpus: number
  /** 1, 5 and 15 minute load averages. */
  load: [number, number, number]
  memTotalMb: number
  memAvailableMb: number
}

export interface SandboxProcess {
  pid: number
  ppid: number
  /** Current CPU use over a short sample, as a percentage of one CPU. */
  cpuPercent: number
  memRssMb: number
  ageSeconds: number
  state: string
  command: string
  /** The sandbox server itself, its ancestors, and the user manager cannot be signalled. */
  protected: boolean
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
  | { available: true; containers: SandboxContainer[] }
  | { available: false; reason: string }

export interface SandboxProcesses {
  pressure: SandboxPressure | null
  processes: SandboxProcess[]
  containers: SandboxContainers
}

export const SANDBOX_PROCESS_SIGNALS = ['TERM', 'INT', 'KILL'] as const
export type SandboxProcessSignal = (typeof SANDBOX_PROCESS_SIGNALS)[number]

/**
 * A sandbox is overloaded when its one-minute load is at least twice its CPU
 * count: commands queue long enough that toolchain checks and agent tool calls
 * time out.
 */
export function isSandboxOverloaded(pressure: SandboxPressure | null | undefined): boolean {
  return !!pressure && pressure.load[0] >= pressure.cpus * 2
}

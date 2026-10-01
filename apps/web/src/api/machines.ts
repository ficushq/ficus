import { apiFetch } from './client'

/**
 * Probed host capabilities, stamped at bootstrap. All fields optional — a
 * freshly-registered (un-bootstrapped) machine reports `{}`.
 */
export interface MachineCapabilities {
  arch?: string
  cpus?: number
  memMb?: number
  diskGb?: number
  docker?: 'rootless' | 'rootful' | 'none'
  kernel?: string
  forwarding?: 'yes' | 'no' | 'unknown'
  // Shared per-machine browser availability (browser-tools-in-sandbox spec §4.1):
  // `available` when Chromium's sandbox is on and the ficus-browser service is
  // live, `unavailable` (with a `browserReason` token) when the host cannot
  // sandbox it — browsing is then off but the machine still runs. Absent on a
  // machine bootstrapped before this field existed. Mirror of the server's
  // MachineCapabilities (apps/core/src/db/schema.ts).
  browser?: 'available' | 'unavailable'
  browserReason?: string
}

/**
 * A machine's packer utilization: capacity units its boxes consume against the
 * flat per-VM unit capacity placement weighs against. Mirrors the server's
 * `machineUtilization` (shared with the placement packer, so UI and placement
 * report identical numbers).
 */
export interface MachineUtilization {
  unitsUsed: number
  unitCapacity: number
}

/**
 * A machine as returned by the API (`toPublicMachine`): the full row minus the
 * internal `sshKeyId` secret-store handle, plus a derived `utilization`. Dates
 * arrive JSON-serialized as ISO strings.
 */
export interface Machine {
  id: string
  name: string
  provider: string // 'ssh' | 'exe'
  providerRef: string | null
  sshHost: string
  sshPort: number
  sshUser: string
  sshPublicKey: string
  status: string // 'registered' | 'bootstrapping' | 'ready' | 'unreachable' | 'parked' | 'reaping' | 'terminated'
  capabilities: MachineCapabilities
  scope: string // 'shared' | 'dedicated'
  purpose: string // 'shared' | 'squad' | 'commons' | 'dedicated'
  squadId: string | null
  egressPolicy: boolean
  bootstrapVersion: string | null
  /** The last bootstrap failure's stderr tail, stamped alongside
   *  status='unreachable'; cleared (null) on the next successful bootstrap. */
  lastError: string | null
  /** Content hashes of the artifacts synced to the machine, keyed by name
   *  (e.g. `{ server: 'abc1234', cli: '…' }`). Empty on an un-synced machine. */
  artifactVersions: Record<string, string>
  /** Packer utilization derived by the server from this machine's boxes. */
  utilization: MachineUtilization
  lastSeenAt: string | null
  createdAt: string
}

/** A sandbox "box" (unix user + port) hosted on a machine. */
export interface MachineBox {
  sandboxId: string
  machineId: string
  unixUser: string
  port: number
  status: string // 'ensuring' | 'ready' | 'stopped' | 'orphaned'
  updatedAt: string
}

/** Machine detail (GET /machines/:id): the machine plus its hosted boxes. */
export interface MachineDetail extends Machine {
  boxes: MachineBox[]
}

/** Register a BYO-SSH endpoint (default provider). */
export interface RegisterSshMachineInput {
  name: string
  provider?: 'ssh'
  sshHost: string
  sshPort?: number
  sshUser: string
  scope?: 'shared' | 'dedicated'
  egressPolicy?: boolean
}

/** Provision a fresh exe.dev VM (requires the exe.dev token secret to be set). */
export interface RegisterExeMachineInput {
  name: string
  provider: 'exe'
  scope?: 'shared' | 'dedicated'
  egressPolicy?: boolean
}

export type RegisterMachineInput = RegisterSshMachineInput | RegisterExeMachineInput

export async function listMachines(): Promise<Machine[]> {
  return apiFetch<Machine[]>('/machines')
}

export async function getMachine(id: string): Promise<MachineDetail> {
  return apiFetch<MachineDetail>(`/machines/${id}`)
}

export async function registerMachine(body: RegisterMachineInput): Promise<Machine> {
  return apiFetch<Machine>('/machines', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function bootstrapMachine(id: string): Promise<Machine> {
  return apiFetch<Machine>(`/machines/${id}/bootstrap`, { method: 'POST' })
}

export async function checkMachine(id: string): Promise<Machine> {
  return apiFetch<Machine>(`/machines/${id}/check`, { method: 'POST' })
}

export async function deleteMachine(id: string): Promise<void> {
  await apiFetch(`/machines/${id}`, { method: 'DELETE' })
}

/**
 * Pin an agent's box to a machine (or unpin with `null`) and drive the migration
 * now. Hits POST /api/agents/:id/machine (machines:write).
 */
export async function setAgentMachine(agentId: string, machineId: string | null): Promise<void> {
  await apiFetch(`/agents/${agentId}/machine`, {
    method: 'POST',
    body: JSON.stringify({ machineId }),
  })
}

/**
 * Pin a squad's box to a machine (or unpin with `null`) and drive the migration
 * now. Hits POST /api/squads/:id/machine (machines:write).
 */
export async function setSquadMachine(squadId: string, machineId: string | null): Promise<void> {
  await apiFetch(`/squads/${squadId}/machine`, {
    method: 'POST',
    body: JSON.stringify({ machineId }),
  })
}

/** Why a box migrate was refused (or failed). Mirrors the server's `MigrateReason`. */
export type MigrateReason =
  | 'already-on-target'
  | 'active-turn'
  | 'squad-box'
  | 'provision-failed'
  | 'archive-failed'
  | 'restore-failed'
  | 'unhealthy'
  | 'repoint-conflict'
  | 'box-not-found'
  | 'machine-not-ready'
  | 'failed'

/**
 * Result of a single box migrate. A refused move is a 200 with `moved: false`
 * and a structured `reason` — not an error — so the caller decides what to do.
 */
export interface MigrateResult {
  moved: boolean
  reason?: MigrateReason
  activeExecutionCount?: number
}

/** One planned box move in a rebalance plan. `toMachineId` may be a synthetic
 *  `provision:<n>` group id (no existing VM fits) rather than a real machine. */
export interface RebalanceMove {
  sandboxId: string
  fromMachineId: string
  toMachineId: string
}

/**
 * The fleet re-pack plan (and, for a real execute, its per-move results).
 * Mirrors the server's `RebalancePlan & { results }`. A `dryRun` returns the
 * plan with an empty `results`.
 */
export interface RebalancePlan {
  moves: RebalanceMove[]
  /** Boxes whose migrate a live turn refused (`active-turn`). */
  skippedActive: string[]
  /** Evacuees with no fitting VM and no cap headroom to provision one. */
  unplaceable: string[]
  /** Machines left violating an invariant no legal move can fix (e.g. two squad
   *  boxes sharing a VM). Surfaced so a dry run over an unhealable fleet doesn't
   *  read as balanced. */
  unresolvable: string[]
  /** Per-move outcomes; empty for a dry run. `targetMachineId` is the real
   *  machine the move landed on (absent when its provisioning failed). */
  results: Array<{ sandboxId: string; result: MigrateResult; targetMachineId?: string }>
}

/**
 * Re-pack the shared fleet. `dryRun` returns the plan with no effects; without
 * it the plan executes and `results` carries each move's outcome. Hits
 * POST /api/machines/rebalance (machines:write); a concurrent execute 409s.
 */
export async function rebalanceFleet(opts: { dryRun?: boolean } = {}): Promise<RebalancePlan> {
  return apiFetch<RebalancePlan>('/machines/rebalance', {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}

/**
 * Move one sandbox box onto `targetMachineId` (the TARGET machine — `:id`).
 * Hits POST /api/machines/:id/migrate-box (machines:write). A refused move
 * returns `{ moved: false, reason }` (still a 200).
 */
export async function migrateBox(
  targetMachineId: string,
  sandboxId: string,
  fetch: typeof apiFetch = apiFetch
): Promise<MigrateResult> {
  return fetch<MigrateResult>(`/machines/${targetMachineId}/migrate-box`, {
    method: 'POST',
    body: JSON.stringify({ sandboxId }),
  })
}

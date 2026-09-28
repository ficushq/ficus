import { randomUUID } from 'crypto'
import { InflightDeduper } from '../../lib/infra/inflight'
import { createLogger } from '../../lib/infra/logger'
import { bootstrapMachine as bootstrapMachineReal } from './bootstrap'
import { getMachineProvider } from './provider'
import type { MachineProvider } from './provider'
import { EXE_PROVIDER_SSH_KEY } from './provider-credentials'
import { registerBuiltinMachineProviders } from './providers'
import {
  countMachines as countMachinesReal,
  deleteMachine as deleteMachineReal,
  getMachine as getMachineReal,
  getMachineBox as getMachineBoxReal,
  getMachineByName as getMachineByNameReal,
  insertMachine as insertMachineReal,
  queryReadySharedMachineLoads as queryReadySharedMachineLoadsReal,
  queryReadySharedMachines as queryReadySharedMachinesReal,
} from './queries'
import type { Machine, MachineBox } from './queries'

const log = createLogger('placement')

/**
 * In-process single-flight for provision+insert, keyed by machine NAME. Concurrent
 * callers for the same name (a same-box `dedicated` provisioning race — names are
 * deterministic there) share the ONE provision+insert and its result, so the race
 * never bills two VMs. Different names (the packer's random pool names) never share
 * a key, so shared-pool overflow still provisions independently (mild, intentional
 * over-provision — see the race-safety note above). Module-scoped so every
 * placement in this worker joins the same in-flight run; the entry clears when it
 * settles. See {@link provisionCapped}.
 */
const provisionInflight = new InflightDeduper<Machine>()

/**
 * Placement policy — the role/scope-aware decision of WHICH machine a box lands
 * on, and when to auto-provision a new one (VM machines design §7, B2 packer):
 *
 *  | Context                        | Placement                                    |
 *  |--------------------------------|----------------------------------------------|
 *  | BYO SSH (no cloud provider)    | everything on the least-loaded shared machine|
 *  | exe, any box (squad / agent /  | best-fit unit-packed onto the fullest ready  |
 *  | system-manager)                | shared VM with room; new VM when none fits   |
 *  | `dedicated` on any box         | its own freshly provisioned exe VM           |
 *
 * The packer is deliberately DUMB: each box weighs a fixed role-based unit count
 * ({@link unitWeightForRole}) against a flat per-VM capacity
 * ({@link resolveMachineUnitCapacity}). No affinity, limits, requests, or
 * rebalancing — tenants that need hard isolation or resource guarantees escalate
 * to the k8s runtime instead of a smarter packer. Co-locating boxes across trust
 * domains is safe because every box has its own unix user and per-box
 * EXECUTOR_AUTH_TOKEN (sandbox-auth hardening).
 *
 * This module is deliberately effect-free at its edges: every DB query, the exe
 * provider lookup, and the provision+bootstrap step are injected (defaulting to
 * production), so the whole policy is unit-testable against fakes with no live
 * machine, cloud account, or DB.
 *
 * ## Provisioning race-safety (name-keyed dedupe, two layers)
 * Provisioning is a check-then-act: count the fleet against the cap, look for a
 * shared machine with room, and provision on the miss. These calls are NOT
 * serialized per tenant — VmSandboxManager's InflightDeduper keys on sandboxId, so
 * two DIFFERENT boxes interleave across the load-query await and can both reach
 * the provision step. Two placements racing to provision the SAME name would each
 * bill a VM, so {@link provisionCapped} dedupes on name in two layers:
 *
 *  1. IN-PROCESS: a name-keyed single-flight ({@link provisionInflight}) — same-name
 *     callers in this worker share the ONE provision+insert and its result.
 *  2. CROSS-PROCESS: the `machines.name` UNIQUE constraint. Because provision runs
 *     BEFORE insert, the loser's own VM is already terminated by
 *     defaultProvisionMachine's failed-insert cleanup; provisionCapped then ADOPTS
 *     the winner's row (re-fetched by name) instead of failing. If the winner's
 *     provision failed too (its cleanup deleted the row), the loser retries once.
 *
 * Dedicated machines keep deterministic names (exe-ded-<sandboxId>), so a same-box
 * race dedupes/adopts. Packed shared machines use RANDOM names (exe-<8hex>): two
 * concurrent overflow placements carry different keys and provision two VMs — both
 * valid members of the shared pool that subsequent placements pack onto (mild
 * over-provision, never a leak; the name index still catches the astronomically
 * unlikely random collision the same way). A future multi-worker deployment would
 * additionally need an advisory lock around the cap check, which concurrent
 * provisions can otherwise overshoot by the concurrency count.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** No machine is available to host the box (none registered/ready, or an
 *  explicit machine is missing or not yet ready). Thrown by the BYO/explicit
 *  paths; re-exported from box-manager for backward compatibility. */
export class MachineUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MachineUnavailableError'
  }
}

/** A `dedicated` box was requested but no cloud provider is configured, so tau
 *  cannot provision a VM for it (BYO-SSH machines are registered, not
 *  provisioned). Distinct from the cap error: the capability is absent, not
 *  exhausted. */
export class DedicatedPlacementUnavailableError extends Error {
  constructor(message = 'dedicated placement requires a cloud provider') {
    super(message)
    this.name = 'DedicatedPlacementUnavailableError'
  }
}

/** Provisioning a new machine would exceed the fleet cap (`FICUS_MAX_MACHINES`).
 *  Refused loudly rather than silently over-provisioning. */
export class MachineProvisioningCapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MachineProvisioningCapError'
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The box roles placement weighs and packs. */
export type PlacementRole = 'squad' | 'agent' | 'system-manager'

export interface PlacementRequest {
  sandboxId: string
  role: PlacementRole
  /** The squad this box belongs to. Carried by callers for context only — the
   *  B2 packer no longer keys placement on it (squad-per-VM is gone). */
  squadId?: string
  /** Pin to a specific machine (must be `ready`); short-circuits all policy. */
  explicitMachineId?: string | null
  /** Provision an isolated VM for this box alone (own-VM dial). */
  dedicated?: boolean
}

/** What a provision request needs: the new machine's name and its placement
 *  purpose/scope. `shared` machines join the packed pool; `dedicated` ones host
 *  exactly one box. */
export interface ProvisionMachineOpts {
  name: string
  purpose: 'shared' | 'dedicated'
  scope?: 'shared' | 'dedicated'
}

/** All external effects, injectable for tests; each defaults to production. */
export interface PlacementDeps {
  getMachine?: (id: string) => Promise<Machine | null>
  /** Re-fetch a machine by its unique name — the cross-process adopt-the-winner
   *  lookup after a provision loses the `machines.name` UNIQUE race. */
  getMachineByName?: (name: string) => Promise<Machine | null>
  getMachineBox?: (sandboxId: string) => Promise<MachineBox | null>
  queryReadySharedMachines?: () => Promise<Array<{ machine: Machine; boxCount: number }>>
  /** The packer's load input: every ready shared machine with its hosted box
   *  sandboxIds (weighed in placement, not SQL). */
  queryReadyMachineLoads?: () => Promise<Array<{ machine: Machine; boxSandboxIds: string[] }>>
  countMachines?: () => Promise<number>
  /** The exe provider if a cloud account is configured, else null (BYO-only).
   *  May be async: the production default re-registers providers first (self-heal
   *  for creds configured after boot). */
  getExeProvider?: () => MachineProvider | null | Promise<MachineProvider | null>
  /** Provision + bootstrap a new machine, returning a `ready` row. */
  provisionMachine?: (opts: ProvisionMachineOpts) => Promise<Machine>
  /** Fleet cap; defaults to `FICUS_MAX_MACHINES` (or {@link DEFAULT_MAX_MACHINES}). */
  maxMachines?: number
}

/** Default fleet cap when `FICUS_MAX_MACHINES` is unset/invalid.
 *
 *  This bounds PEAK-CONCURRENT VMs, not steady state: the empty-machine reaper
 *  (machine-reaper.ts) terminates drained auto-provisioned VMs after the idle
 *  grace, so the fleet shrinks back on its own. 50 gives the squad=full-VM
 *  default economics headroom (a squad-heavy tenant needs roughly one VM per
 *  squad plus packed agent VMs); exe.dev's own per-account limit is the real
 *  backstop behind it. Override with `FICUS_MAX_MACHINES`. */
export const DEFAULT_MAX_MACHINES = 50

// ---------------------------------------------------------------------------
// Unit weights + machine capacity (packed shared pool)
// ---------------------------------------------------------------------------

/**
 * Default per-role unit weights when the FICUS_UNIT_WEIGHT_* envs are unset/invalid.
 *
 * The squad default deliberately EQUALS {@link DEFAULT_MACHINE_UNIT_CAPACITY}:
 * out of the box a squad box fills a whole VM (free drops to 0), so no other box
 * ever packs onto a squad's VM and two squads never share — squads are
 * effectively VM-exclusive under the packer, while agents and system-managers
 * (weight 1) pack 10 to a VM. Operators can re-enable squad co-tenancy by
 * overriding the envs.
 */
export const DEFAULT_UNIT_WEIGHTS: Record<PlacementRole, number> = {
  squad: 10,
  agent: 1,
  'system-manager': 1,
}

/** Default units one shared VM holds when `FICUS_MACHINE_UNIT_CAPACITY` is unset/invalid. */
export const DEFAULT_MACHINE_UNIT_CAPACITY = 10

const UNIT_WEIGHT_ENV: Record<PlacementRole, string> = {
  squad: 'FICUS_UNIT_WEIGHT_SQUAD',
  agent: 'FICUS_UNIT_WEIGHT_AGENT',
  'system-manager': 'FICUS_UNIT_WEIGHT_SYSTEM_MANAGER',
}

/** Positive-integer env override, else the default (same rule as FICUS_MAX_MACHINES).
 *  Exported for the sibling machine modules with the same env convention (e.g.
 *  the empty-machine reaper's FICUS_MACHINE_IDLE_GRACE_MS). */
export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** How many capacity units a box of this role consumes on a shared VM. */
export function unitWeightForRole(role: PlacementRole): number {
  return positiveIntEnv(UNIT_WEIGHT_ENV[role], DEFAULT_UNIT_WEIGHTS[role])
}

/** How many units one shared VM holds. */
export function resolveMachineUnitCapacity(): number {
  return positiveIntEnv('FICUS_MACHINE_UNIT_CAPACITY', DEFAULT_MACHINE_UNIT_CAPACITY)
}

let warnedUnknownSandboxIdPrefix = false

/**
 * Weigh a HOSTED box by its sandboxId prefix (`squad_` / `system_manager_` /
 * `agent_` — the vm manager's roleFromSandboxId convention). An unknown prefix
 * counts as the agent default and warns once — placement must keep working even
 * if a row predates or escapes the naming convention.
 */
export function unitWeightForSandboxId(sandboxId: string): number {
  if (sandboxId.startsWith('squad_')) return unitWeightForRole('squad')
  if (sandboxId.startsWith('system_manager_')) return unitWeightForRole('system-manager')
  if (!sandboxId.startsWith('agent_') && !warnedUnknownSandboxIdPrefix) {
    warnedUnknownSandboxIdPrefix = true
    log.warn(`unknown sandboxId prefix for unit weighting (${sandboxId}); counting it as agent weight`)
  }
  return unitWeightForRole('agent')
}

/** A machine's packer load: units currently consumed by its boxes, against the
 *  flat per-VM unit capacity the packer weighs against. */
export interface MachineUtilization {
  unitsUsed: number
  unitCapacity: number
}

/**
 * Read-only utilization of a machine from the boxes it hosts — the SAME numbers
 * {@link resolvePacked} weighs placement against ({@link unitWeightForSandboxId}
 * per box vs {@link resolveMachineUnitCapacity}). Exported so the machines API /
 * UI report exactly what placement decides against and the two can never drift
 * onto separate weight tables. Effect-free: give it the machine's box rows (only
 * `sandboxId` is read).
 */
export function machineUtilization(boxes: ReadonlyArray<{ sandboxId: string }>): MachineUtilization {
  return {
    unitsUsed: boxes.reduce((used, b) => used + unitWeightForSandboxId(b.sandboxId), 0),
    unitCapacity: resolveMachineUnitCapacity(),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the exe provider from the registry, or null when none is registered
 * (no exe.dev key configured ⇒ BYO-only). The registry throws on a miss, which
 * this maps to null so "is a cloud provider available?" is a plain boolean check.
 *
 * SELF-HEAL: re-register the built-in providers before the lookup. The provider
 * registry is the one machine-config surface snapshotted into long-lived module
 * state (a Map) rather than read fresh per use — so an exe account key configured
 * AFTER the process booted (deploy → boot → set creds) would otherwise never be
 * picked up without a restart. Re-registering here reads the key fresh from the
 * secret store (whose cache the worker refreshes on its own interval), so
 * placement converges on its own once the key lands — no restart. This mirrors
 * the identical on-demand re-register the api performs before provisioning
 * (routes/machines.ts) and the point-of-use freshness AI credentials already
 * have. Idempotent (registration overwrites the same entries) and never throws
 * when no key is set.
 */
export async function defaultGetExeProvider(
  register: () => Promise<void> = registerBuiltinMachineProviders
): Promise<MachineProvider | null> {
  try {
    await register()
  } catch {
    // Best-effort: fall through to whatever is already registered.
  }
  try {
    return getMachineProvider('exe')
  } catch {
    return null
  }
}

function resolveMaxMachines(deps: PlacementDeps): number {
  if (deps.maxMachines !== undefined) return deps.maxMachines
  return positiveIntEnv('FICUS_MAX_MACHINES', DEFAULT_MAX_MACHINES)
}

/**
 * External effects of {@link defaultProvisionMachine}, injectable for tests; each
 * defaults to the production implementation (see {@link realProvisionDeps}). Kept
 * separate from {@link PlacementDeps} because this is the provision path's own
 * seam — the policy tests inject a whole fake `provisionMachine` instead.
 */
export interface DefaultProvisionDeps {
  getProvider: (key: string) => MachineProvider
  insertMachine: typeof insertMachineReal
  bootstrapMachine: typeof bootstrapMachineReal
  getMachine: typeof getMachineReal
  deleteMachine: typeof deleteMachineReal
}

const realProvisionDeps: DefaultProvisionDeps = {
  getProvider: getMachineProvider,
  insertMachine: insertMachineReal,
  bootstrapMachine: bootstrapMachineReal,
  getMachine: getMachineReal,
  deleteMachine: deleteMachineReal,
}

/**
 * The default provision path a placement decision runs when it must create a new
 * machine: ask the exe provider to provision a VM, insert the machine row, then
 * bootstrap it so it returns `ready` — mirroring exactly what a human
 * register+bootstrap does, because a box can only land on a bootstrapped machine
 * (`ensureBox → ensureMachineArtifacts` needs `/opt/tau` present). Placement therefore
 * hands the CALLER a machine that is ready to host, not a bare `registered` row.
 *
 * ASSUMPTION — auto-provision ⇒ exe ⇒ account key. Auto-provision only fires when
 * the exe provider is available (BYO machines are registered, never provisioned),
 * so the machine created here is ALWAYS an exe VM. exe.dev authenticates SSH
 * against the ACCOUNT-registered key only (live recon 2026-07-13) — a per-machine
 * key placed in a VM's authorized_keys is rejected — so the account key already
 * reaches every VM. We therefore mint NO per-machine keypair, thread no public key
 * into `provision` (mirrors the POST /api/machines exe branch), and record the
 * shared account-key secret ({@link EXE_PROVIDER_SSH_KEY}) as the row's ssh
 * identity with an empty public-key column. A FUTURE provider that needs its own
 * per-machine key (e.g. hcloud) must branch here on provider type and generate one.
 *
 * Failed-provision cleanup: once `provision()` returns, the VM is BILLED. If the
 * row insert OR bootstrap then fails, we terminate that VM (best-effort, logged)
 * and delete any row we inserted before rethrowing. Otherwise the unreachable VM
 * lingers unusable (findReady* skip it), the next placement provisions a fresh one,
 * and the fleet compounds toward its cap; a post-provision insert failure would
 * leave the VM with no row at all (an invisible paid orphan). NO secret is dropped
 * on cleanup: exe machines share EXE_PROVIDER_SSH_KEY (every VM references it), so
 * deleting it would break SSH to all the tenant's other exe VMs, and there is no
 * per-machine secret to orphan.
 *
 * Exercised end-to-end by the gated exe integration test (slice 5 Task 4); the
 * policy tests inject a fake `provisionMachine`.
 */
export async function defaultProvisionMachine(
  opts: ProvisionMachineOpts,
  deps: DefaultProvisionDeps = realProvisionDeps
): Promise<Machine> {
  const machineId = randomUUID()
  const provider = deps.getProvider('exe')
  const provisioned = await provider.provision({
    name: opts.name,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  })

  // The VM is now BILLED. Everything below is wrapped so a failure at insert or
  // bootstrap terminates it and drops any inserted row before rethrowing.
  const insertValues = {
    id: machineId,
    name: opts.name,
    provider: 'exe' as const,
    providerRef: provisioned.providerRef,
    sshHost: provisioned.sshHost,
    sshPort: provisioned.sshPort,
    // The provider decides the SSH login (exe returns 'exedev').
    sshUser: provisioned.sshUser,
    // Shared account-key secret is the row's ssh identity; exe VMs carry no
    // per-machine public key (the NOT NULL column takes an empty string).
    sshKeyId: EXE_PROVIDER_SSH_KEY,
    sshPublicKey: '',
    status: 'registered' as const,
    purpose: opts.purpose,
    // Mark the row as tau-created: the empty-machine reaper only ever terminates
    // auto-provisioned VMs. User-registered machines (BYO SSH, and operator
    // exe-provisions via POST /api/machines, which are otherwise row-identical
    // to packer VMs) keep the column's false default and are never auto-reaped.
    autoProvisioned: true,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  }
  let inserted: Machine | undefined
  try {
    inserted = await deps.insertMachine(insertValues)
    // Bootstrap so a box can land immediately (a `registered` machine has no
    // /opt/tau server bundle root yet). bootstrapMachine stamps the row `ready`.
    await deps.bootstrapMachine(inserted)
    const ready = await deps.getMachine(inserted.id)
    if (!ready) throw new Error(`provisioned machine ${inserted.id} vanished after bootstrap`)
    return ready
  } catch (err) {
    // Best-effort rollback of the billed VM + any row it got — log failures, never
    // mask the original cause. If insert never returned a row, terminate off the
    // provisioned endpoint directly (the exe provider only needs the providerRef).
    await provider.terminate(inserted ?? (insertValues as unknown as Machine)).catch((termErr) => {
      log.warn(`failed to terminate VM after failed provision of ${opts.name}: ${String(termErr)}`)
    })
    if (inserted) {
      const rowId = inserted.id
      await deps.deleteMachine(rowId).catch((delErr) => {
        log.warn(`failed to delete row ${rowId} after failed provision of ${opts.name}: ${String(delErr)}`)
      })
    }
    // No secret to drop: the exe path minted none, and the shared account key
    // (EXE_PROVIDER_SSH_KEY) is referenced by every other exe VM — never delete it.
    throw err
  }
}

/** True for the `machines.name` UNIQUE-index conflict as the postgres-js driver
 *  surfaces it: SQLSTATE 23505 (unique_violation) on `machines_name_unique`. The
 *  driver rethrows this verbatim through drizzle's insert; the exact shape is
 *  pinned by a real-DB test (queries.test.ts). The `machines` insert has no other
 *  unique constraint, so 23505 alone is decisive — the constraint-name check is a
 *  belt-and-braces guard against a future one. */
function isUniqueNameViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: unknown; constraint_name?: unknown }
  if (e.code !== '23505') return false
  return e.constraint_name === undefined || e.constraint_name === 'machines_name_unique'
}

/**
 * Run the injected provision, but on a lost `machines.name` UNIQUE race adopt the
 * winner's row instead of failing. Provision runs BEFORE insert (see
 * {@link defaultProvisionMachine}), so a losing provision's own VM is already
 * terminated by its failed-insert cleanup — there is no orphan to reap here, only
 * a winner to adopt. If the winner's row is gone (its provision failed and its
 * cleanup deleted it), retry ONCE from scratch (the name is free again); a second
 * miss rethrows. Non-unique errors propagate untouched.
 */
async function provisionOrAdopt(deps: PlacementDeps, opts: ProvisionMachineOpts, retried = false): Promise<Machine> {
  const provision = deps.provisionMachine ?? defaultProvisionMachine
  try {
    const machine = await provision(opts)
    log.info(`Provisioned ${opts.purpose} machine ${machine.id} (${opts.name})`)
    return machine
  } catch (err) {
    if (!isUniqueNameViolation(err)) throw err
    const winner = await (deps.getMachineByName ?? getMachineByNameReal)(opts.name)
    if (winner) {
      log.info(`Adopted machine ${winner.id} (${opts.name}) after losing the provision race for its name`)
      return winner
    }
    if (retried) throw err
    log.info(`Provision race for ${opts.name} left no winner row (winner failed); retrying once`)
    return provisionOrAdopt(deps, opts, true)
  }
}

/** Provision a machine only if the fleet cap allows it. The count-then-provision
 *  can be overshot by concurrent placements (see the race-safety note at the module
 *  head); the name-keyed dedupe still prevents duplicate machines. Concurrent
 *  same-name callers share the ONE provision via {@link provisionInflight}, and a
 *  cross-process loser adopts the winner ({@link provisionOrAdopt}). Exported for
 *  the manual-rebalance loop (rebalance.ts), which resolves its plan's `'provision'`
 *  targets through the exact same cap gate. */
export async function provisionCapped(deps: PlacementDeps, opts: ProvisionMachineOpts): Promise<Machine> {
  const count = await (deps.countMachines ?? countMachinesReal)()
  const max = resolveMaxMachines(deps)
  if (count >= max) {
    throw new MachineProvisioningCapError(
      `machine provisioning cap reached (${count}/${max}); refusing to provision a new ${opts.purpose} machine ` +
        `— raise FICUS_MAX_MACHINES or free a machine`
    )
  }
  return provisionInflight.run(opts.name, () => provisionOrAdopt(deps, opts))
}

/** The BYO/least-loaded default path — byte-identical to the pre-slice-5
 *  resolveMachineForBox: sole ready shared machine, else least-loaded with a
 *  deterministic (createdAt, id) tie-break; zero ready shared machines is an
 *  error. */
async function resolveLeastLoaded(deps: PlacementDeps): Promise<Machine> {
  const query = deps.queryReadySharedMachines ?? queryReadySharedMachinesReal
  const rows = await query()
  if (rows.length === 0) throw new MachineUnavailableError('no ready shared machine registered')
  if (rows.length === 1) return rows[0].machine

  const sorted = [...rows].sort(
    (a, b) =>
      a.boxCount - b.boxCount ||
      a.machine.createdAt.getTime() - b.machine.createdAt.getTime() ||
      (a.machine.id < b.machine.id ? -1 : a.machine.id > b.machine.id ? 1 : 0)
  )
  return sorted[0].machine
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Deterministic per box: a same-box provisioning race loses on the unique name. */
function dedicatedMachineName(sandboxId: string): string {
  return `exe-ded-${sandboxId}`
}

/** Random: pool members carry no identity key (see the race note at module head).
 *  Exported for the rebalance loop, whose provisioned evacuation targets join the
 *  same packed shared pool. */
export function packedMachineName(): string {
  return `exe-${randomUUID().replaceAll('-', '').slice(0, 8)}`
}

// ---------------------------------------------------------------------------
// resolvePacked — the B2 best-fit unit packer
// ---------------------------------------------------------------------------

/**
 * Pack the box onto the fullest ready shared VM that still has room, else
 * provision a new one (subject to the fleet cap).
 *
 * Best-fit: compute each machine's used units (Σ {@link unitWeightForSandboxId}
 * over its hosted boxes) and pick the eligible machine (free ≥ incoming) with the
 * SMALLEST free capacity, tie-broken deterministically by (createdAt, id) like
 * resolveLeastLoaded. Reusing an existing machine is never cap-blocked.
 *
 * Over-capacity guard: a box whose role weight exceeds the machine capacity can
 * never fit anywhere, including a fresh empty VM — it still gets a fresh VM to
 * itself (warned) rather than an error or a loop; the over-full VM simply never
 * becomes eligible again.
 *
 * MIGRATION — legacy purpose-keyed VMs: pre-packer fleets carry `purpose='squad'`
 * (exe-sq-<squadId>) and `purpose='commons'` (exe-commons) machines. The load
 * query filters to `purpose='shared'`, so the packer neither reuses nor provisions
 * them: their existing boxes stay put via the sticky step, and new boxes pack onto
 * (possibly one-time extra) fresh shared VMs. NOTE that a legacy VM does NOT drain
 * merely because its boxes stop — `stopBox` PARKS a box and keeps its
 * `machine_boxes` row, and the sticky step wakes it on the same VM. The rows are
 * deleted only when the boxes' OWNERS terminate/archive (removeBox on explicit
 * teardown, or the orphan reconciler), and once the last row is gone the emptied
 * legacy VM is reclaimed by the empty-machine reaper (machine-reaper.ts) after the
 * idle grace, like any other drained auto-provisioned VM. Deliberate — mixing
 * packed boxes onto squad-keyed VMs would muddy their reuse/reaping semantics for
 * no benefit.
 */
async function resolvePacked(req: PlacementRequest, deps: PlacementDeps): Promise<Machine> {
  const incoming = unitWeightForRole(req.role)
  const capacity = resolveMachineUnitCapacity()

  const rows = await (deps.queryReadyMachineLoads ?? queryReadySharedMachineLoadsReal)()
  const eligible = rows
    .map(({ machine, boxSandboxIds }) => ({
      machine,
      free: capacity - boxSandboxIds.reduce((used, id) => used + unitWeightForSandboxId(id), 0),
    }))
    .filter(({ free }) => free >= incoming)
  if (eligible.length > 0) {
    eligible.sort(
      (a, b) =>
        a.free - b.free ||
        a.machine.createdAt.getTime() - b.machine.createdAt.getTime() ||
        (a.machine.id < b.machine.id ? -1 : a.machine.id > b.machine.id ? 1 : 0)
    )
    return eligible[0].machine
  }

  if (incoming > capacity) {
    log.warn(
      `box ${req.sandboxId} (role ${req.role}, weight ${incoming}) exceeds the machine unit capacity ` +
        `(${capacity}); provisioning it a shared machine of its own`
    )
  }
  return provisionCapped(deps, { name: packedMachineName(), purpose: 'shared', scope: 'shared' })
}

// ---------------------------------------------------------------------------
// resolvePlacement
// ---------------------------------------------------------------------------

/**
 * Decide the machine a box lands on, per §7 + B2. Precedence (first match wins):
 *  1. explicit pin → that machine (must be `ready`)
 *  2. an existing box row on a `ready` machine → that machine (sticky; slice-2 —
 *     this is what keeps packing stable across turns)
 *  3. `dedicated` → a freshly provisioned exe VM (error if no cloud provider)
 *  4. no cloud provider → the least-loaded ready shared machine (BYO/default)
 *  5. everything else (squad / agent / system-manager, squad-scoped or not) →
 *     best-fit unit-packed onto the shared pool ({@link resolvePacked})
 *
 * Steps 3/5 provision subject to the fleet cap (throws
 * {@link MachineProvisioningCapError}); reusing an existing shared machine with
 * room is never cap-blocked.
 */
export async function resolvePlacement(req: PlacementRequest, deps: PlacementDeps = {}): Promise<Machine> {
  const getMachine = deps.getMachine ?? getMachineReal

  // 1. Explicit pin — must exist and be ready. Short-circuits all policy.
  if (req.explicitMachineId) {
    const machine = await getMachine(req.explicitMachineId)
    if (!machine) throw new MachineUnavailableError(`machine not found: ${req.explicitMachineId}`)
    if (machine.status !== 'ready') {
      throw new MachineUnavailableError(`machine ${machine.name} is not ready (status ${machine.status})`)
    }
    return machine
  }

  // 2. Sticky: a live box must stay on its recorded ready machine so re-placement
  //    never repoints the row and orphans the old machine's box. Only consulted
  //    when a real sandboxId is supplied (box-manager's legacy shim passes none,
  //    and already handles stickiness itself before delegating).
  if (req.sandboxId) {
    const getBox = deps.getMachineBox ?? getMachineBoxReal
    const box = await getBox(req.sandboxId)
    if (box) {
      const recorded = await getMachine(box.machineId)
      if (recorded && recorded.status === 'ready') return recorded
    }
  }

  const exeProvider = await (deps.getExeProvider ?? defaultGetExeProvider)()

  // 3. Dedicated — its own VM. Requires a cloud provider (BYO cannot provision).
  if (req.dedicated) {
    if (!exeProvider) throw new DedicatedPlacementUnavailableError()
    return provisionCapped(deps, {
      name: dedicatedMachineName(req.sandboxId),
      purpose: 'dedicated',
      scope: 'dedicated',
    })
  }

  // 4. No cloud provider (BYO-only) → the legacy least-loaded shared path,
  //    byte-identical to pre-slice-5 behavior regardless of role/squad.
  if (!exeProvider) {
    return resolveLeastLoaded(deps)
  }

  // 5. Packed shared pool: every remaining box, whatever its role or squad,
  //    best-fit packs onto the fullest ready shared VM that still has room.
  return resolvePacked(req, deps)
}

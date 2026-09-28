import { createHash } from 'crypto'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { machineBoxes } from '../../db'
import { getPrivateArchiveRoot } from '../sandbox/private-archive'
import { boxUnixUser, boxHomeForUser, boxUnitControl as boxUnitControlFor } from './box-paths'
import { createBoxStepTimer, type BoxStepTimings } from './box-timing'
import { ensureMachineArtifacts as ensureMachineArtifactsReal } from './machine-artifacts-registry'
import { positiveIntEnv, resolvePlacement } from './placement'
import { SERVER_LIB_REMOTE_PATH } from './server-bundle'
import {
  bindMachineBox as bindMachineBoxReal,
  clearBoxSyncedHashes as clearBoxSyncedHashesReal,
  deleteMachineBox as deleteMachineBoxReal,
  externalizeUnverifiedBoxStop as externalizeUnverifiedBoxStopReal,
  findUnverifiedStopRemnant as findUnverifiedStopRemnantReal,
  getMachine as getMachineReal,
  getMachineBox as getMachineBoxReal,
  listMachineBoxes as listMachineBoxesReal,
  upsertMachineBox as upsertMachineBoxReal,
} from './queries'
import type { Machine, MachineBox } from './queries'
import { buildPushFileCommand, defaultSshRunner, defaultSshStreamer } from './ssh'
import type { SshRunner, SshStreamer } from './ssh'
import { machineTunnels } from './tunnel-manager'
import {
  persistBoxCondemnationEvidence,
  type BoxCondemnationEvidenceInput,
  type BoxHealthProbeEvidence,
  type BoxHealthProbeKind,
  type BoxMachineSnapshot,
} from './box-condemnation-evidence'
import { sandboxHasActiveExecution } from './sandbox-activity'

// The placement policy owns machine selection + auto-provisioning; box-manager
// delegates to it (see resolveMachineForBox). `MachineUnavailableError` and
// `queryReadySharedMachines` moved to placement.ts/queries.ts respectively and
// are re-exported here so existing importers (and tests) are unaffected.
export { MachineUnavailableError } from './placement'
export { queryReadySharedMachines } from './queries'

const log = createLogger('box-manager')

/**
 * Box manager — the orchestration layer for VM-based sandbox "boxes".
 *
 * A box is one per-sandbox unix user (`box_<hash>`) on a registered machine,
 * running the sandbox-server as a lingering systemd --user unit and reached over
 * slice 1's SSH ControlMaster tunnels. This module owns the box lifecycle:
 * ensure (create/refresh + reach), stop (park), remove (archive + tear down),
 * and status. The higher-level `VmSandboxManager` (slice 2 Task 3) drives it.
 *
 * ## ensure flow (order is load-bearing)
 *   1. resolve the target machine (explicit id, else placement)
 *   2. guard: a machine with `AllowTcpForwarding=no` cannot host tunnel-reached
 *      boxes → fail loudly BEFORE any mutation
 *   3. validate the caller env (fail fast, before any mutation)
 *   4. fast-path: an already-ready box on this machine whose provisioning
 *      marker (spec hash + env hash) is UNCHANGED and that still passes
 *      /healthz is returned as-is (no re-provision) — health is ALWAYS
 *      checked, and a drifted marker (rotated secret / changed env) falls
 *      through to a full re-provision so the new env reaches the box
 *   5. resume fast-path: a PARKED (stopped) box whose stamped
 *      `provisionedSpecHash` still matches the caller's desired PROVISIONING
 *      marker (spec hash + a hash of the caller env — see the column's doc
 *      in db/schema.ts and vm/manager.ts's `computeProvisioningMarker`, so a
 *      rotated secret busts this skip exactly like a spec change does) skips
 *      box-provision.sh entirely: stamp `ensuring` (so a concurrent status
 *      read during the window below sees `starting`, not the stale
 *      `stopped`) → restart the unit → tunnel forward → poll /healthz → mark
 *      the box row `ready`. Any skip-condition mismatch (or a failed
 *      restart/health) falls through to step 6.
 *   6. ensureMachineArtifacts (box-provision.sh + server bundle + tau cli,
 *      all required) → bindMachineBox → stamp `ensuring` → box-provision.sh
 *      → push server.env (0600 + chown to the box user) → restart the unit →
 *      tunnel forward → poll /healthz → mark the box row `ready` (stamping
 *      `provisionedSpecHash` with the fresh provisioning marker)
 *
 * ## secrets contract
 * `server.env` is a systemd EnvironmentFile of `KEY=value` lines that carries
 * the box's credentials. It is pushed with an explicit `0600` mode and chowned
 * to the box user (install runs as root; the box user must be able to read it).
 * Every value is validated to contain no newline and every key to match a strict
 * charset, so a hostile value can never inject additional unit/env directives —
 * the same injection class the slice-1 `--port` guard closes in box-provision.sh.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A machine exists but cannot host tunnel-reached boxes (e.g. its sshd has
 *  `AllowTcpForwarding no`). Distinct from unavailable: the machine is there,
 *  it just cannot be used. */
export class MachineUnusableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MachineUnusableError'
  }
}

/** An env key/value failed validation (bad key charset or a newline in a value). */
export class BoxEnvValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BoxEnvValidationError'
  }
}

/** The box never reported healthy within the poll budget. Carries the last
 *  observed status/error for diagnostics. */
export class BoxHealthTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BoxHealthTimeoutError'
  }
}

/** A prior stop was accepted while its machine was unreachable and must be
 * verified before the row can be rebound or restarted. */
export class BoxStopUnverifiedError extends Error {
  constructor(sandboxId: string) {
    super(`Box ${sandboxId} has an unverified stop pending machine recovery`)
    this.name = 'BoxStopUnverifiedError'
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BoxEnv {
  [k: string]: string
}

export interface EnsureBoxOpts {
  sandboxId: string
  machineId?: string | null
  env: BoxEnv
  role: 'squad' | 'agent' | 'system-manager'
  /**
   * The caller's PROVISIONING marker for this ensure — {@link
   * computeProvisioningMarker}`(computeSpecHash(opts), env)`, computed by
   * vm/manager.ts (which owns `computeSpecHash`) and passed in here. NOT the
   * bare reconcilable spec hash alone: it folds in a hash of `env` too (never
   * the raw secret values), because the resume fast path this drives skips
   * the `server.env` push a full provision does — without the env hash
   * folded in, a rotated GITHUB_TOKEN/callback secret/API URL would resume
   * the box on stale credentials. Compared against a PARKED box's
   * `provisionedSpecHash` row field to decide the resume fast path (see
   * {@link ensureBox}'s doc). Optional so existing test/legacy callers that
   * never touch the resume path compile unchanged; a caller that omits it
   * simply never qualifies for the resume fast path (undefined never matches
   * a stored hash).
   */
  specHash?: string
  /**
   * What the CALLER already knows about this box's liveness, so the healthy
   * fast path need not find out for itself.
   *
   * `'listening'` means "the caller has just seen this box's port listening on
   * its machine". Under socket activation that IS the health signal: the socket
   * unit owns the port whether or not a server process exists, so an HTTP probe
   * would WAKE an idle box — and the 60s keep-warm tick ensures every
   * active-work-stream box, so every idle server on the host would be woken
   * once a minute and the RAM this design reclaims would come straight back.
   *
   * Set ONLY by the vm lifecycle tick, which learns the whole listening-port set
   * for a machine in one `ss -ltnH`. Request-path ensures leave it undefined and
   * keep probing — waking the box is exactly what they want.
   */
  liveness?: 'listening'
  /** Internal setup-progress seam; invoked only after a physical mutation path is selected. */
  beginPhysicalWork?: (
    reason: 'runtime_start' | 'runtime_reconnect' | 'spec_reconcile'
  ) => (outcome: 'ready' | 'failed') => void
}

/**
 * Canonical hash of a box's caller-supplied env (everything the caller's
 * `EnsureBoxOpts.env` carries: identity token, git user, callback secret,
 * API URL, ...). Keys are sorted before hashing so the result is independent
 * of property-assignment order — an unrelated env-building refactor upstream
 * that reorders assignments can never spuriously bust the resume fast path
 * this feeds ({@link computeProvisioningMarker}).
 */
function computeEnvHash(env: BoxEnv): string {
  const sortedEntries = Object.keys(env)
    .sort()
    .map((k) => [k, env[k]] as const)
  return createHash('sha256').update(JSON.stringify(sortedEntries)).digest('hex').slice(0, 16)
}

/**
 * The value vm/manager.ts passes as `EnsureBoxOpts.specHash` — this module's
 * PARKED-box resume fast-path marker ("has this box's on-machine
 * provisioning drifted from what the caller wants right now"). Folds a HASH
 * of the caller env (never the raw secret values — see {@link
 * computeEnvHash}) into the caller's reconcilable spec hash (vm/manager.ts's
 * `computeSpecHash`).
 *
 * This is DELIBERATELY separate from `computeSpecHash`, which stays
 * env-exclusive (see its doc comment) for spec-drift/recreate decisions. But
 * this module's resume fast path (see {@link ensureBox}'s doc) skips exactly
 * the env re-push a full provision does (it never calls
 * installBoxOnMachine), so without folding env in here a rotated secret —
 * GITHUB_TOKEN/GH_TOKEN, GIT_USER_NAME/EMAIL, SANDBOX_CALLBACK_SECRET,
 * APP_URL, or a degraded-fallback FICUS_API_URL — would silently resume the box
 * on STALE credentials. Park→resume used to be exactly where such a rotation
 * self-healed (every resume took the full path before the resume fast path
 * existed); this marker restores that property: a hash mismatch here costs
 * one full (re)provision, never a skip-starved rotation.
 *
 * Lives here (not in vm/manager.ts, its only caller) because it needs
 * nothing but `BoxEnv` (defined in this module) and `crypto` — keeping it
 * next to the `EnsureBoxOpts.specHash` field it feeds means a lower-layer
 * test (box-manager.test.ts) can exercise the full marker→skip-decision
 * chain without importing vm/manager.ts's heavier dependency surface
 * (SandboxClient, the tunnel manager, ...).
 */
export function computeProvisioningMarker(specHash: string, env: BoxEnv): string {
  // Deliberately DECOMPOSABLE (`<specHash>.<envHash>`), not an opaque digest:
  // a marker mismatch on an otherwise-healthy box forces a full re-provision
  // that RESTARTS the box's systemd unit (killing shells and running agent
  // commands), so the fast-path miss log must be able to say WHICH half
  // drifted (see describeProvisioningMarkerDrift). specHash never contains
  // '.' (hex), so the split is unambiguous.
  return `${specHash}.${computeEnvHash(env)}`
}

/**
 * One-line explanation of a provisioning-marker mismatch, for the ensure log
 * at the moment a full re-provision (env re-push + unit restart) is chosen
 * over the fast path. Both markers are `<specHash>.<envHash>`
 * ({@link computeProvisioningMarker}); a stamp that doesn't split is from
 * before the decomposable format (or absent) and is reported as such.
 */
export function describeProvisioningMarkerDrift(previous: string | null | undefined, next: string): string {
  const prevParts = previous?.split('.')
  const nextParts = next.split('.')
  if (!prevParts || prevParts.length !== 2 || nextParts.length !== 2) {
    return `legacy or missing stamp (${previous ?? 'none'} -> ${next})`
  }
  const specDrifted = prevParts[0] !== nextParts[0]
  const envDrifted = prevParts[1] !== nextParts[1]
  if (specDrifted && envDrifted) return `spec hash (${prevParts[0]} -> ${nextParts[0]}) and env both drifted`
  if (specDrifted) return `spec hash drifted (${prevParts[0]} -> ${nextParts[0]})`
  if (envDrifted) return `env drifted (env hash ${prevParts[1]} -> ${nextParts[1]})`
  return 'no drift (markers equal)'
}

/** Minimal fetch surface the health probes need (real `fetch` satisfies it).
 *  `headers` carries the migrate primitive's token-auth probe bearer. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number }>

/**
 * Per-request timeout for a single /healthz fetch. Without it a raw `fetch` can
 * black-hole on a wedged TCP connection FOREVER — and the poll's 60s budget is
 * only checked BETWEEN resolved fetches, so one stuck connection would hang
 * ensureBox / the fast-path / boxStatus indefinitely. Mirrors
 * SandboxClient.waitForReady's 2s per-attempt abort.
 */
const HEALTH_FETCH_TIMEOUT_MS = 2_000

/** The tunnel-manager surface this module depends on (`machineTunnels` satisfies it). */
export interface BoxTunnels {
  ensureMaster(machine: Machine): Promise<void>
  addForward(machine: Machine, remotePort: number): Promise<number>
  removeForward(machine: Machine, remotePort: number): Promise<void>
  endpointFor(machineId: string, remotePort: number): string | null
  checkHealth(machineId: string): Promise<boolean>
}

/** All external effects, injectable for tests; each defaults to production. */
export interface BoxManagerDeps {
  runner?: SshRunner
  /** Host→host pipe used by {@link streamBoxStateArchive} (migration transport);
   *  defaults to ssh.ts's process-wide streamer. */
  streamer?: SshStreamer
  tunnels?: BoxTunnels
  fetch?: FetchLike
  /** Deliver the full registered artifact set (box-provision.sh, server
   *  bundle, tau cli) to the machine; every artifact is required — any
   *  failure propagates and fails the ensure. Defaults to
   *  machine-artifacts-registry's ensureMachineArtifacts. */
  ensureMachineArtifacts?: (machine: Machine) => Promise<void>
  getMachine?: (id: string) => Promise<Machine | null>
  bindMachineBox?: (values: {
    sandboxId: string
    machineId: string
    unixUser: string
    port?: number
    authToken?: string
    /** CAS precondition (the migrate repoint) — see bindMachineBox in queries.ts. */
    expected?: { fromMachineId: string; port: number; authToken: string | null }
  }) => Promise<MachineBox>
  upsertMachineBox?: (box: typeof machineBoxes.$inferInsert) => Promise<MachineBox>
  /** Reset a box's per-asset content-hash stamps to `'{}'` before a (re)provision
   *  so file-sync re-pushes every asset onto the rebuilt box. Defaults to
   *  queries.ts's clearBoxSyncedHashes. */
  clearBoxSyncedHashes?: (sandboxId: string) => Promise<void>
  getMachineBox?: (sandboxId: string) => Promise<MachineBox | null>
  deleteMachineBox?: (sandboxId: string) => Promise<void>
  queryReadySharedMachines?: () => Promise<Array<{ machine: Machine; boxCount: number }>>
  /** Exact old-machine remnant fence for a fresh logical sandbox placement. */
  findUnverifiedStopRemnant?: (machineId: string, unixUser: string) => Promise<MachineBox | null>
  /** Inline retirement seam for a remnant on the only returning machine. */
  retireUnverifiedStopRemnant?: (
    remnant: MachineBox,
    originalSandboxId: string,
    role: EnsureBoxOpts['role']
  ) => Promise<void>
  /** Every box row on a machine — supplies the best-effort
   *  `priorBoxesOnMachine` timing annotation. Defaults to queries.ts's listMachineBoxes. */
  listMachineBoxes?: (machineId: string) => Promise<MachineBox[]>
  /** Private-archive destination root (defaults to HOME_DIR/private-archive). */
  getArchiveRoot?: () => string
  /** Latest Core-side archive for a sandbox, used only by fresh replacement. */
  findPrivateArchive?: (sandboxId: string) => Promise<string | null>
  writeArchiveFile?: (dest: string, bytes: Uint8Array) => Promise<void>
  /** Read a core-side archive file; null when absent (defaults to fs readFile). */
  readArchiveFile?: (src: string) => Promise<Uint8Array | null>
  /** Fresh-box health-poll shape (production: 2s interval within the
   *  {@link resolveBoxHealthBudgetMs} budget — 240s default, `FICUS_BOX_HEALTH_BUDGET_MS`). */
  healthIntervalMs?: number
  healthBudgetMs?: number
  /** Fast-path re-check resilience (production: 3 attempts, 1s apart) — see {@link recheckBoxHealth}. */
  healthRecheckAttempts?: number
  healthRecheckGapMs?: number
  /** Full patience for an established box with admitted execution work. */
  establishedActiveGraceMs?: number
  /** Short patience for an established box with no admitted execution work. */
  establishedIdleGraceMs?: number
  /** First established-box grace gap; later gaps double up to a fixed cap. */
  establishedGraceInitialGapMs?: number
  hasActiveExecution?: (sandboxId: string) => Promise<boolean>
  persistCondemnationEvidence?: (evidence: BoxCondemnationEvidenceInput) => Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Naming + layout helpers
// ---------------------------------------------------------------------------

// A box's unix user + HOME derivation lives in the pure leaf module ./box-paths
// so services/sandbox/workspace-layout can derive box-native agent paths without
// importing this (db/ssh-heavy) module. Re-exported for existing importers.
export { boxUnixUser } from './box-paths'
// The box's systemd-unit control seam lives in the same pure leaf module, for
// the same reason: box-migrate and the platform's box-control script need it
// without this module's db/ssh weight. Re-exported so `./box-manager` remains
// the one import surface for provisioning callers.
export { boxUnitControl, boxUnitMode } from './box-paths'
export type { BoxUnitControl, BoxUnitMode } from './box-paths'
const boxHome = boxHomeForUser

/** Where the box's systemd unit runs the bundle; installed by bootstrap.sh. */
const BOX_PROVISION_PATH = '/opt/tau/bin/box-provision.sh'
/** Per-box browser auth token DIGEST files live here — a SIBLING of
 *  /opt/tau/browser (NOT inside it: bootstrap.sh recursively world-opens
 *  /opt/tau/browser). Kept in lockstep with the tau-browser service's
 *  FICUS_BROWSER_TOKENS_DIR. See {@link installBoxOnMachine}. */
const BROWSER_TOKENS_DIR = '/opt/tau/browser-tokens'
/** box-provision (user + linger + rootless-docker setuptool) can take a minute+.
 *  Bounds ONLY that one SSH run (see {@link installBoxOnMachine}); it does NOT
 *  wrap the later /healthz poll, whose own budget is {@link resolveBoxHealthBudgetMs}. */
const BOX_PROVISION_RUN_TIMEOUT_MS = 5 * 60_000

/**
 * How long a FRESH box (just provisioned/started) may take to first answer
 * `/healthz` before it is condemned — 4 minutes.
 *
 * Why not the old 60s: on a slow-booting VM (a small BYO cloud VM still
 * settling, its rootless dockerd cold-starting alongside the unit, the
 * per-machine first-box tax, a concurrent background devbox pre-warm pegging
 * the CPUs) the sandbox-server can take well over a minute to start accepting
 * connections. Every probe until then fails with "The socket connection was
 * closed unexpectedly" — the box is BOOTING, not dead — and at 60s the whole
 * execution was failed instead of waiting (observed live). 240s covers that
 * comfortably (the same order as the k8s manager's 300s devbox-ready wait) while
 * still bounding a genuinely dead box: it sits BELOW {@link
 * BOX_PROVISION_RUN_TIMEOUT_MS} (a sequential, independent bound on the
 * box-provision.sh run, so the two never race — a fresh ensure's worst case is
 * simply their sum), keeping "no single provisioning step exceeds ~5 minutes".
 * `FICUS_BOX_HEALTH_BUDGET_MS` (positive-int env, same rule as the other machine
 * knobs) overrides it for unusually slow fleets. An established box's re-check
 * is a different, much shorter budget — see {@link recheckBoxHealth}.
 */
export const DEFAULT_BOX_HEALTH_BUDGET_MS = 4 * 60_000

/** The fresh-box health budget: `FICUS_BOX_HEALTH_BUDGET_MS` else {@link DEFAULT_BOX_HEALTH_BUDGET_MS}. */
export function resolveBoxHealthBudgetMs(): number {
  return positiveIntEnv('FICUS_BOX_HEALTH_BUDGET_MS', DEFAULT_BOX_HEALTH_BUDGET_MS)
}

/** Cadence of the "still waiting for box health" progress line while a fresh
 *  box boots — frequent enough that an operator tailing logs sees liveness,
 *  sparse enough not to flood (the poll itself probes every 2s). */
const HEALTH_PROGRESS_LOG_INTERVAL_MS = 20_000

/** Single-quote a value for safe interpolation into a remote shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// ---------------------------------------------------------------------------
// server.env content
// ---------------------------------------------------------------------------

/** systemd EnvironmentFile keys must be shell-safe identifiers. */
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/

/** Validate a single env entry (throws {@link BoxEnvValidationError}). */
function assertValidEnvEntry(key: string, value: string): void {
  if (!ENV_KEY_RE.test(key)) {
    throw new BoxEnvValidationError(`invalid env key '${key}' (must match ${ENV_KEY_RE.source})`)
  }
  if (/[\n\r]/.test(value)) {
    throw new BoxEnvValidationError(`env value for '${key}' contains a newline (systemd EnvironmentFile injection)`)
  }
}

/** Validate every caller-supplied entry up front so a bad env fails BEFORE any
 *  machine mutation. The derived runtime vars (below) are machine-controlled. */
function assertValidBoxEnv(env: BoxEnv): void {
  for (const [key, value] of Object.entries(env)) assertValidEnvEntry(key, value)
}

/**
 * Runtime vars baked on top of the caller env. These derive from the box itself
 * (its port, its HOME layout) and are authoritative, so they override any
 * caller-provided collision:
 *  - `EXECUTOR_PORT` — the port the sandbox-server binds (the box's bound port)
 *  - `WORKSPACE_PATH` — the box's working root (squad → ~/workspace; agent/
 *    system-manager → ~/.private), mirroring workspace-layout.ts semantics
 *  - `FICUS_DEVBOX_DIR` — the box's own minimal devbox dir (~/.tau/devbox)
 *  - `FICUS_BOX_HOME` — the box user's HOME; the sandbox-server's path allow-list
 *    (packages/k8s-sandbox resolvePath) permits writes under this prefix so
 *    file-sync can land agent assets in the box HOME (~/bin, ~/.tau/skills,
 *    ~/memory). k8s pods never set it, so it is a vm-only, per-box widening.
 *  - `DOCKER_HOST` — ONLY on boxes provisioned `--with-docker` (squad,
 *    system-manager). Points the sandbox-server's docker use at the box user's
 *    OWN rootless daemon socket (`unix:///run/user/<uid>/docker.sock`, started
 *    by box-provision.sh). `<uid>` is useradd-assigned and NOT deterministic, so
 *    box-provision REPORTS it on stdout (`FICUS_BOX_UID=<uid>`) and ensureBox bakes
 *    the socket path from it. Agent (light) boxes get no docker and no
 *    DOCKER_HOST, mirroring k8s where the agent role skips dockerd.
 *  - `BUN_PTY_LIB` — absolute path to the native bun-pty lib ensureServerBundle
 *    ships next to server.js (machine-global under /opt/tau/server). The bundled
 *    server's shell/PTY path dlopens it at boot; pointing the loader here is what
 *    stops a startup crash. k8s pods bake the lib into the image, so this is a
 *    vm-only var.
 *  - `EXECUTOR_AUTH_TOKEN` — the box's per-box auth token. The server 401s any
 *    request not presenting it as a bearer token, so a co-located box_<hash>
 *    user on the shared machine cannot drive a sibling's executor — the token
 *    is the SOLE cross-box boundary (the loopback bind below does not help
 *    against siblings). It lives in the box's 0600 server.env (siblings can't
 *    read it) and in the box's machine_boxes row (so both core processes can
 *    present it). vm-only: k8s pods never set it, and the server's enforcement
 *    is conditional on it.
 *  - `EXECUTOR_BIND` — 127.0.0.1. A box is only ever reached through the SSH
 *    -L forward, which connects to localhost ON the machine, so the server
 *    need not (and must not) listen on non-loopback interfaces. This removes
 *    OFF-MACHINE exposure only (defense-in-depth): all local users share the
 *    loopback interface, so a sibling box can still connect to the port —
 *    co-located isolation is entirely the auth token's job. vm-only: k8s pods
 *    are reached over pod networking and keep the 0.0.0.0 default. It doubles
 *    as the server's VM-runtime marker: a server that sees EXECUTOR_BIND but
 *    no EXECUTOR_AUTH_TOKEN refuses to start (fail closed), so a fresh box's
 *    unit can never serve unauthenticated before this env file lands.
 *
 * Task 3's VmSandboxManager owns the FULL BoxEnv parity with pod-spec; here we
 * only bake the ones the box layout uniquely determines.
 */
/**
 * Home-relative subdir that is a box's WORKSPACE_PATH, keyed by role — the
 * SINGLE source of truth for the role→workspace mapping (consumed by
 * {@link derivedBoxEnv} and by {@link durableStateDirsForRole}). Squad boxes anchor
 * their authoritative working tree on ~/workspace; every other role treats
 * ~/.private as its workspace.
 */
export function workspaceSubdirForRole(role: EnsureBoxOpts['role']): string {
  return role === 'squad' ? 'workspace' : '.private'
}

/** Every box root whose contents survive migration, independently of WORKSPACE_PATH. */
export const DURABLE_BOX_ROOTS = ['workspace', '.private'] as const

export function durableStateDirsForRole(_role: EnsureBoxOpts['role']): ['workspace', '.private'] {
  return [...DURABLE_BOX_ROOTS]
}

function derivedBoxEnv(
  port: number,
  role: EnsureBoxOpts['role'],
  home: string,
  authToken: string,
  uid?: number
): BoxEnv {
  const workspacePath = `${home}/${workspaceSubdirForRole(role)}`
  const env: BoxEnv = {
    EXECUTOR_PORT: String(port),
    EXECUTOR_AUTH_TOKEN: authToken,
    EXECUTOR_BIND: '127.0.0.1',
    // Authoritative even when caller/legacy env conflicts: systemd EnvironmentFile
    // values override the unit's activation-time Environment fallback.
    EXECUTOR_SERVICE_CGROUP: '1',
    WORKSPACE_PATH: workspacePath,
    FICUS_DEVBOX_DIR: `${home}/.tau/devbox`,
    FICUS_TOOLCHAIN_DIR: `${home}/.tau/toolchain`,
    FICUS_BOX_HOME: home,
    BUN_PTY_LIB: SERVER_LIB_REMOTE_PATH,
  }
  // Docker-capable boxes (squad, system-manager) reach their OWN rootless daemon
  // via the box user's runtime socket. uid is required here (guaranteed non-null
  // by ensureBox before this is called for a docker box).
  if (roleWantsDocker(role) && uid !== undefined) {
    env.DOCKER_HOST = `unix:///run/user/${uid}/docker.sock`
  }
  return env
}

/**
 * Whether a box role needs box-provision.sh to bring up rootless docker
 * (`--with-docker`). Product requirement, pinned by a direct regression test
 * (box-manager.test.ts): squad AND system-manager boxes run rootless dockerd
 * (heavier devbox toolchain, `DOCKER_HOST` baked into their env); agent
 * (light) boxes never do — mirrors k8s, where the agent image stage never
 * installs docker.
 */
export function roleWantsDocker(role: EnsureBoxOpts['role']): boolean {
  return role === 'squad' || role === 'system-manager'
}

/**
 * Parse the box user's uid from box-provision.sh's stdout. The script prints
 * exactly one `FICUS_BOX_UID=<uid>` line (the useradd-assigned, non-deterministic
 * login uid) so box-manager can bake the rootless docker socket path. Returns
 * null when no valid marker is present. The legacy `TAU_BOX_UID=` spelling is
 * accepted for one release (Ficus rename): a machine may still run an older
 * box-provision.sh.
 */
export function parseBoxUid(stdout: string): number | null {
  const match = stdout.match(/^(?:FICUS|TAU)_BOX_UID=(\d+)$/m)
  if (!match) return null
  const uid = Number(match[1])
  return Number.isInteger(uid) ? uid : null
}

/** Serialize `env` to `KEY=value\n` lines, validating every entry. */
function buildServerEnvContent(env: BoxEnv): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(env)) {
    assertValidEnvEntry(key, value)
    lines.push(`${key}=${value}`)
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}

// ---------------------------------------------------------------------------
// Machine placement
// ---------------------------------------------------------------------------

/**
 * Resolve the machine a box should live on — the box-manager entry point, kept
 * for its legacy `(explicit, deps)` shape (ensureBox + the vm manager call it).
 *
 * It delegates to the slice-5 {@link resolvePlacement} policy. Because it carries
 * no role/squad context, it always presents the request as a plain agent box with
 * no squad and no sandboxId, so:
 *  - an explicit pin resolves to that machine (must be `ready`), and
 *  - with NO cloud provider configured (BYO-only) it resolves to the least-loaded
 *    ready shared machine — byte-identical to the pre-slice-5 behavior.
 * When a cloud provider IS configured, a null-pin call packs onto the shared pool
 * at agent weight (the B2 best-fit packer, provisioning a shared VM when nothing
 * fits); the dedicated policy is reached by callers that invoke `resolvePlacement`
 * directly with the full request. The sticky rule (existing box → its ready
 * machine) is still owned by ensureBox itself (below), which is why no sandboxId
 * is threaded here.
 */
export async function resolveMachineForBox(explicit?: string | null, deps: BoxManagerDeps = {}): Promise<Machine> {
  return resolvePlacement({ sandboxId: '', role: 'agent', explicitMachineId: explicit ?? null }, deps)
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

type HealthProbeErrorInput = {
  code?: unknown
  name?: unknown
  message?: unknown
  cause?: unknown
}

function classifyHealthProbeError(error: unknown): BoxHealthProbeKind {
  let current: unknown = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 5 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current)
    const input = current as HealthProbeErrorInput
    const code = String(input.code ?? '')
    const name = String(input.name ?? '')
    const message = String(input.message ?? '').toLowerCase()

    if (
      name === 'TimeoutError' ||
      name === 'AbortError' ||
      code === 'ABORT_ERR' ||
      code === 'ETIMEDOUT' ||
      /timeout|timed out/.test(message)
    )
      return 'abort_timeout'
    if (
      code === 'ConnectionRefused' ||
      code === 'ECONNREFUSED' ||
      name === 'ConnectionRefused' ||
      name === 'ECONNREFUSED' ||
      /connection refused|connect refused/.test(message)
    )
      return 'refused'
    if (code === 'ECONNRESET' || name === 'ECONNRESET' || /connection reset|socket connection.*closed/.test(message))
      return 'reset'

    current = input.cause
  }
  return 'other'
}

async function probeHealthWithEvidence(
  endpoint: string,
  deps: BoxManagerDeps
): Promise<{ healthy: boolean; evidence: BoxHealthProbeEvidence }> {
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))
  const now = deps.now ?? Date.now
  const startedAt = now()
  const observedAt = new Date(startedAt)
  try {
    const res = await fetchFn(`${endpoint}/healthz`, {
      method: 'GET',
      signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
    })
    return {
      healthy: res.ok,
      evidence: { observedAt, kind: 'http_status', elapsedMs: Math.max(0, now() - startedAt), status: res.status },
    }
  } catch (error) {
    return {
      healthy: false,
      evidence: {
        observedAt,
        kind: classifyHealthProbeError(error),
        elapsedMs: Math.max(0, now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

async function probeHealthOnce(endpoint: string, deps: BoxManagerDeps): Promise<boolean> {
  return (await probeHealthWithEvidence(endpoint, deps)).healthy
}

const HEALTH_RECHECK_ATTEMPTS = 3
const HEALTH_RECHECK_GAP_MS = 1_000

/** Maximum patience for an established box that has admitted execution work. */
export const DEFAULT_ESTABLISHED_ACTIVE_GRACE_MS = 120_000
/** Maximum patience for an idle established box after its machine says it is alive. */
export const DEFAULT_ESTABLISHED_IDLE_GRACE_MS = 5_000
/** Initial saturated-box retry gap; each failed round doubles this gap. */
const ESTABLISHED_GRACE_INITIAL_GAP_MS = 2_000
/** Upper bound for any one saturated-box retry sleep. */
const ESTABLISHED_GRACE_MAX_GAP_MS = 30_000

function resolveEstablishedActiveGraceMs(): number {
  return positiveIntEnv('FICUS_ESTABLISHED_BOX_ACTIVE_GRACE_MS', DEFAULT_ESTABLISHED_ACTIVE_GRACE_MS)
}

function resolveEstablishedIdleGraceMs(): number {
  return positiveIntEnv('FICUS_ESTABLISHED_BOX_IDLE_GRACE_MS', DEFAULT_ESTABLISHED_IDLE_GRACE_MS)
}

/**
 * Re-verify an ALREADY-ESTABLISHED box's health before condemning it to a full
 * re-provision. A fresh box proves itself through pollBoxHealth's minutes-long budget; an
 * established box only needs to show it is still alive — but a SINGLE 2s
 * /healthz probe is too brittle for that. Under a CPU-heavy in-box build (a
 * background `tau` build on a small 2-vCPU machine will peg both cores) the
 * sandbox-server can miss one probe while very much alive; the fetch then fails
 * with "socket connection closed unexpectedly". Re-provisioning on that single
 * miss throws the box away — and kills any long-running exec/monitor running in
 * it (the background build) — for a transient blip, which is exactly the box
 * "flapping" observed in production. So retry a few times with a short gap: a
 * genuinely dead box still fails EVERY attempt and falls through to the full
 * re-provision, while a merely-busy one is kept and its work survives.
 */
async function recheckBoxHealthWithEvidence(
  endpoint: string,
  deps: BoxManagerDeps
): Promise<{ healthy: boolean; probes: BoxHealthProbeEvidence[] }> {
  const attempts = deps.healthRecheckAttempts ?? HEALTH_RECHECK_ATTEMPTS
  const gap = deps.healthRecheckGapMs ?? HEALTH_RECHECK_GAP_MS
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const probes: BoxHealthProbeEvidence[] = []
  for (let attempt = 0; attempt < attempts; attempt++) {
    const probe = await probeHealthWithEvidence(endpoint, deps)
    probes.push(probe.evidence)
    if (probe.healthy) return { healthy: true, probes }
    if (attempt < attempts - 1) await sleep(gap)
  }
  return { healthy: false, probes }
}

async function recheckBoxHealth(endpoint: string, deps: BoxManagerDeps): Promise<boolean> {
  return (await recheckBoxHealthWithEvidence(endpoint, deps)).healthy
}

/**
 * One `<P>_<name>_BEGIN … <P>_<name>_END` block of a machine snapshot. `<P>` is
 * `FICUS` or, for one release (Ficus rename), the legacy `TAU`; both ends must
 * use the same spelling.
 */
function section(stdout: string, name: string): string | undefined {
  const match = stdout.match(new RegExp(`(FICUS|TAU)_${name}_BEGIN\\n([\\s\\S]*?)\\n\\1_${name}_END`))
  return match?.[2]?.trim() || undefined
}

/** The liveness marker and evidence sections of {@link buildMachineSnapshotCommand}'s output. */
export function parseMachineSnapshotOutput(stdout: string): {
  liveness: 'running' | 'idle' | 'exited' | undefined
  containerStates: string | undefined
  logTail: string | undefined
} {
  const liveness = stdout.match(/^(?:FICUS|TAU)_BOX_LIVENESS=(running|idle|exited)$/m)?.[1] as
    | 'running'
    | 'idle'
    | 'exited'
    | undefined
  return {
    liveness,
    containerStates: section(stdout, 'CONTAINER_STATES'),
    logTail: section(stdout, 'BOX_LOGS'),
  }
}

/**
 * Ask the host, rather than the box server, whether the established unit still
 * exists and capture the evidence that would otherwise disappear on recreate.
 */
async function inspectEstablishedBox(
  machine: Machine,
  box: { sandboxId: string; unixUser: string },
  deps: BoxManagerDeps
): Promise<BoxMachineSnapshot> {
  const runner = deps.runner ?? defaultSshRunner
  const observedAt = new Date((deps.now ?? Date.now)())
  const command = buildMachineSnapshotCommand(box)
  try {
    const result = await runner.run(machine, command)
    if (result.exitCode !== 0) {
      return { observedAt, error: `machine snapshot exited ${result.exitCode}: ${result.stderr.trim()}` }
    }
    const { liveness, containerStates, logTail } = parseMachineSnapshotOutput(result.stdout)
    if (!liveness) return { observedAt, error: 'machine snapshot returned no liveness marker' }
    return { observedAt, liveness, containerStates, logTail }
  } catch (error) {
    return { observedAt, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The one-shot remote program {@link inspectEstablishedBox} runs. Exported and
 * PURE so its liveness decision — which is a shell program, not a string — can
 * be executed against stubbed systemctl output in tests.
 */
export function buildMachineSnapshotCommand(box: { sandboxId: string; unixUser: string }): string {
  const { unixUser } = box
  const ctl = boxUnitControlFor(box)
  // `uid=` stays unconditional: the container listing below always needs it,
  // and the user-mode probes from the seam reference it too (see its contract).
  // Liveness is the SOCKET's story first, the server process's second. A
  // socket-activated box whose server has idle-exited is `idle` — healthy, and
  // the steady state of an unused box — while only a missing socket (or a
  // server unit that has genuinely `failed`, i.e. exhausted Restart=on-failure)
  // means the box is down. The `legacy` leg covers a box this deploy has not
  // re-provisioned yet, whose port is held by the server itself with no socket
  // unit at all; without it every not-yet-migrated box would read `exited` and
  // be condemned.
  const legacyIsActive = ctl.legacyIsActiveCommand?.()
  return [
    `uid=$(id -u ${shellQuote(unixUser)} 2>/dev/null || true)`,
    `tau_live() { case "$1" in active|activating|reloading|listening|running) return 0 ;; *) return 1 ;; esac; }`,
    `sock=$(${ctl.socketIsActiveCommand()} 2>/dev/null || true)`,
    `state=$(${ctl.isActiveCommand()} 2>/dev/null || true)`,
    legacyIsActive ? `legacy=$(${legacyIsActive} 2>/dev/null || true)` : 'legacy=',
    'if tau_live "$sock"; then ' +
      'if tau_live "$state"; then echo FICUS_BOX_LIVENESS=running; ' +
      'elif [ "$state" = failed ]; then echo FICUS_BOX_LIVENESS=exited; ' +
      'else echo FICUS_BOX_LIVENESS=idle; fi; ' +
      'elif tau_live "$state" || tau_live "$legacy"; then echo FICUS_BOX_LIVENESS=running; ' +
      'else echo FICUS_BOX_LIVENESS=exited; fi',
    'echo FICUS_CONTAINER_STATES_BEGIN',
    // Rootless docker is user-manager-only by construction, so this probe keeps
    // its `sudo -u … XDG_RUNTIME_DIR=` shape in BOTH modes: a system-unit box
    // is an agent box, which has no daemon and simply reports the error.
    `sudo -u ${shellQuote(unixUser)} env XDG_RUNTIME_DIR=/run/user/$uid DOCKER_HOST=unix:///run/user/$uid/docker.sock docker ps -a --format '{{.Names}} {{.Status}}' 2>&1 | tail -n 200 || true`,
    'echo FICUS_CONTAINER_STATES_END',
    'echo FICUS_BOX_LOGS_BEGIN',
    `${ctl.journalctl} -n 200 --no-pager 2>&1 || true`,
    'echo FICUS_BOX_LOGS_END',
  ].join('; ')
}

/**
 * The loopback ports currently LISTENING on a machine, parsed from `ss -ltnH`.
 * Every box's port is held by its `.socket` unit whether or not a server
 * process exists, so this is the per-machine liveness sweep that lets the vm
 * lifecycle tick keep boxes warm without HTTP-probing (and thereby waking) each
 * of them — one SSH per machine instead of one HTTP round trip per box.
 */
export function parseListeningLoopbackPorts(stdout: string): Set<number> {
  const ports = new Set<number>()
  for (const match of stdout.matchAll(/127\.0\.0\.1:(\d+)\b/g)) {
    const port = Number(match[1])
    if (Number.isInteger(port) && port > 0) ports.add(port)
  }
  return ports
}

/** {@link parseListeningLoopbackPorts} over one SSH to `machine`. */
export async function listListeningLoopbackPorts(machine: Machine, deps: BoxManagerDeps = {}): Promise<Set<number>> {
  const runner = deps.runner ?? defaultSshRunner
  const result = await runner.run(machine, 'ss -ltnH')
  if (result.exitCode !== 0) {
    throw new Error(`ss -ltnH failed on machine ${machine.id} (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
  return parseListeningLoopbackPorts(result.stdout)
}

type EstablishedBoxDecision = { healthy: true; endpoint: string } | { healthy: false }

/** Classify an HTTP-dead established box and durably record why before recreate. */
async function evaluateEstablishedBox(
  input: { endpoint: string; machine: Machine; box: MachineBox },
  deps: BoxManagerDeps
): Promise<EstablishedBoxDecision> {
  let endpoint = input.endpoint
  const initial = await recheckBoxHealthWithEvidence(endpoint, deps)
  if (initial.healthy) return { healthy: true, endpoint }

  const probes = initial.probes
  let snapshot = await inspectEstablishedBox(input.machine, input.box, deps)
  const persist = deps.persistCondemnationEvidence ?? persistBoxCondemnationEvidence
  const now = deps.now ?? Date.now
  const persistBeforeCondemnation = async (
    classification: BoxCondemnationEvidenceInput['classification'],
    activeExecution: boolean | null,
    graceBudgetMs: number
  ) => {
    await persist({
      sandboxId: input.box.sandboxId,
      machineId: input.machine.id,
      classification,
      probes,
      machineSnapshot: snapshot,
      activeExecution,
      graceBudgetMs,
      recordedAt: new Date(now()),
    })
  }

  if (snapshot.error) {
    await persistBeforeCondemnation('machine_unreachable', null, 0)
    return { healthy: false }
  }
  // A socket-activated box whose server has idle-exited is HEALTHY: its socket
  // holds the port and the next real request re-activates the whole chain. The
  // HTTP probe above failing is expected in that state (it raced the cold
  // start, or the box was woken and stood down again), so believe the host over
  // the probe rather than condemning a box that is working as designed.
  if (snapshot.liveness === 'idle') return { healthy: true, endpoint }
  if (snapshot.liveness === 'exited') {
    await persistBeforeCondemnation('exited', null, 0)
    return { healthy: false }
  }

  // An immediate refusal through a live box process diagnoses the Core-owned
  // forward before it diagnoses the box. Rebuild that forward and probe the
  // fresh local endpoint before work-aware patience (or any condemnation).
  if (probes.length > 0 && probes.every((probe) => probe.kind === 'refused')) {
    const tunnels = deps.tunnels ?? machineTunnels
    try {
      try {
        await tunnels.removeForward(input.machine, input.box.port)
      } catch (error) {
        // A dead master can make cancellation fail. addForward verifies/purges
        // the cached master itself, so cancellation failure does not skip repair.
        log.warn(`box ${input.box.sandboxId}: stale tunnel cancellation failed during repair:`, error)
      }
      await tunnels.ensureMaster(input.machine)
      const repairedPort = await tunnels.addForward(input.machine, input.box.port)
      endpoint = `http://127.0.0.1:${repairedPort}`
      const repairedProbe = await probeHealthWithEvidence(endpoint, deps)
      probes.push(repairedProbe.evidence)
      if (repairedProbe.healthy) return { healthy: true, endpoint }
    } catch (error) {
      log.warn(`box ${input.box.sandboxId}: refused tunnel repair failed; continuing bounded diagnosis:`, error)
    }
  }

  const hasActiveExecution = deps.hasActiveExecution ?? sandboxHasActiveExecution
  let activeExecution = true
  try {
    activeExecution = await hasActiveExecution(input.box.sandboxId)
  } catch (error) {
    log.warn(`box ${input.box.sandboxId}: activity query failed; using active grace:`, error)
  }
  const graceBudgetMs = activeExecution
    ? (deps.establishedActiveGraceMs ?? resolveEstablishedActiveGraceMs())
    : (deps.establishedIdleGraceMs ?? resolveEstablishedIdleGraceMs())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const startedAt = now()
  let gap = deps.establishedGraceInitialGapMs ?? ESTABLISHED_GRACE_INITIAL_GAP_MS

  while (now() - startedAt < graceBudgetMs) {
    const remaining = graceBudgetMs - (now() - startedAt)
    await sleep(Math.min(gap, remaining))
    const probe = await probeHealthWithEvidence(endpoint, deps)
    probes.push(probe.evidence)
    if (probe.healthy) return { healthy: true, endpoint }

    snapshot = await inspectEstablishedBox(input.machine, input.box, deps)
    if (snapshot.error) {
      await persistBeforeCondemnation('machine_unreachable', activeExecution, graceBudgetMs)
      return { healthy: false }
    }
    // See the `idle` note above: socket up, server stood down = healthy.
    if (snapshot.liveness === 'idle') return { healthy: true, endpoint }
    if (snapshot.liveness === 'exited') {
      await persistBeforeCondemnation('exited', activeExecution, graceBudgetMs)
      return { healthy: false }
    }
    gap = Math.min(gap * 2, ESTABLISHED_GRACE_MAX_GAP_MS)
  }

  await persistBeforeCondemnation('running_http_dead', activeExecution, graceBudgetMs)
  return { healthy: false }
}

/**
 * Poll `GET <endpoint>/healthz` until it returns 2xx or the budget expires.
 * Production: a 2s interval within the {@link resolveBoxHealthBudgetMs} budget
 * (240s default — a FRESH box on a slow VM can take minutes to first accept
 * connections; see {@link DEFAULT_BOX_HEALTH_BUDGET_MS}). While waiting, logs a
 * "still waiting" progress line every {@link HEALTH_PROGRESS_LOG_INTERVAL_MS}
 * so an operator tailing logs sees the wait, not silence. On expiry throws
 * {@link BoxHealthTimeoutError} carrying the last status/error.
 */
async function pollBoxHealth(endpoint: string, deps: BoxManagerDeps): Promise<void> {
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))
  const interval = deps.healthIntervalMs ?? 2_000
  const budget = deps.healthBudgetMs ?? resolveBoxHealthBudgetMs()
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const start = now()
  let nextProgressElapsed = HEALTH_PROGRESS_LOG_INTERVAL_MS
  let lastStatus: number | undefined
  let lastError: string | undefined
  for (;;) {
    try {
      const res = await fetchFn(`${endpoint}/healthz`, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
      })
      lastStatus = res.status
      if (res.ok) return
      lastError = `status ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    const elapsed = now() - start
    if (elapsed >= budget) {
      throw new BoxHealthTimeoutError(
        `box at ${endpoint} did not become healthy within ${budget}ms (last: ${lastStatus ?? lastError})`
      )
    }
    if (elapsed >= nextProgressElapsed) {
      log.info(
        `still waiting for box health at ${endpoint} (${Math.round(elapsed / 1000)}s/${Math.round(budget / 1000)}s, ` +
          `last: ${lastStatus ?? lastError})`
      )
      // Skip forward past any intervals a slow probe swallowed (never a burst).
      while (nextProgressElapsed <= elapsed) nextProgressElapsed += HEALTH_PROGRESS_LOG_INTERVAL_MS
    }
    await sleep(interval)
  }
}

// ---------------------------------------------------------------------------
// Machine-parameterized provision seams (shared by ensureBox and box-migrate)
// ---------------------------------------------------------------------------

/** Input for {@link installBoxOnMachine} / {@link startBoxAndAwaitHealth}: the
 *  explicit machine + identity of the box being provisioned, independent of
 *  where its `machine_boxes` row currently points (the migrate primitive
 *  provisions on a TARGET machine while the row still points at the old one). */
export interface InstallBoxOpts {
  machine: Machine
  sandboxId: string
  unixUser: string
  /** The port the unit will serve (the row's bound port, or a migrate-peeked one). */
  port: number
  role: EnsureBoxOpts['role']
  /** Caller env; the machine/box-derived vars are baked on top (see derivedBoxEnv). */
  env: BoxEnv
  /** The box's executor auth token — baked into server.env (fail-closed server). */
  authToken: string
}

/**
 * Provision a box user on an EXPLICIT machine and push its server.env — the
 * box-provision.sh run (user + linger + unit [+ rootless docker]) followed by
 * the 0600 env push. Deliberately does NOT start the unit: box-provision.sh
 * defers the first activation to {@link startBoxAndAwaitHealth}'s restart so a
 * unit never boots before its fail-closed env lands — and so a migrate can
 * restore `~/.private` BETWEEN install and first start (a running box user
 * could otherwise race the restore's chmod with a symlink swap).
 */
export async function installBoxOnMachine(opts: InstallBoxOpts, deps: BoxManagerDeps = {}): Promise<void> {
  const runner = deps.runner ?? defaultSshRunner
  const clearSyncedHashes = deps.clearBoxSyncedHashes ?? clearBoxSyncedHashesReal
  const { machine, sandboxId, unixUser, port, role, authToken } = opts
  const home = boxHome(unixUser)

  // Reset the box's per-asset content-hash stamps BEFORE (re)provisioning. Every
  // path that rebuilds a box's files on a machine flows through here — a fresh
  // ensure, a park→resume re-provision, and the migrate primitive's target
  // install — and in each the machine holds NONE of the per-sandbox assets yet.
  // A stale stamp (from a prior incarnation, or carried on the row across a
  // migrate) would make file-sync SKIP that asset and leave the box missing its
  // skills/identity/env/ssh. Keyed on the sandboxId alone (never machine-guarded)
  // so it clears even while a migrate's row still points at the source machine.
  await clearSyncedHashes(sandboxId)

  // Provision the box (idempotent script). sandboxId/unixUser are single-quoted;
  // port is a DB integer. Docker-capable roles pass --with-docker so
  // box-provision stands up the box user's OWN rootless dockerd; agent (light)
  // boxes omit it (they never run containers), mirroring k8s.
  const withDocker = roleWantsDocker(role)
  // --unit-mode is passed EXPLICITLY even though the script derives the same
  // default from --sandbox-id: the manager and the script must agree on which
  // unit exists, and a silent divergence would leave every later
  // restart/stop/liveness command pointed at a unit that is not there.
  const unitMode = boxUnitControlFor({ sandboxId, unixUser }).mode
  const provisionCmd =
    `sudo bash ${BOX_PROVISION_PATH} --sandbox-id ${shellQuote(sandboxId)} ` +
    `--unix-user ${shellQuote(unixUser)} --port ${port} --unit-mode ${unitMode}` +
    `${withDocker ? ' --with-docker' : ''}`
  // box-provision creates the unix user, enables linger, and (for docker roles)
  // runs dockerd-rootless-setuptool install — the latter pulls/sets up rootless
  // docker and can take a minute+, past the SSH runner's 30s default.
  const provRes = await runner.run(machine, provisionCmd, { timeoutMs: BOX_PROVISION_RUN_TIMEOUT_MS })
  if (provRes.exitCode !== 0) {
    throw new Error(`box-provision failed for ${sandboxId} (exit ${provRes.exitCode}): ${provRes.stderr.trim()}`)
  }

  // box-provision reports the box user's useradd-assigned uid on stdout so we can
  // bake the rootless DOCKER_HOST socket path. Required for docker boxes: an
  // absent marker means we'd guess the socket, so fail loudly instead.
  const uid = parseBoxUid(provRes.stdout)
  if (withDocker && uid === null) {
    throw new Error(`box-provision did not report FICUS_BOX_UID for ${sandboxId}; cannot derive rootless DOCKER_HOST`)
  }

  // Push server.env: 0600 (secret-bearing) + chown to the box user. `install`
  // runs as root, so it lands root-owned 0600; the chown hands read to the box
  // user without widening the mode.
  const envContent = buildServerEnvContent({
    ...opts.env,
    ...derivedBoxEnv(port, role, home, authToken, uid ?? undefined),
  })
  const envPath = `${home}/.tau/server.env`
  // Reuse ssh.ts's push-file builder (0600, single-quoted path) and append the
  // chown that hands read to the box user. `install` runs as root under sudo.
  const envCmd = `sudo ${buildPushFileCommand(envPath, '0600')} && sudo chown ${unixUser}:${unixUser} ${shellQuote(envPath)}`
  const envRes = await runner.run(machine, envCmd, { stdin: envContent })
  if (envRes.exitCode !== 0) {
    throw new Error(`server.env push failed for ${sandboxId} (exit ${envRes.exitCode}): ${envRes.stderr.trim()}`)
  }

  // Push the per-box browser auth token file (R-B8/R-B2): the in-sandbox
  // tau-browser service authenticates a box by comparing sha256(bearer-token)
  // to this file's CONTENTS, so the file holds the sha256 hex DIGEST of the
  // box's executor auth token — a raw-token file would 401 every box. The
  // digest rides stdin through the SAME `install -m /dev/stdin` channel
  // server.env uses (NEVER argv — /proc/cmdline is world-readable). The tokens
  // dir is a SIBLING of /opt/tau/browser (bootstrap.sh recursively world-opens
  // /opt/tau/browser, which would expose a token placed within); the file is
  // 0640 root:tau-browser so the service (running as tau-browser) can read it
  // and the box user cannot.
  const tokenDigest = createHash('sha256').update(authToken).digest('hex')
  const tokenPath = `${BROWSER_TOKENS_DIR}/${unixUser}.token`
  const tokenCmd =
    `sudo mkdir -p ${shellQuote(BROWSER_TOKENS_DIR)} && ` +
    `sudo ${buildPushFileCommand(tokenPath, '0640')} && ` +
    `sudo chown root:tau-browser ${shellQuote(tokenPath)} && ` +
    `sudo chmod 0640 ${shellQuote(tokenPath)}`
  const tokenRes = await runner.run(machine, tokenCmd, { stdin: tokenDigest })
  if (tokenRes.exitCode !== 0) {
    // NON-FATAL: a pre-browser machine has no tau-browser group, so the chown
    // fails. Remove the half-written file (it would otherwise linger with the
    // wrong ownership) and warn — the browser feature simply stays unavailable
    // on that box until the machine gains the group; provisioning proceeds.
    await runner.run(machine, `sudo rm -f ${shellQuote(tokenPath)}`).catch(() => {})
    log.warn(
      `browser token push failed for ${sandboxId} (exit ${tokenRes.exitCode}); browser unavailable on this box (pre-browser machine?): ${tokenRes.stderr.trim()}`
    )
  }
}

/**
 * (Re)start an installed box's unit, forward its port over the machine tunnel,
 * and poll /healthz until it answers — the activation half of the provision
 * seam. Returns the local endpoint (`http://127.0.0.1:<localPort>`).
 */
export async function startBoxAndAwaitHealth(
  opts: { machine: Machine; sandboxId: string; unixUser: string; port: number },
  deps: BoxManagerDeps = {}
): Promise<string> {
  const runner = deps.runner ?? defaultSshRunner
  const tunnels = deps.tunnels ?? machineTunnels
  const { machine, sandboxId, unixUser, port } = opts

  // Restart the unit so the server picks up the new bundle + env, through the
  // one seam that knows WHICH manager owns this box's unit (system unit for a
  // light `agent_*` box, the box user's own manager otherwise) — the same
  // derivation box-provision.sh is handed as --unit-mode.
  const ctl = boxUnitControlFor({ sandboxId, unixUser })
  // Start the SOCKET first, then restart the server. The socket start is what
  // resumes a PARKED box (stopBox takes all three units down), and is an
  // idempotent no-op on a box whose socket is already listening. It is
  // deliberately tolerant of failure — a box that has not been re-provisioned
  // since this deploy has no socket unit at all, and must still restart — so
  // the compound command's exit code is the RESTART's, which is what decides
  // whether the box came up.
  // reset-failed first: the socket is enabled --now at provision, so a stray
  // connection in the window before server.env lands can crash-loop the server
  // into start-limit-hit, which a plain `restart` cannot clear. Best-effort —
  // a unit that is not failed makes it a no-op.
  const restartCmd = `${ctl.systemctl} reset-failed ${ctl.unit} 2>/dev/null || true; ${ctl.systemctl} start ${ctl.socket} 2>/dev/null || true; ${ctl.systemctl} restart ${ctl.unit}`
  const restartRes = await runner.run(machine, restartCmd)
  if (restartRes.exitCode !== 0) {
    throw new Error(
      `sandbox-server restart failed for ${sandboxId} (exit ${restartRes.exitCode}): ${restartRes.stderr.trim()}`
    )
  }

  // Establish the tunnel and wait for the server to report healthy.
  await tunnels.ensureMaster(machine)
  const localPort = await tunnels.addForward(machine, port)
  const endpoint = `http://127.0.0.1:${localPort}`
  await pollBoxHealth(endpoint, deps)
  return endpoint
}

// ---------------------------------------------------------------------------
// ensure / stop / remove / status
// ---------------------------------------------------------------------------

/**
 * Ensure a sandbox's box exists on a machine, is running the current server
 * bundle with the given env, and is reachable over a tunnel. Idempotent: an
 * already-ready box whose provisioning marker is unchanged and that still
 * passes /healthz is returned without re-provisioning. Returns the machine,
 * the box row, and the local tunnel
 * endpoint (`http://127.0.0.1:<localPort>`).
 *
 * Also returns a best-effort box-creation `timings` breakdown (`artifacts` /
 * `provision` / `start` on a full (re)provision, `health` on the fast healthy
 * path — see box-timing.ts's module doc for what each covers and why they're
 * mutually exclusive) and `priorBoxesOnMachine` (how many OTHER box rows
 * already existed on this machine — a warm-`/nix/store` proxy, see
 * {@link BoxReadyContext}), for the caller (VmSandboxManager) to fold into its
 * ONE "Box ready" summary line. `priorBoxesOnMachine` is computed ONLY on the
 * slow (re)provision path — never on the fast path, so the hot re-ensure of an
 * already-healthy box pays no extra query — and any failure to compute it is
 * swallowed (annotation only, must never fail or slow the ensure).
 */
export async function ensureBox(
  opts: EnsureBoxOpts,
  deps: BoxManagerDeps = {}
): Promise<{
  machine: Machine
  box: MachineBox
  endpoint: string
  timings: BoxStepTimings
  priorBoxesOnMachine?: number
}> {
  const tunnels = deps.tunnels ?? machineTunnels
  const ensureArtifacts = deps.ensureMachineArtifacts ?? ((m: Machine) => ensureMachineArtifactsReal(m))
  const bind = deps.bindMachineBox ?? bindMachineBoxReal
  const upsert = deps.upsertMachineBox ?? upsertMachineBoxReal
  const getBox = deps.getMachineBox ?? getMachineBoxReal
  const getMachine = deps.getMachine ?? getMachineReal
  const listBoxes = deps.listMachineBoxes ?? listMachineBoxesReal
  const timer = createBoxStepTimer(deps.now ?? Date.now)

  // Consult the existing box row BEFORE running placement. A live box must stick
  // to its recorded machine: re-running placement with a null pin could pick a
  // different (less-loaded) machine, repoint the row, and orphan the old
  // machine's unix user + unit + forward forever. Placement therefore runs only
  // for a brand-new box, an explicit machine pin, or a recorded machine that is
  // gone/not-ready.
  const existing = await getBox(opts.sandboxId)
  if (existing?.status === 'stop_unverified') throw new BoxStopUnverifiedError(opts.sandboxId)

  let machine: Machine
  if (!opts.machineId && existing) {
    const recorded = await getMachine(existing.machineId)
    if (recorded && recorded.status === 'ready') {
      machine = recorded
    } else {
      // The recorded machine is gone or not ready. Re-place onto a healthy
      // machine. Best-effort drop the stale forward now (only possible when the
      // machine record still exists). NOTE: the box-side remnants on the old
      // machine — the box_<hash> unix user, its systemd --user unit, and its
      // home dir — are NOT reclaimed by this. The orphan reconciler
      // (reconcileOrphanedBoxes) is row-based, and the re-placement below
      // repoints the machine_boxes row off the old machine, so the reconciler
      // can no longer see those remnants. A machine-side remnant sweep is a
      // follow-up (see docs/wiki/machines/runtime.md Backlog).
      log.warn(
        `box ${opts.sandboxId}: recorded machine ${existing.machineId} is ${
          recorded ? `not ready (status ${recorded.status})` : 'missing'
        }; re-placing (box-side remnants on the old machine are not reclaimed — see runtime.md Backlog)`
      )
      if (recorded) {
        try {
          await tunnels.removeForward(recorded, existing.port)
        } catch {
          // best-effort: the old machine may be unreachable
        }
      }
      machine = await resolveMachineForBox(opts.machineId, deps)
    }
  } else {
    machine = await resolveMachineForBox(opts.machineId, deps)
  }

  let restoreFromArchive = false
  if (!existing) {
    const remnant = await (deps.findUnverifiedStopRemnant ?? findUnverifiedStopRemnantReal)(
      machine.id,
      boxUnixUser(opts.sandboxId)
    )
    if (remnant) {
      const retire =
        deps.retireUnverifiedStopRemnant ??
        ((candidate: MachineBox, ownerId: string, role: EnsureBoxOpts['role']) =>
          removeBox(candidate.sandboxId, { archivePrivate: role !== 'squad', archiveOwnerId: ownerId }, deps))
      await retire(remnant, opts.sandboxId, opts.role)
      restoreFromArchive = opts.role !== 'squad'
    }
  }

  // Guard: a machine that forbids TCP forwarding cannot host a tunnel-reached
  // box. Fail loudly BEFORE any mutation (bundle push, bind, provision).
  if (machine.capabilities.forwarding === 'no') {
    throw new MachineUnusableError(
      `machine ${machine.name} has AllowTcpForwarding=no; it cannot host tunnel-reached boxes`
    )
  }

  // Validate the caller env before any mutation so a hostile/malformed value
  // fails fast rather than half-provisioning a box.
  assertValidBoxEnv(opts.env)

  let finishPhysicalWork: ((outcome: 'ready' | 'failed') => void) | undefined
  const beginPhysicalWork = (reason: 'runtime_start' | 'runtime_reconnect' | 'spec_reconcile') => {
    finishPhysicalWork ??= opts.beginPhysicalWork?.(reason)
  }
  const finishPhysicalReady = () => {
    finishPhysicalWork?.('ready')
    finishPhysicalWork = undefined
  }

  try {
    // Migrate-with-teardown (the slice-5 correctness fix): an EXPLICIT pin that
    // differs from where the box currently lives means the operator moved the box
    // to another machine. Binding straight onto the new machine (below) would
    // repoint the row via bindMachineBox and ORPHAN the old machine's unix user +
    // systemd unit + tunnel forward forever. So tear the OLD box down FIRST
    // (removeForward → optional private-archive pull → box-provision --remove →
    // delete row) and only THEN fall through to a clean provision on the new
    // machine. The private tree is archived for the roles that own one
    // (agent/system-manager) and skipped for squad boxes, mirroring
    // VmSandboxManager.removeSandbox's `!squad` rule. This runs AFTER the fail-fast
    // guards (forwarding, env) so a rejected migrate never tears down a live box,
    // and BEFORE the fast-path/bind below.
    //
    // No-stale-client invariant: the only production caller — VmSandboxManager
    // ._ensureSandbox — closes and recreates its in-memory SandboxClient on every
    // ensure (see manager.ts: `if (existing) existing.client.close()`), so the
    // torn-down box's client is always dropped when the migrate is driven through
    // the manager. The teardown therefore goes through box-manager.removeBox
    // (never a stale manager client) and stays layering-safe.
    //
    // CRITICAL: this branch fires for TWO distinct cases, because ensureBox's only
    // production caller always passes a CONCRETE machineId (placement runs once,
    // upstream). The teardown is correct for only one of them, so gate it on the
    // OLD recorded machine still being reachable (exists AND `ready`):
    //  - operator moved a LIVE box (old machine ready) → tear the old box down
    //    first (below), THEN rebind on the new machine.
    //  - placement re-placed a box OFF a DEAD machine (old machine gone/not-ready)
    //    → there is nothing reachable to tear down; every removeBox step SSHes the
    //    unreachable host and would THROW, failing ensure for the whole outage. So
    //    SKIP the teardown and just rebind on the new machine. The DB row and the
    //    tunnel forward are cleaned up, but the dead machine's box-side remnants
    //    (box_<hash> user, systemd --user unit, home dir) are NOT reclaimed: the
    //    orphan reconciler is row-based and this rebind repoints the only row that
    //    pointed at them, so it can't see them. A machine-side remnant sweep is a
    //    follow-up (docs/wiki/machines/runtime.md Backlog).
    if (existing && opts.machineId && existing.machineId !== machine.id) {
      const oldMachine = await getMachine(existing.machineId)
      if (oldMachine && oldMachine.status === 'ready') {
        log.info(
          `box ${opts.sandboxId}: pin moved from machine ${existing.machineId} to ${machine.id}; ` +
            `tearing down the old box before rebinding on the new machine`
        )
        // Belt-and-suspenders: a `ready` machine can go unreachable between the
        // check above and the teardown. A teardown failure must NOT block the
        // rebind — removeBox throws BEFORE it deletes the box row, so bind() below
        // simply repoints the row onto the new machine. NOTE: on such a failed
        // teardown the old machine's box-side remnants (box_<hash> user, systemd
        // --user unit, home dir) are NOT reclaimed — the orphan reconciler is
        // row-based and the rebind repoints the only row that pointed at them, so
        // it can no longer see them. A machine-side remnant sweep is a follow-up
        // (see docs/wiki/machines/runtime.md Backlog).
        beginPhysicalWork('spec_reconcile')
        try {
          await removeBox(opts.sandboxId, { archivePrivate: opts.role !== 'squad' }, deps)
        } catch (err) {
          log.warn(
            `box ${opts.sandboxId}: migrate teardown of the old box on ${existing.machineId} failed; ` +
              `rebinding on ${machine.id} anyway (old machine's box-side remnants are not reclaimed — see runtime.md Backlog): ${
                err instanceof Error ? err.message : String(err)
              }`
          )
        }
      } else {
        log.info(
          `box ${opts.sandboxId}: recorded machine ${existing.machineId} is ${
            oldMachine ? `not ready (status ${oldMachine.status})` : 'gone'
          }; skipping migrate teardown and rebinding on ${machine.id} ` +
            `(old machine's box-side remnants are not reclaimed — see runtime.md Backlog)`
        )
      }
    }

    const unixUser = boxUnixUser(opts.sandboxId)

    // Fast path: a box already marked ready on THIS machine that still answers
    // /healthz needs no re-provision. Health is verified every time. A LEGACY box
    // whose row predates the executor auth token (authToken null) is deliberately
    // excluded: it must take the full path ONCE so a token is minted, pushed into
    // its server.env, and its unit restarted — that full pass is also what
    // delivers the current server bundle (bind 127.0.0.1 + 401 enforcement) to
    // boxes provisioned before the hardening.
    // The provisioning marker (spec hash + a hash of the caller env — see
    // computeProvisioningMarker) must ALSO still match. Without this, a change to
    // the box's env/secrets (a rotated token, or a squad's githubIdentity override
    // being set) never reaches an already-running box: the health-only fast path
    // returned it as-is and never re-pushed server.env, so the box kept its
    // provisioned-time credentials until a park/resume or recreate. A drifted
    // marker falls through to a full (re)provision — which re-pushes server.env
    // and restarts the unit — exactly as the PARKED-box resume fast path below
    // already does. A legacy row (null provisionedSpecHash) also falls through,
    // self-healing its stamp on the next provision, mirroring the authToken rule.
    if (
      existing &&
      existing.machineId === machine.id &&
      existing.status === 'ready' &&
      existing.authToken &&
      existing.provisionedSpecHash === opts.specHash
    ) {
      const healthy = await timer.time('health', async () => {
        await tunnels.ensureMaster(machine)
        const localPort = await tunnels.addForward(machine, existing.port)
        const endpoint = `http://127.0.0.1:${localPort}`
        // The caller already saw this box's port listening on its machine (see
        // EnsureBoxOpts.liveness). Under socket activation that is the health
        // signal, and probing would WAKE a box that is deliberately stood down.
        // The forward above is set up either way — establishing an SSH -L does
        // not connect to the box port — so the endpoint stays usable the moment
        // someone actually has work for it.
        if (opts.liveness === 'listening') return { ok: true, endpoint }
        // A failed HTTP recheck is not enough to destroy an established box:
        // consult the host, apply work-aware bounded grace, and persist the full
        // reason chain before allowing the slow recreate path to mutate it.
        const decision = await evaluateEstablishedBox({ endpoint, machine, box: existing }, deps)
        return { ok: decision.healthy, endpoint: decision.healthy ? decision.endpoint : endpoint }
      })
      if (healthy.ok) {
        return { machine, box: existing, endpoint: healthy.endpoint, timings: timer.steps }
      }
      // Unhealthy → fall through to a full (re-)provision below.
    }

    // Resume fast path: a PARKED box (status 'stopped') whose on-machine
    // provisioning is STILL up to date — its stamped `provisionedSpecHash`
    // (recorded at the end of the full provision that last made it 'ready')
    // matches the caller's freshly computed `opts.specHash` — needs no
    // box-provision.sh re-run. box-provision.sh already ran successfully for
    // this exact spec, and file-sync's own per-asset content-hash skip
    // (syncBoxFiles, driven by the UNTOUCHED `syncedHashes` stamp — resume never
    // calls clearBoxSyncedHashes) means the caller's later asset sync is a
    // near-no-op too, so the only real work left is restart + tunnel + health.
    //
    // Same legacy-row exclusion as the healthy fast path: a null authToken or a
    // null/mismatched provisionedSpecHash (never recorded, or the box's spec
    // genuinely changed — e.g. recreateSandbox's stop-then-reensure after a
    // drift detection, or a legacy row predating this column) falls through to
    // the full path below — a slow correct ensure beats a fast broken box. A
    // start that fails to come healthy ALSO falls through rather than
    // propagating: the caller only ever sees a hard failure once the full path
    // itself fails.
    if (
      existing &&
      existing.machineId === machine.id &&
      existing.status === 'stopped' &&
      existing.authToken &&
      existing.provisionedSpecHash != null &&
      existing.provisionedSpecHash === opts.specHash
    ) {
      beginPhysicalWork('runtime_start')
      try {
        // Stamp 'ensuring' before the restart/health window (mirrors the full
        // path's own pre-provision stamp below) so a concurrent boxStatus()/
        // boxChainHealth() observer during the ~2-3s restart+health wait reads
        // 'starting' rather than the stale 'stopped' — the box IS mid-transition,
        // not sitting parked. No `box.status` event here (matches the full
        // path's 'ensuring' stamp, which also emits nothing); only the terminal
        // 'ready' transition below announces.
        await upsert({
          sandboxId: existing.sandboxId,
          machineId: existing.machineId,
          unixUser,
          port: existing.port,
          status: 'ensuring',
          authToken: existing.authToken,
        })
        const endpoint = await timer.time('start', () =>
          startBoxAndAwaitHealth({ machine, sandboxId: opts.sandboxId, unixUser, port: existing.port }, deps)
        )
        const readyBox = await upsert({
          sandboxId: existing.sandboxId,
          machineId: existing.machineId,
          unixUser,
          port: existing.port,
          status: 'ready',
          authToken: existing.authToken,
          lastActivityAt: new Date(),
        })
        eventEmitter.emit('box.status', {
          sandboxId: readyBox.sandboxId,
          machineId: readyBox.machineId,
          status: 'ready',
          port: readyBox.port,
        })
        finishPhysicalReady()
        return { machine, box: readyBox, endpoint, timings: timer.steps }
      } catch (err) {
        log.warn(
          `box ${opts.sandboxId}: resume fast path failed (restart/tunnel/health) on machine ${machine.id}; ` +
            `falling back to a full (re)provision: ${err instanceof Error ? err.message : String(err)}`
        )
        // Fall through to the full (re)provision below.
      }
    }

    // Best-effort box-creation annotation: how many OTHER box rows already exist
    // on this machine (a warm-/nix/store proxy — see this function's doc). Only
    // reached on the slow (re)provision path below, so the fast path above never
    // pays this query. Never allowed to fail or slow the ensure.
    let priorBoxesOnMachine: number | undefined
    try {
      const siblings = await listBoxes(machine.id)
      priorBoxesOnMachine = siblings.filter((b) => b.sandboxId !== opts.sandboxId).length
    } catch (err) {
      log.warn(`Failed to compute priorBoxesOnMachine for ${opts.sandboxId} (annotation only, non-fatal):`, err)
    }

    // A previously-provisioned box taking the full path means an env re-push
    // and a systemd unit RESTART — every process on the box (agent commands,
    // terminal shells) dies. When the trigger is a marker mismatch, say which
    // half drifted: a "spec hash drifted" line here on a box nobody upgraded
    // is the one-log signature of a caller stamping non-canonical inputs (the
    // 2026-09-01 terminal bug: partial-opts ensures ping-ponged the marker and
    // restarted boxes at a ~60s drumbeat).
    if (
      (existing?.status === 'ready' || existing?.status === 'stopped') &&
      existing.provisionedSpecHash !== opts.specHash &&
      opts.specHash
    ) {
      log.info(
        `box ${opts.sandboxId}: full re-provision (env re-push + unit restart) because the provisioning ` +
          `marker drifted: ${describeProvisioningMarkerDrift(existing.provisionedSpecHash, opts.specHash)}`
      )
    }

    beginPhysicalWork(
      existing?.status === 'ready'
        ? existing.provisionedSpecHash === opts.specHash
          ? 'runtime_reconnect'
          : 'spec_reconcile'
        : 'runtime_start'
    )
    await timer.time('artifacts', () => ensureArtifacts(machine))
    const bound = await bind({ sandboxId: opts.sandboxId, machineId: machine.id, unixUser })

    // The box's executor auth token: minted ATOMICALLY inside bindMachineBox
    // (COALESCE in the bind upsert — the first writer's token wins and is never
    // overwritten), so `bound` always carries the row's persisted token. Minting
    // it HERE, after the bind, would race: two concurrent full ensures of the
    // same brand-new box (api + worker) would each mint a different token, each
    // push their own server.env + restart, and the row could end on one token
    // while the running server enforces the other — /healthz (exempt) keeps
    // passing, every real route 401s, and the box is wedged until a re-provision.
    // Stable across ensures and mid-provision retries by the same COALESCE.
    const authToken = bound.authToken
    if (!authToken) {
      // bindMachineBox guarantees a token on every row it returns; a null here is
      // a broken invariant, and pushing a token-less server.env would boot an
      // unauthenticated executor. Fail loudly instead.
      throw new Error(`bindMachineBox returned no auth token for ${opts.sandboxId}`)
    }

    // Stamp the row 'ensuring' now that a real (re-)provision is under way, so a
    // concurrent observer never mistakes a box mid-provision for a healthy one.
    // (A brand-new box already inserts as 'ensuring'; `bind` keeps the prior
    // 'ready' on a re-provision, so stamp it explicitly here — never on the
    // healthy fast-path above, which returns before this point.)
    const box = await upsert({
      sandboxId: bound.sandboxId,
      machineId: bound.machineId,
      unixUser,
      port: bound.port,
      status: 'ensuring',
      authToken,
    })

    // Provision on the machine (script + server.env), then first-start + health.
    // Both phases are the shared machine-parameterized seams the migrate
    // primitive reuses. Only explicit inline remnant recovery restores an
    // owner archive between them; ordinary fresh boxes always start clean.
    //
    // `provision` timing note: for docker-capable roles (squad, system-manager)
    // installBoxOnMachine's SINGLE box-provision.sh SSH call also runs the box's
    // rootless dockerd install/enable/restart — see box-timing.ts's BOX_STEP_ORDER
    // doc for why that can't be isolated into its own step without a disallowed
    // second SSH round trip.
    await timer.time('provision', () =>
      installBoxOnMachine(
        { machine, sandboxId: opts.sandboxId, unixUser, port: box.port, role: opts.role, env: opts.env, authToken },
        deps
      )
    )
    if (restoreFromArchive) {
      const archivePath = await (
        deps.findPrivateArchive ?? ((sandboxId: string) => findLatestPrivateArchive(sandboxId, deps))
      )(opts.sandboxId)
      if (archivePath) {
        await restorePrivateArchive(
          deps.runner ?? defaultSshRunner,
          machine,
          opts.sandboxId,
          boxHome(unixUser),
          archivePath,
          deps
        )
      }
    }
    const endpoint = await timer.time('start', () =>
      startBoxAndAwaitHealth({ machine, sandboxId: opts.sandboxId, unixUser, port: box.port }, deps)
    )

    const readyBox = await upsert({
      sandboxId: box.sandboxId,
      machineId: box.machineId,
      unixUser,
      port: box.port,
      status: 'ready',
      authToken,
      // Record what was JUST provisioned so a later park→resume can trust the
      // resume fast path above (a match skips this whole slow path). `null`
      // when the caller supplied no specHash (only legacy/test callers) so a
      // future ensure never mistakes an unknown provisioned state for a match.
      provisionedSpecHash: opts.specHash ?? null,
      reconcilableSpecHash: opts.env.FICUS_BOX_SPEC_HASH ?? null,
      // Seed the cross-process activity heartbeat so every ready box has a
      // baseline: the idle reaper (worker) reads max(process-local, row) and a
      // box ensured by ANOTHER process would otherwise carry no activity signal
      // at all — unreapable forever if never exec'd (bill leak).
      lastActivityAt: new Date(),
    })
    // Announce the ready box AFTER the row is persisted so a UI subscriber sees a
    // ready box the moment it refetches. Keyed by machineId (the machine detail
    // view lists its boxes); the sandboxId carries no secret material.
    eventEmitter.emit('box.status', {
      sandboxId: readyBox.sandboxId,
      machineId: readyBox.machineId,
      status: 'ready',
      port: readyBox.port,
    })
    finishPhysicalReady()
    return { machine, box: readyBox, endpoint, timings: timer.steps, priorBoxesOnMachine }
  } catch (error) {
    finishPhysicalWork?.('failed')
    throw error
  }
}

export async function findLatestPrivateArchive(
  sandboxId: string,
  deps: Pick<BoxManagerDeps, 'getArchiveRoot'> = {}
): Promise<string | null> {
  const root = (deps.getArchiveRoot ?? getPrivateArchiveRoot)()
  try {
    const prefix = `${sandboxId}-`
    const candidates = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => ({ entry: entry.name, timestamp: Number(entry.name.slice(prefix.length)) }))
      .filter((candidate) => Number.isFinite(candidate.timestamp))
      .sort((a, b) => b.timestamp - a.timestamp)
    return candidates[0] ? join(root, candidates[0].entry, 'private.tar.gz') : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Pull the box's `~/.private` tree as a gzip'd tar and write it to the core's
 * private-archive root.
 *
 * The archive is written as `<sandboxId>-<epochMillis>/private.tar.gz` — a
 * per-archive DIRECTORY named for its trailing epoch, mirroring the k8s agent
 * archives. This is load-bearing for reclamation: the janitor
 * `purgeExpiredAgentPrivateArchives` (services/sandbox/private-archive.ts) reads
 * each entry directly under the archive root and removes only those whose name
 * matches `/-(\d+)$/`, via a recursive `rmSync` that handles directories. A bare
 * `<sandboxId>-<epochMillis>.tar.gz` FILE would never match that trailing-epoch
 * regex (the `.tar.gz` suffix breaks it) and would leak on disk forever.
 *
 * The tar stream is base64-wrapped on the wire because {@link SshRunner}
 * surfaces stdout as a UTF-8 string, which would otherwise mangle raw archive
 * bytes; base64 preserves them losslessly.
 *
 * Returns the core-side path of the written archive (`.../private.tar.gz`),
 * which {@link restorePrivateArchive} can push back onto a box. NOTE: box
 * MIGRATION no longer uses this pair — it streams host→host and never writes a
 * core-side archive. What remains of this path is the at-rest teardown artifact
 * (see the at-rest note further down).
 */
/**
 * Build the machine-side archive command for `dirs` (home-relative), gzip-tar
 * piped through base64. Every member is guarded by `test -d` so a missing dir is
 * skipped instead of failing the whole pull; when NONE exist the archive is
 * empty (`--files-from /dev/null`).
 *
 * The single-dir case renders BYTE-IDENTICALLY to the command shipped before
 * squad archiving existed — the regression pin (and the teardown/removeBox
 * callers that still archive `.private` only) depend on this exact shape.
 */
function buildArchivePullCommand(home: string, dirs: string[]): string {
  const q = shellQuote(home)
  if (dirs.length === 1) {
    const d = dirs[0]
    return (
      `if sudo test -d ${q}/${d}; then sudo tar czf - -C ${q} ${d}; ` +
      `else sudo tar czf - -C ${q} --files-from /dev/null; fi | base64 -w0`
    )
  }
  // Multi-dir (squad: workspace + .private): collect the members that exist,
  // then tar exactly those (empty archive when none). Dir names are fixed
  // literals from durableStateDirsForRole, so unquoted `$m` word-splitting is safe.
  const dirList = dirs.join(' ')
  return (
    `m=''; for d in ${dirList}; do sudo test -d ${q}/"$d" && m="$m $d"; done; ` +
    `if [ -n "$m" ]; then sudo tar czf - -C ${q} $m; ` +
    `else sudo tar czf - -C ${q} --files-from /dev/null; fi | base64 -w0`
  )
}

export async function pullPrivateArchive(
  runner: SshRunner,
  machine: Machine,
  sandboxId: string,
  home: string,
  deps: BoxManagerDeps,
  opts: { stateDirs?: string[]; timeoutMs?: number } = {}
): Promise<string> {
  const getArchiveRoot = deps.getArchiveRoot ?? getPrivateArchiveRoot
  const writeArchiveFile =
    deps.writeArchiveFile ??
    (async (dest: string, bytes: Uint8Array) => {
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, bytes)
    })
  const now = deps.now ?? Date.now

  // Which home-relative dirs to archive. Defaults to `.private` — byte-identical
  // to the pre-squad behavior every non-migrate caller (teardown/removeBox)
  // still relies on; migration passes the role-derived set (squad adds
  // ~/workspace, its authoritative state).
  const stateDirs = opts.stateDirs ?? ['.private']

  // A half-provisioned box may never have gotten its ~/.private (box-provision
  // creates it, but a box that failed earlier can lack it), and a squad box may
  // have a workspace but no .private (or vice versa). `tar` on a missing member
  // exits non-zero, which — under a pipefail login shell — fails the pull and
  // wedges removal/migration forever. Treat every missing member as absent (an
  // EMPTY archive when NONE exist) so the caller always proceeds.
  const cmd = buildArchivePullCommand(home, stateDirs)
  const res = await runner.run(machine, cmd, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined)
  if (res.exitCode !== 0) {
    throw new Error(`private archive pull failed for ${sandboxId} (exit ${res.exitCode}): ${res.stderr.trim()}`)
  }
  const bytes = new Uint8Array(Buffer.from(res.stdout.trim(), 'base64'))
  // Swept segment is the `<sandboxId>-<epochMillis>` directory; keep it matching
  // the janitor's `/-(\d+)$/` on its trailing epoch.
  const dest = join(getArchiveRoot(), `${sandboxId}-${now()}`, 'private.tar.gz')
  await writeArchiveFile(dest, bytes)
  return dest
}

/**
 * Restore a previously pulled `~/.private` archive onto a (new) box — the
 * reverse of {@link pullPrivateArchive}, and the foundation the box migrate
 * primitive builds on. Reads the core-side tar at `archivePath` (a
 * `.../private.tar.gz` the pull wrote), pushes its bytes to a machine-side
 * scratch path (root-installed 0600, so no co-located box user can read the
 * private tree in transit), then runs `box-provision.sh --restore`, which
 * extracts it into the box HOME (the tar's top member is `.private`) and
 * re-owns/locks the tree (box user, 0700). Idempotent: re-restoring simply
 * overwrites.
 *
 * An ABSENT or empty archive file is a successful NO-OP (no push, no error) —
 * the mirror of pullPrivateArchive's tolerance for a box that never had a
 * `~/.private` (which it pulls as an EMPTY archive).
 *
 * `home` is accepted for signature parity with {@link pullPrivateArchive};
 * box-provision.sh resolves the box HOME itself (getent) on the restore side.
 */
export async function restorePrivateArchive(
  runner: SshRunner,
  machine: Machine,
  sandboxId: string,
  home: string,
  archivePath: string,
  deps: BoxManagerDeps = {},
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const readArchiveFileFn =
    deps.readArchiveFile ??
    (async (src: string): Promise<Uint8Array | null> => {
      try {
        return await readFile(src)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    })

  const bytes = await readArchiveFileFn(archivePath)
  if (!bytes || bytes.byteLength === 0) return

  const unixUser = boxUnixUser(sandboxId)
  const scratchPath = `/tmp/tau-restore-${sandboxId}.tar.gz`
  // Reuse ssh.ts's push-file builder (quoted path, validated mode); `install`
  // runs under sudo so the 0600 scratch tar lands root-owned.
  const pushCmd = `sudo ${buildPushFileCommand(scratchPath, '0600')}`
  // A multi-GB squad workspace tar must not die on the runner's 30s default;
  // migration passes a large budget (the scratch push AND the extraction both
  // scale with archive size). Absent = runner default (non-migrate callers).
  const runOpts = opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined
  const pushRes = await runner.run(machine, pushCmd, { stdin: bytes, ...runOpts })
  if (pushRes.exitCode !== 0) {
    throw new Error(`private archive push failed for ${sandboxId} (exit ${pushRes.exitCode}): ${pushRes.stderr.trim()}`)
  }

  const restoreCmd =
    `sudo bash ${BOX_PROVISION_PATH} --unix-user ${shellQuote(unixUser)} ` + `--restore ${shellQuote(scratchPath)}`
  try {
    const res = await runner.run(machine, restoreCmd, runOpts)
    if (res.exitCode !== 0) {
      throw new Error(`box-provision --restore failed for ${sandboxId} (exit ${res.exitCode}): ${res.stderr.trim()}`)
    }
  } finally {
    // The scratch tar is a full copy of the box's private tree sitting in the
    // machine-shared /tmp (root-owned 0600). Remove it win or lose; best-effort
    // — a failed rm must never mask the restore's own outcome.
    try {
      await runner.run(machine, `sudo rm -f ${shellQuote(scratchPath)}`)
    } catch {
      // best-effort cleanup only
    }
  }
}

// ---------------------------------------------------------------------------
// Streamed state archives (the migration transport)
//
// A migration moves a box's authoritative state (a squad's ~/workspace can be
// multi-GB) between two machines. It does that by piping the SOURCE's `tar c`
// stdout directly into the DESTINATION's `box-provision.sh --restore-stream`
// stdin, so the payload is never materialized: not as a JS string, not as a
// core-side file, and not as scratch on either host (staging would need
// transient headroom equal to the workspace on BOTH machines — and disk
// pressure is frequently the very reason a migration is happening).
//
// The at-rest path ({@link pullPrivateArchive} / {@link restorePrivateArchive})
// is deliberately untouched: teardown genuinely needs a FILE under core's
// archive root that a later box can restore from.
// ---------------------------------------------------------------------------

/** Compression codec for a streamed state archive. */
export type ArchiveCodec = 'zstd' | 'gzip'

/** How the codec is chosen. `auto` (default) probes both hosts; an explicit
 *  value pins the CANDIDATE, which is still verified on both hosts. */
export type ArchiveCodecPreference = 'auto' | ArchiveCodec

/**
 * Codec preference, `FICUS_BOX_ARCHIVE_CODEC`-overridable. Deliberately NOT
 * maximum compression: a migration is a same-datacenter transfer where CPU,
 * not bandwidth, is the constraint, so `xz -9` would be slower end to end than
 * a fast codec. zstd's own DEFAULT level is 3 — the fast end — which is why
 * {@link tarCodecFlag} needs no level argument.
 */
const ARCHIVE_CODEC_PREFERENCE = ((): ArchiveCodecPreference => {
  const raw = process.env.FICUS_BOX_ARCHIVE_CODEC
  return raw === 'zstd' || raw === 'gzip' ? raw : 'auto'
})()

/** tar's own flag for each codec (see {@link ARCHIVE_CODEC_PREFERENCE} on why
 *  no explicit level is passed). The SAME mapping is used to write on the
 *  source and to read on the destination, so the two can never disagree. */
export function tarCodecFlag(codec: ArchiveCodec): string {
  return codec === 'zstd' ? '--zstd' : '-z'
}

/**
 * FUNCTIONAL zstd probe, printing `zstd` or `gzip` (the floor: gzip is
 * universally present in the target OS baseline).
 *
 * It is a full WRITE→READ round trip, not `command -v zstd` and not a
 * create-only check, because those are not the same capability: libarchive's
 * bsdtar happily CREATES a `--zstd` archive and then fails to EXTRACT one
 * ("Error opening archive: Child process exited with status 1" — observed on
 * bsdtar 3.5.3). A host like that would pass a create-only probe and then be
 * handed an archive it cannot read, which is precisely the corruption this
 * detection exists to prevent. `pipefail` (in an explicit `bash -c`, so the
 * login shell's flavor is irrelevant) is required because `tar -t` on EMPTY
 * input exits 0 — without it a failing producer would read as success.
 *
 * It runs under `sudo`, because the TRANSFER does: the source runs `sudo tar
 * -c` and the destination runs `sudo bash box-provision.sh`. sudo resolves
 * binaries through its own `secure_path`, NOT the login user's PATH, so a host
 * where zstd exists only on the login user's PATH would pass an unprivileged
 * probe and then fail every transfer. `-n` keeps it non-interactive: a host
 * whose sudo wants a password fails the probe instantly and degrades to gzip
 * (the safe direction) instead of hanging on a tty prompt mid-migration. The
 * `if`/`else` always exits 0 and always prints a verdict, so a refused sudo is
 * an ordinary `gzip` answer rather than an unparseable one.
 */
export const ARCHIVE_CODEC_PROBE_COMMAND =
  `if sudo -n bash -c 'set -o pipefail; command -v zstd >/dev/null 2>&1 && ` +
  `tar -c --zstd -f - --files-from /dev/null 2>/dev/null | tar -t --zstd -f - >/dev/null 2>&1'; ` +
  `then echo zstd; else echo gzip; fi`

/**
 * Decide the ONE codec a transfer writes AND reads with, by proving every
 * participating host can handle it. A codec is only upgraded from gzip when
 * EVERY host answers `zstd`; a failed/ambiguous probe degrades to gzip.
 *
 * This is the whole "never silently produce an archive the destination cannot
 * read" guarantee: the result is a single value threaded into both the source
 * tar command and the destination restore command, so a write/read mismatch is
 * not expressible.
 */
export async function detectArchiveCodec(
  runner: SshRunner,
  machines: Machine[],
  opts: { preference?: ArchiveCodecPreference } = {}
): Promise<ArchiveCodec> {
  const preference = opts.preference ?? ARCHIVE_CODEC_PREFERENCE
  if (preference === 'gzip') return 'gzip'

  const answers = await Promise.all(
    machines.map(async (machine) => {
      try {
        const res = await runner.run(machine, ARCHIVE_CODEC_PROBE_COMMAND)
        return res.exitCode === 0 ? res.stdout.trim() : 'gzip'
      } catch (err) {
        log.warn(
          `archive codec probe failed on machine ${machine.name} (falling back to gzip): ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        return 'gzip'
      }
    })
  )
  if (answers.every((answer) => answer === 'zstd')) return 'zstd'
  if (preference === 'zstd') {
    log.warn(`FICUS_BOX_ARCHIVE_CODEC=zstd but not every host can produce a zstd tar; using gzip on both ends`)
  }
  return 'gzip'
}

/** Home-relative state dir names are interpolated UNQUOTED into the remote
 *  shell's `for` list (they are fixed literals from {@link durableStateDirsForRole}),
 *  so re-assert that here rather than trusting the caller. */
function assertSafeStateDirs(dirs: string[]): void {
  for (const dir of dirs) {
    if (!/^[A-Za-z0-9._-]+$/.test(dir) || dir === '.' || dir === '..') {
      throw new Error(`invalid box state dir '${dir}' (must be a plain path segment)`)
    }
  }
}

/**
 * SOURCE-side command: tar the state dirs that exist straight to stdout.
 *
 * Two properties are load-bearing and pinned by tests:
 *  - NO base64 (the payload is binary on the wire, never a 33%-inflated string);
 *  - NO trailing pipe. A shell pipeline's exit status is its LAST element's, so
 *    the old `| base64 -w0` tail would have reported success for a tar that
 *    died halfway. Here `tar` IS the command whose status ssh reports, which is
 *    what lets the caller tell a truncated stream from a complete one.
 * The per-member `test -d` guard and the `--files-from /dev/null` fallback are
 * carried over unchanged: a box missing a state dir must not fail the tar.
 */
export function buildArchiveStreamCommand(home: string, dirs: string[], codec: ArchiveCodec): string {
  assertSafeStateDirs(dirs)
  const q = shellQuote(home)
  const flag = tarCodecFlag(codec)
  const dirList = dirs.join(' ')
  return (
    `m=''; for d in ${dirList}; do sudo test -d ${q}/"$d" && m="$m $d"; done; ` +
    `if [ -n "$m" ]; then sudo tar -c ${flag} -f - -C ${q} $m; ` +
    `else sudo tar -c ${flag} -f - -C ${q} --files-from /dev/null; fi`
  )
}

/**
 * DESTINATION-side command: extract the streamed tar from stdin into the box
 * HOME and re-own/lock the restored trees, via box-provision.sh's
 * `--restore-stream` mode — the streaming sibling of `--restore`, sharing that
 * script's ownership logic (box user, ~/workspace 0755, private trees 0700) so
 * a streamed restore ends in exactly the state a file restore does.
 *
 * This restore-only caller intentionally omits `--port`: restore-stream neither
 * starts nor configures/connects to the sandbox server. The script therefore
 * treats an omitted port as safe in this mode while still validating one if a
 * future caller explicitly supplies it.
 *
 * `--codec` is the SAME value the source wrote with; `--state-dirs` is the
 * role-derived set, needed because a stream can only be read ONCE (the file
 * path re-reads the tar to learn its members).
 */
interface ShellArg {
  value: string
  quoted: boolean
}

function renderShellArgs(args: readonly ShellArg[]): string {
  return args.map(({ value, quoted }) => (quoted ? shellQuote(value) : value)).join(' ')
}

function buildStreamRestoreArgs(unixUser: string, dirs: string[], codec: ArchiveCodec, stagingId: string): ShellArg[] {
  assertSafeStateDirs(dirs)
  return [
    { value: '--unix-user', quoted: false },
    { value: unixUser, quoted: true },
    { value: '--restore-stream', quoted: false },
    { value: '--codec', quoted: false },
    { value: codec, quoted: false },
    { value: '--state-dirs', quoted: false },
    { value: dirs.join(' '), quoted: true },
    { value: '--staging-id', quoted: false },
    { value: stagingId, quoted: true },
  ]
}

export function buildStreamRestoreCommand(
  unixUser: string,
  dirs: string[],
  codec: ArchiveCodec,
  stagingId = '00000000-0000-4000-8000-000000000000'
): string {
  return `sudo bash ${BOX_PROVISION_PATH} ${renderShellArgs(buildStreamRestoreArgs(unixUser, dirs, codec, stagingId))}`
}

/** Observable facts about one home-relative state dir on a box. */
export interface StateDirFacts {
  present: boolean
  /** Owning unix user (`''` when absent). */
  owner: string
  /** Octal permission bits as `stat -c %a` reports them (`''` when absent). */
  mode: string
  /** Top-level entry count — an O(entries) probe, never a full-tree walk. */
  entries: number
}

/** The mode box-provision.sh's restore applies to a state dir. Mirrored here so
 *  destination verification demands back exactly what the script promises (a
 *  root-owned or mis-moded ~/workspace is a functionally dead squad box). */
export function expectedStateDirMode(dir: string): string {
  return dir === 'workspace' ? '755' : '700'
}

/**
 * Probe command for {@link StateDirFacts}, one line per dir:
 *   `<dir> present <owner>:<mode> <entries>` / `<dir> absent - 0`
 */
export function buildStateDirFactsCommand(home: string, dirs: string[]): string {
  assertSafeStateDirs(dirs)
  const q = shellQuote(home)
  const dirList = dirs.join(' ')
  return (
    `for d in ${dirList}; do ` +
    `if sudo test -d ${q}/"$d"; then ` +
    `printf '%s present %s %s\\n' "$d" ` +
    `"$(sudo stat -c '%U:%a' ${q}/"$d")" ` +
    `"$(sudo find ${q}/"$d" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"; ` +
    `else printf '%s absent - 0\\n' "$d"; fi; done`
  )
}

/** Parse {@link buildStateDirFactsCommand}'s output. */
export function parseStateDirFacts(stdout: string): Record<string, StateDirFacts> {
  const facts: Record<string, StateDirFacts> = {}
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length !== 4) continue
    const [dir, presence, ownerMode, entries] = parts
    if (presence !== 'present') {
      facts[dir] = { present: false, owner: '', mode: '', entries: 0 }
      continue
    }
    const sep = ownerMode.lastIndexOf(':')
    facts[dir] = {
      present: true,
      owner: sep >= 0 ? ownerMode.slice(0, sep) : ownerMode,
      mode: sep >= 0 ? ownerMode.slice(sep + 1) : '',
      entries: Number(entries) || 0,
    }
  }
  return facts
}

/**
 * Measure a box's state dirs over SSH. Throws when the probe fails OR when any
 * requested dir is missing from the reply: an unmeasurable box must never be
 * ASSUMED intact — that assumption is exactly how a migration "succeeds" onto
 * an empty workspace.
 */
export async function measureBoxStateDirs(
  runner: SshRunner,
  machine: Machine,
  sandboxId: string,
  home: string,
  dirs: string[],
  opts: { timeoutMs?: number } = {}
): Promise<Record<string, StateDirFacts>> {
  const res = await runner.run(
    machine,
    buildStateDirFactsCommand(home, dirs),
    opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined
  )
  if (res.exitCode !== 0) {
    throw new Error(`state dir probe failed for ${sandboxId} (exit ${res.exitCode}): ${res.stderr.trim()}`)
  }
  const facts = parseStateDirFacts(res.stdout)
  const missing = dirs.filter((dir) => facts[dir] === undefined)
  if (missing.length > 0) {
    throw new Error(`state dir probe for ${sandboxId} returned no facts for ${missing.join(', ')}`)
  }
  return facts
}

/**
 * Destination OUTCOME verification — the replacement for inspecting a pulled
 * archive at rest, and strictly stronger than it: it checks the state the
 * target box actually ended up in rather than the transport that produced it.
 * Run AFTER the restore and BEFORE the source box is torn down, so a failure
 * still leaves the last authoritative copy intact.
 *
 * Per state dir, all of:
 *  - it EXISTS on the destination (box-provision's ensure_dirs creates every
 *    one, so an absent dir means the restore mangled the home);
 *  - its top-level entry count lands within `[min, max]` of the SOURCE
 *    readings. Comparing against the source (not a fixed floor) is what makes
 *    this safe for a genuinely-empty new squad workspace while still catching
 *    the total-loss case.
 *
 *    `sourceReadings` is a RANGE, not a point, because the source box stays
 *    LIVE across the move: the caller measures it before provisioning and
 *    again right after the stream, and minutes of artifact delivery and box
 *    install sit in between. A background build adding one top-level entry in
 *    that window must not abort the migration AFTER the whole multi-GB stream
 *    has been paid for. Both readings are real probes; the band between them is
 *    exactly the drift the transfer could legitimately have captured.
 *
 *    The UPPER bound is kept (rather than settling for `>=`) as defence in
 *    depth against a STALE destination, a reachable data-loss path: migration
 *    A→B streams the workspace and then fails at health/repoint;
 *    {@link teardownBoxOnMachine} is best-effort there and its failure is only
 *    a WARN, so the restored home survives on B. Work continues on A and a
 *    top-level entry is deleted. A later A→B attempt whose transfer silently
 *    omits `workspace` (both ends exit 0, bytes > 0 from a `.private`-only
 *    archive) would pass `>=` against B's stale SUPERSET — health passes, the
 *    row repoints, and A is torn down. The PRIMARY guard against that shape is
 *    {@link checkDestinationBaseline}, which proves the destination empty
 *    before the stream; this ceiling is what still catches it if that guard is
 *    ever bypassed or regressed;
 *  - it is owned by the box user with the mode the restore promises — a
 *    root-owned ~/workspace is a dead squad box, and this is the only place
 *    that fact is verified rather than trusted.
 */
export function compareStateDirFacts(
  sourceReadings: Array<Record<string, StateDirFacts>>,
  destFacts: Record<string, StateDirFacts>,
  expected: { unixUser: string; stateDirs: string[] }
): { ok: boolean; reason: string } {
  // No reading is not a permissive reading: with nothing to compare against
  // there is no bound at all, and "we could not check" is never "it is fine".
  if (sourceReadings.length === 0) {
    return { ok: false, reason: 'no source state-dir readings to verify the destination against' }
  }
  for (const dir of expected.stateDirs) {
    const dst = destFacts[dir]
    if (!dst) return { ok: false, reason: `no destination facts for ~/${dir}` }
    if (!dst.present) return { ok: false, reason: `~/${dir} is absent on the destination box` }
    const counts = sourceReadings.map((reading) => {
      const src = reading[dir]
      return src?.present ? src.entries : 0
    })
    const min = Math.min(...counts)
    const max = Math.max(...counts)
    if (dst.entries < min || dst.entries > max) {
      return {
        ok: false,
        reason:
          min === max
            ? `~/${dir} restored with ${dst.entries} top-level entries but the source had ${min}`
            : `~/${dir} restored with ${dst.entries} top-level entries, outside the ${min}–${max} the source ` +
              `held across the transfer`,
      }
    }
    if (dst.owner !== expected.unixUser) {
      return { ok: false, reason: `~/${dir} is owned by '${dst.owner}', expected '${expected.unixUser}'` }
    }
    const mode = expectedStateDirMode(dir)
    if (dst.mode !== mode) {
      return { ok: false, reason: `~/${dir} has mode ${dst.mode || '(unknown)'}, expected ${mode}` }
    }
  }
  return { ok: true, reason: '' }
}

/**
 * Destination BASELINE check — run BEFORE a single byte is streamed, against a
 * box that {@link installBoxOnMachine} has just provisioned.
 *
 * box-provision's `ensure_dirs` creates every state dir EMPTY, and nothing has
 * written into `~/workspace` or `~/.private` by this point. NOT because asset
 * delivery avoids those dirs — two of the five vm assets land squarely inside
 * them (the squad `.env` at `~/workspace/.tau/.env`, the identity key at
 * `~/.private/identity.pem`; see vm/file-sync.ts's push order) — but because
 * that delivery goes through the BOX SERVER's HTTP API, and box-provision.sh
 * only `enable`s the unit, never starts it. The caller's first activation comes
 * after the transfer, and the migrate path never calls `syncBoxFiles` at all.
 * So a freshly-provisioned destination MUST hold no top-level entries in any
 * state dir, and anything else means the target already carries a tree from an
 * earlier, abandoned attempt whose best-effort teardown failed. (Move asset
 * delivery ahead of the stream and this invariant dies with it.)
 *
 * Refusing that is what keeps the post-stream comparison's UPPER bound
 * meaningful (see {@link compareStateDirFacts}): with an empty baseline there is
 * nothing the destination could legitimately hold except what this transfer put
 * there, so a stale superset can no longer stand in for content the transfer
 * silently dropped.
 *
 * Deliberately NOT an owner/mode check — that is the post-restore comparison's
 * job, and re-asserting it here would fail migrations for a condition the
 * restore is about to fix anyway.
 */
export function checkDestinationBaseline(
  destFacts: Record<string, StateDirFacts>,
  expected: { stateDirs: string[] }
): { ok: boolean; reason: string } {
  for (const dir of expected.stateDirs) {
    const dst = destFacts[dir]
    if (!dst) return { ok: false, reason: `no destination facts for ~/${dir}` }
    if (!dst.present) {
      return { ok: false, reason: `~/${dir} is absent on the freshly-provisioned destination box` }
    }
    if (dst.entries !== 0) {
      return {
        ok: false,
        reason:
          `~/${dir} on the freshly-provisioned destination already holds ${dst.entries} top-level ` +
          `entries (a leftover tree from an earlier abandoned migration); refusing to stream onto it`,
      }
    }
  }
  return { ok: true, reason: '' }
}

/** A streamed state transfer failed. `end` says WHICH side did, so the caller
 *  can keep the operator-facing "old machine unreadable" vs "target write
 *  failed" distinction the migrate reasons draw.
 *
 *  `end` is a best-effort ATTRIBUTION, never a certainty — see {@link ambiguous}
 *  — which is why {@link ends} carries BOTH ends' exit codes and stderr tails
 *  and the message interpolates both. Reporting only the blamed end's stderr
 *  once hid the real cause completely: when the DESTINATION fails (a stale
 *  script, ENOSPC mid-extract), core's pipe pump cancels the source's stdout,
 *  the source ssh dies of EPIPE, and BOTH ends exit non-zero — with the source's
 *  stderr empty or "Broken pipe" while "unknown argument: --restore-stream" /
 *  "No space left on device" sat unlogged on the other end. */
export class BoxArchiveStreamError extends Error {
  constructor(
    message: string,
    readonly end: 'source' | 'destination' | 'transport',
    /** Both ends' outcomes as the transport reported them. `undefined` ONLY for
     *  `end: 'transport'`, where no child ever produced a status. */
    readonly ends?: BoxArchiveStreamEnds,
    /** True when BOTH ends exited non-zero, i.e. {@link end} is a guess: a
     *  truncated source fails the destination's decompressor, and a failing
     *  destination kills the source with EPIPE — the two are not distinguishable
     *  from exit statuses alone. */
    readonly ambiguous: boolean = false
  ) {
    super(message)
    this.name = 'BoxArchiveStreamError'
  }
}

/** Both ends of a failed transfer, as reported by the transport. */
export interface BoxArchiveStreamEnds {
  bytes: number
  source: { exitCode: number; stderr: string }
  dest: { exitCode: number; stderr: string }
}

/** Per-end stderr budget in the thrown message. The TAIL is kept: the last
 *  lines of a tar/decompressor failure are the diagnostic ones, and this
 *  message is persisted into machine logs. */
const STREAM_STDERR_TAIL_CHARS = 2000

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim()
  if (trimmed.length === 0) return '(no stderr)'
  if (trimmed.length <= STREAM_STDERR_TAIL_CHARS) return trimmed
  return `…(truncated)…${trimmed.slice(-STREAM_STDERR_TAIL_CHARS)}`
}

/**
 * Render BOTH ends into one operator-facing line. Every {@link
 * BoxArchiveStreamError} thrown after the transport returned goes through here,
 * so no failure mode can report one end and swallow the other.
 */
function describeStreamEnds(sandboxId: string, ends: BoxArchiveStreamEnds, blamed: string, ambiguous: boolean): string {
  return (
    `state archive stream for ${sandboxId} failed — attributed to the ${blamed} end` +
    `${ambiguous ? ' (ambiguous: BOTH ends exited non-zero, so the attribution is a guess)' : ''}; ` +
    `source exit ${ends.source.exitCode}: ${stderrTail(ends.source.stderr)}; ` +
    `destination exit ${ends.dest.exitCode}: ${stderrTail(ends.dest.stderr)}; ` +
    `${ends.bytes} bytes streamed`
  )
}

export interface StreamBoxStateArchiveOpts {
  sandboxId: string
  source: { machine: Machine; home: string }
  dest: { machine: Machine; unixUser: string; stagingId?: string }
  /** Role-derived (see {@link durableStateDirsForRole}) — the SAME set is tar'd on
   *  the source and re-owned on the destination. */
  stateDirs: string[]
  codec: ArchiveCodec
  timeoutMs?: number
}

/**
 * Stream a box's state dirs from one machine to another, extracting them into
 * the destination box's HOME as they arrive.
 *
 * Fail-closed by construction — a truncated transfer can never look complete,
 * because THREE independent signals must all agree and any one of them aborts:
 *  1. the SOURCE tar's exit status (primary: a `tar` fed a prefix that happens
 *     to end on a member boundary extracts it and exits 0, so the destination
 *     alone cannot detect truncation);
 *  2. the DESTINATION restore's exit status (a compressed stream truncated
 *     ANYWHERE fails its decompressor, and box-provision.sh runs under
 *     `set -euo pipefail`);
 *  3. a non-zero streamed byte count.
 * A transport-level throw (timeout, connection death) is a failure too. The
 * caller then adds the destination outcome check ({@link compareStateDirFacts}).
 */
export async function streamBoxStateArchive(
  opts: StreamBoxStateArchiveOpts,
  deps: BoxManagerDeps = {}
): Promise<{ bytes: number }> {
  const streamer = deps.streamer ?? defaultSshStreamer
  const { sandboxId, source, dest, stateDirs, codec } = opts

  let result: Awaited<ReturnType<SshStreamer['stream']>>
  try {
    result = await streamer.stream(
      { machine: source.machine, command: buildArchiveStreamCommand(source.home, stateDirs, codec) },
      { machine: dest.machine, command: buildStreamRestoreCommand(dest.unixUser, stateDirs, codec, dest.stagingId) },
      opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined
    )
  } catch (err) {
    throw new BoxArchiveStreamError(
      `state archive stream for ${sandboxId} failed in transport: ${err instanceof Error ? err.message : String(err)}`,
      'transport'
    )
  }

  const ends: BoxArchiveStreamEnds = { bytes: result.bytes, source: result.source, dest: result.dest }
  // A failing DESTINATION takes the source down with it (EPIPE when the pump
  // cancels the source's stdout), and a truncated SOURCE takes the destination
  // down with it (its decompressor fails). Both-non-zero is therefore genuinely
  // ambiguous: the attribution below stays source-first (flipping it would just
  // move the misdiagnosis), but it is FLAGGED as a guess and both ends' stderr
  // rides along on every path.
  const ambiguous = result.source.exitCode !== 0 && result.dest.exitCode !== 0

  if (result.source.exitCode !== 0) {
    throw new BoxArchiveStreamError(describeStreamEnds(sandboxId, ends, 'source', ambiguous), 'source', ends, ambiguous)
  }
  if (result.dest.exitCode !== 0) {
    throw new BoxArchiveStreamError(describeStreamEnds(sandboxId, ends, 'destination', false), 'destination', ends)
  }
  if (result.bytes === 0) {
    throw new BoxArchiveStreamError(
      `${describeStreamEnds(sandboxId, ends, 'source', false)} ` +
        `(both ends exited 0 but the source produced no archive at all)`,
      'source',
      ends
    )
  }
  return { bytes: result.bytes }
}

/**
 * Run `box-provision.sh --remove` for a bare unix user on a machine — the
 * lowest-level machine-side teardown, needing only the user (no box row, port,
 * or tunnel). The script archives the whole home to a tarball BEFORE `userdel`,
 * so removal is data-preserving, and it re-asserts its own `^box_[0-9a-f]{12}$`
 * + uid≥1000 guards. Used by {@link teardownBoxOnMachine} (row-driven teardown)
 * and by the machine-health remnant sweep (which has only the unix user of a
 * DB-invisible leftover box). The invocation shape is the single source of
 * truth for how tau removes a box user.
 *
 * `timeoutMs` exists because that pre-`userdel` archive is a `tar czf` over the
 * WHOLE home: on the runner's 30s default a stale multi-GB squad `~/workspace`
 * cannot be removed at all. Callers that know the home may be big (migrate,
 * which has already sized the move) pass their own budget; callers that don't
 * (the remnant sweep) keep the default, where fail-fast is the right posture.
 */
export async function removeBoxUserOnMachine(
  machine: Machine,
  unixUser: string,
  deps: Pick<BoxManagerDeps, 'runner'> & { timeoutMs?: number } = {}
): Promise<void> {
  const runner = deps.runner ?? defaultSshRunner
  // Revoke the box's browser token FIRST (R-B2: removal is the revocation
  // mechanism). `rm -f` never fails, and prefixing it with `;` (not `&&`) keeps
  // the revocation independent of --remove's exit — the command's status is
  // still --remove's, so the throw-on-failure below is unchanged.
  const tokenPath = `${BROWSER_TOKENS_DIR}/${unixUser}.token`
  const removeCmd =
    `sudo rm -f ${shellQuote(tokenPath)}; ` +
    `sudo bash ${BOX_PROVISION_PATH} --unix-user ${shellQuote(unixUser)} --remove`
  const res = await runner.run(machine, removeCmd, deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : undefined)
  if (res.exitCode !== 0) {
    throw new Error(
      `box-provision --remove failed for user ${unixUser} on machine ${machine.name} (exit ${res.exitCode}): ${res.stderr.trim()}`
    )
  }
}

/**
 * Tear down a box's MACHINE-side presence on an EXPLICIT machine: cancel its
 * tunnel forward, optionally pull its private archive (BEFORE --remove deletes
 * the home), and run box-provision.sh --remove (archives the whole home
 * machine-side as belt-and-braces, then userdel). Deliberately does NOT touch
 * the `machine_boxes` row — {@link removeBox} deletes it after this, while the
 * migrate primitive tears down old/new boxes whose row must stay alive (it is
 * the migration fence and the only reservation of the box's identity).
 *
 * `opts.timeoutMs` is the SSH budget for the `--remove` itself — see
 * {@link removeBoxUserOnMachine} for why a big home needs one. Omitted, the
 * runner default applies.
 */
export async function teardownBoxOnMachine(
  machine: Machine,
  sandboxId: string,
  unixUser: string,
  port: number,
  opts: { archivePrivate?: boolean; archiveOwnerId?: string; timeoutMs?: number } = {},
  deps: BoxManagerDeps = {}
): Promise<void> {
  const runner = deps.runner ?? defaultSshRunner
  const tunnels = deps.tunnels ?? machineTunnels
  const home = boxHome(unixUser)

  await tunnels.removeForward(machine, port)

  // Pull the private archive BEFORE --remove, which deletes the home entirely.
  if (opts.archivePrivate) {
    // The SAME budget the removal below gets, for the same reason: this is a
    // `tar` of the box's whole ~/.private streamed over SSH, and the runner's
    // 30s default is not a budget for that.
    //
    // #1403 gave removeBoxUserOnMachine a real budget and stopped there, which
    // fixed the step AFTER this one and left this one on 30s. The result was a
    // fix that deployed and changed nothing: a tenant whose boxes were too big
    // kept failing with `ssh command timed out after 30000ms`, now from the
    // pull rather than the remove, and the archive loop it was meant to end
    // carried on. Two steps do the same shape of work; both need the same
    // budget or neither is fixed.
    await pullPrivateArchive(runner, machine, opts.archiveOwnerId ?? sandboxId, home, deps, {
      timeoutMs: opts.timeoutMs,
    })
  }

  await removeBoxUserOnMachine(machine, unixUser, { runner, timeoutMs: opts.timeoutMs })
}

/**
 * Remove a box: cancel its tunnel, optionally pull its private archive (BEFORE
 * teardown), run box-provision.sh --remove (archives the whole home machine-side
 * as belt-and-braces, then userdel), and delete the box row. No-op when the box
 * row is absent.
 */
export async function externalizeUnverifiedStop(
  sandboxId: string,
  deps: Pick<BoxManagerDeps, 'tunnels' | 'getMachine'> & {
    externalize?: typeof externalizeUnverifiedBoxStopReal
  } = {}
): Promise<boolean> {
  const result = await (deps.externalize ?? externalizeUnverifiedBoxStopReal)(sandboxId)
  if (result.kind !== 'externalized') return false
  try {
    const machine = await (deps.getMachine ?? getMachineReal)(result.machineId)
    if (machine) await (deps.tunnels ?? machineTunnels).removeForward(machine, result.port)
  } catch (error) {
    log.warn(`Failed to remove local forward while externalizing ${sandboxId}: ${String(error)}`)
  }
  eventEmitter.emit('box.status', {
    sandboxId,
    machineId: result.machineId,
    status: 'gone',
    port: result.port,
  })
  return true
}

export async function removeBox(
  sandboxId: string,
  /**
   * `timeoutMs` is the SSH budget for BOTH slow steps of the teardown — the
   * private-archive pull and `box-provision --remove`. It was missing from this
   * type while teardownBoxOnMachine already accepted it, so a caller passing a
   * budget compiled fine (parameter bivariance) and had it silently dropped.
   * That is how #1403's fix shipped without changing anything.
   */
  opts: { archivePrivate?: boolean; archiveOwnerId?: string; timeoutMs?: number } = {},
  deps: BoxManagerDeps = {}
): Promise<void> {
  const getBox = deps.getMachineBox ?? getMachineBoxReal
  const getMachine = deps.getMachine ?? getMachineReal
  const del = deps.deleteMachineBox ?? deleteMachineBoxReal

  const box = await getBox(sandboxId)
  if (!box) return

  const machine = await getMachine(box.machineId)
  // If the machine record is gone, there is nothing to tear down remotely; just
  // drop the orphaned box row.
  if (!machine) {
    await del(sandboxId)
    eventEmitter.emit('box.status', { sandboxId, machineId: box.machineId, status: 'gone', port: box.port })
    return
  }

  await teardownBoxOnMachine(machine, sandboxId, box.unixUser, box.port, opts, deps)

  await del(sandboxId)
  eventEmitter.emit('box.status', { sandboxId, machineId: box.machineId, status: 'gone', port: box.port })
}

/**
 * Park a box: stop its systemd unit and cancel its tunnel, marking the box row
 * `stopped`. On-disk state (home, workspace, .private) persists so a later
 * ensure resumes it (spec §8). No-op when the box row is absent.
 */
export type BoxStopResult = { kind: 'verified' } | { kind: 'unverified' } | { kind: 'not-found' }

export async function stopBox(sandboxId: string, deps: BoxManagerDeps = {}): Promise<BoxStopResult> {
  const runner = deps.runner ?? defaultSshRunner
  const tunnels = deps.tunnels ?? machineTunnels
  const getBox = deps.getMachineBox ?? getMachineBoxReal
  const getMachine = deps.getMachine ?? getMachineReal
  const upsert = deps.upsertMachineBox ?? upsertMachineBoxReal
  const del = deps.deleteMachineBox ?? deleteMachineBoxReal

  const box = await getBox(sandboxId)
  if (!box) return { kind: 'not-found' }

  const alreadyStopped = box.status === 'stopped'

  const machine = await getMachine(box.machineId)
  if (!machine) {
    await del(sandboxId)
    eventEmitter.emit('box.status', {
      sandboxId: box.sandboxId,
      machineId: box.machineId,
      status: 'gone',
      port: box.port,
    })
    return { kind: 'not-found' }
  }
  // A non-ready machine cannot be stopped authoritatively. Preserve that fact
  // durably so the next ready-machine lifecycle tick retries the unit and
  // tunnel effects rather than treating a logical invalidation as physical.
  if (machine.status !== 'ready') {
    if (box.status !== 'stop_unverified') {
      await upsert({
        sandboxId: box.sandboxId,
        machineId: box.machineId,
        unixUser: box.unixUser,
        port: box.port,
        status: 'stop_unverified',
      })
      eventEmitter.emit('box.status', {
        sandboxId: box.sandboxId,
        machineId: box.machineId,
        status: 'stop_unverified',
        port: box.port,
      })
    }
    return { kind: 'unverified' }
  }

  // Best-effort stop (the units may already be down), through the unit-control
  // seam so a light box's system units are stopped rather than user units that
  // do not exist. ALL THREE go down, socket first: parking a box that left its
  // socket listening would let the next stray connection re-activate the proxy
  // and bring the server straight back up under a `stopped` row.
  const ctl = boxUnitControlFor(box)
  const stopCmd = `${ctl.systemctl} stop ${ctl.allUnits}`
  await runner.run(machine, stopCmd)
  await tunnels.removeForward(machine, box.port)

  await upsert({
    sandboxId: box.sandboxId,
    machineId: box.machineId,
    unixUser: box.unixUser,
    port: box.port,
    status: 'stopped',
  })
  // Skip the emit when the box was already stopped — the stop itself stays
  // idempotent/best-effort, but a repeat call must not re-announce a status
  // that never changed.
  if (!alreadyStopped) {
    eventEmitter.emit('box.status', {
      sandboxId: box.sandboxId,
      machineId: box.machineId,
      status: 'stopped',
      port: box.port,
    })
  }
  return { kind: 'verified' }
}

/**
 * Compose a box's live status from its DB row, the box's machine, its tunnel
 * endpoint, and /healthz. The value maps 1:1 onto the k8s-shaped discriminant
 * VmSandboxManager surfaces, so it deliberately distinguishes NON-terminal
 * starting/transient states from TERMINAL failure — collapsing the two would
 * make routes/agents.ts tear down a live session (its allow-list keeps
 * running/starting/pending) and make outage.ts mis-attribute a mid-provision box
 * as a crash.
 *
 *  - no row → `absent`
 *  - row `stopped` → `stopped` (parked; not probed)
 *  - row `ensuring` → `starting` (mid-(re-)provision; non-terminal, never a crash)
 *  - live (`ready`) row whose machine is GONE or no longer `ready` → `failed`
 *    (terminal: the box is unrecoverable where it lives)
 *  - live row on a ready machine whose `last_listening_at` is fresher than
 *    {@link LISTENING_FRESH_MS} → `ready` with `boxServer: 'idle'`, and NO probe
 *    (probing wakes a socket-activated box — see that branch's comment)
 *  - live row on a ready machine, healthy /healthz → `ready`
 *  - live row on a ready machine, no endpoint yet or a failing probe → `starting`
 *    (transient: tunnel not re-established / server mid-restart — mirrors k8s
 *    treating a waiting container on a healthy node as starting, not failed)
 */
/**
 * Presentation breakdown of a box's live status into the three links the VM
 * chain-health UI surfaces (design: "machine reachable / box provisioned / box
 * server up"). Each field is sourced from data {@link boxStatus} already reads
 * — the DB row, the box's (separately health-probed) machine record, and the
 * SAME /healthz re-check boxStatus performs — never a separate probe.
 * 'unknown' means the fact genuinely isn't available at this link (e.g. a
 * parked box is never probed, so its server state is reported 'down' rather
 * than guessed; an absent box has no machine to check).
 */
export interface BoxChainHealth {
  /** A box row exists for this sandbox (has been provisioned at least once). */
  boxProvisioned: boolean
  /** The box's host machine is present and marked ready (read from the
   *  separately health-probed machine row — not re-probed here). 'unknown' when
   *  the box is parked or mid-provision (machine health isn't consulted on
   *  those paths, mirroring boxStatus). */
  machine: 'reachable' | 'unreachable' | 'unknown'
  /** The box server answered the live /healthz probe. 'unknown' when the box is
   *  parked, mid-provision, or this process holds no tunnel to probe through
   *  (trusts the row instead — see the no-endpoint branch below). */
  boxServer: 'up' | 'down' | 'idle' | 'unknown'
}

/**
 * How long a box's `last_listening_at` watermark (stamped by the lifecycle
 * tick's per-machine `ss -ltnH` sweep) is trusted as proof the box is up.
 *
 * 2.5 ticks at the 60s lifecycle cadence: one missed sweep (a transient SSH
 * failure, a tick that ran long) must not flip every box on the host back to
 * probing, while a box whose socket genuinely stopped listening stops being
 * trusted within ~3 minutes and falls back to the probe path unchanged.
 */
export const LISTENING_FRESH_MS = 150_000

export interface BoxStatusWithChain {
  status: 'ready' | 'stopped' | 'starting' | 'failed' | 'absent'
  chain: BoxChainHealth
}

/**
 * Compose a box's live status from its DB row, the box's machine, its tunnel
 * endpoint, and /healthz. The value maps 1:1 onto the k8s-shaped discriminant
 * VmSandboxManager surfaces, so it deliberately distinguishes NON-terminal
 * starting/transient states from TERMINAL failure — collapsing the two would
 * make routes/agents.ts tear down a live session (its allow-list keeps
 * running/starting/pending) and make outage.ts mis-attribute a mid-provision box
 * as a crash.
 *
 *  - no row → `absent`
 *  - row `stopped` → `stopped` (parked; not probed)
 *  - row `ensuring` → `starting` (mid-(re-)provision; non-terminal, never a crash)
 *  - live (`ready`) row whose machine is GONE or no longer `ready` → `failed`
 *    (terminal: the box is unrecoverable where it lives)
 *  - live row on a ready machine whose `last_listening_at` is fresher than
 *    {@link LISTENING_FRESH_MS} → `ready` with `boxServer: 'idle'`, and NO probe
 *    (probing wakes a socket-activated box — see that branch's comment)
 *  - live row on a ready machine, healthy /healthz → `ready`
 *  - live row on a ready machine, no endpoint yet (or a dead tunnel master —
 *    checked, and its forwards purged, before probing) → `ready`, trusting the
 *    row (see the no-endpoint branch)
 *  - live row on a ready machine, /healthz failing EVERY re-check attempt
 *    ({@link recheckBoxHealth}: 3 × 1s apart) → `starting` (transient: server
 *    mid-restart — mirrors k8s treating a waiting container on a healthy node
 *    as starting, not failed; a single miss under CPU load is NOT enough)
 *
 * {@link boxChainHealth} computes the SAME thing (one DB read, one machine
 * read, one /healthz re-check) and additionally returns the {@link BoxChainHealth}
 * breakdown the VM status routes surface for presentation; this function
 * delegates to it so the two can never drift.
 */
export async function boxStatus(
  sandboxId: string,
  deps: BoxManagerDeps = {}
): Promise<'ready' | 'stopped' | 'starting' | 'failed' | 'absent'> {
  return (await boxChainHealth(sandboxId, deps)).status
}

/** See {@link boxStatus}'s doc comment for the shared status/chain contract. */
export async function boxChainHealth(sandboxId: string, deps: BoxManagerDeps = {}): Promise<BoxStatusWithChain> {
  const getBox = deps.getMachineBox ?? getMachineBoxReal
  const getMachine = deps.getMachine ?? getMachineReal
  const tunnels = deps.tunnels ?? machineTunnels

  const box = await getBox(sandboxId)
  if (!box) {
    return { status: 'absent', chain: { boxProvisioned: false, machine: 'unknown', boxServer: 'unknown' } }
  }
  if (box.status === 'stopped') {
    return { status: 'stopped', chain: { boxProvisioned: true, machine: 'unknown', boxServer: 'down' } }
  }
  if (box.status === 'stop_unverified') {
    const machine = await getMachine(box.machineId)
    return {
      status: 'stopped',
      chain: {
        boxProvisioned: true,
        machine: machine?.status === 'ready' ? 'reachable' : 'unreachable',
        boxServer: 'unknown',
      },
    }
  }
  if (box.status === 'ensuring') {
    return { status: 'starting', chain: { boxProvisioned: true, machine: 'unknown', boxServer: 'unknown' } }
  }

  // A live ('ready') row: terminal failure is defined by the box's HOST, not by a
  // single probe. If the machine is gone or no longer ready, the box is failed.
  const machine = await getMachine(box.machineId)
  if (!machine || machine.status !== 'ready') {
    return { status: 'failed', chain: { boxProvisioned: true, machine: 'unreachable', boxServer: 'unknown' } }
  }

  // SOCKET ACTIVATION: a fresh listening watermark IS the health signal, and
  // taking it lets us answer WITHOUT touching the box. Every probe below is an
  // HTTP request through the box's socket unit, which ACTIVATES the server — and
  // the UI polls this path every few seconds for as long as a squad/agent page
  // is open, so probing here would make it impossible for a box to ever stay
  // idle (and would give back the RAM the socket layout reclaims). The
  // lifecycle tick learned this box's port was listening at most
  // LISTENING_FRESH_MS ago from ONE `ss` on its machine; a stale or missing
  // stamp falls through to exactly today's logic.
  const lastListeningAt = box.lastListeningAt?.getTime()
  const now = deps.now?.() ?? Date.now()
  if (lastListeningAt !== undefined && now - lastListeningAt < LISTENING_FRESH_MS) {
    return { status: 'ready', chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'idle' } }
  }

  // Machine is ready → any endpoint/probe miss is transient, not a crash.
  //
  // Verify the SSH master behind any forward we hold is actually alive BEFORE
  // trusting endpointFor. This process may well hold tunnels (the api prewarms
  // boxes), and a stale forward whose master has died points at a dead local
  // port: every probe through it fails, so the box would read as a perpetual
  // 'starting' until restart even though it is fine. checkHealth() purges a
  // dead master's forwards, so endpointFor then returns null and we fall
  // through to the trust-the-row branch below — the same place a process that
  // never held a tunnel lands.
  let endpoint = tunnels.endpointFor(box.machineId, box.port)
  if (endpoint && !(await tunnels.checkHealth(box.machineId))) endpoint = null
  if (!endpoint) {
    // No SSH forward in THIS process. Tunnels are in-memory and owned by the
    // process that ENSURED the box (the worker); the api serving a status query
    // has none, so it would otherwise report a perpetual 'starting' for a box
    // that is actually ready. The row already cleared 'ensuring' (provisioning
    // is done) and the machine is ready, so trust the row's 'ready' rather than
    // a probe this process structurally cannot make. A genuinely dead box is
    // caught by the worker's health/lifecycle reconcile (which owns the tunnel),
    // not by a status poll from a tunnel-less process. In the worker itself this
    // path is only hit during a brief tunnel re-establish, where 'ready' is also
    // correct (the box is up; the forward is re-forming).
    return { status: 'ready', chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'unknown' } }
  }
  // Same resilience as the ensure fast-path: an established box's server can
  // miss ONE 2s probe while alive (CPU-pegged by an in-box build), and a status
  // poll flipping to 'starting' on that single miss is the pill "sticking on
  // Starting…" for a box whose agent is running fine. A genuinely dead server
  // still fails every attempt and reports down.
  const up = await recheckBoxHealth(endpoint, deps)
  return {
    status: up ? 'ready' : 'starting',
    chain: { boxProvisioned: true, machine: 'reachable', boxServer: up ? 'up' : 'down' },
  }
}

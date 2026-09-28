import { and, eq, sql } from 'drizzle-orm'
import { db, instanceMaintenanceState } from '../db'
import { withDeviceStreamRevocation } from '../services/streaming/device-revocation'
import { randomUUID } from 'crypto'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { Permissions } from '@ficus/shared'
import { eventEmitter } from '../lib/infra/event-emitter'
import { requirePermission } from '../middleware'
import { bootstrapMachine as bootstrapMachineDefault, capLastError } from '../services/machines/bootstrap'
import { generateMachineKeypair } from '../services/machines/keys'
import { EXE_PROVIDER_SSH_KEY, getExeSshKey as getExeSshKeyDefault } from '../services/machines/provider-credentials'
import { getMachineProvider as getMachineProviderDefault, type ProvisionedMachine } from '../services/machines/provider'
import { createLogger } from '../lib/infra/logger'
import { machineUtilization } from '../services/machines/placement'
import { migrateBox as migrateBoxDefault, type MigrateOptions } from '../services/machines/box-migrate'
import { registerBuiltinMachineProviders } from '../services/machines/providers'
import { RebalanceInProgressError, rebalanceFleet as rebalanceFleetDefault } from '../services/machines/rebalance'
import {
  quiesceMachineBoxes as quiesceMachineBoxesDefault,
  releaseMachineBoxes as releaseMachineBoxesDefault,
} from '../services/machines/machine-quiesce'
import {
  claimMachineForBootstrap,
  deleteMachine,
  failMachineBootstrapClaim,
  getMachine,
  getMachineByName,
  insertMachine,
  listAllMachineBoxes,
  listMachineBoxes,
  listMachines,
  recoverMigrationFencesOnce,
  updateMachine,
  type Machine,
  type MachineBox,
} from '../services/machines/queries'
import { machineTunnels, type MachineTunnelManager } from '../services/machines/tunnel-manager'
import { getSecretStore } from '../services/secrets'
import { hasPermission, type Identity } from '../services/rbac'
import { FORCE_MIGRATION_REASON_MAX_LENGTH, type ForceMigrationActor } from '../services/machines/force-migration-audit'
import {
  authorizeEvacuationSourceDeletion,
  beginMachineEvacuation,
  recordEvacuationBoxProof,
  settleEvacuationSourceDeleted,
  settleEvacuationSourceTerminated,
  verifyMachineEvacuation,
} from '../services/machines/machine-evacuation'

const log = createLogger('routes:machines')

/**
 * Machines API routes: register/bootstrap/inspect/health-check/delete
 * BYO-SSH (and, in future slices, provider-provisioned) VM-based sandbox hosts.
 */

const createMachineSchema = z
  .object({
    name: z.string().min(1).max(200),
    // 'ssh' (default) registers a BYO endpoint; 'exe' provisions a new exe.dev VM.
    provider: z.enum(['ssh', 'exe']).optional(),
    // Required for BYO-SSH; omitted for 'exe' (its endpoint comes from provision).
    sshHost: z.string().min(1).optional(),
    sshPort: z.number().int().min(1).max(65535).optional(),
    sshUser: z.string().min(1).optional(),
    scope: z.enum(['shared', 'dedicated']).optional(),
    // Opt into the machine-level egress lockdown (applied at bootstrap). Default
    // false; the column default backs it when omitted.
    egressPolicy: z.boolean().optional(),
  })
  .refine((v) => v.provider === 'exe' || (v.sshHost !== undefined && v.sshUser !== undefined), {
    message: 'sshHost and sshUser are required for BYO-SSH machines',
    path: ['sshHost'],
  })

const migrateBoxSchema = z.object({
  sandboxId: z.string().min(1),
  evacuationId: z.string().uuid().optional(),
  // A SQUAD box moves by DEFAULT (it carries ~/workspace and has its local
  // deployments quiesced/restarted around the move). Pass `false` to get the
  // old refusal instead (`{moved:false, reason:'squad-box'}`).
  allowSquad: z.boolean().optional(),
  // Operator override for the ACTIVE-EXECUTION refusal only, for evacuating a
  // dying machine. Nothing else is bypassed. In-flight writes by those
  // executions are lost with the torn-down source box — see
  // MigrateOptions.force.
  force: z
    .object({ reason: z.string().trim().min(1).max(FORCE_MIGRATION_REASON_MAX_LENGTH), requestId: z.string().uuid() })
    .optional(),
})

const beginEvacuationSchema = z.object({
  operationId: z.string().uuid(),
  targetMachineId: z.string().uuid(),
  sourceGeneration: z.number().int().nonnegative().nullable(),
  targetGeneration: z.number().int().nonnegative().nullable(),
})
const evacuationReceiptSchema = z.object({
  operationId: z.string().uuid(),
  sourceMachineId: z.string().uuid(),
  targetMachineId: z.string().uuid(),
  sourceGeneration: z.number().int().nonnegative().nullable(),
  targetGeneration: z.number().int().nonnegative().nullable(),
  rosterDigest: z.string().regex(/^[a-f0-9]{64}$/),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  verifiedAt: z.string().datetime(),
})

const quiesceSchema = z.object({
  owner: z.string().min(1).optional(),
  // Operator override for the ACTIVE-EXECUTION refusal only — same escape and
  // same authorization gate as migrateBoxSchema's `force`. Nothing else is
  // bypassed: a box already fenced by a concurrent migration still refuses.
  force: z.object({ reason: z.string().trim().min(1).max(FORCE_MIGRATION_REASON_MAX_LENGTH) }).optional(),
})

const releaseSchema = z.object({
  owner: z.string().min(1).optional(),
  // The EXACT list a prior /quiesce returned — never re-derived from the
  // machine's current boxes, which could include one a concurrent migrate-box
  // owns the fence for.
  sandboxIds: z.array(z.string().min(1)),
})

export function forceMigrationActor(identity: Identity | undefined): ForceMigrationActor | null {
  if (identity?.type === 'user') return { type: 'user', id: identity.userId }
  if (identity?.type === 'agent') return { type: 'agent', id: identity.agentId }
  return null
}

const rebalanceSchema = z.object({
  dryRun: z.boolean().optional(),
})

/**
 * Strip the secret-store handle before returning a machine over the API.
 * Private key material is never returnable by design (keys.ts only yields a
 * secret-store id) — but we also omit that id itself, since it's an internal
 * plumbing detail rather than something the UI needs.
 */
function toPublicMachine(machine: Machine): Omit<Machine, 'sshKeyId'> {
  const { sshKeyId: _sshKeyId, ...rest } = machine
  return rest
}

/**
 * Strip the box's executor auth token before returning it over the API — it is
 * a live credential (bearer access to the box's exec/file surface for anyone
 * local to the machine) and the UI only needs the box's placement/status. Also
 * omit `syncedHashes`: those are unsalted sha256 content hashes of secret files
 * (identity.pem, squad `.env`), a content-verification oracle no API caller
 * needs — and the UI doesn't consume them.
 */
function toPublicBox(box: MachineBox): Omit<MachineBox, 'authToken' | 'syncedHashes'> {
  const { authToken: _authToken, syncedHashes: _syncedHashes, ...rest } = box
  return rest
}

/**
 * Announce a machine-row mutation (bootstrap/check) over the event bus. A genuine
 * status transition emits the more specific `machine.status`; any OTHER genuine
 * change to a field these two routes can touch (`lastSeenAt`, `bootstrapVersion`,
 * `capabilities`, `lastError`) emits `machine.updated`. The two are mutually
 * exclusive so a single mutation never doubles up. `machines` has no `updatedAt`
 * column, so a mutation that leaves the row byte-identical (a repeat `/check` on
 * an already-unreachable machine reporting the same probe outcome, or a repeat
 * `/bootstrap` with an identical script version) emits NOTHING — there is no
 * other change to report.
 *
 * `lastError` is included in the changed-field set (not just status) because
 * `/check` now rewrites it on EVERY transition, including unreachable->
 * unreachable: a machine that was unreachable for a stale bootstrap-era reason
 * and fails a fresh reachability probe gets a new, distinct lastError with no
 * status flip to ride along with — that's a real change to what the API/UI
 * shows, so it must not go silently unreported.
 */
function emitMachineChange(previous: Machine, updated: Machine): void {
  if (updated.status !== previous.status) {
    eventEmitter.emit('machine.status', { machineId: updated.id, status: updated.status })
    return
  }
  const lastSeenChanged = (previous.lastSeenAt?.getTime() ?? null) !== (updated.lastSeenAt?.getTime() ?? null)
  const bootstrapVersionChanged = previous.bootstrapVersion !== updated.bootstrapVersion
  const capabilitiesChanged = JSON.stringify(previous.capabilities) !== JSON.stringify(updated.capabilities)
  const lastErrorChanged = previous.lastError !== updated.lastError
  if (lastSeenChanged || bootstrapVersionChanged || capabilitiesChanged || lastErrorChanged) {
    eventEmitter.emit('machine.updated', { machineId: updated.id })
  }
}

export function createMachinesRouter(
  deps: {
    bootstrap?: typeof bootstrapMachineDefault
    getProvider?: typeof getMachineProviderDefault
    insert?: typeof insertMachine
    getSshKey?: typeof getExeSshKeyDefault
    registerProviders?: typeof registerBuiltinMachineProviders
    tunnels?: Pick<MachineTunnelManager, 'closeMachine'>
    migrate?: (
      sandboxId: string,
      targetMachineId: string,
      opts?: MigrateOptions
    ) => ReturnType<typeof migrateBoxDefault>
    rebalance?: (opts: { dryRun?: boolean }) => ReturnType<typeof rebalanceFleetDefault>
    recoverFences?: () => Promise<number>
    quiesceMachine?: typeof quiesceMachineBoxesDefault
    releaseMachine?: typeof releaseMachineBoxesDefault
  } = {}
) {
  const app = new Hono()
  const bootstrap = deps.bootstrap ?? bootstrapMachineDefault
  const getProvider = deps.getProvider ?? getMachineProviderDefault
  const insert = deps.insert ?? insertMachine
  const getSshKey = deps.getSshKey ?? getExeSshKeyDefault
  const registerProviders = deps.registerProviders ?? registerBuiltinMachineProviders
  const tunnels = deps.tunnels ?? machineTunnels
  const migrate =
    deps.migrate ??
    ((sandboxId: string, targetMachineId: string, opts?: MigrateOptions) =>
      migrateBoxDefault(sandboxId, targetMachineId, {}, opts))
  const rebalance = deps.rebalance ?? ((opts: { dryRun?: boolean }) => rebalanceFleetDefault(opts))
  // Fence crash-recovery barrier (memoized-once): awaited before every
  // migrate/rebalance so recovery is strictly-before any fence this process
  // claims, even for a request served before index.ts's boot chain runs it.
  const recoverFences = deps.recoverFences ?? recoverMigrationFencesOnce
  const quiesceMachine = deps.quiesceMachine ?? quiesceMachineBoxesDefault
  const releaseMachine = deps.releaseMachine ?? releaseMachineBoxesDefault
  // Point-of-use self-heal for provider lookups outside the register route: the
  // router-creation `void registerProviders()` below races secret-store init in
  // the api process, so the exe provider can be absent here forever (the worker
  // registers post-init at boot; the register route re-registers inline).
  // Registration is idempotent + one secret read, so a miss re-registers once
  // and retries instead of 500ing until restart.
  const getProviderEnsured = async (key: string) => {
    try {
      return getProvider(key)
    } catch {
      await registerProviders()
      return getProvider(key)
    }
  }

  // Eagerly register the built-in providers at boot (best-effort). This is a
  // snapshot: it reads whatever exe account SSH key exists NOW. A key configured
  // AFTER boot (realistic first-run: deploy → boot → set creds → provision) would
  // be missed, so the exe branch below re-runs this on demand (it's idempotent)
  // before resolving the provider — never a 500 from a stale registry.
  void registerProviders()

  // POST /api/machines — register a BYO-SSH machine or provision an exe.dev VM.
  app.post('/', requirePermission('machines:write'), zValidator('json', createMachineSchema), async (c) => {
    const body = c.req.valid('json')
    const provider = body.provider ?? 'ssh'

    // exe VMs are tau-provisioned, so the tenant's exe.dev account SSH key must be set.
    if (provider === 'exe' && !(await getSshKey())) {
      return c.json({ error: 'configure exe.dev credentials to provision exe machines' }, 400)
    }

    if (await getMachineByName(body.name)) {
      return c.json({ error: `Machine '${body.name}' already exists` }, 409)
    }

    const machineId = randomUUID()

    let machine: Machine
    // Hoisted so the catch can tell a successful exe provision from a pre-provision
    // failure: once set, the VM is BILLED and must be terminated on a later insert
    // failure (dup-name race or transient DB error between provision and insert),
    // else it orphans with no row — an invisible paid VM (findReady* never see it).
    let provisioned: ProvisionedMachine | undefined
    // The per-machine keypair secret to roll back on failure. Set ONLY on the BYO
    // path — exe machines share the account key (EXE_PROVIDER_SSH_KEY) and mint no
    // per-machine secret, so cleanup must never touch a secret for the exe path.
    let mintedSecretKeyId: string | undefined
    try {
      if (provider === 'exe') {
        // Re-run built-in registration on demand so an account key configured after
        // boot registers the exe provider now — otherwise the live-read 400-gate
        // above passes but getProvider('exe') would throw (500) until restart.
        // Idempotent.
        await registerProviders()
        // Provision a fresh exe.dev VM. No key is injected: exe authenticates SSH
        // against the ACCOUNT key (live recon 2026-07-13), which already reaches
        // every VM. The endpoint + ref come back from the provider; the shared
        // account-key secret (EXE_PROVIDER_SSH_KEY) is the row's ssh identity.
        provisioned = await getProvider('exe').provision({
          name: body.name,
          ...(body.scope !== undefined ? { scope: body.scope } : {}),
        })
        machine = await insert({
          id: machineId,
          name: body.name,
          provider: 'exe',
          providerRef: provisioned.providerRef,
          sshHost: provisioned.sshHost,
          sshPort: provisioned.sshPort,
          sshUser: provisioned.sshUser,
          sshKeyId: EXE_PROVIDER_SSH_KEY,
          // exe VMs carry no per-machine public key (the account key reaches them);
          // the NOT NULL column takes an empty string.
          sshPublicKey: '',
          status: 'registered',
          ...(body.scope !== undefined ? { scope: body.scope } : {}),
          ...(body.egressPolicy !== undefined ? { egressPolicy: body.egressPolicy } : {}),
        })
      } else {
        // BYO-SSH: mint a per-machine keypair; tau's public key is the operator's
        // to install by hand. Rolled back below if the insert fails.
        const { publicKey, secretKeyId } = await generateMachineKeypair(machineId)
        mintedSecretKeyId = secretKeyId
        machine = await insert({
          id: machineId,
          name: body.name,
          provider: 'ssh',
          sshHost: body.sshHost as string,
          sshUser: body.sshUser as string,
          sshKeyId: secretKeyId,
          sshPublicKey: publicKey,
          status: 'registered',
          ...(body.sshPort !== undefined ? { sshPort: body.sshPort } : {}),
          ...(body.scope !== undefined ? { scope: body.scope } : {}),
          ...(body.egressPolicy !== undefined ? { egressPolicy: body.egressPolicy } : {}),
        })
      }
    } catch (err) {
      // Best-effort rollback before rethrowing (mirrors placement.ts's failed-
      // provision cleanup). Order: terminate the billed VM first (the costliest
      // orphan), then drop any per-machine keypair secret.
      //
      // If an exe VM was already provisioned when the insert failed, terminate it —
      // otherwise it lingers billed with no row. The exe provider's terminate needs
      // only id + providerRef; log a terminate failure but never let it mask the
      // original cause.
      if (provisioned) {
        const ref = provisioned.providerRef
        await getProvider('exe')
          .terminate({ id: machineId, providerRef: ref } as Machine)
          .catch((termErr) => {
            log.warn(`failed to terminate exe VM ${ref} after failed insert of '${body.name}': ${String(termErr)}`)
          })
      }
      // Only the BYO path mints a per-machine secret; delete it so the private key
      // does not orphan. NEVER the shared exe account key (exe minted no secret).
      if (mintedSecretKeyId) {
        await getSecretStore()
          .delete(mintedSecretKeyId)
          .catch(() => {})
      }
      throw err
    }

    // Fire AFTER the row is durably inserted so a UI subscriber that refetches
    // on this event always sees the new machine.
    eventEmitter.emit('machine.created', { machineId: machine.id })

    return c.json(toPublicMachine(machine), 201)
  })

  // GET /api/machines — list all machines, each with its packer utilization.
  // Utilization needs the boxes' sandboxIds (for their role weights), so pull
  // EVERY box in one query and group by machine in JS — no per-machine N+1.
  app.get('/', requirePermission('machines:read'), async (c) => {
    const [list, allBoxes] = await Promise.all([listMachines(), listAllMachineBoxes()])
    const boxesByMachine = new Map<string, MachineBox[]>()
    for (const box of allBoxes) {
      const existing = boxesByMachine.get(box.machineId)
      if (existing) existing.push(box)
      else boxesByMachine.set(box.machineId, [box])
    }
    return c.json(
      list.map((machine) => ({
        ...toPublicMachine(machine),
        utilization: machineUtilization(boxesByMachine.get(machine.id) ?? []),
      }))
    )
  })

  // GET /api/machines/:id — machine detail, including its boxes and utilization.
  app.get('/:id', requirePermission('machines:read'), async (c) => {
    const machine = await getMachine(c.req.param('id'))
    if (!machine) return c.json({ error: 'Not found' }, 404)

    const boxes = await listMachineBoxes(machine.id)
    return c.json({
      ...toPublicMachine(machine),
      utilization: machineUtilization(boxes),
      boxes: boxes.map(toPublicBox),
    })
  })

  // POST /api/machines/:id/bootstrap — push + run the bootstrap script.
  /**
   * Kick off a bootstrap and return IMMEDIATELY (202) — do not hold the request
   * open for the run.
   *
   * A bootstrap installs apt packages, bun and a multi-user nix; it routinely
   * takes minutes and is allowed up to 15 (BOOTSTRAP_RUN_TIMEOUT_MS). Awaiting
   * it here meant every caller sat on an open connection for that long, and no
   * intermediary tolerates it: a tenant behind Cloudflare got a 502 error page
   * while the bootstrap it triggered was still running happily on the box, and
   * the platform's provisioning call would have failed a tenant whose host had
   * in fact been bootstrapped.
   *
   * The row is the source of truth instead. `bootstrapping` is stamped here —
   * the status existed in the schema and the UI already conditions its poll on
   * it, but nothing ever set it, because the only writer was the synchronous
   * ready/unreachable stamp at the end of the run. Callers watch the row (via
   * the change events emitted at each transition, or by polling GET
   * /api/machines/:id) rather than the response body.
   */
  app.post('/:id/bootstrap', requirePermission('machines:write'), async (c) => {
    const machine = await getMachine(c.req.param('id'))
    if (!machine) return c.json({ error: 'Not found' }, 404)

    // Already running: return the current row rather than starting a SECOND
    // concurrent bootstrap over the same SSH connection. Double-clicking the
    // button, a provision retry landing on an in-flight run, or the worker's
    // boot-time drift reconcile holding the machine must all be inert. The
    // claim is atomic, so two requests racing here cannot both start one.
    const starting = await claimMachineForBootstrap(machine.id)
    if (!starting) {
      return c.json(toPublicMachine((await getMachine(machine.id)) ?? machine), 202)
    }
    emitMachineChange(machine, starting)

    // Deliberately not awaited. Terminal state (ready | unreachable) is written
    // by bootstrapMachine itself and broadcast here, so a caller that polls or
    // listens sees the outcome. NOTE: a core restart mid-run leaves the row
    // stuck 'bootstrapping' — the machine health check reconciles a stale row,
    // and a caller's deadline covers the rest.
    void bootstrap(starting)
      .catch(async (err: unknown) => {
        // bootstrapMachine stamps 'unreachable' (+ lastError) before rethrowing
        // for failures it reaches — but a throw BEFORE that point (or any
        // injected/alternate implementation) would otherwise strand the row in
        // 'bootstrapping' forever, and nothing would ever clear it. The route
        // started this transition, so the route guarantees it terminates: stamp
        // 'unreachable' only if the row is still sitting in the state we put it
        // in, and persist the error message alongside it so the row still tells
        // an operator WHY even when bootstrapMachine's own write never ran.
        const message = err instanceof Error ? err.message : String(err)
        await failMachineBootstrapClaim(machine.id, capLastError(message))
      })
      .finally(async () => {
        const settled = await getMachine(machine.id)
        if (settled) emitMachineChange(starting, settled)
      })

    return c.json(toPublicMachine(starting), 202)
  })

  // POST /api/machines/:id/check — probe reachability via the provider.
  app.post('/:id/check', requirePermission('machines:write'), async (c) => {
    const machine = await getMachine(c.req.param('id'))
    if (!machine) return c.json({ error: 'Not found' }, 404)

    const provider = await getProviderEnsured(machine.provider)
    const result = await provider.status(machine)
    const running = result === 'running'

    // `lastSeenAt` is a liveness watermark: only bump it when the machine was
    // actually observed running. On a failed probe we still record the derived
    // status ('unreachable') but leave the last-seen timestamp untouched so it
    // keeps reflecting the last time the machine was genuinely reachable.
    const updates: Partial<Machine> = { status: running ? 'ready' : 'unreachable' }
    if (running) {
      updates.lastSeenAt = new Date()
      // A successful probe supersedes ANY stale error on the row — including a
      // bootstrap-era failure from a run that finished long ago. A ready
      // machine must never keep advertising a problem that no longer applies.
      updates.lastError = null
    } else {
      // Stamp a message that identifies THIS reachability probe as the source,
      // built only from what the probe actually returned (`result`) — never
      // reused/left over from an unrelated bootstrap failure. Without this, a
      // machine that goes unreachable via a plain connectivity blip would keep
      // showing an old, unrelated bootstrap error as if it explained the
      // CURRENT outage.
      updates.lastError = `reachability check failed: provider reported '${result}'`
    }

    const updated = (await updateMachine(machine.id, updates)) as Machine
    emitMachineChange(machine, updated)
    return c.json(toPublicMachine(updated))
  })

  // POST /api/machines/rebalance — re-pack the shared fleet via rebalanceFleet
  // (dryRun returns the plan with no effects). Runs in-process, like DELETE's
  // terminate and bootstrap's SSH: box ops are valid from this process.
  // Registered before the param routes purely for readability — a static
  // segment never collides with `/:id/...` two-segment paths anyway.
  app.post('/rebalance', requirePermission('machines:write'), zValidator('json', rebalanceSchema), async (c) => {
    const body = c.req.valid('json')
    try {
      await recoverFences()
      const plan = await rebalance({ ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}) })
      return c.json(plan)
    } catch (err) {
      // e.g. not the VM sandbox runtime — surface the message instead of a bare 500.
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`rebalance failed: ${message}`)
      // An execute overlapping a running execute is a caller-resolvable
      // conflict (retry when it finishes), not a server fault.
      if (err instanceof RebalanceInProgressError) return c.json({ error: message }, 409)
      return c.json({ error: message }, 500)
    }
  })

  app.post(
    '/:id/evacuations',
    requirePermission('machines:write'),
    zValidator('json', beginEvacuationSchema),
    async (c) => {
      try {
        const body = c.req.valid('json')
        const operation = await beginMachineEvacuation({ ...body, sourceMachineId: c.req.param('id') })
        return c.json(operation)
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 409)
      }
    }
  )

  app.post('/evacuations/:id/verify', requirePermission('machines:write'), async (c) => {
    try {
      return c.json(await verifyMachineEvacuation(c.req.param('id')))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409)
    }
  })

  // POST /api/machines/:id/migrate-box — move one sandbox box onto THIS machine
  // (`:id` is the target). Returns migrateBox's structured MigrateResult as-is:
  // a refused move (`active-turn`, `squad-box`, …) is a 200 with
  // `{ moved: false, reason }`, not an error — the caller decides what to do.
  app.post('/:id/migrate-box', requirePermission('machines:write'), zValidator('json', migrateBoxSchema), async (c) => {
    const { sandboxId, allowSquad, force, evacuationId } = c.req.valid('json')
    let forceRequest: { actor: ForceMigrationActor; reason: string; requestId: string } | undefined
    if (force) {
      const identity = c.get('identity') as Identity | undefined
      if (!identity) return c.json({ error: 'Authenticated actor required for forced migration' }, 401)
      const actor = forceMigrationActor(identity)
      if (!actor) return c.json({ error: 'Forced migration requires an attributable user or agent actor' }, 403)
      if (!(await hasPermission(identity, Permissions.MACHINES_FORCE_MIGRATE)))
        return c.json({ error: 'Forbidden' }, 403)
      forceRequest = { actor, reason: force.reason, requestId: force.requestId }
    }

    // Force authorization is intentionally complete before target lookup so
    // an unauthorized override cannot use 404 differences as an oracle.
    const machine = await getMachine(c.req.param('id'))
    if (!machine) return c.json({ error: 'Not found' }, 404)

    // A big squad ~/workspace archive/restore can run many minutes; a client
    // that asks for text/event-stream gets a live phase-by-phase feed (so a
    // driving CLI / resize orchestrator can tell which phase is running without
    // waiting for the end), terminated by a single `result` (or `error`) event.
    // Plain callers keep the original one-shot JSON response.
    if (c.req.header('accept')?.includes('text/event-stream')) {
      c.header('X-Accel-Buffering', 'no')
      c.header('Cache-Control', 'no-cache, no-transform')
      return streamSSE(c, async (stream) =>
        withDeviceStreamRevocation(c.get('authContext'), stream, async (signal) => {
          const queue: Array<{ event: string; data: string }> = []
          let done = false
          const run = (async () => {
            try {
              await recoverFences()
              const result = await migrate(sandboxId, machine.id, {
                allowSquad,
                force: forceRequest,
                evacuationId,
                onProgress: (p) => queue.push({ event: 'progress', data: JSON.stringify(p) }),
              })
              if (evacuationId && result.moved && result.migrationProof)
                await recordEvacuationBoxProof({ evacuationId, sandboxId, ...result.migrationProof })
              queue.push({ event: 'result', data: JSON.stringify(result) })
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              log.warn(`migrate-box ${sandboxId} -> ${machine.id} failed: ${message}`)
              queue.push({ event: 'error', data: JSON.stringify({ error: message }) })
            } finally {
              done = true
            }
          })()
          while (!signal.aborted && (!done || queue.length > 0)) {
            if (queue.length > 0) {
              for (const ev of queue.splice(0)) await stream.writeSSE(ev)
            } else {
              await stream.sleep(50)
            }
          }
          await run
        })
      )
    }

    try {
      await recoverFences()
      const result = await migrate(sandboxId, machine.id, { allowSquad, force: forceRequest, evacuationId })
      if (evacuationId && result.moved && result.migrationProof)
        await recordEvacuationBoxProof({ evacuationId, sandboxId, ...result.migrationProof })
      return c.json(result)
    } catch (err) {
      // migrateBox returns structured reasons for every expected failure; a
      // throw is unexpected (or a non-VM runtime) — surface the message.
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`migrate-box ${sandboxId} -> ${machine.id} failed: ${message}`)
      return c.json({ error: message }, 500)
    }
  })

  // POST /api/machines/:id/quiesce — claim the migration fence on EVERY box of
  // this machine, so the machine itself can be taken down (the platform's
  // native machine-host resize powers the droplet OFF, which kills every box on
  // it instantly — see services/machines/machine-quiesce.ts for why this reuses
  // the migration fence rather than inventing a second quiescence model).
  //
  // ALL-OR-NOTHING: a refusal (409) means nothing was left fenced. A machine
  // with no boxes is a trivial 200 with an empty list.
  //
  // The caller MUST hand the returned `quiesced` list back to /release — the
  // fences are held until it does (or until the API restarts, which clears them
  // wholesale; see machine-quiesce.ts's crash-durability note).
  app.post('/:id/quiesce', requirePermission('machines:write'), zValidator('json', quiesceSchema), async (c) => {
    const { force, owner } = c.req.valid('json')
    if (owner) {
      const identity = c.get('identity') as Identity | undefined
      if (identity?.type !== 'system') return c.json({ error: 'Owner-scoped quiesce requires system identity' }, 403)
      const [lease] = await db
        .select()
        .from(instanceMaintenanceState)
        .where(
          and(
            eq(instanceMaintenanceState.id, 'global'),
            eq(instanceMaintenanceState.platformLeaseId, owner),
            eq(instanceMaintenanceState.platformLeaseOwnerTokenId, identity.systemTokenId),
            sql`${instanceMaintenanceState.platformLeaseExpiresAt} > clock_timestamp()`
          )
        )
      if (!lease) return c.json({ error: 'Maintenance lease ownership mismatch' }, 409)
    }

    let forceRequest: { actor: string; reason: string } | undefined
    if (force) {
      // Gated exactly like migrate-box's own force escape, and for the same
      // reason: forcing here powers a machine off past live turns, killing them
      // and losing their in-flight writes. Authorization is resolved BEFORE the
      // machine lookup so an unauthorized override cannot use 404 differences
      // as an existence oracle.
      const identity = c.get('identity') as Identity | undefined
      if (!identity) return c.json({ error: 'Authenticated actor required for forced quiesce' }, 401)
      const actor = forceMigrationActor(identity)
      if (!actor) return c.json({ error: 'Forced quiesce requires an attributable user or agent actor' }, 403)
      if (!(await hasPermission(identity, Permissions.MACHINES_FORCE_MIGRATE)))
        return c.json({ error: 'Forbidden' }, 403)
      forceRequest = { actor: `${actor.type}:${actor.id}`, reason: force.reason }
    }

    const machine = await getMachine(c.req.param('id'))
    if (!machine) return c.json({ error: 'Not found' }, 404)

    try {
      // Same barrier migrate-box takes: a fence claimed before crash-recovery
      // ran could be cleared out from under this call by a later recovery.
      await recoverFences()
      const identity = c.get('identity') as Identity | undefined
      const fenceOwner = owner && identity?.type === 'system' ? `${owner}:${identity.systemTokenId}` : owner
      const result = await quiesceMachine(machine.id, {
        ...(forceRequest ? { force: forceRequest } : {}),
        owner: fenceOwner,
      })
      if (result.refused.length > 0) {
        return c.json(
          {
            error:
              `Cannot quiesce machine ${machine.id}: ${result.refused.length} box(es) are busy or already fenced — ` +
              'no fences were left in place',
            refused: result.refused,
          },
          409
        )
      }
      return c.json({ quiesced: result.quiesced })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`quiesce ${machine.id} failed: ${message}`)
      return c.json({ error: message }, 500)
    }
  })

  // POST /api/machines/:id/release — lift the fences a prior /quiesce took.
  // Takes the EXPLICIT sandbox id list rather than "every box on the machine",
  // so it can never clear a fence belonging to a concurrent migrate-box.
  // Idempotent: clearing an already-clear (or absent) box is a no-op.
  app.post('/:id/release', requirePermission('machines:write'), zValidator('json', releaseSchema), async (c) => {
    const { sandboxIds, owner } = c.req.valid('json')
    if (owner && (c.get('identity') as Identity | undefined)?.type !== 'system') {
      return c.json({ error: 'Owner-scoped release requires system identity' }, 403)
    }
    const machine = await getMachine(c.req.param('id'))
    if (!machine) return c.json({ error: 'Not found' }, 404)
    const identity = c.get('identity') as Identity | undefined
    const fenceOwner = owner && identity?.type === 'system' ? `${owner}:${identity.systemTokenId}` : owner
    const released = await releaseMachine(sandboxIds, {}, fenceOwner)
    return c.json({ released })
  })

  // DELETE /api/machines/:id — terminate + forget a machine.
  app.delete('/:id', requirePermission('machines:write'), async (c) => {
    const machine = await getMachine(c.req.param('id'))
    if (!machine) {
      // A crash after machine-row deletion but before evacuation settlement is
      // replayable because evacuation receipt identity intentionally survives
      // machine deletion.
      try {
        const parsed = evacuationReceiptSchema.safeParse(await c.req.json())
        if (parsed.success && parsed.data.sourceMachineId === c.req.param('id')) {
          const authorization = await authorizeEvacuationSourceDeletion(parsed.data)
          if (!authorization.providerTerminationRequired) {
            await settleEvacuationSourceDeleted(parsed.data.operationId)
            return c.body(null, 204)
          }
        }
      } catch {
        // Preserve the ordinary missing-machine response below.
      }
      return c.json({ error: 'Not found' }, 404)
    }

    // Co-operate with the worker's empty-machine reaper instead of racing it to
    // provider.terminate: 'reaping' means the reaper has CLAIMED this machine
    // and is terminating it right now. Within one tick it either finishes (row
    // deleted — a retried DELETE turns 404) or rolls back to 'ready' on a
    // failed terminate (a retried DELETE then proceeds), so a retry-shortly 409
    // is always resolvable and never double-terminates.
    if (machine.status === 'reaping') {
      return c.json({ error: 'Machine is being reaped (terminating); retry shortly' }, 409)
    }

    let evacuationOperationId: string | undefined
    let providerTerminationRequired = true
    let terminationReconciliationRequired = false
    if (machine.status === 'draining') {
      let receipt: unknown
      try {
        receipt = await c.req.json()
      } catch {
        return c.json({ error: 'Verified evacuation receipt required' }, 409)
      }
      const parsed = evacuationReceiptSchema.safeParse(receipt)
      if (!parsed.success || parsed.data.sourceMachineId !== machine.id)
        return c.json({ error: 'Verified evacuation receipt required' }, 409)
      try {
        const authorization = await authorizeEvacuationSourceDeletion(parsed.data)
        providerTerminationRequired = authorization.providerTerminationRequired
        terminationReconciliationRequired = authorization.reconciliationRequired === true
        evacuationOperationId = parsed.data.operationId
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 409)
      }
    }

    const boxes = await listMachineBoxes(machine.id)
    if (boxes.length > 0) {
      return c.json({ error: 'Machine has active boxes; remove them before deleting' }, 409)
    }

    const provider = await getProviderEnsured(machine.provider)
    if (terminationReconciliationRequired) {
      const status = await provider.status(machine)
      if (status !== 'gone')
        return c.json({ error: 'Machine termination outcome is still ambiguous; retry shortly' }, 409)
      if (evacuationOperationId) await settleEvacuationSourceTerminated(evacuationOperationId)
    }
    if (providerTerminationRequired) {
      await provider.terminate(machine)
      if (evacuationOperationId) await settleEvacuationSourceTerminated(evacuationOperationId)
    }
    // Genuine machine teardown: `-O exit` the shared ControlMaster (this is the
    // ONE place routine shutdown reserves it for). Without it a deleted-but-
    // still-running BYO machine keeps the master — including the `-R` reverse
    // listener from the no-longer-trusted host into core's API port — alive
    // indefinitely. Pass the full row: closeMachine must aim at the
    // deterministic ControlPath even when THIS process (the api serves DELETE;
    // the worker establishes most masters) holds no in-memory record. The OTHER
    // core process's master health checks purge its own registries once the
    // socket is gone.
    await tunnels.closeMachine(machine)
    // Delete the per-machine BYO keypair secret — but NEVER the shared exe account
    // key (EXE_PROVIDER_SSH_KEY), which every exe machine references; deleting it
    // would break SSH to all the tenant's OTHER exe VMs. exe machines mint no
    // per-machine secret, so there is nothing of theirs to delete here.
    if (machine.provider !== 'exe' && machine.sshKeyId !== EXE_PROVIDER_SSH_KEY) {
      await getSecretStore().delete(machine.sshKeyId)
    }
    await deleteMachine(machine.id)
    if (evacuationOperationId) await settleEvacuationSourceDeleted(evacuationOperationId)
    eventEmitter.emit('machine.deleted', { machineId: machine.id })

    return c.body(null, 204)
  })

  return app
}

export default createMachinesRouter()

import { randomBytes, randomUUID } from 'crypto'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db, instanceMaintenanceState, machineBoxes, machines } from '../../db'
import type { MachineCapabilities } from '../../db/schema'
import { cancelInterruptedForceMigrationAudits } from './force-migration-audit'

/**
 * Query layer for VM-based sandbox "machines" (provider VMs / BYO SSH boxes)
 * and the per-sandbox "boxes" (unix users + ports) they host.
 */

export type { MachineCapabilities }

export type Machine = typeof machines.$inferSelect
export type MachineBox = typeof machineBoxes.$inferSelect

// Lowest port a box may bind on a machine. MAX(port)+1 allocation starts here
// on an empty machine (COALESCE(MAX(port), FIRST_BOX_PORT - 1) + 1).
const FIRST_BOX_PORT = 50100

/**
 * A bind targeted a machine whose status is not `'ready'` — most importantly
 * `'reaping'`, the empty-machine reaper's claim marker: the VM is about to be
 * (or is being) terminated, so landing a box on it would be destroyed with it.
 * Thrown by {@link bindMachineBox} under the machines-row lock, so a placement
 * that resolved the machine BEFORE the reaper claimed it still fails loudly at
 * bind time instead of silently binding onto a doomed VM. The vm manager
 * treats this as re-placeable (it re-runs placement, which never offers a
 * non-ready machine) rather than an agent-visible failure.
 */
export class MachineNotReadyError extends Error {
  constructor(
    message: string,
    /** The machine's status at the rejected bind (startup retry waits out transient ones). */
    readonly machineStatus?: string
  ) {
    super(message)
    this.name = 'MachineNotReadyError'
  }
}

/**
 * A CONDITIONAL bind ({@link bindMachineBox} with `expected`) found the box row
 * in a different state than the caller snapshotted — a concurrent ensure/bind
 * repointed it, changed its port, minted a token, or removed it entirely.
 * Thrown INSIDE the bind transaction, so the whole bind rolls back: the row is
 * exactly as the concurrent writer left it, and the caller's own bind never
 * became visible. The migrate repoint treats this as "old box stays
 * authoritative": it tears down the box it provisioned and reports a
 * structured conflict instead of committing a row that disagrees with any
 * running unit.
 */
export class BoxBindConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BoxBindConflictError'
  }
}

export async function insertMachine(values: typeof machines.$inferInsert): Promise<Machine> {
  const [row] = await db.insert(machines).values(values).returning()
  return row
}

export async function getMachine(id: string): Promise<Machine | null> {
  const [row] = await db.select().from(machines).where(eq(machines.id, id)).limit(1)
  return row ?? null
}

export async function getMachineByName(name: string): Promise<Machine | null> {
  const [row] = await db.select().from(machines).where(eq(machines.name, name)).limit(1)
  return row ?? null
}

export async function listMachines(): Promise<Machine[]> {
  return db.select().from(machines)
}

/**
 * Whether ANY machine of the given provider is registered — a bounded
 * LIMIT-1 existence probe, not a count. Used by the tenant secrets UI (via
 * services/machines/provider-credentials.ts's `isExeBacked`) to infer "this
 * instance is exe-backed" (core has no `machine_mode` column of its own).
 *
 * Deliberately GLOBAL/unscoped, not per-tenant — core runs one DB per
 * instance (instance-per-tenant), so "any machine of this provider exists
 * anywhere in this DB" already IS the correct per-instance scope. Do not
 * add a tenant/owner filter here without re-checking that premise.
 */
export async function machineExistsWithProvider(provider: string): Promise<boolean> {
  const rows = await db.select({ id: machines.id }).from(machines).where(eq(machines.provider, provider)).limit(1)
  return rows.length > 0
}

export async function updateMachine(
  id: string,
  updates: Partial<typeof machines.$inferInsert>
): Promise<Machine | null> {
  const [row] = await db.update(machines).set(updates).where(eq(machines.id, id)).returning()
  return row ?? null
}

/**
 * Atomically move a machine into `'bootstrapping'`: the only way a
 * `bootstrap.sh` run may start. Two concurrent runs on one host race on shared
 * installer paths (two bun installers unzipping the same file), so whoever
 * loses the claim must not run. `from` restricts the statuses it may claim
 * from; by default any status but `'bootstrapping'` itself. Returns the claimed
 * row, or null when the claim lost.
 */
export async function claimMachineForBootstrap(id: string, from?: readonly string[]): Promise<Machine | null> {
  const [row] = await db
    .update(machines)
    .set({ status: 'bootstrapping' })
    .where(and(eq(machines.id, id), from ? inArray(machines.status, [...from]) : ne(machines.status, 'bootstrapping')))
    .returning()
  return row ?? null
}

/**
 * Settle a bootstrap claim whose run threw before `bootstrapMachine` could
 * record an outcome, so the row is not stranded in `'bootstrapping'`.
 * Conditional on the claim still being held: never clobbers a status the run
 * itself (or anything else) wrote meanwhile.
 */
export async function failMachineBootstrapClaim(id: string, lastError: string): Promise<void> {
  await db
    .update(machines)
    .set({ status: 'unreachable', lastError })
    .where(and(eq(machines.id, id), eq(machines.status, 'bootstrapping')))
}

export async function deleteMachine(id: string): Promise<void> {
  await db.delete(machines).where(eq(machines.id, id))
}

/**
 * Record that artifact `name` at content-hash `version` was pushed to the
 * machine — the drift stamp {@link ensureArtifact} writes after a successful
 * push (`machine-artifacts.ts`).
 *
 * Deliberately an IN-DATABASE jsonb merge (`COALESCE(...,'{}') || {name:
 * version}`), never a read-modify-write of `machine.artifactVersions`:
 * ensureMachineArtifacts ensures every artifact sequentially against the SAME
 * in-memory machine snapshot, so spreading the snapshot's map when stamping the
 * second artifact would merge against the pre-first-stamp value and silently
 * clobber the first artifact's just-written entry. The `||` merges against the
 * current row, making each stamp independent of the caller's snapshot age.
 */
export async function stampArtifactVersion(machineId: string, name: string, version: string): Promise<void> {
  await db
    .update(machines)
    .set({
      artifactVersions: sql`COALESCE(${machines.artifactVersions}, '{}'::jsonb) || jsonb_build_object(${name}::text, ${version}::text)`,
    })
    .where(eq(machines.id, machineId))
}

/**
 * Record that the per-sandbox asset `name` at content-hash `hash` was pushed to
 * the box — the drift stamp {@link syncBoxFiles} (vm/file-sync.ts) writes after
 * successfully pushing every file of that asset. The `machineId` guard means a
 * stamp only lands while the box still lives where file-sync pushed it: a
 * concurrent migrate that repointed the row makes the stamp a no-op (0 rows),
 * so the next ensure on the new machine re-pushes rather than trusting a hash
 * for files that never reached it.
 *
 * Deliberately an IN-DATABASE jsonb merge (`COALESCE(...,'{}') || {name: hash}`),
 * never a read-modify-write of `box.syncedHashes`: syncBoxFiles stamps each
 * asset in turn against ONE in-memory box snapshot, so spreading that snapshot
 * when stamping the second asset would merge against the pre-first-stamp value
 * and silently clobber the first asset's just-written entry (the exact
 * regression stampArtifactVersion documents). The `||` merges against the
 * current row instead.
 */
export async function stampBoxSyncedHash(
  machineId: string,
  sandboxId: string,
  name: string,
  hash: string,
  files?: string[]
): Promise<void> {
  const value: unknown = files ? { hash, files } : hash
  await db
    .update(machineBoxes)
    .set({
      syncedHashes: sql`COALESCE(${machineBoxes.syncedHashes}, '{}'::jsonb) || jsonb_build_object(${name}::text, ${JSON.stringify(value)}::jsonb)`,
    })
    .where(and(eq(machineBoxes.sandboxId, sandboxId), eq(machineBoxes.machineId, machineId)))
}

/**
 * Reset a box's per-asset content-hash stamps to `'{}'` — called before any
 * (re)provision of the box's files ({@link installBoxOnMachine}) so a freshly
 * built or migrated box, whose machine holds NONE of the per-sandbox assets yet,
 * is never skip-starved by stamps a prior incarnation left. Keyed on the box's
 * PRIMARY KEY (`sandbox_id`) alone — NOT machine-guarded — because the migrate
 * primitive provisions the target box while the row still points at the SOURCE
 * machine, and a machine-guarded clear would no-op there and leave the migrated
 * box unable to receive its skills/identity/env/ssh. Clearing is unconditionally
 * safe (it only ever forces a re-push), so no guard is warranted. No-op when the
 * row is absent.
 */
export async function clearBoxSyncedHashes(sandboxId: string): Promise<void> {
  await db.update(machineBoxes).set({ syncedHashes: {} }).where(eq(machineBoxes.sandboxId, sandboxId))
}

/**
 * Bind a sandbox to a box on a machine, allocating its port atomically.
 *
 * Semantics:
 *  - New sandbox → assigned `MAX(port)+1` on that machine, floor
 *    {@link FIRST_BOX_PORT} (50100) on an empty machine.
 *  - Rebinding an existing sandbox to the *same* machine → keeps its existing
 *    port, only refreshing `unix_user`/`updated_at`.
 *  - Rebinding an existing sandbox to a *different* machine → assigned the newly
 *    computed port on the new machine.
 *
 * Concurrency: the whole operation runs in ONE transaction that first locks the
 * parent `machines` row `FOR UPDATE`, then reads `MAX(port)` and inserts within
 * that same lock. Because the lock, the MAX read, and the insert share a single
 * transaction, concurrent binds on one machine genuinely serialize end-to-end —
 * each sees the prior bind's port. The `(machine_id, port)` unique constraint is
 * the backstop that turns any residual race into an error rather than a silent
 * double-bind. Binds on different machines run in parallel.
 *
 * Executor auth token: the bind is ALSO where the box's `EXECUTOR_AUTH_TOKEN`
 * is minted, and it is minted atomically. Each call generates a fresh candidate
 * token, but the upsert only adopts it for a row that has none yet
 * (`COALESCE(machine_boxes.auth_token, excluded.auth_token)`): the FIRST
 * writer's token wins and, once set, the column is never overwritten. Two
 * concurrent full ensures of the same brand-new box (api + worker) therefore
 * observe the SAME persisted token via `.returning()` and push identical
 * server.envs — minting after the bind (as box-manager once did) let each
 * process mint a different token and wedge the box on a permanent 401 mismatch.
 * Same-machine binds serialize on the machine row lock above; binds racing
 * across machines still serialize on the `sandbox_id` unique conflict itself,
 * so the COALESCE is atomic at the row level either way. A legacy null-token
 * row picks up a token on its next bind (the re-provision pass).
 *
 * Empty-since upkeep: a bound box makes the machine non-empty, so the bind
 * clears `machines.empty_since` inside the same transaction/lock
 * ({@link deleteMachineBox} sets it, under the same lock, only when it deletes
 * the machine's last box).
 *
 * Reaper serialization: the bind REJECTS ({@link MachineNotReadyError}) any
 * machine whose status is not `'ready'` — in particular `'reaping'`, the
 * empty-machine reaper's claim marker. The status check runs under the same
 * machines-row FOR UPDATE lock the reaper's claim transaction takes
 * ({@link claimMachineForReaping}), so bind-vs-reap genuinely serializes: either
 * the bind commits first (the claim then sees a live box and aborts) or the
 * claim commits first (the bind then sees 'reaping' and throws — the caller
 * re-places onto another machine). Production callers only ever bind onto a
 * machine placement resolved as `ready`, so rejecting every other status is a
 * pure tightening.
 */
export async function bindMachineBox(values: {
  sandboxId: string
  machineId: string
  unixUser: string
  /**
   * Explicit port to bind instead of the MAX(port)+1 allocation — the migrate
   * repoint path, whose box was already provisioned on the target machine at a
   * pre-peeked port ({@link peekNextBoxPort}): the row must record the port the
   * running unit actually serves. The `(machine_id, port)` unique constraint
   * backstops a stale peek (a concurrent bind took the port meanwhile → this
   * bind throws instead of double-binding).
   */
  port?: number
  /**
   * Candidate auth token for a bind that must land a SPECIFIC token (the
   * migrate of a legacy token-less box, whose new unit's server.env already
   * carries a freshly minted token). The COALESCE below still keeps any
   * already-persisted token — a candidate can never overwrite one.
   */
  authToken?: string
  /**
   * Compare-and-swap precondition (the migrate repoint). When present, the box
   * row is locked (`FOR UPDATE`, inside this same transaction) and must still
   * hold EXACTLY this pre-state — `machineId === fromMachineId`, `port`, and
   * `authToken` (null matches a legacy token-less row) — or the bind throws
   * {@link BoxBindConflictError} and the WHOLE transaction rolls back, leaving
   * the row untouched. An absent row also conflicts (an unconditional bind
   * would silently resurrect a box a concurrent remove just deleted). Callers
   * that omit `expected` get today's unconditional upsert, byte-for-byte.
   */
  onBound?: (tx: DbTransaction, box: MachineBox) => Promise<void>
  expected?: {
    /** The machine the row must still point at (the migrate's source). */
    fromMachineId: string
    /** The row's snapshotted port on that source machine. */
    port: number
    /** The row's snapshotted token (null for a legacy token-less row). */
    authToken: string | null
  }
}): Promise<MachineBox> {
  const { sandboxId, machineId, unixUser } = values
  return db.transaction(async (tx) => {
    // Serialize concurrent binds for this machine on the parent row lock.
    const [machine] = await tx
      .select({ id: machines.id, status: machines.status })
      .from(machines)
      .where(eq(machines.id, machineId))
      .for('update')
    if (!machine) throw new Error(`machine not found: ${machineId}`)
    // Under the same lock the reaper's claim takes: a machine the reaper has
    // claimed ('reaping') — or any other non-ready machine — must never gain a
    // box. See MachineNotReadyError for the bind-vs-reap serialization story.
    if (machine.status !== 'ready') {
      throw new MachineNotReadyError(
        `machine ${machineId} is not ready (status ${machine.status}); refusing to bind`,
        machine.status
      )
    }

    // CAS precondition: lock the box row and verify the caller's snapshot still
    // holds. Machine-row-then-box-row is the lock order deleteMachineBox already
    // takes, so this adds no new deadlock cycle. The lock is held through the
    // commit, so the upsert below is deterministic against the verified state.
    if (values.expected) {
      const [current] = await tx
        .select({ machineId: machineBoxes.machineId, port: machineBoxes.port, authToken: machineBoxes.authToken })
        .from(machineBoxes)
        .where(eq(machineBoxes.sandboxId, sandboxId))
        .for('update')
      if (!current) {
        throw new BoxBindConflictError(`conditional bind of ${sandboxId}: box row is gone (concurrent remove)`)
      }
      if (
        current.machineId !== values.expected.fromMachineId ||
        current.port !== values.expected.port ||
        current.authToken !== values.expected.authToken
      ) {
        throw new BoxBindConflictError(
          `conditional bind of ${sandboxId}: row drifted from the expected pre-state ` +
            `(machine ${values.expected.fromMachineId} → ${current.machineId}, ` +
            `port ${values.expected.port} → ${current.port}, ` +
            `token ${current.authToken === values.expected.authToken ? 'unchanged' : 'CHANGED'})`
        )
      }
    }

    let nextPort: number
    if (values.port !== undefined) {
      nextPort = values.port
    } else {
      const [row] = await tx
        .select({ nextPort: sql<number>`COALESCE(MAX(${machineBoxes.port}), ${FIRST_BOX_PORT - 1}) + 1` })
        .from(machineBoxes)
        .where(eq(machineBoxes.machineId, machineId))
      nextPort = Number(row?.nextPort ?? FIRST_BOX_PORT)
    }

    // Candidate token for a first bind; the COALESCE below keeps an existing one.
    const authToken = values.authToken ?? randomBytes(32).toString('hex')

    const [box] = await tx
      .insert(machineBoxes)
      .values({ sandboxId, machineId, unixUser, port: nextPort, authToken })
      .onConflictDoUpdate({
        target: machineBoxes.sandboxId,
        set: {
          machineId: sql`excluded.machine_id`,
          unixUser: sql`excluded.unix_user`,
          // Same machine → keep existing port; different machine → take the new one.
          port: sql`CASE WHEN ${machineBoxes.machineId} = excluded.machine_id THEN ${machineBoxes.port} ELSE excluded.port END`,
          // Cross-machine rebind resets the per-asset drift stamps ATOMICALLY with
          // the repoint (spec §4 "or bindMachineBox on re-bind"). The new machine's
          // box holds NONE of the per-sandbox assets, so any stamp the old row
          // carried must not survive the move. Under this row lock the wipe is
          // atomic with the machine change: a stamp racing in during the migrate's
          // provision window (still matching stampBoxSyncedHash's SOURCE-machine
          // guard) is erased here if it committed BEFORE this bind, and rejected by
          // that guard if attempted AFTER — closing the migrate skip-starve race.
          // Same machine → keep the stamps (the install-time clearBoxSyncedHashes
          // handles same-machine rebuilds; here we deliberately preserve them).
          syncedHashes: sql`CASE WHEN ${machineBoxes.machineId} = excluded.machine_id THEN ${machineBoxes.syncedHashes} ELSE '{}'::jsonb END`,
          // First writer wins; once a token is persisted it is NEVER overwritten
          // (stable across ensures, machine moves, and mid-provision retries).
          authToken: sql`COALESCE(${machineBoxes.authToken}, excluded.auth_token)`,
          updatedAt: new Date(),
        },
      })
      .returning()

    // CAS postcondition (belt-and-braces; still inside the transaction, so a
    // failure rolls the whole bind back): with the box-row lock held since the
    // precondition, the upsert's CASE/COALESCE must have landed exactly the
    // caller's values — any disagreement means the row would diverge from the
    // unit the migrate provisioned, so refuse to commit it.
    if (values.expected && (box.machineId !== machineId || box.port !== nextPort || box.authToken !== authToken)) {
      throw new BoxBindConflictError(
        `conditional bind of ${sandboxId}: committed row would disagree with the bind ` +
          `(machine ${box.machineId} vs ${machineId}, port ${box.port} vs ${nextPort}, ` +
          `token ${box.authToken === authToken ? 'matches' : 'MISMATCH'})`
      )
    }

    // The machine now hosts a box: clear the drain marker so the empty-machine
    // reaper never counts a previous drain window against a re-occupied machine.
    // Same transaction (and parent-row lock) as the insert, so a racing last-box
    // delete cannot interleave between the bind and the clear.
    await tx.update(machines).set({ emptySince: null }).where(eq(machines.id, machineId))
    await values.onBound?.(tx, box)
    return box
  })
}

/**
 * Upsert a box for non-allocating updates (status flips, unix_user refresh).
 * Ports are assigned only via {@link bindMachineBox}; callers here must pass the
 * box's already-bound port.
 */
export async function upsertMachineBox(box: typeof machineBoxes.$inferInsert): Promise<MachineBox> {
  const [row] = await db
    .insert(machineBoxes)
    .values(box)
    .onConflictDoUpdate({
      target: machineBoxes.sandboxId,
      set: {
        machineId: box.machineId,
        unixUser: box.unixUser,
        port: box.port,
        ...(box.status !== undefined ? { status: box.status } : {}),
        // Conditional like status: an upsert that doesn't carry the token
        // (status flips, activity seeds) must never null out the box's
        // persisted executor auth token.
        ...(box.authToken !== undefined ? { authToken: box.authToken } : {}),
        // Conditional for the same reason: a status-flip/activity-seed upsert
        // (e.g. the resume fast-path's 'ready' stamp, which never touches this
        // field) must never null out the box's last-provisioned spec hash.
        ...(box.provisionedSpecHash !== undefined ? { provisionedSpecHash: box.provisionedSpecHash } : {}),
        // The durable bare hash is independently optional; status-only upserts
        // must preserve it so restart-safe drift inspection remains possible.
        ...(box.reconcilableSpecHash !== undefined ? { reconcilableSpecHash: box.reconcilableSpecHash } : {}),
        ...(box.lastActivityAt !== undefined ? { lastActivityAt: box.lastActivityAt } : {}),
        updatedAt: new Date(),
      },
    })
    .returning()
  return row
}

/**
 * Persist the coarse cross-process activity heartbeat for a box. Callers
 * throttle (the vm manager writes at most every ~30s per box), so this is a
 * plain unconditional update; it no-ops when the row is gone (box removed
 * mid-touch).
 */
export async function touchMachineBoxActivity(sandboxId: string, at: Date): Promise<void> {
  await db.update(machineBoxes).set({ lastActivityAt: at }).where(eq(machineBoxes.sandboxId, sandboxId))
}

export async function listMachineBoxes(machineId: string): Promise<MachineBox[]> {
  return db.select().from(machineBoxes).where(eq(machineBoxes.machineId, machineId))
}

/**
 * Every box across the whole fleet — the machines LIST endpoint groups these by
 * machineId in JS to attach per-machine utilization without an N+1 (one query
 * for all machines' boxes rather than one per machine). Fine at the current
 * fleet/box scale; if it ever grows, fold utilization into a grouped aggregate
 * query alongside {@link listMachines}.
 */
export async function listAllMachineBoxes(): Promise<MachineBox[]> {
  return db.select().from(machineBoxes)
}

/**
 * The port {@link bindMachineBox} WOULD allocate on `machineId` right now
 * (`COALESCE(MAX(port), 50099) + 1`), without reserving it. The migrate
 * primitive provisions a box on a target machine BEFORE the row repoints there
 * (the row is the only reservation mechanism), so it peeks the port here, bakes
 * it into the new unit, and passes it back to the final bind as an explicit
 * port. A concurrent bind can take the peeked port in between — the
 * `(machine_id, port)` unique constraint then fails the migrate's bind loudly
 * (old box intact) instead of double-binding the port.
 */
export async function peekNextBoxPort(machineId: string): Promise<number> {
  const [row] = await db
    .select({ nextPort: sql<number>`COALESCE(MAX(${machineBoxes.port}), ${FIRST_BOX_PORT - 1}) + 1` })
    .from(machineBoxes)
    .where(eq(machineBoxes.machineId, machineId))
  return Number(row?.nextPort ?? FIRST_BOX_PORT)
}

export async function getMachineBox(sandboxId: string): Promise<MachineBox | null> {
  const [row] = await db.select().from(machineBoxes).where(eq(machineBoxes.sandboxId, sandboxId)).limit(1)
  return row ?? null
}

/**
 * All ready, general-shared machines with their current box count — one LEFT JOIN
 * aggregate. The placement policy's BYO/least-loaded rule reads this to pick the
 * least-loaded machine.
 *
 * Filters on `purpose='shared'` as well as `scope='shared'`: a squad/commons VM
 * carries scope='shared' but is reserved for one squad (or the tenant commons),
 * so it must never be offered as a general least-loaded host — that would land a
 * box on another squad's VM (intra-tenant isolation leak). A pure BYO fleet has
 * only purpose='shared' machines, so this filter is a no-op there.
 */
export async function queryReadySharedMachines(): Promise<Array<{ machine: Machine; boxCount: number }>> {
  const rows = await db
    .select({ machine: machines, boxCount: sql<number>`count(${machineBoxes.sandboxId})` })
    .from(machines)
    .leftJoin(machineBoxes, eq(machineBoxes.machineId, machines.id))
    .where(and(eq(machines.status, 'ready'), eq(machines.scope, 'shared'), eq(machines.purpose, 'shared')))
    .groupBy(machines.id)
  return rows.map((r) => ({ machine: r.machine, boxCount: Number(r.boxCount) }))
}

/**
 * All ready, general-shared machines with the sandboxIds of the boxes they host —
 * the packed-pool placement input (one LEFT JOIN aggregate). Same
 * `status='ready' AND scope='shared' AND purpose='shared'` filter as
 * {@link queryReadySharedMachines}: legacy purpose-keyed VMs (`squad`/`commons`)
 * are deliberately invisible to the packer so packed boxes never mix onto them
 * (see resolvePacked's migration note). Returns RAW sandboxIds — role weighting
 * lives in placement, not SQL, so the weight policy stays in one place.
 */
export async function queryReadySharedMachineLoads(): Promise<Array<{ machine: Machine; boxSandboxIds: string[] }>> {
  const rows = await db
    .select({
      machine: machines,
      boxSandboxIds: sql<
        string[]
      >`coalesce(array_agg(${machineBoxes.sandboxId}) filter (where ${machineBoxes.sandboxId} is not null), '{}')`,
    })
    .from(machines)
    .leftJoin(machineBoxes, eq(machineBoxes.machineId, machines.id))
    .where(and(eq(machines.status, 'ready'), eq(machines.scope, 'shared'), eq(machines.purpose, 'shared')))
    .groupBy(machines.id)
  return rows.map((r) => ({ machine: r.machine, boxSandboxIds: r.boxSandboxIds }))
}

/**
 * Total machine rows — the input to the placement provisioning cap. Counts every
 * row (a terminated machine's row is deleted, not retained), so this reflects the
 * live fleet size the cap bounds.
 */
export async function countMachines(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(machines)
  return Number(row?.count ?? 0)
}

/**
 * Delete a box row, stamping the parent machine's `empty_since` when that was
 * the machine's LAST box (the empty-machine reaper's idle clock; cleared again
 * by {@link bindMachineBox}).
 *
 * Runs in one transaction that locks the parent `machines` row `FOR UPDATE`
 * FIRST — the exact lock (and lock order) bindMachineBox takes — so a
 * concurrent bind and a last-box delete serialize: the "was that the last
 * box?" count can never interleave with a bind's insert, and a machine that
 * hosts a box always has `empty_since` null. No-op when the box row is absent;
 * tolerant of the machine row itself being gone (nothing left to stamp).
 *
 * Repoint safety (TOCTOU): the box's machineId is read BEFORE the machine lock
 * is taken, and a concurrent bind can REPOINT the row to a different machine in
 * between (bindMachineBox locks the NEW machine, so the old machine's lock does
 * not serialize it). The delete is therefore qualified `AND machine_id = <the
 * machineId we read>`: a repointed row matches zero rows, the transaction
 * leaves it untouched, and the whole read→lock→delete is retried under the
 * CORRECT machine's lock (bounded). Without the qualifier the delete would
 * remove a row now living on the NEW machine while holding the OLD machine's
 * lock — draining the new machine without ever stamping its idle clock.
 */
export const UNVERIFIED_STOP_REMNANT_PREFIX = 'unverified_stop_remnant_'
export const UNVERIFIED_STOP_EXTERNALIZE_AFTER_MS = 5 * 60 * 1000

export function unverifiedStopRemnantId(sandboxId: string, id = randomUUID()): string {
  const encodedOwner = encodeURIComponent(sandboxId).replaceAll('.', '%2E')
  return `${UNVERIFIED_STOP_REMNANT_PREFIX}${encodedOwner}.${id}`
}

export function originalSandboxIdFromUnverifiedStopRemnant(remnantId: string): string | null {
  if (!remnantId.startsWith(UNVERIFIED_STOP_REMNANT_PREFIX)) return null
  const encoded = remnantId.slice(UNVERIFIED_STOP_REMNANT_PREFIX.length).split('.', 1)[0]
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

export async function findUnverifiedStopRemnant(machineId: string, unixUser: string): Promise<MachineBox | null> {
  const [row] = await db
    .select()
    .from(machineBoxes)
    .where(
      and(
        eq(machineBoxes.machineId, machineId),
        eq(machineBoxes.unixUser, unixUser),
        eq(machineBoxes.status, 'orphaned'),
        sql`${machineBoxes.sandboxId} LIKE ${`${UNVERIFIED_STOP_REMNANT_PREFIX}%`}`
      )
    )
    .limit(1)
  return row ?? null
}

export async function hasUnverifiedStopRemnant(machineId: string, unixUser: string): Promise<boolean> {
  return Boolean(await findUnverifiedStopRemnant(machineId, unixUser))
}

/**
 * Detach an unverified stop from its logical sandbox while retaining a durable
 * machine/user/port retirement row. The original sandbox ID becomes reusable
 * only when the recorded machine is still non-ready; a ready machine must
 * verify the physical stop instead. The remnant row is later reclaimed by the
 * machine lifecycle when that exact machine is reachable again.
 */
export async function externalizeUnverifiedBoxStop(
  sandboxId: string
): Promise<
  | { kind: 'externalized'; remnantId: string; machineId: string; port: number }
  | { kind: 'not-found' }
  | { kind: 'machine-ready' }
  | { kind: 'deferred' }
> {
  return db.transaction(async (tx) => {
    const [snapshot] = await tx
      .select({ machineId: machineBoxes.machineId })
      .from(machineBoxes)
      .where(and(eq(machineBoxes.sandboxId, sandboxId), eq(machineBoxes.status, 'stop_unverified')))
      .limit(1)
    if (!snapshot) return { kind: 'not-found' } as const

    const [machine] = await tx
      .select({ id: machines.id, status: machines.status })
      .from(machines)
      .where(eq(machines.id, snapshot.machineId))
      .for('update')
    if (!machine) return { kind: 'not-found' } as const
    if (machine.status === 'ready') return { kind: 'machine-ready' } as const

    const [box] = await tx
      .select()
      .from(machineBoxes)
      .where(
        and(
          eq(machineBoxes.sandboxId, sandboxId),
          eq(machineBoxes.machineId, machine.id),
          eq(machineBoxes.status, 'stop_unverified')
        )
      )
      .for('update')
    if (!box) return { kind: 'not-found' } as const
    if (box.updatedAt.getTime() > Date.now() - UNVERIFIED_STOP_EXTERNALIZE_AFTER_MS) {
      return { kind: 'deferred' } as const
    }

    const remnantId = unverifiedStopRemnantId(sandboxId)
    await tx.delete(machineBoxes).where(eq(machineBoxes.sandboxId, sandboxId))
    await tx.insert(machineBoxes).values({
      sandboxId: remnantId,
      machineId: box.machineId,
      unixUser: box.unixUser,
      port: box.port,
      status: 'orphaned',
    })
    return { kind: 'externalized', remnantId, machineId: box.machineId, port: box.port } as const
  })
}

export async function deleteMachineBox(sandboxId: string): Promise<void> {
  const MAX_ATTEMPTS = 5
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const done = await db.transaction(async (tx) => {
      const [box] = await tx
        .select({ machineId: machineBoxes.machineId })
        .from(machineBoxes)
        .where(eq(machineBoxes.sandboxId, sandboxId))
        .limit(1)
      if (!box) return true // absent (or deleted by a racing call) — nothing to do

      // Serialize with bindMachineBox on the parent-row lock (same order:
      // machine first, then machine_boxes writes) so the emptiness accounting
      // below is race-free. An absent machine row (concurrent machine delete)
      // simply locks nothing — the cascade owns the boxes then.
      await tx.select({ id: machines.id }).from(machines).where(eq(machines.id, box.machineId)).for('update')

      const deleted = await tx
        .delete(machineBoxes)
        .where(and(eq(machineBoxes.sandboxId, sandboxId), eq(machineBoxes.machineId, box.machineId)))
        .returning({ sandboxId: machineBoxes.sandboxId })
      // Zero rows → the row was repointed to another machine after our read;
      // retry the read under the new machine's lock (see the doc comment).
      if (deleted.length === 0) return false

      const [remaining] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(machineBoxes)
        .where(eq(machineBoxes.machineId, box.machineId))
      if (Number(remaining?.count ?? 0) === 0) {
        await tx.update(machines).set({ emptySince: new Date() }).where(eq(machines.id, box.machineId))
      }
      return true
    })
    if (done) return
  }
  // Only reachable if the row was repointed on EVERY attempt — pathological
  // (each retry needs a concurrent rebind landing in a sub-ms window). Fail
  // loudly rather than looping forever; the caller's retry re-runs the delete.
  throw new Error(`deleteMachineBox: box ${sandboxId} kept repointing across ${MAX_ATTEMPTS} attempts; giving up`)
}

// ---------------------------------------------------------------------------
// Empty-machine reaper primitives (claim / restore / stamp)
// ---------------------------------------------------------------------------

/**
 * Atomically claim a drained machine for reaping: lock the machines row
 * `FOR UPDATE` (the same lock {@link bindMachineBox} takes), re-verify
 * eligibility against the LOCKED row via `isEligible`, re-count the machine's
 * boxes IN the transaction, and only then flip `status` to `'reaping'`.
 * Returns true iff the claim committed — only then may the caller
 * `provider.terminate` the VM.
 *
 * This is what serializes terminate against bind: a bind that committed after
 * the reaper's snapshot makes the in-txn count non-zero (claim aborts), and a
 * bind that starts after the claim sees `'reaping'` and throws
 * ({@link MachineNotReadyError}). There is no window in which both a bind and a
 * terminate can proceed.
 *
 * `isEligible` is the caller's policy re-check (status/marker/grace — see
 * machine-reaper.ts `isReapCandidate`), evaluated against the row as locked, so
 * a marker that moved since the caller's snapshot (e.g. a bind+drain cycle
 * re-stamped `empty_since` inside the grace) is honored.
 */
export async function claimMachineForReaping(
  machineId: string,
  isEligible: (machine: Machine) => boolean
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(machines).where(eq(machines.id, machineId)).for('update')
    if (!row) return false
    if (!isEligible(row)) return false

    const [count] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(machineBoxes)
      .where(eq(machineBoxes.machineId, machineId))
    if (Number(count?.count ?? 0) > 0) return false

    await tx.update(machines).set({ status: 'reaping' }).where(eq(machines.id, machineId))
    return true
  })
}

/**
 * Undo a reaping claim after a FAILED `provider.terminate`: put the machine
 * back to `'ready'` so binds may land again and the next reaper pass retries.
 * Conditional on `status='reaping'` so it can never clobber a status someone
 * else set in the meantime.
 */
export async function restoreMachineFromReaping(machineId: string): Promise<void> {
  await db
    .update(machines)
    .set({ status: 'ready' })
    .where(and(eq(machines.id, machineId), eq(machines.status, 'reaping')))
}

/**
 * Start the idle clock on a machine that is empty but carries no
 * `empty_since` marker (`null`) — the reaper's repair for the two drain paths
 * that bypass {@link deleteMachineBox}'s last-box stamp:
 *  (a) a bind REPOINTING a box's row off its old machine (ensureBox re-place /
 *      migrate), which drains the old machine with no delete, and
 *  (b) a machine provisioned but never bound (the caller failed between
 *      provision and bind).
 * Same lock + in-txn zero-count discipline as {@link claimMachineForReaping}:
 * stamps `empty_since = at` only when the LOCKED row is still `'ready'`, still
 * unmarked, and hosts zero boxes. Returns true iff it stamped. The machine
 * then becomes reap-eligible a full grace later (a bind meanwhile clears the
 * marker as usual).
 */
export async function stampMachineEmptySinceIfDrained(machineId: string, at: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: machines.status, emptySince: machines.emptySince })
      .from(machines)
      .where(eq(machines.id, machineId))
      .for('update')
    if (!row || row.status !== 'ready' || row.emptySince !== null) return false

    const [count] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(machineBoxes)
      .where(eq(machineBoxes.machineId, machineId))
    if (Number(count?.count ?? 0) > 0) return false

    await tx.update(machines).set({ emptySince: at }).where(eq(machines.id, machineId))
    return true
  })
}

// ---------------------------------------------------------------------------
// Manual-rebalance fence primitives (set / clear / read `migrating`)
// ---------------------------------------------------------------------------

/**
 * The drizzle transaction handle `db.transaction` passes to its callback — the
 * parameter type for queries that must run inside a CALLER-owned transaction
 * (e.g. {@link isBoxMigratingLocked}, which only means anything when its row
 * lock is held through the caller's own commit).
 */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Atomically CLAIM a box's migration fence: in ONE transaction under the box's
 * `machine_boxes` row `FOR UPDATE` lock, refuse (return false) if `migrating`
 * is ALREADY true — another migration holds the fence, and re-winning it would
 * let two concurrent migrations of one box both proceed into a double
 * tar/restore. Otherwise SET `migrating = true` FIRST, and only THEN re-check
 * `hasActiveExecution(sandboxId)`. If a turn is active, the fence is cleared
 * (same transaction, lock still held — the flip was never visible to anyone)
 * and the call returns false; otherwise the fence commits and the call returns
 * true. Returns false when the box row is absent. `true` therefore means this
 * caller EXCLUSIVELY owns the fence (same claim discipline as
 * {@link claimMachineForReaping}) until it lifts it via
 * {@link clearBoxMigrating}.
 *
 * Consumer protocol — how a turn-starting path must check the fence: the box
 * row's `FOR UPDATE` lock is the ONE serialization point. Any consumer that
 * must PREVENT a turn from starting under a live migration MUST take that same
 * lock — `SELECT migrating FROM machine_boxes WHERE sandbox_id = ? FOR UPDATE`
 * ({@link isBoxMigratingLocked}) — INSIDE the same transaction as its own
 * execution claim, refuse if `migrating` is true, and hold the lock through
 * its commit. Then either order resolves to exactly one winner, because both
 * sides block on the box row lock: if the consumer's claim transaction
 * acquired the lock first, this fence waits for its commit, and the recheck
 * below sees the committed execution via `hasActiveExecution` and backs off;
 * if the fence acquired it first, the consumer's locked read waits for the
 * fence's commit and then sees `migrating = true` and refuses. A PLAIN
 * (non-locking) read is NOT a safe guard — the consumer could commit its claim
 * and read `migrating = false` moments before the fence transaction commits,
 * starting a turn under a live migration. {@link isBoxMigrating} is
 * advisory/display only, never the guard.
 *
 * `hasActiveExecution` is the caller's activity probe. It runs INSIDE the
 * fence transaction while the box row lock is held, so it must be FAST and
 * DB-only: query ONLY the executions table (for the box's owning agent(s)),
 * and it MUST NOT touch this box's `machine_boxes` row — or call any path that
 * locks it — from its own connection. That wait (fence txn awaiting the
 * callback, callback's connection waiting on the fence's row lock) spans two
 * connections, so Postgres cannot detect it as a deadlock: it hangs silently
 * rather than erroring 40P01. The callback also pins a pool connection plus
 * the row lock for its full latency — keep it to one indexed query.
 */
export async function fenceBoxForMigration(
  sandboxId: string,
  hasActiveExecution: (agentSandboxId: string, tx?: DbTransaction) => Promise<boolean>,
  executor: Pick<typeof db, 'transaction'> = db,
  owner?: string
): Promise<boolean> {
  return executor.transaction(async (tx) => {
    if (owner !== undefined) {
      await tx.insert(instanceMaintenanceState).values({ id: 'global' }).onConflictDoNothing()
      const [maintenance] = await tx
        .select({
          leaseId: instanceMaintenanceState.platformLeaseId,
          expiresAt: instanceMaintenanceState.platformLeaseExpiresAt,
          now: sql<Date>`clock_timestamp()`,
        })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
        .for('update')
      if (
        !maintenance ||
        maintenance.leaseId !== owner.split(':', 1)[0] ||
        !maintenance.expiresAt ||
        maintenance.expiresAt <= new Date(maintenance.now)
      )
        return false
    }
    const [box] = await tx
      .select({ migrating: machineBoxes.migrating, migrationOwner: machineBoxes.migrationOwner })
      .from(machineBoxes)
      .where(eq(machineBoxes.sandboxId, sandboxId))
      .for('update')
    if (!box) return false
    if (box.migrating && box.migrationOwner === owner) return owner !== undefined
    if (box.migrating && owner === undefined) return false

    // A different owner whose lease was validated above is the current
    // successor. Since only one platform lease can be active, the persisted
    // owner is stale (expired/replaced or token-rotated) and may be adopted.
    const previousOwner = box.migrating ? box.migrationOwner : null
    await tx
      .update(machineBoxes)
      .set({ migrating: true, migrationOwner: owner ?? null })
      .where(eq(machineBoxes.sandboxId, sandboxId))

    // ... THEN recheck. An execution that committed before this point is seen
    // here (the consumer's claim txn held our row lock until it committed);
    // one claimed after our commit sees the fence via its locked read.
    if (await hasActiveExecution(sandboxId, tx)) {
      await tx
        .update(machineBoxes)
        .set(
          box.migrating
            ? { migrating: true, migrationOwner: previousOwner }
            : { migrating: false, migrationOwner: null }
        )
        .where(eq(machineBoxes.sandboxId, sandboxId))
      return false
    }
    return true
  })
}

/**
 * Locking fence read for consumers that must PREVENT a turn from starting
 * during a migration (the execution pickup path): `SELECT migrating ... FOR
 * UPDATE` issued on the CALLER's transaction handle, so it runs inside the
 * same transaction as the caller's own claim and the box row lock is held
 * through the caller's commit — see {@link fenceBoxForMigration} for why the
 * lock, not a plain read, is the serialization point. Returns false when the
 * box row is absent (nothing is migrating — and with no row there is no lock
 * to take; a box only becomes fence-able once bound).
 */
export async function areBoxesMigratingLocked(tx: DbTransaction, sandboxIds: string[]): Promise<boolean> {
  const orderedSandboxIds = [...new Set(sandboxIds)].sort()
  if (orderedSandboxIds.length === 0) return false
  const rows = await tx
    .select({ migrating: machineBoxes.migrating })
    .from(machineBoxes)
    .where(inArray(machineBoxes.sandboxId, orderedSandboxIds))
    .orderBy(machineBoxes.sandboxId)
    .for('update')
  return rows.some((row) => row.migrating)
}

export async function isBoxMigratingLocked(tx: DbTransaction, sandboxId: string): Promise<boolean> {
  return areBoxesMigratingLocked(tx, [sandboxId])
}

/**
 * Lift a box's migration fence (migration finished or failed). Unconditional
 * `migrating = false`; no-ops when the row is gone.
 */
export async function clearBoxMigrating(sandboxId: string, owner?: string): Promise<void> {
  await db
    .update(machineBoxes)
    .set({ migrating: false, migrationOwner: null })
    .where(
      and(
        eq(machineBoxes.sandboxId, sandboxId),
        ...(owner === undefined ? [] : [eq(machineBoxes.migrationOwner, owner)])
      )
    )
}

/**
 * Clear EVERY box's migration fence — the API process's boot-time crash
 * recovery (run via {@link recoverMigrationFencesOnce}). Returns the number of
 * fences cleared.
 *
 * Why this is safe, and why the API (NOT the worker): a fence is only ever
 * held by a live in-process migrateBox call, and migrations EXECUTE IN THE API
 * PROCESS — the machines router (routes/machines.ts, mounted in index.ts)
 * calls migrateBox / rebalanceFleet directly, and nothing else invokes them
 * (the CLI goes through those HTTP routes). So at API boot no fence can
 * legitimately be live. migrateBox's try/finally does NOT survive process
 * death: an API crash mid-migrate leaves `migrating = true` forever, making
 * the box permanently unmigratable (fenceBoxForMigration always loses to the
 * ghost) and — since execution pickup defers on the fence — deferring ALL
 * turns on that box indefinitely. Any fence observed at API boot is therefore
 * stale by construction. The WORKER must never run this: a fence it observes
 * at ITS boot may be live in an in-flight API-side migrate, and clearing it
 * would let pickup start the deferred turn on the OLD box mid-move (the
 * migrate then repoints + userdels that box under the running turn — turn
 * killed, ~/.private writes lost); the worker only DEFERS on a fence, so a
 * stale one merely delays a turn until the API boot clears it.
 *
 * CAVEAT: this assumes a SINGLE API process. A multi-replica API could observe
 * a fence held by a sibling replica's live migrate — replicas would need a
 * fence TTL/heartbeat instead of a boot-time clear-all (out of scope; noted
 * here so the assumption is explicit).
 */
export async function clearAllMigratingFences(): Promise<number> {
  const cleared = await db
    .update(machineBoxes)
    .set({ migrating: false, migrationOwner: null })
    .where(and(eq(machineBoxes.migrating, true), isNull(machineBoxes.migrationOwner)))
    .returning({ sandboxId: machineBoxes.sandboxId })
  return cleared.length
}

let migrationFenceRecovery: Promise<number> | null = null

/**
 * Run {@link clearAllMigratingFences} exactly ONCE per process (memoized) —
 * the API's fence crash-recovery barrier.
 *
 * Why a barrier and not just a boot step: Bun.serve starts accepting requests
 * BEFORE index.ts's async boot chain finishes, so "clear during boot" alone
 * leaves a window where a migrate request is served first, wins a live fence,
 * and the boot chain then clears that LIVE fence out from under it (the exact
 * bug the boot recovery exists to prevent, reintroduced in-process). The
 * migrate/rebalance routes therefore AWAIT this barrier before executing, and
 * the boot chain awaits the same one: whoever arrives first performs the one
 * clear, every migrate is strictly-after it, and once any migrate has run the
 * recovery can never run again. A failed clear un-memoizes so the next caller
 * retries instead of wedging every future migrate on a boot-time DB blip.
 */
export function recoverMigrationFencesOnce(): Promise<number> {
  if (!migrationFenceRecovery) {
    migrationFenceRecovery = Promise.all([clearAllMigratingFences(), cancelInterruptedForceMigrationAudits()])
      .then(([cleared]) => cleared)
      .catch((err) => {
        migrationFenceRecovery = null
        throw err
      })
  }
  return migrationFenceRecovery
}

/**
 * Whether the box is currently fenced for migration — ADVISORY/DISPLAY ONLY
 * (status surfaces, logs). This is a plain non-locking read: it can return
 * false while a fence transaction is instants from committing, so it must
 * NEVER gate starting a turn — guards use {@link isBoxMigratingLocked} inside
 * their own claim transaction. Absent row → false.
 */
export async function isBoxMigrating(sandboxId: string): Promise<boolean> {
  const [row] = await db
    .select({ migrating: machineBoxes.migrating })
    .from(machineBoxes)
    .where(eq(machineBoxes.sandboxId, sandboxId))
    .limit(1)
  return row?.migrating ?? false
}

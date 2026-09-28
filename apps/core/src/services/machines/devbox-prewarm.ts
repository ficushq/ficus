/**
 * Machine-scoped devbox pre-warm.
 *
 * ## Why this exists
 * The FIRST box (sandbox) on a freshly-bootstrapped `do_droplet`/BYO machine is
 * COLD: its devbox comfort set has to be resolved (`@latest` → Nixhub, ~46s) and
 * realized (the actual nix fetch/build/link into the machine's `/nix` store,
 * ~57s). Every box AFTER the first is fast because BOTH of those costs are
 * SHARED once paid:
 *  - the machine's multi-user `/nix` store (per-machine) — warmed by `devbox
 *    install`'s realize on ANY box user;
 *  - the DB-backed {@link DevboxLockCache} (global, machine-independent) — warmed
 *    by {@link seedBoxDevbox} capturing the generated `devbox.lock`.
 *
 * So the ~100s realization is a ONE-TIME per-machine tax that the first user
 * execution used to pay — and on a real tenant it blew the 60s box-health
 * timeout and FAILED the execution. This module pays that tax up front, in the
 * BACKGROUND, the moment a machine flips `ready` (see bootstrap.ts), so the
 * first user box lands on an already-warm machine.
 *
 * ## Mechanism: a throwaway warm box
 * There is no machine-level "realize a devbox" primitive — `devbox install` must
 * run as a box user through a live sandbox-server (`SandboxClient`). So the
 * default realize ensures a THROWAWAY, machine-scoped box (a synthetic
 * `devbox-prewarm-<role>-<machineId>` sandbox, NOT tied to any squad), seeds its
 * devbox via {@link seedBoxDevbox} (which warms both the `/nix` store and the
 * lock cache), publishes its public Nix source objects, then REMOVES the box.
 * The realized `/nix` store, shared source objects and cached lock survive the
 * box's teardown.
 *
 * ## Non-blocking, fault-isolated, idempotent
 * The entry point is fire-and-forget ({@link prewarmMachineDevboxBackground}) and
 * a no-op under `FICUS_TEST_MODE=1`. Every failure is swallowed/logged — a
 * pre-warm can only ever make the first box faster, never fail machine bootstrap
 * or a later ensure. A re-run on an already-warm machine is cheap: `seedBoxDevbox`
 * short-circuits on the `~/.tau/devbox/.seeded` hash marker for a re-used
 * throwaway sandboxId, and even a fresh throwaway box hits the warm `/nix` store
 * + lock cache, so no slow re-realization happens.
 */

import { createLogger } from '../../lib/infra/logger'
import { SandboxClient } from '../sandbox/k8s/http-client'
import { ensureBox as ensureBoxReal, removeBox as removeBoxReal } from './box-manager'
import { seedBoxDevbox as seedBoxDevboxReal, type SeedBoxRole } from './devbox-seed'
import { getMachine as getMachineReal, type Machine } from './queries'
import { publishPrewarmedNixCache } from './nix-cache'

const log = createLogger('devbox-prewarm')

/**
 * Roles whose comfort set is realized on a freshly-ready machine. `squad` is the
 * common case (and the heavier superset toolchain), so it is realized FIRST;
 * `agent` is included because, once squad has warmed the `/nix` store, the
 * agent light set is nearly free to realize on top.
 */
export const DEFAULT_PREWARM_ROLES: readonly SeedBoxRole[] = ['squad', 'agent']

export interface PrewarmMachineDevboxDeps {
  /** Machine lookup (test seam). Defaults to queries.ts's getMachine. */
  getMachine?: (id: string) => Promise<Machine | null>
  /**
   * Realize a single role's devbox on the machine. Defaults to the throwaway
   * warm-box path ({@link realizeDevboxViaThrowawayBox}). Injected in tests so a
   * unit test can assert it is invoked once per role, in the background, and
   * that a failure is swallowed.
   */
  realizeDevbox?: (machine: Machine, role: SeedBoxRole) => Promise<void>
  /** Which roles to realize (default {@link DEFAULT_PREWARM_ROLES}). */
  roles?: readonly SeedBoxRole[]
}

/** Strip the scheme so a bare `host:port` reaches the SandboxClient (it re-adds `http://`). */
function stripScheme(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, '')
}

/**
 * Default realize: ensure a throwaway machine-scoped box, seed its devbox (warms
 * the machine `/nix` store + the shared lock cache), then tear the box down. The
 * teardown runs in a `finally` so a failed seed never leaks the box user/unit.
 */
async function realizeDevboxViaThrowawayBox(machine: Machine, role: SeedBoxRole): Promise<void> {
  // Stable per-(machine, role) synthetic id so a repeat pre-warm re-uses the same
  // throwaway box's `.seeded` marker (a fast marker-skip) rather than churning ids.
  const sandboxId = `devbox-prewarm-${role}-${machine.id}`
  try {
    // Pin to THIS machine; empty caller env (box-manager bakes the fail-closed
    // EXECUTOR_* runtime vars + the auth token on top). Not tied to any squad.
    const { endpoint, box } = await ensureBoxReal({ sandboxId, machineId: machine.id, env: {}, role })
    const client = new SandboxClient(stripScheme(endpoint), box.authToken ?? undefined)
    try {
      await seedBoxDevboxReal(client, sandboxId, role)
      await publishPrewarmedNixCache(machine, sandboxId)
    } finally {
      client.close()
    }
  } finally {
    // Always reclaim the throwaway box (row + machine-side box user/unit). The
    // warmed /nix store + cached lock persist independently of the box.
    await removeBoxReal(sandboxId, { archivePrivate: false }).catch((err) => {
      log.warn(`Failed to remove throwaway pre-warm box ${sandboxId} (non-fatal):`, err)
    })
  }
}

/**
 * Realize the machine's devbox comfort set(s) so the first user box lands warm.
 * Awaitable (the background wrapper drives it fire-and-forget). Every role's
 * realize is independently fault-isolated: a failure logs WARN and the next role
 * still runs; the whole call resolves (never throws) so a caller can `void` it.
 */
export async function prewarmMachineDevbox(machineId: string, deps: PrewarmMachineDevboxDeps = {}): Promise<void> {
  const getMachine = deps.getMachine ?? getMachineReal
  const realize = deps.realizeDevbox ?? realizeDevboxViaThrowawayBox
  const roles = deps.roles ?? DEFAULT_PREWARM_ROLES

  const machine = await getMachine(machineId)
  if (!machine) {
    log.warn(`devbox pre-warm skipped: machine ${machineId} not found`)
    return
  }
  if (machine.status !== 'ready') {
    log.warn(`devbox pre-warm skipped: machine ${machineId} is ${machine.status}, not ready`)
    return
  }

  log.info(`Pre-warming devbox on machine ${machineId} for role(s): ${roles.join(', ')}`)
  for (const role of roles) {
    try {
      await realize(machine, role)
      log.info(`devbox pre-warm realized role ${role} on machine ${machineId}`)
    } catch (err) {
      // Non-fatal: a pre-warm that fails simply leaves the first box to pay the
      // cold realization it always did — never worse than before.
      log.warn(`devbox pre-warm failed for machine ${machineId} role ${role} (non-fatal):`, err)
    }
  }
}

/**
 * Fire-and-forget {@link prewarmMachineDevbox}: returns immediately, no-op under
 * `FICUS_TEST_MODE=1`, and swallows any rejection so it can never surface as an
 * unhandled rejection or block/fail its caller (the bootstrap ready-transition).
 */
export function prewarmMachineDevboxBackground(machineId: string, deps: PrewarmMachineDevboxDeps = {}): void {
  if (process.env.FICUS_TEST_MODE === '1') return
  prewarmMachineDevbox(machineId, deps).catch((err) => {
    log.error(`Background devbox pre-warm failed for machine ${machineId}:`, err)
  })
}

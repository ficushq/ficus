import { and, eq, isNull, ne } from 'drizzle-orm'
import { db } from '../../db'
import { localDeployments } from '../../db/schema'

/**
 * Port assignment for local app deployments.
 *
 * WHY TAU ASSIGNS THE PORT
 *
 * The feature was built against docker and k8s, where every sandbox has its own
 * network namespace: two squads can both bind 3000 and neither notices. The VM
 * runtime broke that assumption without anyone noticing, because a VM "box" is
 * not a container — it is a systemd unit running as a `box_<hash>` user
 * DIRECTLY on the machine (see services/machines/box-manager.ts), so every box
 * on a machine shares one loopback.
 *
 * There, a caller-chosen port is a claim on a machine-wide resource. Two squads
 * asking for 3000 collide, and — worse — a tokenized deployment URL could
 * forward to a DIFFERENT squad's app, which is precisely what the per-deployment
 * token exists to prevent.
 *
 * So Ficus assigns by default and the app reads `$PORT`. An explicit port is still
 * accepted (some apps genuinely cannot be told where to listen) but is rejected
 * when another live deployment holds it.
 *
 * SCOPE: uniqueness holds within a NETWORK SCOPE, never globally — see
 * local-deployment-port-scope.ts. A global rule would invalidate the
 * deployments every docker/k8s instance is already running, where two squads
 * sharing 3000 is both legal and harmless.
 */

export const LOCAL_DEPLOYMENT_PORT_MIN = 1024
export const LOCAL_DEPLOYMENT_PORT_MAX = 65535

/**
 * Assigned ports live high, above the range apps conventionally default to, so
 * an assigned port rarely lands on something an unmanaged process already holds.
 * Ficus cannot see the machine's real listeners, so this is a probability
 * argument, not a guarantee — a genuinely occupied port surfaces as the app
 * failing to bind, which the health poller already reports.
 */
export const ASSIGNED_PORT_MIN = 20_000
export const ASSIGNED_PORT_MAX = 29_999

export class LocalDeploymentPortInUseError extends Error {
  constructor(readonly port: number) {
    super(
      `Port ${port} is already held by another live local deployment. Omit "port" to let Ficus assign a free one ` +
        `and read it from $PORT, or choose a different port.`
    )
    this.name = 'LocalDeploymentPortInUseError'
  }
}

export class LocalDeploymentPortUnavailableError extends Error {
  constructor() {
    super('No free local deployment port is available. Stop an unused deployment and retry.')
    this.name = 'LocalDeploymentPortUnavailableError'
  }
}

/**
 * Ports held by deployments that still exist. A stopped-but-not-archived
 * deployment keeps its port: it can be restarted, and handing the port to
 * someone else in the meantime would make that restart fail confusingly.
 */
export async function reservedLocalDeploymentPorts(portScope: string): Promise<Set<number>> {
  const rows = await db
    .select({ port: localDeployments.port })
    .from(localDeployments)
    .where(and(eq(localDeployments.portScope, portScope), isNull(localDeployments.archivedAt)))
  return new Set(rows.map((row) => row.port))
}

/** True when another live deployment (never the given one) holds `port`. */
export async function isLocalDeploymentPortTaken(
  port: number,
  portScope: string,
  excludeId?: string
): Promise<boolean> {
  const conditions = [
    eq(localDeployments.port, port),
    eq(localDeployments.portScope, portScope),
    isNull(localDeployments.archivedAt),
  ]
  if (excludeId) conditions.push(ne(localDeployments.id, excludeId))
  const [row] = await db
    .select({ id: localDeployments.id })
    .from(localDeployments)
    .where(and(...conditions))
    .limit(1)
  return row !== undefined
}

/**
 * The port a new deployment should use.
 *
 * `requested` present  → validated and checked for conflict (throws).
 * `requested` absent   → a free port from the assigned range.
 *
 * The check is advisory: the durable guarantee is the partial unique index on
 * `local_deployments(port) where archived_at is null`, which makes two
 * concurrent creates race to the same answer rather than both winning.
 */
export async function resolveLocalDeploymentPort(portScope: string, requested?: number): Promise<number> {
  if (requested !== undefined) {
    if (await isLocalDeploymentPortTaken(requested, portScope)) throw new LocalDeploymentPortInUseError(requested)
    return requested
  }

  const reserved = await reservedLocalDeploymentPorts(portScope)
  const span = ASSIGNED_PORT_MAX - ASSIGNED_PORT_MIN + 1
  // Probe from a random offset rather than scanning upward, so repeated creates
  // do not cluster on the low end of the range.
  const start = Math.floor(Math.random() * span)
  for (let offset = 0; offset < span; offset += 1) {
    const port = ASSIGNED_PORT_MIN + ((start + offset) % span)
    if (!reserved.has(port)) return port
  }
  throw new LocalDeploymentPortUnavailableError()
}

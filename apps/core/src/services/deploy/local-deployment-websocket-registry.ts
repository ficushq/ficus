import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { getLocalDeployment, isValidLocalDeploymentBrowserToken } from './local-deployment-service'

const log = createLogger('local-deployment-websocket')

/**
 * How often every deployment with open relayed sockets is re-checked against
 * the database, whatever changed it. Most access changes close sockets at once
 * through `sandboxLocalDeployment.updated` (emitted by every service write and
 * forwarded between Core's processes); the sweep catches the ones no event
 * announces: a squad deleted with its deployments (a cascade), a token or
 * visibility changed outside the service, or an event lost between processes.
 */
export const LOCAL_APP_WEBSOCKET_REVALIDATE_INTERVAL_MS = 60_000

/**
 * Why a relayed socket closed, as logged. A fixed vocabulary on purpose: a close
 * reason from the app or the browser is free text and is never logged.
 */
export type LocalAppWebSocketCloseCategory =
  | 'browser-closed'
  | 'app-closed'
  | 'deployment-stopped'
  | 'deployment-removed'
  | 'visibility-changed'
  | 'token-revoked'
  | 'browser-backpressure'
  | 'app-backpressure'
  | 'message-too-big'
  | 'app-heartbeat'
  | 'shutdown'

/** One browser-to-app relay as the registry sees it. */
export interface LocalAppWebSocketRelay {
  readonly localDeploymentId: string
  /** The credential that authorized the upgrade: re-checked on every revalidation, never logged. */
  readonly token: string
  /** Close both sides. Called at most once per relay by the registry. */
  close(code: number, reason: string, category: LocalAppWebSocketCloseCategory): void
}

export type LocalAppWebSocketRegistration = 'registered' | 'at-capacity' | 'shutting-down'

const relaysByDeployment = new Map<string, Set<LocalAppWebSocketRelay>>()
let shuttingDown = false
let stopWatching: (() => void) | null = null

/**
 * Watch for access changes only while some socket is open, so an instance with
 * no relayed sockets runs no timer and does no database reads for them.
 */
function startWatching(): void {
  if (stopWatching) return
  const unsubscribe = eventEmitter.on('sandboxLocalDeployment.updated', ({ localDeploymentId }) => {
    void revalidateLocalAppWebSockets(localDeploymentId)
  })
  const sweep = setInterval(() => void revalidateAllLocalAppWebSockets(), LOCAL_APP_WEBSOCKET_REVALIDATE_INTERVAL_MS)
  sweep.unref?.()
  stopWatching = () => {
    unsubscribe()
    clearInterval(sweep)
  }
}

function stopWatchingIfIdle(): void {
  if (relaysByDeployment.size > 0 || !stopWatching) return
  stopWatching()
  stopWatching = null
}

/** Open relayed sockets for one deployment (including ones still connecting to the app). */
export function countLocalAppWebSockets(localDeploymentId: string): number {
  return relaysByDeployment.get(localDeploymentId)?.size ?? 0
}

/**
 * Claim a slot for a relay before its app socket is opened, so concurrent
 * upgrades cannot overshoot the per-deployment cap.
 */
export function registerLocalAppWebSocket(
  relay: LocalAppWebSocketRelay,
  maxPerDeployment: number
): LocalAppWebSocketRegistration {
  if (shuttingDown) return 'shutting-down'
  const relays = relaysByDeployment.get(relay.localDeploymentId) ?? new Set()
  if (relays.size >= maxPerDeployment) return 'at-capacity'
  relays.add(relay)
  relaysByDeployment.set(relay.localDeploymentId, relays)
  startWatching()
  return 'registered'
}

/** Release a relay's slot; returns how many stay open for its deployment. */
export function unregisterLocalAppWebSocket(relay: LocalAppWebSocketRelay): number {
  const relays = relaysByDeployment.get(relay.localDeploymentId)
  if (!relays?.delete(relay)) return countLocalAppWebSockets(relay.localDeploymentId)
  if (relays.size === 0) relaysByDeployment.delete(relay.localDeploymentId)
  stopWatchingIfIdle()
  return relays.size
}

function closeRelays(
  relays: Iterable<LocalAppWebSocketRelay>,
  code: number,
  reason: string,
  category: LocalAppWebSocketCloseCategory
): void {
  for (const relay of [...relays]) {
    unregisterLocalAppWebSocket(relay)
    try {
      relay.close(code, reason, category)
    } catch (err) {
      log.warn('Closing a local app WebSocket failed', { localDeploymentId: relay.localDeploymentId, category, err })
    }
  }
}

/**
 * Re-apply the upgrade's authorization to a deployment's open sockets and close
 * the ones it no longer allows: the same checks the proxy makes at upgrade
 * (local-deployment-proxy.ts), so a socket never outlives the access that
 * opened it. A stopped or removed app closes with 1001 (going away); a
 * visibility change or a token that no longer matches closes with 1008 (policy).
 *
 * A failed lookup keeps the sockets: the next event or sweep tries again.
 */
export async function revalidateLocalAppWebSockets(localDeploymentId: string): Promise<void> {
  const relays = relaysByDeployment.get(localDeploymentId)
  if (!relays?.size) return
  try {
    const deployment = await getLocalDeployment(localDeploymentId)
    const current = [...(relaysByDeployment.get(localDeploymentId) ?? [])]
    if (!deployment || deployment.archivedAt) {
      return closeRelays(current, 1001, 'The app was removed', 'deployment-removed')
    }
    if (deployment.status === 'stopped') return closeRelays(current, 1001, 'The app was stopped', 'deployment-stopped')
    if (deployment.visibility !== 'private') {
      return closeRelays(current, 1008, 'Access to the app changed', 'visibility-changed')
    }
    const validity = new Map<string, Promise<boolean>>()
    for (const relay of current) {
      if (!validity.has(relay.token)) {
        validity.set(relay.token, isValidLocalDeploymentBrowserToken(localDeploymentId, relay.token))
      }
    }
    const revoked: LocalAppWebSocketRelay[] = []
    for (const relay of current) if (!(await validity.get(relay.token))) revoked.push(relay)
    closeRelays(revoked, 1008, 'Access to the app was revoked', 'token-revoked')
  } catch (err) {
    log.warn('Re-checking local app WebSocket access failed; will retry', { localDeploymentId, err })
  }
}

/** Revalidate every deployment that has open sockets (the periodic sweep). */
export async function revalidateAllLocalAppWebSockets(): Promise<void> {
  await Promise.all([...relaysByDeployment.keys()].map((id) => revalidateLocalAppWebSockets(id)))
}

/**
 * Core is shutting down: refuse new upgrades and close every relayed socket
 * with 1012 (service restart), so browsers reconnect as soon as Core is back
 * instead of seeing 1006 when the process exits. Waits `flushMs` when any
 * socket was open, so the close frames leave before the server is stopped.
 */
export async function shutdownLocalAppWebSockets(flushMs = 250): Promise<void> {
  shuttingDown = true
  const all = [...relaysByDeployment.values()].flatMap((relays) => [...relays])
  if (all.length > 0) log.info(`Closing ${all.length} local app WebSocket(s) for shutdown`)
  closeRelays(all, 1012, 'Ficus is restarting', 'shutdown')
  if (all.length > 0) await Bun.sleep(flushMs)
}

/** Tests only: forget shutdown and every registered relay. */
export function resetLocalAppWebSocketRegistryForTests(): void {
  shuttingDown = false
  relaysByDeployment.clear()
  stopWatchingIfIdle()
}

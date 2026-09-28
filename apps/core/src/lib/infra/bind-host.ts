/**
 * Bind-host resolution for the two core processes' HTTP servers.
 *
 * Pure leaf module: both apps/core/src/index.ts (the API) and
 * apps/core/src/worker.ts (the stream server) resolve their bind host here so
 * the precedence rules live in exactly one place.
 */

/**
 * The API's bind host: `HOST` if set, otherwise all interfaces inside
 * Kubernetes (pod-IP readiness/liveness probes and other pods must reach it),
 * otherwise IPv4 loopback, matching the URL injected into host agent commands.
 */
export function apiBindHost(env: Record<string, string | undefined>, isK8s: boolean): string {
  return env.HOST || (isK8s ? '0.0.0.0' : '127.0.0.1')
}

/**
 * The worker stream server's bind host: `FICUS_WORKER_BIND` if set, else `HOST`,
 * else all interfaces inside Kubernetes, else loopback. The worker is not
 * meant to be reached from off-box (tau-api reaches it over loopback, or over
 * the container network in deployments that set HOST/WORKER_URL), so unlike
 * the API its non-k8s default is loopback-only.
 */
export function workerBindHost(env: Record<string, string | undefined>, isK8s: boolean): string {
  return env.FICUS_WORKER_BIND?.trim() || env.HOST || (isK8s ? '0.0.0.0' : '127.0.0.1')
}

/** True when a bind host exposes the listener beyond the loopback interface. */
export function beyondLoopback(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1'
}

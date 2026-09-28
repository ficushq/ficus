/**
 * Environment-derived constants shared across the K8s sandbox modules
 * (pod manager, port-forward manager, pod-spec builder).
 */

import { isLocalK8sMode } from '../runtime'

/**
 * Whether running in local dev mode (k3d). Enables port-forwarding to reach
 * pods from host.
 *
 * Derived through isLocalK8sMode, so it is false unless FICUS_SANDBOX_RUNTIME=k8s
 * — the sandbox factory imports every manager eagerly, so this module is
 * evaluated even on a host/docker install, and a stale FICUS_K8S_LOCAL=true left
 * in its .env must stay inert.
 */
export const IS_LOCAL_DEV = isLocalK8sMode()

export const LOCAL_KUBECTL_CONTEXT = process.env.FICUS_K8S_CONTEXT || 'k3d-tau-dev-token'

/** Port the in-pod executor HTTP server listens on. */
export const EXECUTOR_PORT = 50051

/** Headless service that gives each sandbox pod a stable DNS name. */
export const HEADLESS_SERVICE_NAME = 'tau-sandboxes'

/** K8s Secret name for sandbox auth credentials (mounted as volume) */
export const SANDBOX_AUTH_SECRET_NAME = 'tau-sandbox-auth'

/** Default idle timeout in milliseconds (15 minutes) */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Shared KubeConfig loader for K8s sandbox managers.
 *
 * In local dev mode (FICUS_SANDBOX_RUNTIME=k8s with FICUS_K8S_LOCAL=true), disables
 * TLS certificate verification so Bun can talk to k3d's self-signed K8s API
 * server. node-fetch's per-request rejectUnauthorized option doesn't work in
 * Bun, so we set the process-level NODE_TLS_REJECT_UNAUTHORIZED=0 env var
 * instead. Because local mode is read through isLocalK8sMode, that
 * process-wide TLS downgrade can only happen under the k8s runtime — which is
 * the point: a stale FICUS_K8S_LOCAL=true line in a .env that now selects
 * host/docker/vm must never disable TLS verification for the whole process.
 *
 * In production (in-cluster), TLS works normally — the service account CA
 * is trusted via NODE_EXTRA_CA_CERTS set in the K8s deployment manifest.
 */

import * as k8s from '@kubernetes/client-node'
import { isLocalK8sMode } from '../runtime'

const IS_LOCAL_DEV = isLocalK8sMode()

const K3D_CONTEXT = process.env.FICUS_K8S_CONTEXT || 'k3d-tau-dev-token'

export function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig()
  kc.loadFromDefault()

  if (IS_LOCAL_DEV) {
    // Use the k3d token-based context regardless of current kubectl context.
    // This avoids auth failures when the user switches to another context
    // (e.g. orbstack) while the API is running.
    kc.setCurrentContext(K3D_CONTEXT)

    // Bun ignores the rejectUnauthorized option on node-fetch's HTTPS agent,
    // so the @kubernetes/client-node skipTLSVerify flag has no effect.
    // Set the process-level env var as a workaround for local k3d dev only.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }

  return kc
}

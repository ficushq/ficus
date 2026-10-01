import * as k8s from '@kubernetes/client-node'
import { createLogger } from '../../../lib/infra/logger'
import { getSandboxImage, type SandboxType } from './pod-spec'

const log = createLogger('k8s-image-prepull')

/** Identifying label on the throwaway pre-pull pods (for humans/kubectl).
 *  Cleanup is by deterministic name (finally-delete + delete-before-create),
 *  not by label sweep. */
const PREPULL_LABEL = 'ficus-sandbox-prepull'
/** Bounds a wedged pull: at the deadline the kubelet marks the pod Failed
 *  (DeadlineExceeded). It does NOT delete the Pod object — reaping relies on the
 *  finally-delete below and the next boot's delete-before-create (by name). */
const ACTIVE_DEADLINE_S = 600
const POLL_MS = 2_000
const WAIT_TIMEOUT_MS = 5 * 60_000

/** Just the CoreV1Api surface the pre-pull needs — keeps it unit-testable with a fake. */
type PrepullCoreApi = Pick<k8s.CoreV1Api, 'createNamespacedPod' | 'readNamespacedPod' | 'deleteNamespacedPod'>

export interface PrepullDeps {
  coreApi: PrepullCoreApi
  namespace: string
  isLocalDev?: boolean
  /** Test seam: override the inter-poll delay (default 2s). */
  pollMs?: number
  waitTimeoutMs?: number
}

/** 'squad' and 'system-manager' resolve to the same image, so these two types
 *  cover both distinct sandbox images (ficus-sandbox + ficus-sandbox-agent). */
const PREPULL_TYPES: SandboxType[] = ['squad', 'agent']

export function prepullPodName(type: SandboxType): string {
  return `tau-sb-prepull-${type}`
}

function statusCode(err: unknown): number | undefined {
  const e = err as { response?: { statusCode?: number }; statusCode?: number; code?: number }
  return e?.response?.statusCode ?? e?.statusCode ?? e?.code
}

function buildPrepullPodSpec(name: string, namespace: string, image: string): k8s.V1Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels: { app: PREPULL_LABEL } },
    spec: {
      // A failed pull must NOT crash-loop — fail once, then we clean up.
      restartPolicy: 'Never',
      activeDeadlineSeconds: ACTIVE_DEADLINE_S,
      // Deliberately minimal: no runtimeClass/sysbox, no volumes, no privileged,
      // no imagePullSecrets (matches real sandbox pods — prod ECR auth comes from
      // the node IAM role, local from the unauthenticated k3d registry). We only
      // need the kubelet to fetch the layers; overriding the image entrypoint with
      // /bin/true makes the container exit 0 the instant the image lands.
      containers: [
        {
          name: 'prepull',
          image,
          imagePullPolicy: 'Always',
          command: ['/bin/true'],
          resources: {
            requests: { cpu: '10m', memory: '16Mi' },
            limits: { cpu: '100m', memory: '64Mi' },
          },
        },
      ],
    },
  }
}

async function deletePrepullPod(deps: PrepullDeps, name: string): Promise<void> {
  try {
    await deps.coreApi.deleteNamespacedPod({ name, namespace: deps.namespace })
  } catch (err) {
    if (statusCode(err) !== 404) log.debug(`delete pre-pull pod ${name} failed:`, err)
  }
}

async function prepullOne(deps: PrepullDeps, type: SandboxType): Promise<void> {
  const image = getSandboxImage({ sandboxType: type, isLocalDev: deps.isLocalDev })
  const name = prepullPodName(type)
  const pollMs = deps.pollMs ?? POLL_MS
  const waitTimeoutMs = deps.waitTimeoutMs ?? WAIT_TIMEOUT_MS

  // Idempotent: clear any leftover pod from a prior boot before creating.
  await deletePrepullPod(deps, name)

  log.info(`Pre-pulling sandbox image ${image} (pod ${name})`)
  try {
    await deps.coreApi.createNamespacedPod({
      namespace: deps.namespace,
      body: buildPrepullPodSpec(name, deps.namespace, image),
    })
  } catch (err) {
    // 409 = another Core replica created it; harmless. Anything else: give up on this image.
    if (statusCode(err) !== 409) {
      log.warn(`create pre-pull pod ${name} failed (non-fatal):`, err)
      return
    }
  }

  const start = Date.now()
  try {
    while (Date.now() - start < waitTimeoutMs) {
      let phase: string | undefined
      try {
        const pod = await deps.coreApi.readNamespacedPod({ name, namespace: deps.namespace })
        phase = pod.status?.phase
      } catch (err) {
        if (statusCode(err) === 404) break // already removed
        log.debug(`read pre-pull pod ${name} failed:`, err)
      }
      if (phase === 'Succeeded') {
        log.info(`Pre-pull complete: ${image}`)
        break
      }
      if (phase === 'Failed') {
        log.warn(`Pre-pull pod for ${image} reached Failed (unpullable image?)`)
        break
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  } finally {
    // Pods have no native TTL — always clean up.
    await deletePrepullPod(deps, name)
  }
}

/**
 * Warm the node's image cache for both sandbox images in the background.
 *
 * Creates a throwaway pod per distinct image that pulls the layers and exits
 * immediately, so the FIRST real squad/agent creation after a rebuild (new image
 * digest) doesn't pay the layer-download cost on the user-facing path. Best-effort
 * and non-fatal: allSettled means one image failing never blocks the other, and
 * the whole thing is fire-and-forget so it never blocks Core startup.
 *
 * Note: a single one-shot pod warms only the node it lands on. This fully covers
 * the single-node local k3d dev target; multi-node prod would want a DaemonSet
 * (out of scope here).
 */
export async function prepullSandboxImages(deps: PrepullDeps): Promise<void> {
  await Promise.allSettled(PREPULL_TYPES.map((type) => prepullOne(deps, type)))
}

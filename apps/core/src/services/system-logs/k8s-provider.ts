/**
 * Kubernetes-based System Log Provider
 *
 * Streams container logs from Ficus's own API/worker pods. Pod targeting uses
 * fixed label selectors; namespace is server-configured. Clients cannot specify
 * pod names, namespaces, or label selectors.
 *
 * Env configuration:
 *   FICUS_SYSTEM_LOG_PROVIDER=k8s selects this provider explicitly.
 *   FICUS_SYSTEM_LOG_K8S_NAMESPACE sets the required core namespace.
 */

import { Writable } from 'node:stream'
import * as k8s from '@kubernetes/client-node'
import { loadKubeConfig } from '../sandbox/k8s/kubeconfig'
import type { SystemLogComponent, SystemLogProvider, SystemLogStreamOptions, SystemLogStreamResult } from './types'
import { clampTailLines, SystemLogProviderError } from './types'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('k8s-system-logs')
import { createLinePrefixer } from './stream-utils'

export interface K8sLogConfig {
  namespace: string
  selectors: Record<SystemLogComponent, string>
  containers: Record<SystemLogComponent, string>
}

interface PodTarget {
  metadata?: { name?: string }
  spec?: { containers?: Array<{ name?: string }> }
}

export interface K8sLogDependencies {
  listPods: (namespace: string, selector: string) => Promise<PodTarget[]>
  openLog: (
    namespace: string,
    pod: string,
    container: string,
    writable: Writable,
    options: { follow: boolean; tailLines: number; pretty: false; timestamps: false }
  ) => Promise<AbortController>
  reportDiagnostic?: (message: string, cause?: unknown) => void
}

function defaultDependencies(): K8sLogDependencies {
  const kc = loadKubeConfig()
  const logApi = new k8s.Log(kc)
  const coreApi = kc.makeApiClient(k8s.CoreV1Api)
  return {
    listPods: async (namespace, selector) =>
      (await coreApi.listNamespacedPod({ namespace, labelSelector: selector })).items,
    openLog: (namespace, pod, container, writable, options) => logApi.log(namespace, pod, container, writable, options),
  }
}

export class K8sLogProvider implements SystemLogProvider {
  readonly name = 'kubernetes'

  constructor(
    private readonly config: K8sLogConfig = {
      namespace: 'tau-core',
      selectors: { api: 'app=tau-core,component=api', worker: 'app=tau-core,component=worker' },
      containers: { api: 'tau-api', worker: 'tau-worker' },
    },
    private readonly dependencies?: K8sLogDependencies,
    private readonly createDependencies: () => K8sLogDependencies = defaultDependencies
  ) {}

  describe(components: SystemLogComponent[]) {
    return { provider: 'k8s' as const, targets: components.map((component) => ({ component, kind: 'pod' as const })) }
  }

  stream(
    components: SystemLogComponent[],
    opts: SystemLogStreamOptions,
    onData: (chunk: Buffer) => void,
    onError?: (err: Error) => void,
    onEnd?: () => void
  ): SystemLogStreamResult {
    const controllers: AbortController[] = []
    let canceled = false
    let pendingStreams = 0
    let discoveryDone = false
    let failed = false
    const abortAll = () => {
      for (const controller of controllers) {
        try {
          controller.abort()
        } catch {
          // Already aborted.
        }
      }
    }
    const fail = (error: SystemLogProviderError, cause?: unknown) => {
      if (canceled || failed) return
      failed = true
      abortAll()
      ;(this.dependencies?.reportDiagnostic ?? ((message, detail) => log.error(message, { error: detail })))(
        error.message,
        cause ?? error.cause
      )
      onError?.(error)
    }
    const markDone = () => {
      pendingStreams -= 1
      if (!failed && !canceled && discoveryDone && pendingStreams === 0) onEnd?.()
    }

    void (async () => {
      try {
        const dependencies = this.dependencies ?? this.createDependencies()
        const namespace = this.config.namespace

        for (const component of components) {
          if (canceled || failed) return
          const pods = await dependencies.listPods(namespace, this.config.selectors[component])

          if (pods.length === 0) {
            fail(new SystemLogProviderError('TARGET_NOT_FOUND', 'No configured Kubernetes log target was found.'))
            return
          }

          for (const pod of [...pods].sort((a, b) => (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''))) {
            if (canceled || failed) return
            const podName = pod.metadata?.name
            if (!podName) continue
            const containerName = this.config.containers[component]
            if (!pod.spec?.containers?.some((container) => container.name === containerName)) {
              fail(
                new SystemLogProviderError('TARGET_NOT_FOUND', 'A configured Kubernetes log container was not found.')
              )
              return
            }

            pendingStreams += 1
            const prefix = createLinePrefixer(`[${component} pod/${podName} container/${containerName}] `)
            const writable = new Writable({
              write(chunk: Buffer, _encoding, callback) {
                if (!canceled && !failed) onData(prefix(chunk))
                callback()
              },
            })
            let settled = false
            const settle = () => {
              if (settled) return
              settled = true
              markDone()
            }
            writable.on('finish', settle)
            writable.on('error', (cause) => {
              settle()
              fail(new SystemLogProviderError('STREAM_FAILED', 'Unable to read configured Kubernetes logs.'), cause)
            })

            const controller = await dependencies.openLog(namespace, podName, containerName, writable, {
              follow: opts.follow,
              tailLines: clampTailLines(opts.tailLines),
              pretty: false,
              timestamps: false,
            })
            controllers.push(controller)
            if (canceled || failed) controller.abort()
          }
        }
        discoveryDone = true
        if (!canceled && !failed && pendingStreams === 0) onEnd?.()
      } catch (err) {
        discoveryDone = true
        const status =
          (err as { response?: { statusCode?: number }; statusCode?: number })?.response?.statusCode ??
          (err as { statusCode?: number })?.statusCode
        fail(
          new SystemLogProviderError(
            status === 401 || status === 403 ? 'ACCESS_DENIED' : 'STREAM_FAILED',
            status === 401 || status === 403
              ? 'Unable to read configured Kubernetes logs; check Kubernetes permissions.'
              : 'Unable to read configured Kubernetes logs.'
          ),
          err
        )
      }
    })()

    return {
      cancel: () => {
        canceled = true
        abortAll()
      },
    }
  }
}

import { isAbsolute } from 'node:path'
import { expandTilde } from '@ficus/shared/node'
import { SystemLogProviderError, type SystemLogComponent, type SystemLogProviderId } from './types'

type Targets = Record<SystemLogComponent, string>
export type ExplicitSystemLogConfig =
  | { provider: 'pm2'; targets: Targets }
  | { provider: 'systemd'; targets: Targets }
  | { provider: 'docker'; targets: Targets }
  | { provider: 'file'; targets: Targets }
  | { provider: 'k8s'; namespace: string; selectors: Targets; containers: Targets }

const components: SystemLogComponent[] = ['api', 'worker']
const clean = (value: string | undefined, variable: string, fallback?: string): string => {
  const result = (value ?? fallback ?? '').trim()
  if (!result || /[\0\r\n]/.test(result))
    throw new SystemLogProviderError(
      'CONFIG_INVALID',
      `${variable} must be configured with a non-empty single-line value.`
    )
  return result
}
const targets = (env: NodeJS.ProcessEnv, prefix: string, fallback?: Targets): Targets => ({
  api: clean(env[`${prefix}_API`], `${prefix}_API`, fallback?.api),
  worker: clean(env[`${prefix}_WORKER`], `${prefix}_WORKER`, fallback?.worker),
})

export function loadExplicitSystemLogConfig(env: NodeJS.ProcessEnv = process.env): ExplicitSystemLogConfig | undefined {
  const configuredProvider = env.FICUS_SYSTEM_LOG_PROVIDER?.trim()
  if (!configuredProvider) return undefined
  if (!['pm2', 'systemd', 'docker', 'file', 'k8s'].includes(configuredProvider)) {
    throw new SystemLogProviderError('CONFIG_INVALID', 'FICUS_SYSTEM_LOG_PROVIDER is invalid.')
  }
  const provider = configuredProvider as Exclude<SystemLogProviderId, 'unavailable'>
  switch (provider) {
    case 'pm2':
      return { provider, targets: targets(env, 'FICUS_PM2', { api: 'tau-api', worker: 'tau-worker' }) }
    case 'systemd':
      return { provider, targets: targets(env, 'FICUS_SYSTEMD', { api: 'tau-api', worker: 'tau-worker' }) }
    case 'docker':
      return {
        provider,
        targets: {
          api: clean(env.FICUS_DOCKER_API_CONTAINER, 'FICUS_DOCKER_API_CONTAINER'),
          worker: clean(env.FICUS_DOCKER_WORKER_CONTAINER, 'FICUS_DOCKER_WORKER_CONTAINER'),
        },
      }
    case 'file': {
      // Expand BEFORE the absolute check: `~/logs/api.log` is a perfectly
      // ordinary way to spell an absolute path, but isAbsolute() sees a
      // relative one and the whole provider config was rejected as
      // CONFIG_INVALID. The check itself still stands — a genuinely relative
      // path (and `~user/…`, which we deliberately do not expand) is still
      // refused.
      const raw = targets(env, 'FICUS_LOG_FILE')
      const paths: Targets = { api: expandTilde(raw.api), worker: expandTilde(raw.worker) }
      for (const component of components)
        if (!isAbsolute(paths[component]))
          throw new SystemLogProviderError('CONFIG_INVALID', 'Configured system log file paths must be absolute.')
      return { provider, targets: paths }
    }
    case 'k8s':
      return {
        provider,
        namespace: clean(env.FICUS_SYSTEM_LOG_K8S_NAMESPACE, 'FICUS_SYSTEM_LOG_K8S_NAMESPACE'),
        selectors: {
          api: clean(
            env.FICUS_SYSTEM_LOG_K8S_API_SELECTOR,
            'FICUS_SYSTEM_LOG_K8S_API_SELECTOR',
            'app=tau-core,component=api'
          ),
          worker: clean(
            env.FICUS_SYSTEM_LOG_K8S_WORKER_SELECTOR,
            'FICUS_SYSTEM_LOG_K8S_WORKER_SELECTOR',
            'app=tau-core,component=worker'
          ),
        },
        containers: {
          api: clean(env.FICUS_SYSTEM_LOG_K8S_API_CONTAINER, 'FICUS_SYSTEM_LOG_K8S_API_CONTAINER', 'tau-api'),
          worker: clean(
            env.FICUS_SYSTEM_LOG_K8S_WORKER_CONTAINER,
            'FICUS_SYSTEM_LOG_K8S_WORKER_CONTAINER',
            'tau-worker'
          ),
        },
      }
    default:
      throw new SystemLogProviderError('CONFIG_INVALID', 'FICUS_SYSTEM_LOG_PROVIDER is invalid.')
  }
}

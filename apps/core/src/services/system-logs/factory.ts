import { createLogger } from '../../lib/infra/logger'
import { loadExplicitSystemLogConfig } from './config'
import { DockerLogProvider } from './docker-provider'
import { FileLogProvider } from './file-provider'
import { K8sLogProvider } from './k8s-provider'
import { Pm2LogProvider } from './pm2-provider'
import { SystemdLogProvider } from './systemd-provider'
import type { SystemLogProvider } from './types'
import { SystemLogProviderError } from './types'
import { UnavailableLogProvider } from './unavailable-provider'

const log = createLogger('system-logs-factory')
const commandDependencies = {
  reportDiagnostic: (message: string, cause?: unknown) => log.error(message, { error: cause }),
}

export interface SystemLogFactoryDependencies {
  listPm2Processes: () => { exitCode: number; stdout: string }
}

const defaultFactoryDependencies: SystemLogFactoryDependencies = {
  listPm2Processes: () => {
    const result = Bun.spawnSync(['pm2', 'jlist'], { stdout: 'pipe', stderr: 'ignore' })
    return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout).toString() }
  },
}

function verifiedPm2Targets(dependencies: SystemLogFactoryDependencies): { api: string; worker: string } | undefined {
  const targets = {
    api: process.env.FICUS_PM2_API_NAME?.trim() || 'tau-api',
    worker: process.env.FICUS_PM2_WORKER_NAME?.trim() || 'tau-worker',
  }
  try {
    const result = dependencies.listPm2Processes()
    if (result.exitCode !== 0) return undefined
    const processes = JSON.parse(result.stdout) as Array<{ name?: string }>
    return processes.some((process) => process.name === targets.api) &&
      processes.some((process) => process.name === targets.worker)
      ? targets
      : undefined
  } catch {
    return undefined
  }
}

export function detectProvider(dependencies = defaultFactoryDependencies): string {
  try {
    const config = loadExplicitSystemLogConfig()
    return config?.provider ?? (verifiedPm2Targets(dependencies) ? 'pm2' : 'unavailable')
  } catch {
    return 'unavailable'
  }
}

let cachedProvider: SystemLogProvider | null = null

export function getSystemLogProvider(forceFresh = false, dependencies = defaultFactoryDependencies): SystemLogProvider {
  if (cachedProvider && !forceFresh) return cachedProvider
  try {
    const config = loadExplicitSystemLogConfig()
    if (!config) {
      const targets = verifiedPm2Targets(dependencies)
      cachedProvider = targets
        ? new Pm2LogProvider(targets, commandDependencies)
        : new UnavailableLogProvider(
            new SystemLogProviderError(
              'PROVIDER_UNAVAILABLE',
              'System logs are unavailable; configure FICUS_SYSTEM_LOG_PROVIDER.'
            )
          )
    } else {
      switch (config.provider) {
        case 'pm2':
          cachedProvider = new Pm2LogProvider(config.targets, commandDependencies)
          break
        case 'systemd':
          cachedProvider = new SystemdLogProvider(config.targets, commandDependencies)
          break
        case 'docker':
          cachedProvider = new DockerLogProvider(config.targets, commandDependencies)
          break
        case 'file':
          cachedProvider = new FileLogProvider(config.targets, commandDependencies)
          break
        case 'k8s':
          cachedProvider = new K8sLogProvider(config)
          break
      }
    }
  } catch (error) {
    const providerError =
      error instanceof SystemLogProviderError
        ? error
        : new SystemLogProviderError('CONFIG_INVALID', 'System log provider configuration is invalid.', {
            cause: error,
          })
    log.error(providerError.message, { error: providerError.cause })
    cachedProvider = new UnavailableLogProvider(providerError)
  }
  log.info(`System log provider: ${cachedProvider.name}`)
  return cachedProvider
}

export function initializeSystemLogProvider(): SystemLogProvider {
  return getSystemLogProvider()
}

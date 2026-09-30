/**
 * Health check service.
 *
 * Now handled inline by server.ts /healthz endpoint.
 * This file is kept for backward compatibility with tests.
 */

const startTime = Date.now()
import { readExecutorCommandIdentity, type ExecutorCommandIdentity } from './command-identity'
import { readPressure } from './processes'

const VERSION = process.env.EXECUTOR_VERSION || '0.2.0'

export interface DockerRuntimeHealthContract {
  runtime: 'docker'
  version: 1
  executorProtocol: 1
  capabilities: Array<'bash' | 'bash-cancel' | 'command-identity' | 'socket-proxy'>
  commandIdentity: ExecutorCommandIdentity
}

let devboxReady = false

export function setDevboxReady(ready: boolean) {
  devboxReady = ready
}

export function isDevboxReady() {
  return devboxReady
}

export function getHealthResponse(env: NodeJS.ProcessEnv = process.env) {
  const commandIdentity = readExecutorCommandIdentity(env)
  const runtimeContract: DockerRuntimeHealthContract | undefined = commandIdentity
    ? {
        runtime: 'docker',
        version: 1,
        executorProtocol: 1,
        capabilities: ['bash', 'bash-cancel', 'command-identity', 'socket-proxy'],
        commandIdentity,
      }
    : undefined
  const pressure = readPressure()
  return {
    healthy: true,
    devboxReady,
    // Load and memory only (no process detail): health is unauthenticated.
    ...(pressure ? { pressure } : {}),
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    ...(runtimeContract ? { runtimeContract } : {}),
  }
}

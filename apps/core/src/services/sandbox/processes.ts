import { SANDBOX_PROCESS_SIGNALS, type SandboxProcesses, type SandboxProcessSignal } from '@ficus/shared'
import { createLogger } from '../../lib/infra/logger'
import type { Identity } from '../rbac/permissions'
import { SandboxHttpError, type SandboxClient } from './k8s/http-client'

const log = createLogger('sandbox-processes')

/** A process-management request the API answers with `status`. */
export class SandboxProcessesError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 501 | 504
  ) {
    super(message)
    this.name = 'SandboxProcessesError'
  }
}

type GetClient = (sandboxId: string) => Promise<SandboxClient | null>

/**
 * The box server for a sandbox, from either Core process: the api and worker
 * each track their own clients, so a box the worker ensured is attached here
 * on demand. Runtimes without a box server (host) have none.
 */
async function defaultGetClient(sandboxId: string): Promise<SandboxClient | null> {
  const { getSandboxManager } = await import('./factory')
  const manager = getSandboxManager() as unknown as {
    getOrAttachClient?: (id: string) => Promise<SandboxClient | null>
    getClientForSandbox?: (id: string) => SandboxClient | null
  }
  if (manager.getOrAttachClient) return manager.getOrAttachClient(sandboxId)
  return manager.getClientForSandbox?.(sandboxId) ?? null
}

async function clientFor(sandboxId: string, getClient: GetClient): Promise<SandboxClient> {
  const client = await getClient(sandboxId)
  if (!client) throw new SandboxProcessesError('The sandbox is not running', 409)
  return client
}

/**
 * Map a box server answer onto the API. A server that predates process
 * management answers these routes with a plain-text 404, which carries no
 * JSON error; the server's own refusals always do.
 */
function translate(error: unknown): never {
  if (error instanceof SandboxHttpError) {
    if (error.status === 404 && /^Request failed: 404$/.test(error.message)) {
      throw new SandboxProcessesError('This sandbox predates process management; restart it to update', 501)
    }
    if ([400, 403, 404, 504].includes(error.status)) {
      throw new SandboxProcessesError(error.message, error.status as 400 | 403 | 404 | 504)
    }
  }
  throw error
}

export async function listSandboxProcesses(
  sandboxId: string,
  getClient: GetClient = defaultGetClient
): Promise<SandboxProcesses> {
  const client = await clientFor(sandboxId, getClient)
  return client.listProcesses().catch(translate)
}

/** Signal one process the sandbox's user owns. Audited: this stops someone's work. */
export async function signalSandboxProcess(
  sandboxId: string,
  pid: number,
  signal: SandboxProcessSignal,
  actor: Identity,
  getClient: GetClient = defaultGetClient
) {
  const client = await clientFor(sandboxId, getClient)
  const result = await client.signalProcess(pid, signal).catch(translate)
  log.info(`${describe(actor)} sent SIG${result.signal} to pid ${result.pid} in ${sandboxId}: ${result.command}`)
  return result
}

/** Stop one of the sandbox's containers. Audited. */
export async function stopSandboxContainer(
  sandboxId: string,
  containerId: string,
  actor: Identity,
  getClient: GetClient = defaultGetClient
) {
  const client = await clientFor(sandboxId, getClient)
  const result = await client.stopContainer(containerId).catch(translate)
  log.info(`${describe(actor)} stopped container ${result.id} in ${sandboxId}`)
  return result
}

function describe(actor: Identity): string {
  if (actor.type === 'user') return `user ${actor.userId}`
  if (actor.type === 'agent') return `agent ${actor.agentId}`
  return actor.type
}

/** A signal from a request body; TERM when omitted. */
export function parseProcessSignal(value: unknown): SandboxProcessSignal {
  if (value === undefined || value === null || value === '') return 'TERM'
  const signal = typeof value === 'string' ? value.toUpperCase() : ''
  if (!(SANDBOX_PROCESS_SIGNALS as readonly string[]).includes(signal)) {
    throw new SandboxProcessesError(`signal must be one of ${SANDBOX_PROCESS_SIGNALS.join(', ')}`, 400)
  }
  return signal as SandboxProcessSignal
}

export function parseProcessId(value: string | undefined): number {
  const pid = Number(value)
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new SandboxProcessesError('pid must be a process id greater than 1', 400)
  }
  return pid
}

export function parseContainerId(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new SandboxProcessesError('containerId must be a container id or name', 400)
  }
  return value
}

/** The JSON error response for a process-management failure, or null for anything else. */
export function sandboxProcessesErrorResponse(
  error: unknown
): { status: SandboxProcessesError['status']; body: { error: string } } | null {
  return error instanceof SandboxProcessesError ? { status: error.status, body: { error: error.message } } : null
}

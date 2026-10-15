/**
 * Browse and upload into one agent's private area, on whichever runtime holds
 * it. Callers authorize first (./access.ts); this module confines.
 *
 * Where the private area lives:
 * - docker + host: on Core's own disk, `<HOME_DIR>/private/agent_<id>` (docker
 *   bind-mounts it at `/private`). Read and written here directly, so it works
 *   whether or not the agent's box is running, and for dormant agents too
 *   (dormancy keeps storage).
 * - vm + k8s: inside the agent's own box/pod. Reached through that box's
 *   sandbox server, only while the agent is live and its box is running; a
 *   dormant agent's box is retired by the lifecycle and is not started here.
 *
 * Every path goes through `@ficus/shared/confined-fs` (locally, or inside the
 * box via its `/confined/*` routes): no `..`, no absolute paths, and no
 * symlink is followed at any level. On top of that, ./policy.ts hides
 * platform custody files. Nothing here ever reads from or writes to the
 * shared squad workspace.
 */

import { posix } from 'path'
import {
  ConfinedFsError,
  isConfinedFsErrorCode,
  listConfinedDir,
  readConfinedFile,
  splitConfinedPath,
  writeConfinedFile,
  type ConfinedEntry,
  type ConfinedWriteStatus,
} from '@ficus/shared/confined-fs'
import { getSandboxManager, isRemoteSandboxRuntime, isVmRuntime } from '../sandbox/factory'
import { getAgentPrivateStoragePath } from '../sandbox/ensure'
import { resolveWorkspaceLayout } from '../sandbox/workspace-layout'
import { SandboxHttpError, type SandboxClient } from '../sandbox/client/http-client'
import type { VmSandboxManager } from '../sandbox/vm/manager'
import type { K8sSandboxManager } from '../sandbox/k8s'
import type { AgentPrivateTarget } from './access'
import { isHiddenPrivatePath, isWritablePrivatePath } from './policy'

/** The box-side logical root the sandbox server rebases onto the agent's private dir. */
const BOX_PRIVATE_ROOT = '/private'

export type AgentPrivateUnavailableReason = 'dormant' | 'not-running' | 'outdated'

const UNAVAILABLE_MESSAGES: Record<AgentPrivateUnavailableReason, string> = {
  dormant: 'This agent is dormant, so its sandbox is stopped. Its private files are available while it is awake.',
  'not-running': 'This agent’s sandbox is not running. Start it to browse its private files.',
  outdated: 'This agent’s sandbox predates private file browsing. Restart it, then try again.',
}

/** The private area cannot be reached right now (box state, not a path problem). */
export class AgentPrivateUnavailableError extends Error {
  constructor(readonly reason: AgentPrivateUnavailableReason) {
    super(UNAVAILABLE_MESSAGES[reason])
    this.name = 'AgentPrivateUnavailableError'
  }
}

export interface AgentPrivateEntry {
  name: string
  type: 'file' | 'directory'
  size?: number
  /** Present for symbolic links: listed so the agent's layout is visible, never followed. */
  symlink?: true
}

interface PrivateStore {
  list(path: string): Promise<ConfinedEntry[]>
  read(path: string, maxBytes: number): Promise<{ content: Buffer; size: number; truncated: boolean }>
  write(path: string, content: Uint8Array, options: { overwrite: boolean }): Promise<ConfinedWriteStatus>
}

/** Whether the private area is on Core's own disk (docker + host). */
export function isAgentPrivateAreaLocal(): boolean {
  return !isRemoteSandboxRuntime()
}

/** Absolute path of the private root as the agent itself sees it in its sandbox. */
export function agentVisiblePrivateRoot(target: AgentPrivateTarget): string {
  return resolveWorkspaceLayout({ squadId: target.squadId ?? undefined, sandboxId: target.sandboxId }).privateMount
}

/** Absolute path of a private file as the agent sees it, for "copy path". */
export function agentVisiblePrivatePath(target: AgentPrivateTarget, relativePath: string): string {
  const parts = splitConfinedPath(relativePath)
  return parts.length ? posix.join(agentVisiblePrivateRoot(target), ...parts) : agentVisiblePrivateRoot(target)
}

/**
 * Turn a request path into root-relative components. A path may be relative,
 * or absolute under the agent-visible private root (as an agent would quote
 * it); any other absolute path is invalid. Hidden paths are reported as not
 * found so their existence is not confirmed.
 */
export function normalizePrivatePath(target: AgentPrivateTarget, requested: string): string[] {
  let relative = requested
  if (relative.startsWith('/')) {
    const root = agentVisiblePrivateRoot(target)
    if (relative === root) relative = ''
    else if (relative.startsWith(`${root}/`)) relative = relative.slice(root.length + 1)
    else throw new ConfinedFsError('invalid-path')
  }
  const parts = splitConfinedPath(relative)
  if (isHiddenPrivatePath(parts)) throw new ConfinedFsError('not-found')
  return parts
}

function localStore(target: AgentPrivateTarget): PrivateStore {
  const root = getAgentPrivateStoragePath(target.sandboxId)
  return {
    list: (path) => listConfinedDir(root, path),
    read: (path, maxBytes) => readConfinedFile(root, path, { maxBytes }),
    write: (path, content, { overwrite }) => writeConfinedFile(root, path, content, { overwrite, createDirs: true }),
  }
}

/** Map box-server failures: a coded refusal stays a path error; a bare 404 is an old bundle. */
async function viaBox<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof SandboxHttpError) {
      if (isConfinedFsErrorCode(error.code)) throw new ConfinedFsError(error.code)
      if (error.status === 404) throw new AgentPrivateUnavailableError('outdated')
    }
    throw error
  }
}

async function boxClient(target: AgentPrivateTarget): Promise<SandboxClient | null> {
  const manager = getSandboxManager()
  if (isVmRuntime()) return (manager as unknown as VmSandboxManager).getOrAttachClient(target.sandboxId)
  return (manager as unknown as K8sSandboxManager).getClient(target.sandboxId)
}

async function remoteStore(target: AgentPrivateTarget): Promise<PrivateStore> {
  if (!target.live) throw new AgentPrivateUnavailableError('dormant')
  const client = await boxClient(target).catch(() => null)
  if (!client) throw new AgentPrivateUnavailableError('not-running')
  return {
    list: (path) => viaBox(async () => (await client.confinedList({ root: BOX_PRIVATE_ROOT, path })).entries),
    read: (path, maxBytes) =>
      viaBox(async () => {
        const result = await client.confinedRead({ root: BOX_PRIVATE_ROOT, path, maxBytes })
        return { content: Buffer.from(result.content, 'base64'), size: result.size, truncated: result.truncated }
      }),
    write: (path, content, { overwrite }) =>
      viaBox(
        async () =>
          (await client.confinedUpload({ root: BOX_PRIVATE_ROOT, path, content, overwrite, createDirs: true })).status
      ),
  }
}

async function storeFor(target: AgentPrivateTarget): Promise<PrivateStore> {
  return isAgentPrivateAreaLocal() ? localStore(target) : remoteStore(target)
}

/** Direct children of a private directory, hidden entries removed, directories first. */
export async function listAgentPrivateDir(target: AgentPrivateTarget, requested: string): Promise<AgentPrivateEntry[]> {
  const parts = normalizePrivatePath(target, requested)
  const entries = await (await storeFor(target)).list(parts.join('/'))
  return entries
    .filter((entry) => !isHiddenPrivatePath([...parts, entry.name]))
    .filter((entry) => entry.type !== 'other')
    .map((entry): AgentPrivateEntry => {
      if (entry.type === 'directory') return { name: entry.name, type: 'directory' }
      if (entry.type === 'symlink') return { name: entry.name, type: 'file', symlink: true }
      return { name: entry.name, type: 'file', size: entry.size }
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
}

/** Read up to `maxBytes` of a private file. */
export async function readAgentPrivateFile(
  target: AgentPrivateTarget,
  requested: string,
  maxBytes: number
): Promise<{ path: string; content: Buffer; size: number; truncated: boolean }> {
  const parts = normalizePrivatePath(target, requested)
  if (parts.length === 0) throw new ConfinedFsError('not-a-file')
  const path = parts.join('/')
  return { path, ...(await (await storeFor(target)).read(path, maxBytes)) }
}

/** Create or replace one private file, creating its directories. */
export async function writeAgentPrivateFile(
  target: AgentPrivateTarget,
  requested: string,
  content: Uint8Array,
  options: { overwrite: boolean }
): Promise<{ path: string; status: ConfinedWriteStatus }> {
  const parts = normalizePrivatePath(target, requested)
  if (!isWritablePrivatePath(parts)) throw new ConfinedFsError('invalid-path')
  const path = parts.join('/')
  return { path, status: await (await storeFor(target)).write(path, content, options) }
}

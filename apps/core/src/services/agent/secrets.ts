/**
 * Per-agent secrets: Secret Store keys exposed to ONE agent's own sandbox.
 *
 * The model mirrors squad exposures (services/squad/env.ts): only key NAMES are
 * stored (`agent_secret_exposures`); values stay in the Secret Store and are
 * never returned by an API. What differs is where the values land:
 *
 * - Only the agent's own sandbox (`agent_<id>`), as the 0600 file
 *   `<private dir>/.ficus/agent-secrets.env` (see sandbox/agent-secrets-file.ts).
 *   Never the shared squad workspace, the squad box, memory or another agent's
 *   sandbox. The agent's own `bash` tool sources the file per command, so the
 *   values are environment variables of that command only; `squad_bash` runs in
 *   the squad box, which never receives the file.
 * - Subagents run in their root agent's sandbox and private dir, so they
 *   inherit the root's per-agent secrets: same trust boundary as the parent.
 *   Exposing to a subagent directly is refused.
 * - Shared runtimes (system managers, consultants) and the host runtime (every
 *   agent is the same OS user there) cannot keep a value private to one agent,
 *   so exposure to them is refused with a clear error.
 *
 * The file is (re)written on every exposure change, on every sandbox ensure
 * (each turn) and when an exposed Secret Store value changes. It is removed when
 * the last key is unexposed or unset, when the agent goes dormant or is
 * terminated, and before its private dir is archived. On vm boxes the change is
 * pushed to a running box right away; docker/k8s mount the core-host file.
 *
 * Exposures are keyed by agent id (cascade-deleted with the agent), so they
 * never follow a reused name or a respawned agent. Each row records the squad
 * the agent belonged to; a row whose squad no longer matches is inert.
 */

import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'fs'
import { join } from 'path'
import { and, eq, isNull } from 'drizzle-orm'
import { isLiveAgentStatus, isUserAssistantAgentType, type AgentStatus } from '@ficus/shared'
import { agentSecretExposures, agents, db } from '../../db'
import { getHomeDir } from '../../lib/utils/home'
import { createLogger } from '../../lib/infra/logger'
import { getDeploymentAwareSecretValue } from '../integrations/deployment/settings'
import { normalizeSecretKeys } from '../squad/env'
import { isHostRuntime } from '../sandbox/runtime'
import { ensureWorkspaceDotDir, prepareWorkspaceDotDir } from '../workspace/dot-dir'
import {
  AGENT_SECRETS_FILE_NAME,
  agentIdFromAgentSandboxId,
  agentSecretsHostPath,
  agentSecretsSandboxPath,
} from '../sandbox/agent-secrets-file'

const log = createLogger('agent-secrets')

const GENERATED_MARKER = '# Generated from the Ficus Secret Store for this agent only. Do not edit or print values.'

/** A refused request, with the HTTP status the route answers. Messages never contain values. */
export class AgentSecretsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404
  ) {
    super(message)
    this.name = 'AgentSecretsError'
  }
}

interface AgentSecretsRow {
  id: string
  squadId: string | null
  parentAgentId: string | null
  agentTypeId: string
  status: AgentStatus
}

async function loadAgentRow(agentId: string): Promise<AgentSecretsRow | null> {
  const [row] = await db
    .select({
      id: agents.id,
      squadId: agents.squadId,
      parentAgentId: agents.parentAgentId,
      agentTypeId: agents.agentTypeId,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
  return row ?? null
}

/** Why `row` cannot hold per-agent secrets, or null when it can. */
export function agentSecretsUnsupportedReason(row: Omit<AgentSecretsRow, 'id'>, hostRuntime = isHostRuntime()) {
  if (hostRuntime) {
    return 'Per-agent secrets need an isolated sandbox runtime (vm, docker or k8s). The host runtime runs every agent as the same OS user, so it cannot keep a value private to one agent.'
  }
  if (row.parentAgentId) {
    return 'This is a subagent. Subagents share their parent agent’s sandbox and inherit its per-agent secrets; expose the secret to the parent agent instead.'
  }
  if (row.agentTypeId === 'consultant' || isUserAssistantAgentType(row.agentTypeId)) {
    return 'This agent runs in a sandbox shared with other agents, so it cannot hold per-agent secrets.'
  }
  if (row.status === 'terminated') return 'This agent is terminated.'
  return null
}

/** Exposure rows still bound to the agent's current squad (`squad_id IS NOT DISTINCT FROM`). */
function activeRowsFilter(agentId: string, squadId: string | null) {
  return and(
    eq(agentSecretExposures.agentId, agentId),
    squadId === null ? isNull(agentSecretExposures.squadId) : eq(agentSecretExposures.squadId, squadId)
  )
}

async function activeExposedKeys(row: Pick<AgentSecretsRow, 'id' | 'squadId'>): Promise<string[]> {
  const rows = await db
    .select({ secretKey: agentSecretExposures.secretKey })
    .from(agentSecretExposures)
    .where(activeRowsFilter(row.id, row.squadId))
  return normalizeSecretKeys(rows.map((r) => r.secretKey))
}

export interface AgentSecretsStatus {
  /** Exposed key names (never values). */
  exposedSecretKeys: string[]
  /** Null when the agent can hold per-agent secrets; otherwise why not. */
  unsupportedReason: string | null
  /** Sandbox-side path of the secrets file (a path, not content). */
  secretsFilePath: string | null
}

/** Names-only view of an agent's exposures. Throws 404 for an unknown agent. */
export async function getAgentSecretsStatus(agentId: string): Promise<AgentSecretsStatus> {
  const row = await loadAgentRow(agentId)
  if (!row) throw new AgentSecretsError('Agent not found', 404)
  const unsupportedReason = agentSecretsUnsupportedReason(row)
  return {
    exposedSecretKeys: await activeExposedKeys(row),
    unsupportedReason,
    secretsFilePath: unsupportedReason ? null : agentSecretsSandboxPath(`agent_${row.id}`),
  }
}

/** Exposed key names for an agent (empty for unknown agents). */
export async function getAgentExposedSecretKeys(agentId: string): Promise<string[]> {
  const row = await loadAgentRow(agentId)
  return row ? activeExposedKeys(row) : []
}

export type AgentSecretsChange = { mode: 'replace' | 'add' | 'remove'; keys: string[] }

export interface AgentSecretsChangeResult {
  exposedSecretKeys: string[]
  /** How the change reached the agent's sandbox (never contains values). */
  sandboxSync: { pushed: boolean; reason?: string }
}

/**
 * Apply an exposure change and deliver it to the agent's sandbox. Adding keys
 * requires a supported target; removing is always allowed, so a revocation can
 * never be blocked by the agent's state.
 */
export async function changeAgentExposedSecretKeys(
  agentId: string,
  change: AgentSecretsChange,
  deps: {
    syncSandbox?: (sandboxId: string) => Promise<{ pushed: boolean; reason?: string }>
    /**
     * Whether the caller may read `key` in the Secret Store. Every key the change ADDS must pass:
     * exposing a key hands its value to an agent the caller can talk to, so it must never grant
     * more than the caller could already read. Removal is never checked.
     */
    mayReadSecret?: (key: string) => boolean
  } = {}
): Promise<AgentSecretsChangeResult> {
  const row = await loadAgentRow(agentId)
  if (!row) throw new AgentSecretsError('Agent not found', 404)
  const current = await activeExposedKeys(row)
  const requested = normalizeSecretKeys(change.keys)
  const next =
    change.mode === 'replace'
      ? requested
      : change.mode === 'add'
        ? normalizeSecretKeys([...current, ...requested])
        : current.filter((key) => !change.keys.includes(key))
  const adds = next.filter((key) => !current.includes(key))
  if (adds.length > 0) {
    const reason = agentSecretsUnsupportedReason(row)
    if (reason) throw new AgentSecretsError(reason, 400)
    const unreadable = deps.mayReadSecret ? adds.filter((key) => !deps.mayReadSecret!(key)) : []
    if (unreadable.length > 0) {
      throw new AgentSecretsError(
        `You can only expose secrets you are allowed to read in the Secret Store. Not allowed: ${unreadable.join(', ')}.`,
        403
      )
    }
  }
  if (change.mode !== 'remove' && requested.length !== new Set(change.keys.map((key) => key.trim())).size) {
    throw new AgentSecretsError(
      'One or more keys cannot be exposed to an agent: platform-managed, GitHub and Ficus identity credentials are never exposed.',
      400
    )
  }

  await db.transaction(async (tx) => {
    // Rows bound to another squad are inert; drop them with any change so they can never revive.
    await tx.delete(agentSecretExposures).where(eq(agentSecretExposures.agentId, row.id))
    if (next.length > 0) {
      const now = new Date()
      await tx
        .insert(agentSecretExposures)
        .values(next.map((secretKey) => ({ agentId: row.id, squadId: row.squadId, secretKey, updatedAt: now })))
    }
  })

  const sandboxId = `agent_${row.id}`
  await materializeAgentSecretsFile(sandboxId)
  const sandboxSync = await (deps.syncSandbox ?? syncAgentSecretsToSandbox)(sandboxId)
  log.info(
    `Per-agent secrets for agent ${row.id} changed (${change.mode}); ${next.length} key(s) exposed; sandbox sync: ${sandboxSync.pushed ? 'pushed' : sandboxSync.reason}`
  )
  return { exposedSecretKeys: next, sandboxSync }
}

/** Render the secrets file, or null when no exposed key has a value. */
export function renderAgentSecretsFile(
  keys: string[],
  getSecretValue: (key: string) => string | undefined
): string | null {
  const lines = normalizeSecretKeys(keys).flatMap((key) => {
    const value = getSecretValue(key)
    return value === undefined || !hasValue(value) ? [] : [`export ${key}=${shellQuote(value)}`]
  })
  return lines.length === 0 ? null : [GENERATED_MARKER, ...lines].join('\n') + '\n'
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * Remove the core-host secrets file for `sandboxId` (idempotent). A settings
 * dir that is not a real directory is left alone: nothing was ever written
 * through it, and removing through a planted symlink would touch its target.
 */
export function removeAgentSecretsFile(sandboxId: string): void {
  try {
    prepareWorkspaceDotDir(join(getHomeDir(), 'private', sandboxId))
  } catch {
    return
  }
  rmSync(agentSecretsHostPath(sandboxId), { force: true })
}

/**
 * Write (or remove) the core-host secrets file for an agent sandbox from its
 * current exposures and Secret Store values. Returns the key NAMES written.
 * Never writes for shared sandboxes, unsupported agents, non-live agents or on
 * the host runtime; in all those cases any existing file is removed.
 */
export async function materializeAgentSecretsFile(
  sandboxId: string,
  getSecretValue: (key: string) => string | undefined = getDeploymentAwareSecretValue
): Promise<string[]> {
  const agentId = agentIdFromAgentSandboxId(sandboxId)
  if (!agentId) return []
  const row = await loadAgentRow(agentId)
  if (!row || agentSecretsUnsupportedReason(row) || !isLiveAgentStatus(row.status)) {
    removeAgentSecretsFile(sandboxId)
    return []
  }
  const keys = await activeExposedKeys(row)
  const content = renderAgentSecretsFile(keys, getSecretValue)
  if (content === null) {
    removeAgentSecretsFile(sandboxId)
    return []
  }
  writePrivateFileAtomically(join(getHomeDir(), 'private', sandboxId), content)
  return keys.filter((key) => hasValue(getSecretValue(key)))
}

/**
 * Atomic 0600 write into `<root>/.ficus/`: refuses a symlinked or non-directory
 * settings dir (an agent can rewrite its own private dir), creates the temp file
 * exclusively (never following an existing path) and renames it over the
 * target, which replaces rather than follows a symlink planted there.
 */
function writePrivateFileAtomically(privateRoot: string, content: string): void {
  mkdirSync(privateRoot, { recursive: true })
  const dir = ensureWorkspaceDotDir(privateRoot)
  const target = join(dir, AGENT_SECRETS_FILE_NAME)
  if (unchangedPrivateFile(target, content)) return
  const temp = join(dir, `.${AGENT_SECRETS_FILE_NAME}.tmp-${crypto.randomUUID()}`)
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeSync(fd, content)
    closeSync(fd)
    fd = undefined
    chmodSync(temp, 0o600)
    renameSync(temp, target)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    rmSync(temp, { force: true })
    throw error
  }
}

/** True when `target` is already a regular 0600 file holding exactly `content` (every ensure re-renders). */
function unchangedPrivateFile(target: string, content: string): boolean {
  try {
    const stats = lstatSync(target)
    return stats.isFile() && (stats.mode & 0o777) === 0o600 && readFileSync(target, 'utf8') === content
  } catch {
    return false
  }
}

/** Push the current file state to a running vm box; docker/k8s/host read the core-host file directly. */
export async function syncAgentSecretsToSandbox(sandboxId: string): Promise<{ pushed: boolean; reason?: string }> {
  const { isVmRuntime } = await import('../sandbox/runtime')
  if (!isVmRuntime()) return { pushed: false, reason: 'live-mount' }
  try {
    const { pushAgentSecretsToBox } = await import('../sandbox/vm/file-sync')
    return await pushAgentSecretsToBox(sandboxId)
  } catch (error) {
    // The next ensure (every turn, and the keep-warm sweep) re-syncs the asset.
    log.warn(`Could not push per-agent secrets to ${sandboxId} now; the next sandbox sync applies the change`, error)
    return { pushed: false, reason: 'push-failed' }
  }
}

/**
 * Remove an agent's secrets from its sandbox when it stops running (dormancy):
 * the core-host file, and on vm the running box's copy. The next ensure after a
 * wake writes it again.
 */
export async function clearAgentSecretsForSandbox(sandboxId: string): Promise<void> {
  removeAgentSecretsFile(sandboxId)
  await syncAgentSecretsToSandbox(sandboxId)
}

/** Re-render every agent file that exposes `key` (called when the Secret Store value changes). */
export async function regenerateAgentSecretFilesForSecretKey(key: string): Promise<void> {
  const rows = await db
    .selectDistinct({ agentId: agentSecretExposures.agentId })
    .from(agentSecretExposures)
    .where(eq(agentSecretExposures.secretKey, key))
  for (const { agentId } of rows) {
    const sandboxId = `agent_${agentId}`
    try {
      await materializeAgentSecretsFile(sandboxId)
      await syncAgentSecretsToSandbox(sandboxId)
    } catch (error) {
      log.warn(`Failed to refresh per-agent secrets for agent ${agentId}`, error)
    }
  }
}

/**
 * Env var NAMES available to commands in `sandboxId` (for the agent prompt).
 * Subagents pass their root's sandbox id and so see the root's names.
 */
export async function agentSecretNamesForSandbox(
  sandboxId: string,
  getSecretValue: (key: string) => string | undefined = getDeploymentAwareSecretValue
): Promise<string[]> {
  const agentId = agentIdFromAgentSandboxId(sandboxId)
  if (!agentId) return []
  const row = await loadAgentRow(agentId)
  if (!row || agentSecretsUnsupportedReason(row)) return []
  return (await activeExposedKeys(row)).filter((key) => hasValue(getSecretValue(key)))
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

import { getSquadClient } from '../services/squad/client'
import { WorkflowError } from '../services/workflows/catalog'
import { resolveActingUser } from '../services/rbac'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import { zValidator } from '@hono/zod-validator'
import {
  createSquadSchema,
  updateSquadSchema,
  spawnSquadAgentSchema,
  reorderSquadsSchema,
  squadToolchainSchema,
  SQUAD_ACTIVITY_KINDS,
  attentionSchema,
  DEFAULT_ATTENTION,
  type SquadActivityKind,
} from '@ficus/shared'
import { requirePermission, requireSquadPermission } from '../middleware'
import { getAccessibleSquadIds, type Identity } from '../services/rbac'
import { resolveSquadActivityAccess } from '../services/squad-activity/access'
import { filterToAccessibleSquads } from '../middleware/require-entity-permission'
import {
  subscribeToSquad,
  unsubscribeFromSquad,
  getSquadAttention,
  countSquadSubscribers,
} from '../services/squad/subscriptions'
import { Squad } from '../entities/Squad'
import type { Squad as SquadEntity } from '../entities/Squad'
import { isInsideWorkspaceRoot, resolveSquadWorkspaceHostPath, searchWorkspaceFiles } from '../services/squad/workspace'
import type { SquadStatus } from '@ficus/shared'
import { terminalManager } from '../services/sandbox/docker/terminal'
import {
  getSandboxManager,
  isHostRuntime,
  isK8sRuntime,
  isRemoteSandboxRuntime,
  isVmRuntime,
} from '../services/sandbox/factory'
import { setHostWorkspaceOverride } from '../services/sandbox/host/workspace-overrides'
import { hostActiveWorkspacePath } from '../services/sandbox/host/active-workspace'
import {
  cleanupPreparedHostWorkspacePath,
  ensureHostWorkspacePath,
  HostWorkspacePathError,
  type PreparedHostWorkspacePath,
} from '../services/sandbox/host/workspace-path'
import { HOST_NO_TOOLCHAIN_ERROR, hostRuntimeGuard } from './host-runtime-guard'
import { SandboxHttpError, type K8sSandboxManager } from '../services/sandbox/k8s'
import * as fs from 'fs'
import * as path from 'path'
import { createDownloadResponse, createSandboxFileResponse } from '../lib/utils'
import { Agent } from '../entities/Agent'
import { createLogger } from '../lib/infra/logger'
import { getSandboxProvisionErrorResponse } from './sandbox-provision-error'
import { WriteService } from '../services/memory'
import { ensureSquadMemoryPath, toFilesystemPath, validateMemoryPath } from '../services/memory/paths'
import { markLocalDeploymentsStoppedForSandbox } from '../services/deploy/local-deployment-service'
import { assertMachinePinReady, MachinePinError } from '../services/machines/pin'
import { SquadSourceConfig } from '../entities/SquadSourceConfig'
import { Image, type ImageContent } from '../entities/Image'
import { resolveWorkspaceLayout } from '../services/sandbox/workspace-layout'
import { db } from '../db'
import { squads } from '../db/schema'
import { eq } from 'drizzle-orm'
import { projectSquadActivity } from '../services/squad/activity'
import { ActivityCursorExpiredError, InvalidActivityCursorError } from '../services/squad/activity-cursor'
import { getHomeDir } from '../lib/utils/home'
import { normalizeToolchain } from '../services/sandbox/toolchain/config'
import { mergeSandboxStatus, resolveToolchainStatus } from '../services/sandbox/status'
import { openSandboxOverloadPressure } from '../services/fleet-alerts/store'
import {
  listSandboxProcesses,
  parseContainerId,
  parseProcessId,
  parseProcessSignal,
  sandboxProcessesErrorResponse,
  signalSandboxProcess,
  stopSandboxContainer,
} from '../services/sandbox/processes'
import * as sandboxPrewarm from '../services/sandbox/prewarm'
import { requireSandboxRuntime } from '../services/sandbox/runtime'
import { userSessionRequired } from '../services/auth/user-session-required'
import {
  FileSource,
  ThreadSource,
  WorkspaceFileSource,
  SlackThreadSource,
  SlackCanvasSource,
  GitHubIssueSource,
} from '../services/memory/sources'

const log = createLogger('routes')

const HOST_WORKSPACE_ID_PLACEHOLDERS = new Set(['<squad-id>', '<new squad id>'])

async function prepareHostWorkspaceOverride(workspacePath: string): Promise<PreparedHostWorkspacePath> {
  if (!isHostRuntime()) throw new HostWorkspacePathError('hostWorkspacePath is only available in host runtime')
  if (HOST_WORKSPACE_ID_PLACEHOLDERS.has(path.basename(workspacePath))) {
    throw new HostWorkspacePathError('Replace the squad ID placeholder with a real directory path')
  }
  return ensureHostWorkspacePath(workspacePath)
}

/**
 * Reject mutating an archived (soft-deleted) squad with 410 Gone.
 * Returns the 410 response when archived, otherwise null (caller proceeds).
 */
function archivedGuard(c: Context, squad: SquadEntity) {
  return squad.isArchived ? c.json({ error: 'Squad is archived' }, 410) : null
}

/**
 * Get the sandbox client for a squad's sandbox.
 * Returns the cached client if the sandbox exists, otherwise returns null.
 * Does NOT wait for devbox — file ops only need the HTTP server running.
 * Call ensureSquadSandbox first if the pod might not exist yet.
 */

const SKIP_DIRS = new Set(['node_modules', '.tmp', '.cache', '__pycache__', '.venv', 'venv'])

function normalizeMemoryDirectoryPath(rawPath?: string): string {
  const memoryPath = rawPath || '/memory'
  if (memoryPath === '/memory') return memoryPath
  validateMemoryPath(memoryPath.endsWith('/') ? `${memoryPath}placeholder.md` : `${memoryPath}/placeholder.md`)
  return memoryPath.replace(/\/$/, '')
}

function memoryDirToFilesystemPath(squadId: string, memoryPath: string): string {
  const basePath = path.resolve(ensureSquadMemoryPath(squadId))
  if (memoryPath === '/memory') return basePath
  const fsPath = path.resolve(toFilesystemPath(squadId, `${memoryPath}/placeholder.md`), '..')
  if (!fsPath.startsWith(`${basePath}${path.sep}`) && fsPath !== basePath) throw new Error('Invalid path')
  return fsPath
}

function buildSquadTree(dirPath: string, depth: number, maxDepth: number): any[] {
  if (depth > maxDepth) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: any[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        type: 'directory',
        children: depth < maxDepth ? buildSquadTree(fullPath, depth + 1, maxDepth) : [],
      })
    } else if (entry.isFile()) {
      try {
        nodes.push({ name: entry.name, type: 'file', size: fs.statSync(fullPath).size })
      } catch {
        nodes.push({ name: entry.name, type: 'file' })
      }
    }
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

export const squadsRouter = new Hono()
  // GET /squads — filtered-list: identity required, results scoped to accessible squads
  .get('/', async (c) => {
    const identity = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    const status = c.req.query('status') as SquadStatus | undefined
    const includeAnonymous = c.req.query('includeAnonymous') === 'true'
    const allSquads = await Squad.list({ status, includeAnonymous })
    const visible = await filterToAccessibleSquads(identity, allSquads, (s) => s.id)
    return c.json(visible.map((s) => s.toJson()))
  })
  .get('/create-options', requirePermission('squads:create'), (c) => {
    const runtime = requireSandboxRuntime()
    return c.json({
      runtime,
      ...(runtime === 'host' ? { defaultHostWorkspaceRoot: path.join(getHomeDir(), 'workspaces', 'squads') } : {}),
    })
  })
  // POST /squads — system-scoped: requires squads:create permission
  .post('/', requirePermission('squads:create'), zValidator('json', createSquadSchema), async (c) => {
    let input = c.req.valid('json')
    let preparedWorkspace: PreparedHostWorkspacePath | undefined
    if (input.hostWorkspacePath) {
      try {
        preparedWorkspace = await prepareHostWorkspaceOverride(input.hostWorkspacePath)
        input.hostWorkspacePath = preparedWorkspace.path
      } catch (error) {
        if (error instanceof HostWorkspacePathError) return c.json({ error: error.message }, 400)
        throw error
      }
    }
    try {
      const { squadWorkflowSources, authorizeWorkflowSource } = await import('../services/workflows/access')
      input = await Squad.prepareCreateInput(input)
      for (const source of squadWorkflowSources(input.metadata ?? {}))
        await authorizeWorkflowSource(c.get('identity')!, source, '')
      const squad = await Squad.create(input)
      return c.json(squad.toJson(), 201)
    } catch (error) {
      if (preparedWorkspace) await cleanupPreparedHostWorkspacePath(preparedWorkspace)
      if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status)
      throw error
    }
  })
  // PATCH /squads/reorder — Squad.reorder writes a GLOBAL order column, so gate
  // it behind squads:update and clamp to the caller's accessible squads rather
  // than letting any authenticated identity reorder squads deployment-wide.
  .patch('/reorder', requirePermission('squads:update'), zValidator('json', reorderSquadsSchema), async (c) => {
    const identity = c.get('identity') as Identity
    const { ids } = c.req.valid('json')
    const accessible = await getAccessibleSquadIds(identity)
    const allowedIds = accessible === 'all' ? ids : ids.filter((id) => (accessible as string[]).includes(id))
    const squads = await Squad.reorder(allowedIds)
    return c.json(squads.map((s) => s.toJson()))
  })
  // POST /squads/cleanup-agents — system-scoped operation across all squads
  .post('/cleanup-agents', requirePermission('system:cleanup'), async (c) => {
    const dryRun = c.req.query('dryRun') === 'true'
    const result = await Squad.cleanupFlexAgents(dryRun)
    return c.json(result)
  })
  .get('/:id/activity', requireSquadPermission('squads:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad || squad.isArchived) return c.json({ error: 'Squad not found' }, 404)
    const identity = c.get('identity') as Identity
    const rawLimit = c.req.query('limit')
    const limit = rawLimit === undefined ? 50 : Number(rawLimit)
    const rawVerbose = c.req.query('verbose')
    const agentIds = [...new Set(c.req.queries('agentId') ?? [])].sort()
    const kinds = [...new Set(c.req.queries('kind') ?? [])].sort()
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (rawVerbose !== undefined && rawVerbose !== 'true' && rawVerbose !== 'false') ||
      agentIds.some((id) => !uuid.test(id)) ||
      kinds.some((kind) => !SQUAD_ACTIVITY_KINDS.includes(kind as SquadActivityKind))
    )
      return c.json({ error: 'Invalid activity query' }, 400)

    const access = await resolveSquadActivityAccess(identity, squad.id)
    if (!access) return c.json({ error: 'Forbidden' }, 403)
    try {
      return c.json(
        await projectSquadActivity({
          squadId: squad.id,
          limit,
          cursor: c.req.query('cursor'),
          verbose: rawVerbose === 'true',
          agentIds,
          kinds: kinds as SquadActivityKind[],
          access,
        })
      )
    } catch (error) {
      if (error instanceof ActivityCursorExpiredError)
        return c.json({ error: 'Activity cursor expired', code: 'activity_cursor_expired' }, 400)
      if (error instanceof InvalidActivityCursorError)
        return c.json({ error: 'Invalid activity cursor', code: 'invalid_cursor' }, 400)
      throw error
    }
  })
  .get('/:id/source-configs', requireSquadPermission('squads:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    return c.json((await SquadSourceConfig.listBySquad(squad.id)).map(sourceConfigToJson))
  })
  .put('/:id/source-configs/:sourceType', requireSquadPermission('squads:update'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    const archived = archivedGuard(c, squad)
    if (archived) return archived
    const body = await parseOptionalJsonObjectBody(c, {} as { enabled?: boolean; policy?: Record<string, unknown> })
    const policy = body.policy ?? { version: 1 }
    const sourceType = c.req.param('sourceType')
    const errors = validateSourcePolicy(sourceType, policy)
    if (errors) return c.json({ error: 'Invalid source policy', details: errors }, 400)
    const config = await SquadSourceConfig.upsert({
      squadId: squad.id,
      sourceType,
      enabled: body.enabled,
      policy,
    })
    return c.json(sourceConfigToJson(config))
  })
  .get('/:id', requireSquadPermission('squads:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }
    if (squad.isArchived) return c.json({ error: 'Squad not found' }, 404)

    const { resolveCreationWorkflow } = await import('../services/workflows/creation-source')
    const defaultWorkflow = await resolveCreationWorkflow(undefined, squad)
    const includeRelationships = c.req.query('includeRelationships') === 'true'
    if (includeRelationships) {
      return c.json({ ...(await squad.withRelationships()), defaultWorkflow })
    }

    return c.json({ ...squad.toJson(), defaultWorkflow })
  })
  // --- Squad attention (levels for the squad's decisions and progress; see @ficus/shared/attention) ---
  .get('/:id/subscription', requireSquadPermission('squads:read'), async (c) => {
    const squadId = c.req.param('id')
    const identity = await resolveActingUser(c.get('identity'))
    const row = identity?.type === 'user' ? await getSquadAttention(squadId, identity.userId) : null
    return c.json({
      subscribed: Boolean(row),
      count: await countSquadSubscribers(squadId),
      attention: row ?? DEFAULT_ATTENTION,
    })
  })
  .post('/:id/subscribe', requireSquadPermission('squads:read'), async (c) => {
    const squadId = c.req.param('id')
    const identity = await resolveActingUser(c.get('identity'))
    if (identity?.type !== 'user') return userSessionRequired(c, c.get('identity'), 'follow squads')
    if (!(await Squad.find(squadId))) return c.json({ error: 'Squad not found' }, 404)
    const body = await parseOptionalJsonObjectBody(c, {} as Record<string, unknown>)
    // Omitted attention means "watch, but never reset levels I already chose".
    const requested = body.attention === undefined ? undefined : attentionSchema.safeParse(body.attention)
    if (requested && !requested.success) return c.json({ error: 'Invalid attention levels' }, 400)
    await subscribeToSquad(squadId, identity.userId, requested?.data)
    const row = await getSquadAttention(squadId, identity.userId)
    return c.json({
      subscribed: Boolean(row),
      count: await countSquadSubscribers(squadId),
      attention: row ?? DEFAULT_ATTENTION,
    })
  })
  .delete('/:id/subscribe', requireSquadPermission('squads:read'), async (c) => {
    const squadId = c.req.param('id')
    const identity = await resolveActingUser(c.get('identity'))
    if (identity?.type !== 'user') return userSessionRequired(c, c.get('identity'), 'follow squads')
    await unsubscribeFromSquad(squadId, identity.userId)
    return c.json({ subscribed: false, count: await countSquadSubscribers(squadId), attention: DEFAULT_ATTENTION })
  })
  .patch('/:id', requireSquadPermission('squads:update'), zValidator('json', updateSquadSchema), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }
    const archived = archivedGuard(c, squad)
    if (archived) return archived

    const input = c.req.valid('json')

    // A machine pin, when present, must reference an existing, ready machine —
    // mirror the agent PATCH + POST /:id/machine readiness check so a well-formed
    // but nonexistent/not-ready machineId is rejected here (400) instead of being
    // silently persisted and only failing later at ensure. `undefined` means the
    // field was omitted (leave the pin as-is); `null` unpins and is always allowed.
    if (input.machineId !== undefined) {
      try {
        await assertMachinePinReady(input.machineId)
      } catch (error) {
        if (error instanceof MachinePinError) return c.json({ error: error.message }, 400)
        throw error
      }
    }

    let preparedWorkspace: PreparedHostWorkspacePath | undefined
    if (input.hostWorkspacePath) {
      try {
        preparedWorkspace = await prepareHostWorkspaceOverride(input.hostWorkspacePath)
        input.hostWorkspacePath = preparedWorkspace.path
      } catch (error) {
        if (error instanceof HostWorkspacePathError) return c.json({ error: error.message }, 400)
        throw error
      }
    }

    try {
      const { squadWorkflowSources, authorizeWorkflowSource } = await import('../services/workflows/access')
      for (const source of squadWorkflowSources(input.metadata ?? {}))
        await authorizeWorkflowSource(c.get('identity')!, source, squad.id)
      await squad.update(input)
    } catch (error) {
      if (preparedWorkspace) await cleanupPreparedHostWorkspacePath(preparedWorkspace)
      if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status)
      throw error
    }
    if (input.hostWorkspacePath !== undefined) setHostWorkspaceOverride(squad.id, input.hostWorkspacePath)
    return c.json(squad.toJson())
  })
  .delete('/:id', requireSquadPermission('squads:delete'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    const deleteWorkspace = c.req.query('deleteWorkspace') === 'true'
    await squad.archive({ deleteWorkspace })
    return c.body(null, 204)
  })
  .get('/:id/memory/tree', requireSquadPermission('memory:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)

    const depthParam = c.req.query('depth')
    const parsedDepth = depthParam ? parseInt(depthParam, 10) : 1
    const depth = Number.isFinite(parsedDepth) ? Math.min(parsedDepth, 10) : 1

    let memoryPath: string
    let targetPath: string
    try {
      memoryPath = normalizeMemoryDirectoryPath(c.req.query('path'))
      targetPath = memoryDirToFilesystemPath(squad.id, memoryPath)
      const stat = fs.statSync(targetPath)
      if (!stat.isDirectory()) return c.json({ error: 'Path is not a directory' }, 400)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid path'
      return c.json({ error: message }, message.includes('not') ? 404 : 400)
    }

    return c.json({
      name: memoryPath === '/memory' ? 'memory' : path.basename(memoryPath),
      type: 'directory',
      children: buildSquadTree(targetPath, 1, depth),
    })
  })
  .get('/:id/memory/file', requireSquadPermission('memory:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)

    const memoryPath = c.req.query('path')
    if (!memoryPath) return c.json({ error: 'Path query parameter is required' }, 400)

    try {
      validateMemoryPath(memoryPath)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid path' }, 400)
    }

    const result = await WriteService.instance().read(squad.id, memoryPath)
    if (!result.success) return c.json({ error: result.error.message }, 404)

    return c.json({
      path: memoryPath,
      content: result.content,
      size: Buffer.byteLength(result.content, 'utf-8'),
      binary: false,
    })
  })
  .get('/:id/memory/download', requireSquadPermission('memory:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)

    const memoryPath = c.req.query('path')
    if (!memoryPath) return c.json({ error: 'Path query parameter is required' }, 400)

    let targetPath: string
    try {
      validateMemoryPath(memoryPath)
      const basePath = path.resolve(ensureSquadMemoryPath(squad.id))
      targetPath = path.resolve(toFilesystemPath(squad.id, memoryPath))
      if (!targetPath.startsWith(`${basePath}${path.sep}`) && targetPath !== basePath) {
        return c.json({ error: 'Invalid path' }, 400)
      }
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid path' }, 400)
    }

    try {
      const stat = fs.statSync(targetPath)
      if (!stat.isFile()) return c.json({ error: 'Path is not a file' }, 400)
      return createDownloadResponse(targetPath, 'memory')
    } catch (error: any) {
      if (error.code === 'ENOENT') return c.json({ error: 'Path not found' }, 404)
      log.error('Error downloading memory file:', error)
      return c.json(
        { error: `Failed to download memory file: ${error instanceof Error ? error.message : String(error)}` },
        500
      )
    }
  })
  .get('/:id/workspace/tree', requireSquadPermission('workspace:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const relativePath = c.req.query('path') || ''
    const depthParam = c.req.query('depth')
    const depth = depthParam ? Math.min(parseInt(depthParam, 10), 10) : 1

    // K8s runtime: proxy through sandbox
    const client = await getSquadClient(squad.id)
    if (client) {
      const { workspaceMount } = resolveWorkspaceLayout({ squadId: squad.id })
      try {
        const listPath = relativePath ? `${workspaceMount}/${relativePath}` : workspaceMount
        const result = await client.list({ path: listPath, maxDepth: depth })
        const rootName = relativePath ? path.basename(relativePath) : 'workspace'

        // Build tree from flat file list. Paths are relative to listPath.
        // depth=1 means only direct children (no nested paths).
        const children: any[] = []
        for (const f of result.files) {
          // Skip hidden files (except .env)
          const name = path.basename(f.path)
          if (name.startsWith('.') && name !== '.env') continue
          if (SKIP_DIRS.has(name) && f.isDirectory) continue

          // Only include direct children (single path segment)
          const segments = f.path.split('/').filter(Boolean)
          if (segments.length !== 1) continue

          if (f.isDirectory) {
            children.push({ name, type: 'directory', children: [] })
          } else {
            children.push({ name, type: 'file', size: f.size })
          }
        }
        children.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        return c.json({ name: rootName, type: 'directory', children })
      } catch (err) {
        log.error('Failed to list workspace via sandbox:', err)
        return c.json({ error: 'Failed to list workspace' }, 500)
      }
    }

    // Local runtime: read from filesystem
    const workspacePath = resolveSquadWorkspaceHostPath(squad.id)
    if (!fs.existsSync(workspacePath)) {
      return c.json({ error: 'Workspace not found' }, 404)
    }

    const targetPath = relativePath ? path.resolve(workspacePath, relativePath) : workspacePath
    if (!isInsideWorkspaceRoot(workspacePath, targetPath)) {
      return c.json({ error: 'Invalid path' }, 400)
    }

    try {
      const stat = fs.statSync(targetPath)
      if (!stat.isDirectory()) return c.json({ error: 'Path is not a directory' }, 400)
    } catch {
      return c.json({ error: 'Path not found' }, 404)
    }

    const children = buildSquadTree(targetPath, 1, depth)
    const rootName = relativePath ? path.basename(targetPath) : 'workspace'

    return c.json({ name: rootName, type: 'directory', children })
  })
  .get('/:id/workspace/search', requireSquadPermission('workspace:read'), async (c) => {
    const rawId = c.req.param('id')
    const squad = await Squad.find(rawId)
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const query = c.req.query('q') ?? ''

    // K8s runtime: search via sandbox bash
    const client = await getSquadClient(squad.id)
    if (client) {
      const { workspaceMount } = resolveWorkspaceLayout({ squadId: squad.id })
      try {
        const result = await new Promise<string[]>((resolve, reject) => {
          let output = ''
          const stream = client.bash({
            command: `find ${workspaceMount} -maxdepth 5 -name '*${query.replace(/'/g, "\\'")}*' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -name '*.pyc' 2>/dev/null | head -20`,
            cwd: workspaceMount,
          })
          stream.on('data', (data) => {
            if (data.stdout) output += Buffer.from(data.stdout, 'base64').toString('utf-8')
          })
          stream.on('end', () => {
            const files = output
              .split('\n')
              .filter(Boolean)
              .map((f) => f.replace(`${workspaceMount}/`, ''))
            resolve(files)
          })
          stream.on('error', reject)
        })
        return c.json({ files: result })
      } catch (err) {
        log.error('Failed to search workspace via sandbox:', err)
        return c.json({ files: [] })
      }
    }

    // Local runtime
    const files = searchWorkspaceFiles(squad.id, { query, maxResults: 20 })
    return c.json({ files })
  })
  .get('/:id/workspace/file', requireSquadPermission('workspace:read'), async (c) => {
    const rawId = c.req.param('id')
    const squad = await Squad.find(rawId)
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const { workspaceMount } = resolveWorkspaceLayout({ squadId: squad.id })

    let relativePath = c.req.query('path')
    if (!relativePath) return c.json({ error: 'Path query parameter is required' }, 400)

    // Handle memory paths - read from memory service instead of workspace
    if (relativePath.startsWith('/memory/')) {
      const result = await WriteService.instance().read(squad.id, relativePath)
      if (!result.success) {
        return c.json({ error: result.error.message }, 404)
      }
      const content = result.content
      return c.json({
        path: relativePath,
        content,
        size: Buffer.byteLength(content, 'utf-8'),
        binary: false,
      })
    }

    // Strip container mount prefix so paths from inside sandboxes resolve correctly
    if (relativePath.startsWith(`${workspaceMount}/`)) {
      relativePath = relativePath.slice(`${workspaceMount}/`.length)
    } else if (relativePath === workspaceMount) {
      relativePath = '.'
    }

    // K8s runtime: proxy through sandbox
    const client = await getSquadClient(squad.id)
    if (client) {
      try {
        const filePath = `${workspaceMount}/${relativePath}`
        const result = await client.read({ path: filePath })
        const buffer = Buffer.from(result.content, 'base64')
        const binary = result.isBinary || buffer.slice(0, 8192).includes(0)
        return c.json({
          path: relativePath,
          content: binary ? '' : buffer.toString('utf-8'),
          size: result.totalSize,
          binary,
        })
      } catch (err: any) {
        if (err.message?.includes('404') || err.message?.includes('not found')) {
          return c.json({ error: 'File not found' }, 404)
        }
        log.error('Failed to read file via sandbox:', err)
        return c.json({ error: 'Failed to read file' }, 500)
      }
    }

    // Local runtime: read from filesystem
    const workspacePath = resolveSquadWorkspaceHostPath(squad.id)
    const targetPath = path.resolve(workspacePath, relativePath)
    if (!isInsideWorkspaceRoot(workspacePath, targetPath)) {
      return c.json({ error: 'Invalid path' }, 400)
    }

    if (!fs.existsSync(targetPath)) {
      return c.json({ error: 'File not found' }, 404)
    }

    try {
      const stat = fs.statSync(targetPath)
      if (!stat.isFile()) return c.json({ error: 'Path is not a file' }, 400)
      if (stat.size > 1024 * 1024) {
        return c.json({ path: relativePath, content: '', size: stat.size, binary: false, error: 'File too large' })
      }
      const buffer = fs.readFileSync(targetPath)
      const binary = buffer.slice(0, 8192).includes(0)
      return c.json({ path: relativePath, content: binary ? '' : buffer.toString('utf-8'), size: stat.size, binary })
    } catch (error) {
      log.error('Error reading file:', error)
      return c.json({ error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}` }, 500)
    }
  })
  .get('/:id/workspace/download', requireSquadPermission('workspace:read'), async (c) => {
    const rawId = c.req.param('id')
    const squad = await Squad.find(rawId)
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const { workspaceMount } = resolveWorkspaceLayout({ squadId: squad.id })

    let relativePath = c.req.query('path')
    if (!relativePath) return c.json({ error: 'Path query parameter is required' }, 400)

    // Strip container mount prefix so paths from inside sandboxes resolve correctly
    if (relativePath.startsWith(`${workspaceMount}/`)) {
      relativePath = relativePath.slice(`${workspaceMount}/`.length)
    } else if (relativePath === workspaceMount) {
      relativePath = '.'
    }

    // K8s runtime: proxy through sandbox
    const client = await getSquadClient(squad.id)
    if (client) {
      try {
        const filePath = `${workspaceMount}/${relativePath}`
        const filename = path.basename(relativePath)
        return await createSandboxFileResponse(client, filePath, filename)
      } catch (err: any) {
        if (err.message?.includes('404') || err.message?.includes('not found')) {
          return c.json({ error: 'File not found' }, 404)
        }
        log.error('Failed to download file via sandbox:', err)
        return c.json({ error: 'Failed to download file' }, 500)
      }
    }

    // Local runtime: read from filesystem
    const workspacePath = resolveSquadWorkspaceHostPath(squad.id)
    const targetPath = path.resolve(workspacePath, relativePath)
    if (!isInsideWorkspaceRoot(workspacePath, targetPath)) {
      return c.json({ error: 'Invalid path' }, 400)
    }

    try {
      return createDownloadResponse(targetPath, 'workspace')
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return c.json({ error: 'Path not found' }, 404)
      }
      log.error('Error downloading:', error)
      return c.json({ error: `Failed to download: ${error instanceof Error ? error.message : String(error)}` }, 500)
    }
  })
  .post('/:id/workspace/upload', requireSquadPermission('workspace:write'), async (c) => {
    const rawId = c.req.param('id')
    const squad = await Squad.find(rawId)
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }
    const archived = archivedGuard(c, squad)
    if (archived) return archived

    try {
      const formData = await c.req.formData()
      const files: { file: File; relativePath: string }[] = []

      // Collect all files with their relative paths
      for (const [key, value] of formData.entries()) {
        if (value && typeof value === 'object' && 'arrayBuffer' in value) {
          const file = value as File
          const relativePath = formData.get(`path_${key}`) as string | null
          files.push({
            file,
            relativePath: relativePath || file.name,
          })
        }
      }

      if (files.length === 0) {
        return c.json({ error: 'No files provided' }, 400)
      }

      const targetDir = (c.req.query('dir') || '').replace(/^\/+/, '')
      const overwrite = c.req.query('overwrite') === 'true'
      const results: { path: string; status: 'created' | 'overwritten' | 'skipped' | 'error'; error?: string }[] = []

      // K8s runtime: proxy through sandbox
      const client = await getSquadClient(squad.id)
      if (client) {
        const { workspaceMount } = resolveWorkspaceLayout({ squadId: squad.id })
        for (const { file, relativePath } of files) {
          const fullRelativePath = targetDir ? `${targetDir}/${relativePath}` : relativePath
          try {
            if (!overwrite) {
              try {
                const stat = await client.stat({ path: `${workspaceMount}/${fullRelativePath}` })
                if (stat.exists) {
                  results.push({ path: fullRelativePath, status: 'skipped' })
                  continue
                }
              } catch {
                // File doesn't exist, proceed
              }
            }
            const buffer = Buffer.from(await file.arrayBuffer())
            try {
              // Raw-body transport: no base64 (+33%) and no multi-megabyte JSON
              // string on either side — large uploads broke both.
              await client.upload({
                path: `${workspaceMount}/${fullRelativePath}`,
                content: buffer,
                createDirs: true,
              })
            } catch (err) {
              // A box bundle that predates /upload answers 404 — fall back to
              // the JSON write path so uploads keep working mid-rollout.
              if (!(err instanceof SandboxHttpError && err.status === 404)) throw err
              await client.write({
                path: `${workspaceMount}/${fullRelativePath}`,
                content: buffer.toString('base64'),
                createDirs: true,
              })
            }
            results.push({ path: fullRelativePath, status: 'created' })
          } catch (err) {
            results.push({
              path: fullRelativePath,
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        return c.json({ uploaded: results.filter((r) => r.status !== 'error').length, results })
      }

      // Local runtime: write to filesystem
      const workspacePath = resolveSquadWorkspaceHostPath(squad.id)
      const writtenFiles: string[] = []

      try {
        for (const { file, relativePath } of files) {
          const fullRelativePath = targetDir ? `${targetDir}/${relativePath}` : relativePath
          const targetPath = path.resolve(workspacePath, fullRelativePath)

          if (!isInsideWorkspaceRoot(workspacePath, targetPath)) {
            results.push({ path: fullRelativePath, status: 'error', error: 'Invalid path' })
            continue
          }

          const exists = fs.existsSync(targetPath)
          if (exists && !overwrite) {
            results.push({ path: fullRelativePath, status: 'skipped' })
            continue
          }

          const parentDir = path.dirname(targetPath)
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true })
          }

          const buffer = Buffer.from(await file.arrayBuffer())
          fs.writeFileSync(targetPath, buffer)
          writtenFiles.push(targetPath)
          results.push({ path: fullRelativePath, status: exists ? 'overwritten' : 'created' })
        }
      } catch (err) {
        for (const filePath of writtenFiles) {
          try {
            fs.unlinkSync(filePath)
          } catch {
            // Ignore cleanup errors
          }
        }
        throw err
      }

      return c.json({ uploaded: results.filter((r) => r.status !== 'error').length, results })
    } catch (error) {
      log.error('Error uploading files:', error)
      return c.json({ error: `Failed to upload: ${error instanceof Error ? error.message : String(error)}` }, 500)
    }
  })
  .get('/:id/workspace/sessions', requireSquadPermission('terminal:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const sessions = terminalManager.listSessions(squad.sandboxId)
    return c.json(sessions)
  })
  .get('/:id/relationships', requireSquadPermission('squads:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }
    const withRels = await squad.withRelationships()
    return c.json(withRels.relationships)
  })
  .get('/:id/can-communicate/:otherId', requireSquadPermission('squads:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }
    const otherId = c.req.param('otherId')
    const result = await squad.canCommunicateWith(otherId)
    return c.json({ canCommunicate: result })
  })
  .get('/:id/agents', requireSquadPermission('agents:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    // Check if we should include recently terminated agents
    const includeRecentlyTerminated = c.req.query('includeRecentlyTerminated') === 'true'

    const addressableAgentJson = (await squad.getAddressableAgents()).map((agent) => agent.toJson())

    if (!includeRecentlyTerminated) {
      return c.json({ agents: addressableAgentJson })
    }

    const rawTerminatedLimit = c.req.query('terminatedLimit')
    const rawTerminatedOffset = c.req.query('terminatedOffset')
    const terminatedLimit = rawTerminatedLimit
      ? Math.max(1, Math.min(parseInt(rawTerminatedLimit, 10) || 20, 100))
      : undefined
    const terminatedOffset = rawTerminatedOffset ? Math.max(0, parseInt(rawTerminatedOffset, 10) || 0) : undefined

    // Fetch recently terminated agents (within last 7 days). When a limit is provided, fetch one extra row to
    // determine whether another page exists without loading/rendering the entire terminated list.
    const recentlyTerminatedAgents = await squad.getRecentlyTerminatedAgents(7, {
      limit: terminatedLimit ? terminatedLimit + 1 : undefined,
      offset: terminatedOffset,
    })
    const recentlyTerminatedHasMore = terminatedLimit ? recentlyTerminatedAgents.length > terminatedLimit : false
    const visibleRecentlyTerminatedAgents = terminatedLimit
      ? recentlyTerminatedAgents.slice(0, terminatedLimit)
      : recentlyTerminatedAgents
    const recentlyTerminatedTotalCount = await squad.countRecentlyTerminatedAgents(7)

    return c.json({
      agents: addressableAgentJson,
      recentlyTerminated: visibleRecentlyTerminatedAgents.map((agent) => agent.toJson()),
      recentlyTerminatedHasMore,
      recentlyTerminatedTotalCount,
    })
  })
  // GET /api/squads/:id/messages/search?q=<term>&limit=N&role=human|assistant
  .get('/:id/messages/search', requireSquadPermission('chat:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const q = c.req.query('q')
    if (!q) {
      return c.json({ error: 'Search query "q" is required' }, 400)
    }

    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined
    const role = c.req.query('role') as 'human' | 'assistant' | undefined

    const results = await squad.searchMessages(q, { limit, role })
    return c.json(results)
  })
  .post('/:id/spawn', requireSquadPermission('agents:create'), zValidator('json', spawnSquadAgentSchema), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }
    const archived = archivedGuard(c, squad)
    if (archived) return archived

    const { agentTypeId, model } = c.req.valid('json')

    try {
      const agent = await squad.spawnAgent(agentTypeId, { model })
      return c.json(agent.toJson(), 201)
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400)
    }
  })
  .delete('/:id/agents/:agentId', requireSquadPermission('agents:terminate'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const agent = await Agent.find(c.req.param('agentId'))
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }
    if (agent.squadId !== squad.id) {
      return c.json({ error: 'Agent does not belong to this squad' }, 403)
    }
    if (agent.status === 'dormant') {
      return c.json({ error: 'Agent is already dormant', code: 'AGENT_ALREADY_DORMANT' }, 409)
    }
    if (agent.status === 'terminated') {
      return c.json({ error: 'Agent is terminated', code: 'AGENT_TERMINATED' }, 409)
    }

    try {
      await agent.tryTerminate()
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : `Failed to unspawn agent: ${error}` }, 400)
    }

    return c.body(null, 204)
  })
  // POST /api/squads/:id/agents/terminate-bulk - Bulk-terminate all eligible agents of a given type.
  // Reuses Agent.tryTerminate() per agent so every existing safety check applies (skips managers,
  // persistent agents, agents with active work streams; defers mid-turn agents). Returns a summary.
  .post('/:id/agents/terminate-bulk', requireSquadPermission('agents:terminate'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const { agentTypeId } = await c.req.json<{ agentTypeId?: string }>()
    if (!agentTypeId || typeof agentTypeId !== 'string') {
      return c.json({ error: 'agentTypeId is required' }, 400)
    }

    const activeAgents = await squad.getActiveAgents()
    const targetAgents = activeAgents.filter((agent) => agent.agentTypeId === agentTypeId)
    const terminated: string[] = []
    const deferred: string[] = []
    const skipped: { id: string; reason: string }[] = []

    for (const agent of targetAgents) {
      try {
        await agent.tryTerminate()
        if (agent.pendingDormancyAt) {
          deferred.push(agent.id)
        } else {
          terminated.push(agent.id)
        }
      } catch (error) {
        skipped.push({ id: agent.id, reason: error instanceof Error ? error.message : String(error) })
      }
    }

    return c.json({ terminated, deferred, skipped })
  })
  .get('/:id/toolchain', requireSquadPermission('squads:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    return c.json(squad.toolchainConfig ?? { packages: [] })
  })
  .put(
    '/:id/toolchain',
    requireSquadPermission('squads:update'),
    zValidator('json', squadToolchainSchema),
    async (c) => {
      const squad = await Squad.find(c.req.param('id'))
      if (!squad) return c.json({ error: 'Squad not found' }, 404)
      const archived = archivedGuard(c, squad)
      if (archived) return archived
      const config = normalizeToolchain(c.req.valid('json'))
      const storedToolchain: { packages: string[]; setupScript?: string | null } = { packages: config.packages }
      if (config.setupScript !== undefined) storedToolchain.setupScript = config.setupScript
      else if (squad.toolchainConfig?.setupScript !== undefined) storedToolchain.setupScript = null
      await squad.update({ metadata: { sandbox: { toolchain: storedToolchain } } })
      // The declaration is still stored on host (it applies if the deployment
      // moves to a sandboxed runtime), but there is no sandbox to prewarm.
      if (!isHostRuntime()) sandboxPrewarm.prewarmSandboxBackground(squad.id)
      return c.json(config)
    }
  )
  .delete('/:id/toolchain', requireSquadPermission('squads:update'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    const archived = archivedGuard(c, squad)
    if (archived) return archived
    await squad.update({ metadata: { sandbox: { toolchain: null } } })
    if (!isHostRuntime()) sandboxPrewarm.prewarmSandboxBackground(squad.id)
    return c.json({ ok: true })
  })
  .post('/:id/toolchain/apply', requireSquadPermission('squads:update'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    const host = hostRuntimeGuard(c, HOST_NO_TOOLCHAIN_ERROR)
    if (host) return host
    const archived = archivedGuard(c, squad)
    if (archived) return archived
    sandboxPrewarm.prewarmSandboxBackground(squad.id)
    return c.json({ ok: true }, 202)
  })
  // GET /api/squads/:id/sandbox/status - Live sandbox pod status
  .get('/:id/sandbox/status', requireSquadPermission('squads:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    if (!isRemoteSandboxRuntime()) {
      // Docker mode — sandbox is always "running" if it exists
      const manager = getSandboxManager()
      const hasIt = manager.hasSandbox(squad.sandboxId)
      // Host has no devbox, so a declared toolchain has nowhere to be applied:
      // resolving it would decorate the payload with the status of a thing that
      // cannot exist (and flip devboxReady off) for two wasted DB round-trips.
      const toolchain = isHostRuntime() ? undefined : await resolveToolchainStatus(squad.sandboxId, squad)
      // Host only: the directory agents, the terminal and the file routes are
      // using RIGHT NOW. That is the path the last sandbox ensure recorded —
      // NOT the override cache, which the PATCH primes immediately and which
      // therefore describes the next start, not the running one. No ensure has
      // run yet => fall back to the resolved path and say so.
      const applied = isHostRuntime() ? hostActiveWorkspacePath(squad) : undefined
      return c.json(
        mergeSandboxStatus(
          {
            status: hasIt ? 'running' : 'not_found',
            runtime: isHostRuntime() ? ('host' as const) : ('docker' as const),
            devboxReady: true,
            ...(isHostRuntime()
              ? {
                  workspacePath: applied ?? resolveSquadWorkspaceHostPath(squad.id),
                  workspacePathApplied: applied !== undefined,
                }
              : {}),
          },
          toolchain
        )
      )
    }

    // Remote runtime (k8s or vm) — query actual live sandbox status. `runtime`
    // is server-driven config (FICUS_SANDBOX_RUNTIME), never client-guessed: the
    // web UI switches its VM chain-health presentation off this field.
    const manager = getSandboxManager() as K8sSandboxManager
    const status = await manager.getSandboxStatus(squad.sandboxId)
    const provisioning = isK8sRuntime() ? await manager.getProvisionDiagnostics() : undefined
    const toolchain = await resolveToolchainStatus(squad.sandboxId, squad)
    return c.json(
      mergeSandboxStatus(
        {
          ...status,
          // The overload detector's reading when status did not probe the box itself.
          ...(isVmRuntime() && !('pressure' in status && status.pressure)
            ? await openSandboxOverloadPressure(squad.sandboxId).then((pressure) => (pressure ? { pressure } : {}))
            : {}),
          runtime: isVmRuntime() ? ('vm' as const) : ('k8s' as const),
          ...(provisioning ? { provisioning } : {}),
        },
        toolchain
      )
    )
  })
  // POST /api/squads/:id/sandbox/start - Start the sandbox pod
  .post('/:id/sandbox/start', requireSquadPermission('squads:update'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }
    const host = hostRuntimeGuard(c)
    if (host) return host
    const archived = archivedGuard(c, squad)
    if (archived) return archived

    try {
      const { ensureSquadSandbox } = await import('../services/sandbox/ensure')
      await ensureSquadSandbox(squad)
      return c.json({ ok: true })
    } catch (err) {
      const provisioning = getSandboxProvisionErrorResponse(err)
      if (provisioning) {
        if (provisioning.retryAfter) c.header('Retry-After', provisioning.retryAfter)
        return c.json(provisioning.body, provisioning.status)
      }
      log.error(`Failed to start sandbox for squad ${squad.id}:`, err)
      return c.json({ error: 'Failed to start sandbox' }, 500)
    }
  })
  // GET /api/squads/:id/sandbox/processes - What the squad box is running.
  // Command lines can carry secrets, so this needs the same permission as
  // stopping them.
  .get('/:id/sandbox/processes', requireSquadPermission('squads:update'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    try {
      return c.json(await listSandboxProcesses(squad.sandboxId))
    } catch (err) {
      const failure = sandboxProcessesErrorResponse(err)
      if (failure) return c.json(failure.body, failure.status)
      throw err
    }
  })
  // POST /api/squads/:id/sandbox/processes/:pid/signal - Signal one of the box user's processes
  .post('/:id/sandbox/processes/:pid/signal', requireSquadPermission('squads:update'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    try {
      const body = await parseOptionalJsonObjectBody(c, {} as { signal?: unknown })
      const pid = parseProcessId(c.req.param('pid'))
      const signal = parseProcessSignal(body.signal)
      return c.json(await signalSandboxProcess(squad.sandboxId, pid, signal, c.get('identity')!))
    } catch (err) {
      const failure = sandboxProcessesErrorResponse(err)
      if (failure) return c.json(failure.body, failure.status)
      throw err
    }
  })
  // POST /api/squads/:id/sandbox/containers/:containerId/stop - Stop one of the box's containers
  .post('/:id/sandbox/containers/:containerId/stop', requireSquadPermission('squads:update'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    try {
      const containerId = parseContainerId(c.req.param('containerId'))
      return c.json(await stopSandboxContainer(squad.sandboxId, containerId, c.get('identity')!))
    } catch (err) {
      const failure = sandboxProcessesErrorResponse(err)
      if (failure) return c.json(failure.body, failure.status)
      throw err
    }
  })
  // POST /api/squads/:id/sandbox/stop - Stop the sandbox pod
  .post('/:id/sandbox/stop', requireSquadPermission('squads:update'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }
    const host = hostRuntimeGuard(c)
    if (host) return host

    try {
      const manager = getSandboxManager()
      await manager.removeSandbox(squad.sandboxId)
      await markLocalDeploymentsStoppedForSandbox(squad.sandboxId)
      return c.json({ ok: true })
    } catch (err) {
      log.error(`Failed to stop sandbox for squad ${squad.id}:`, err)
      return c.json({ error: 'Failed to stop sandbox' }, 500)
    }
  })
  // POST /api/squads/:id/machine — pin the squad's box to a machine (or unpin with
  // null) AND drive the migration now. Gated on `machines:write` (an infra action,
  // distinct from the `squads:update` attribute write on PATCH).
  .post('/:id/machine', requirePermission('machines:write'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    const archived = archivedGuard(c, squad)
    if (archived) return archived

    // Require the `machineId` key to be PRESENT: an explicit null is a valid
    // unpin, but an absent key or an unparseable body is an ERROR, not an implicit
    // unpin (a typo'd field name would otherwise silently migrate the box off its
    // pinned machine).
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Request body must be JSON with a machineId field (string to pin, null to unpin)' }, 400)
    }
    if (typeof body !== 'object' || body === null || !Object.prototype.hasOwnProperty.call(body, 'machineId')) {
      return c.json({ error: 'machineId is required (string to pin, null to unpin)' }, 400)
    }
    const rawMachineId = (body as { machineId?: unknown }).machineId
    if (rawMachineId !== null && typeof rawMachineId !== 'string') {
      return c.json({ error: 'machineId must be a string or null' }, 400)
    }
    const machineId = rawMachineId ?? null

    try {
      await assertMachinePinReady(machineId)
    } catch (error) {
      if (error instanceof MachinePinError) return c.json({ error: error.message }, 400)
      throw error
    }

    // Writes the pin and emits squad.updated.
    await squad.update({ machineId })

    // Drive the migration now for a LIVE squad box: stop (tears the old box down on
    // its old machine) then start (re-ensures on the new pin). A stopped/absent box
    // is simply repinned and lands on the pin at its next ensure. Best-effort: a
    // migration failure never rolls back the persisted pin.
    try {
      const manager = getSandboxManager()
      const live = isRemoteSandboxRuntime()
        ? (await (manager as K8sSandboxManager).getSandboxStatus(squad.sandboxId)).status !== 'not_found'
        : manager.hasSandbox(squad.sandboxId)
      if (live) {
        await manager.removeSandbox(squad.sandboxId)
        await markLocalDeploymentsStoppedForSandbox(squad.sandboxId)
        const { ensureSquadSandbox } = await import('../services/sandbox/ensure')
        await ensureSquadSandbox(squad)
      }
    } catch (err) {
      log.error(`Pin set for squad ${squad.id} but live migration failed (will migrate on next ensure):`, err)
    }

    return c.json(squad.toJson())
  })
  // POST /api/squads/:id/avatar - Upload/replace the squad avatar image
  .post('/:id/avatar', requireSquadPermission('squads:update'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }
    const archived = archivedGuard(c, squad)
    if (archived) return archived

    const body = await c.req.json<{ image?: ImageContent }>()
    const image = body.image
    const validMimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
    if (!image || image.type !== 'image' || !validMimeTypes.includes(image.mimeType) || !image.data) {
      return c.json({ error: 'A png, jpeg, gif, or webp image is required' }, 400)
    }

    let created
    try {
      ;[created] = await Image.createMany([image], { squadId: squad.id })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Upload failed' }, 400)
    }
    await created.markUsed()

    // Point the squad at the new image, then delete the previous avatar's file + row.
    const previousId = squad.avatarImageId
    await db.update(squads).set({ avatarImageId: created.id, updatedAt: new Date() }).where(eq(squads.id, squad.id))
    if (previousId) {
      const prev = await Image.find(previousId)
      if (prev) await prev.delete().catch(() => {})
    }

    const updated = await Squad.find(squad.id)
    return c.json(updated!.toJson())
  })
  // DELETE /api/squads/:id/avatar - Remove the squad avatar
  .delete('/:id/avatar', requireSquadPermission('squads:update'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const previousId = squad.avatarImageId
    if (previousId) {
      await db.update(squads).set({ avatarImageId: null, updatedAt: new Date() }).where(eq(squads.id, squad.id))
      const prev = await Image.find(previousId)
      if (prev) await prev.delete().catch(() => {})
    }

    const updated = await Squad.find(squad.id)
    return c.json(updated!.toJson())
  })
  // GET /api/squads/:id/terminal/sessions - Active terminal sessions for squad sandbox
  .get('/:id/terminal/sessions', requireSquadPermission('terminal:read'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const sessions = terminalManager.listSessions(squad.sandboxId)
    return c.json(sessions)
  })
  // DELETE /api/squads/:id/terminal/sessions/:sessionId - Kill a terminal session
  .delete('/:id/terminal/sessions/:sessionId', requireSquadPermission('terminal:write'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const sessionId = c.req.param('sessionId')

    const session = terminalManager.getSession(sessionId)
    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }
    if (session.sandboxId !== squad.sandboxId) {
      return c.json({ error: 'Session does not belong to this squad' }, 403)
    }

    terminalManager.killSession(sessionId)
    return c.json({ success: true })
  })

function sourceConfigToJson(config: SquadSourceConfig) {
  return {
    id: config.id,
    squadId: config.squadId,
    sourceType: config.sourceType,
    enabled: config.enabled,
    policy: config.policy,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  }
}

function validateSourcePolicy(sourceType: string, policy: unknown): string[] | null {
  const adapters = [
    FileSource.instance(),
    ThreadSource.instance(),
    WorkspaceFileSource.instance(),
    SlackThreadSource.instance(),
    SlackCanvasSource.instance(),
    GitHubIssueSource.instance(),
  ]
  const adapter = adapters.find(
    (candidate) =>
      candidate.sourceType === sourceType || (sourceType === 'memory_file' && candidate.sourceType === 'file')
  )
  return adapter?.validatePolicy?.(policy) ?? null
}

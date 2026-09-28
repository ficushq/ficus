/**
 * Memory API Routes
 *
 * Provides HTTP endpoints for memory operations:
 * - GET /api/memory/:squadId/file - Read a memory file
 * - GET /api/memory/:squadId/search - Search memory documents
 * - GET /api/memory/:squadId/backlinks - Get backlinks to a document
 * - POST /api/memory/:squadId/write - Write (overwrite) a file
 * - POST /api/memory/:squadId/patch - Patch a file (exact match replacement)
 * - POST /api/memory/:squadId/append - Append to a file
 * - POST /api/memory/:squadId/ingest-url - Ingest a supported external URL
 * - POST /api/memory/:squadId/reindex - Reindex memory documents
 * - POST /api/memory/:squadId/sync/pull - Pull from remote
 * - POST /api/memory/:squadId/sync/push - Push to remote
 * - GET /api/memory/:squadId/sync/status - Get sync status
 */

import { Hono } from 'hono'
import type { MemorySourceType } from '@ficus/shared'
import { AGENT_THREAD_SEARCH_ENABLED, isMemorySourceType } from '@ficus/shared'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Squad } from '../entities/Squad'
import {
  WriteService,
  MemoryErrorCodes,
  SearchService,
  IndexingService,
  ensureSquadMemoryPath,
  SyncService,
  ListService,
  ExternalSourceReindexService,
  type ExternalIndexedSourceType,
} from '../services/memory'
import { resolveExternalUrl } from '../services/memory/sources/url-resolver'
import { ingestWorkspaceFiles } from '../services/memory/workspace-files'
import { readdir, readFile } from 'fs/promises'
import { join, relative } from 'path'
import { K8sSandboxManager } from '../services/sandbox/k8s'
import type { SandboxClient } from '../services/sandbox/k8s/http-client'
import { VmSandboxManager } from '../services/sandbox/vm/manager'
import { ensureSquadSandbox } from '../services/sandbox'
import { requireSquadPermission } from '../middleware/require-permission'
import { requireSandboxCallback } from '../middleware/require-sandbox-callback'
import type { Identity } from '../services/rbac'

// --- Validation Schemas ---

const readQuerySchema = z.object({
  path: z.string().min(1, 'Path is required'),
})

const listQuerySchema = z.object({
  path: z.string().optional(),
})

const writeBodySchema = z.object({
  path: z.string().min(1, 'Path is required'),
  content: z.string().nullable(),
})

const patchBodySchema = z.object({
  path: z.string().min(1, 'Path is required'),
  match: z.string().min(1, 'Match string is required'),
  replacement: z.string(),
})

const appendBodySchema = z.object({
  path: z.string().min(1, 'Path is required'),
  content: z.string(),
  ensureNewline: z.boolean().optional(),
})

const searchQuerySchema = z.object({
  query: z.string().min(1, 'Query is required'),
  limit: z.string().optional(),
  mode: z.enum(['hybrid', 'vector', 'keyword']).optional(),
  sourceTypes: z.string().optional(), // Comma-separated known memory source types
  kinds: z.string().optional(), // Comma-separated: decision,pattern
  tags: z.string().optional(), // Comma-separated: auth,security
  paths: z.string().optional(), // Comma-separated: decisions/**,patterns/*.md
  sourceSquadIds: z.string().optional(), // Comma-separated source squad IDs
  sensitivity: z.enum(['public', 'internal', 'restricted', 'confidential']).optional(),
})

const backlinksQuerySchema = z.object({
  path: z.string().min(1, 'Path is required'),
})

const reindexBodySchema = z.object({
  source: z
    .enum(['memory_file', 'agent_thread', 'workspace_file', 'slack_thread', 'slack_canvas', 'github_issue', 'all'])
    .optional(),
})

const ingestUrlBodySchema = z.object({
  url: z.string().url('A valid URL is required'),
})

const workspaceFileSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string().optional(),
      contentHash: z.string().optional(),
      event: z.enum(['change', 'delete']),
    })
  ),
  reconcile: z.boolean().optional(),
  skipped: z
    .array(
      z.object({
        path: z.string(),
        reason: z.enum(['file_too_large', 'binary', 'max_files_exceeded', 'unreadable']),
        detail: z.string().optional(),
      })
    )
    .optional(),
})

// --- Router ---

export const memoryRouter = new Hono()
  // Search memory documents
  .get(
    '/:squadId/search',
    requireSquadPermission('memory:read', 'squadId'),
    zValidator('query', searchQuerySchema),
    async (c) => {
      const squadId = c.req.param('squadId')
      const { query, limit, mode, sourceTypes, kinds, tags, paths, sourceSquadIds, sensitivity } = c.req.valid('query')

      const squad = await Squad.find(squadId)
      if (!squad) {
        return c.json({ error: 'Squad not found' }, 404)
      }

      try {
        // Parse comma-separated filter values
        const rawSourceTypes = sourceTypes?.split(',').filter(Boolean)
        const invalidSourceTypes = rawSourceTypes?.filter((sourceType) => !isMemorySourceType(sourceType)) ?? []
        if (invalidSourceTypes.length > 0) {
          return c.json({ error: `Unknown sourceTypes: ${invalidSourceTypes.join(', ')}` }, 400)
        }
        const requestedSourceTypes = rawSourceTypes as MemorySourceType[] | undefined
        const parsedSourceTypes = AGENT_THREAD_SEARCH_ENABLED
          ? requestedSourceTypes
          : requestedSourceTypes?.filter((sourceType) => sourceType !== 'agent_thread')
        if (requestedSourceTypes?.length && parsedSourceTypes?.length === 0) {
          return c.json([])
        }
        const parsedKinds = kinds ? kinds.split(',').filter(Boolean) : undefined
        const parsedTags = tags ? tags.split(',').filter(Boolean) : undefined
        const parsedPaths = paths ? paths.split(',').filter(Boolean) : undefined
        const parsedSourceSquadIds = sourceSquadIds
          ? sourceSquadIds
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined

        const results = await SearchService.instance().search(squad.id, query, {
          limit: limit ? parseInt(limit, 10) : undefined,
          mode: mode as 'hybrid' | 'vector' | 'keyword' | undefined,
          sourceTypes: parsedSourceTypes,
          kinds: parsedKinds,
          tags: parsedTags,
          paths: parsedPaths,
          sourceSquadIds: parsedSourceSquadIds,
          sensitivity,
        })
        return c.json(results)
      } catch (e) {
        const error = e as Error
        return c.json({ error: error.message }, 500)
      }
    }
  )

  // Get backlinks to a document
  .get(
    '/:squadId/backlinks',
    requireSquadPermission('memory:read', 'squadId'),
    zValidator('query', backlinksQuerySchema),
    async (c) => {
      const squadId = c.req.param('squadId')
      const { path } = c.req.valid('query')

      const squad = await Squad.find(squadId)
      if (!squad) {
        return c.json({ error: 'Squad not found' }, 404)
      }

      try {
        const results = await IndexingService.instance().getBacklinks(squad.id, path)
        return c.json(results)
      } catch (e) {
        const error = e as Error
        return c.json({ error: error.message }, 500)
      }
    }
  )

  // List memory files in a directory
  .get(
    '/:squadId/list',
    requireSquadPermission('memory:read', 'squadId'),
    zValidator('query', listQuerySchema),
    async (c) => {
      const squadId = c.req.param('squadId')
      const { path = '/memory' } = c.req.valid('query')

      const squad = await Squad.find(squadId)
      if (!squad) {
        return c.json({ error: 'Squad not found' }, 404)
      }

      const result = await ListService.instance().list(squad.id, path)

      if (!result.success) {
        const status = getErrorStatus(result.error.code)
        return c.json({ error: result.error }, status)
      }

      return c.json({ path: result.path, entries: result.entries })
    }
  )

  // Read a memory file
  .get(
    '/:squadId/file',
    requireSquadPermission('memory:read', 'squadId'),
    zValidator('query', readQuerySchema),
    async (c) => {
      const squadId = c.req.param('squadId')
      const { path } = c.req.valid('query')

      // Verify squad exists
      const squad = await Squad.find(squadId)
      if (!squad) {
        return c.json({ error: 'Squad not found' }, 404)
      }

      const result = await WriteService.instance().read(squad.id, path)

      if (!result.success) {
        const status = getErrorStatus(result.error.code)
        return c.json({ error: result.error }, status)
      }

      return c.json({
        path: result.path,
        content: result.content,
        sourceSquadId: result.sourceSquadId,
      })
    }
  )

  // Write (overwrite) a memory file
  .post(
    '/:squadId/write',
    requireSquadPermission('memory:write', 'squadId'),
    zValidator('json', writeBodySchema),
    async (c) => {
      const squadId = c.req.param('squadId')
      const { path, content } = c.req.valid('json')

      // Verify squad exists
      const squad = await Squad.find(squadId)
      if (!squad) {
        return c.json({ error: 'Squad not found' }, 404)
      }

      const callerSquadId = deriveCallerSquadId(c.get('identity'), squad.id)
      const result = await WriteService.instance().writeAs(callerSquadId, squad.id, path, content)

      if (!result.success) {
        const status = getErrorStatus(result.error!.code)
        return c.json({ error: result.error }, status)
      }

      return c.json({ success: true, path: result.path, deleted: result.deleted })
    }
  )

  // Patch a memory file (exact match replacement)
  .post(
    '/:squadId/patch',
    requireSquadPermission('memory:write', 'squadId'),
    zValidator('json', patchBodySchema),
    async (c) => {
      const squadId = c.req.param('squadId')
      const { path, match, replacement } = c.req.valid('json')

      // Verify squad exists
      const squad = await Squad.find(squadId)
      if (!squad) {
        return c.json({ error: 'Squad not found' }, 404)
      }

      const callerSquadId = deriveCallerSquadId(c.get('identity'), squad.id)
      const result = await WriteService.instance().patchAs(callerSquadId, squad.id, path, match, replacement)

      if (!result.success) {
        const status = getErrorStatus(result.error!.code)
        return c.json({ error: result.error }, status)
      }

      return c.json({ success: true, path: result.path })
    }
  )

  // Append to a memory file
  .post(
    '/:squadId/append',
    requireSquadPermission('memory:write', 'squadId'),
    zValidator('json', appendBodySchema),
    async (c) => {
      const squadId = c.req.param('squadId')
      const { path, content, ensureNewline } = c.req.valid('json')

      // Verify squad exists
      const squad = await Squad.find(squadId)
      if (!squad) {
        return c.json({ error: 'Squad not found' }, 404)
      }

      const callerSquadId = deriveCallerSquadId(c.get('identity'), squad.id)
      const result = await WriteService.instance().appendAs(callerSquadId, squad.id, path, content, { ensureNewline })

      if (!result.success) {
        const status = getErrorStatus(result.error!.code)
        return c.json({ error: result.error }, status)
      }

      return c.json({ success: true, path: result.path })
    }
  )

  // Ingest an external memory source by URL (Slack thread or GitHub issue/PR)
  .post(
    '/:squadId/ingest-url',
    requireSquadPermission('memory:write', 'squadId'),
    zValidator('json', ingestUrlBodySchema),
    async (c) => {
      const squadId = c.req.param('squadId')
      const { url } = c.req.valid('json')

      const squad = await Squad.find(squadId)
      if (!squad) {
        return c.json({ error: 'Squad not found' }, 404)
      }

      const resolved = resolveExternalUrl(url)
      if (!resolved) {
        return c.json({ error: 'Unsupported URL' }, 400)
      }

      const result = await IndexingService.instance().index(squad.id, resolved.sourceType, resolved.sourceId)
      if (!result.success) {
        return c.json({ sourceType: resolved.sourceType, sourceId: resolved.sourceId, result }, 400)
      }

      return c.json({ sourceType: resolved.sourceType, sourceId: resolved.sourceId, result })
    }
  )

  // Ingest workspace files from sandbox
  .post('/:squadId/workspace-files', requireSandboxCallback, zValidator('json', workspaceFileSchema), async (c) => {
    const squadId = c.req.param('squadId')
    const result = await ingestWorkspaceFiles(squadId, c.req.valid('json'))
    if (!result.squadFound) {
      return c.json({ error: 'Squad not found' }, 404)
    }
    const { squadFound: _found, ...counts } = result
    return c.json({ success: true, ...counts })
  })

  // Reindex memory documents
  .post(
    '/:squadId/reindex',
    requireSquadPermission('memory:write', 'squadId'),
    zValidator('json', reindexBodySchema),
    async (c) => {
      const squadId = c.req.param('squadId')
      const { source = 'all' } = c.req.valid('json')

      const squad = await Squad.find(squadId)
      if (!squad) {
        return c.json({ error: 'Squad not found' }, 404)
      }

      try {
        const results = {
          filesIndexed: 0,
          workspaceFilesScanned: 0,
          workspaceFilesScanError: undefined as string | undefined,
          externalSources: undefined as Awaited<ReturnType<ExternalSourceReindexService['reindexSquad']>> | undefined,
        }

        if (source === 'agent_thread') {
          return c.json(
            {
              error:
                'agent_thread is indexed automatically from execution lifecycle events and is not user-reindexable. Search is disabled by product decision; see docs/wiki/memory/agent-threads.md.',
            },
            400
          )
        }

        // Index memory files
        if (source === 'memory_file' || source === 'all') {
          const memoryPath = ensureSquadMemoryPath(squad.id)
          const files = await collectMarkdownFiles(memoryPath)

          const fileContents = await Promise.all(
            files.map(async (filePath) => ({
              path: `/memory/${relative(memoryPath, filePath)}`,
              content: await readFile(filePath, 'utf-8'),
            }))
          )

          const indexResults = await IndexingService.instance().indexFiles(squad.id, fileContents)
          results.filesIndexed = indexResults.filter((r) => r.success).length
        }

        // Re-scan workspace files
        if (source === 'workspace_file' || source === 'all') {
          try {
            const { getSandboxManager, isRemoteSandboxRuntime } = await import('../services/sandbox')
            if (isRemoteSandboxRuntime()) {
              const manager = getSandboxManager()
              let client: SandboxClient | null = null
              if (manager instanceof VmSandboxManager) {
                // A vm box may have been ensured by the WORKER process, so the
                // api's in-memory client map misses even though the box is
                // ready — getOrAttachClient reads the ready machine_boxes row
                // and attaches over the shared SSH master instead of silently
                // skipping the rescan.
                client = await manager.getOrAttachClient(squad.sandboxId)
              } else if (manager instanceof K8sSandboxManager) {
                await ensureSquadSandbox(squad)
                // Client should exist if sandbox is running.
                client = manager.getClient(squad.sandboxId)
              }
              if (client) {
                const result = await client.rescanWatch()
                results.workspaceFilesScanned = result.fileCount || 0
              } else {
                // Distinguish "scanned 0 files" from "never scanned": a null
                // client means the sandbox is not reachable (vm box parked/
                // stopped, or k8s client missing), so surface it the same way
                // a thrown scan failure is surfaced below.
                results.workspaceFilesScanError = 'sandbox is not running; workspace files were not rescanned'
              }
            }
          } catch (err: unknown) {
            // Sandbox might not be running
            results.workspaceFilesScanError = err instanceof Error ? err.message : `Unknown error: ${String(err)}`
          }
        }

        if (source === 'slack_thread' || source === 'slack_canvas' || source === 'github_issue') {
          results.externalSources = await ExternalSourceReindexService.instance().reindexSquad(squad.id, {
            sourceTypes: [source as ExternalIndexedSourceType],
          })
        } else if (source === 'all') {
          results.externalSources = await ExternalSourceReindexService.instance().reindexSquad(squad.id)
        }

        return c.json({ success: true, ...results })
      } catch (e) {
        const error = e as Error
        return c.json({ error: error.message }, 500)
      }
    }
  )

  // Sync operations
  .post('/:squadId/sync/pull', requireSquadPermission('memory:write', 'squadId'), async (c) => {
    const squadId = c.req.param('squadId')

    const squad = await Squad.find(squadId)
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    try {
      const result = await SyncService.instance().pull(squad.id)
      if (!result.success) {
        return c.json({ error: result.error }, 400)
      }
      return c.json({
        success: true,
        filesChanged: result.filesChanged,
        conflicts: result.conflicts,
      })
    } catch (e) {
      const error = e as Error
      return c.json({ error: error.message }, 500)
    }
  })

  .post('/:squadId/sync/push', requireSquadPermission('memory:write', 'squadId'), async (c) => {
    const squadId = c.req.param('squadId')

    const squad = await Squad.find(squadId)
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    try {
      const result = await SyncService.instance().push(squad.id)
      if (!result.success) {
        return c.json({ error: result.error }, 400)
      }
      return c.json({
        success: true,
        filesPushed: result.filesPushed,
      })
    } catch (e) {
      const error = e as Error
      return c.json({ error: error.message }, 500)
    }
  })

  .get('/:squadId/sync/status', requireSquadPermission('memory:read', 'squadId'), async (c) => {
    const squadId = c.req.param('squadId')

    const squad = await Squad.find(squadId)
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    try {
      const status = await SyncService.instance().getStatus(squad.id)
      return c.json(status)
    } catch (e) {
      const error = e as Error
      return c.json({ error: error.message }, 500)
    }
  })

  // Webhook endpoint for Git push notifications
  .post('/:squadId/sync/webhook', async (c) => {
    c.set('publicRoute', true)
    const squadId = c.req.param('squadId')

    const squad = await Squad.find(squadId)
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    try {
      const rawBody = await c.req.text()
      const event = c.req.header('X-GitHub-Event') || 'push'
      const signature = c.req.header('X-Hub-Signature-256') || null

      const result = await SyncService.instance().handleWebhook(squad.id, 'git', event, rawBody, signature)
      if (!result.success && result.code === 'unauthorized') {
        return c.json({ error: result.message ?? 'Invalid signature' }, 401)
      }
      return c.json(result)
    } catch (e) {
      const error = e as Error
      return c.json({ error: error.message }, 500)
    }
  })

// --- Helpers ---

function deriveCallerSquadId(identity: Identity, targetSquadId: string): string {
  if (identity.type === 'agent' && identity.squadId) return identity.squadId
  return targetSquadId
}

/**
 * Recursively collect all markdown files in a directory.
 */
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = []

  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        // Skip hidden directories
        if (!entry.name.startsWith('.')) {
          const subFiles = await collectMarkdownFiles(fullPath)
          files.push(...subFiles)
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath)
      }
    }
  } catch {
    // Directory might not exist yet
  }

  return files
}

type ErrorStatusCode = 400 | 403 | 408 | 409 | 500

function getErrorStatus(code: string): ErrorStatusCode {
  switch (code) {
    case MemoryErrorCodes.MEMORY_PATH_INVALID:
      return 400
    case MemoryErrorCodes.PATCH_NO_MATCH:
    case MemoryErrorCodes.PATCH_AMBIGUOUS_MATCH:
      return 409 // Conflict
    case MemoryErrorCodes.MEMORY_FORBIDDEN:
      return 403 // Forbidden
    case MemoryErrorCodes.MEMORY_LOCK_TIMEOUT:
      return 408 // Request Timeout
    case MemoryErrorCodes.MEMORY_WRITE_FAILED:
    default:
      return 500
  }
}

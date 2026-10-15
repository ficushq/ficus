/**
 * An agent's private area, for a person: browse, view, download and upload
 * files there, and see or start the agent's own box.
 *
 *   GET  /api/agents/:agentId/private/status
 *   POST /api/agents/:agentId/private/start
 *   GET  /api/agents/:agentId/private/tree?path=
 *   GET  /api/agents/:agentId/private/file?path=
 *   GET  /api/agents/:agentId/private/download?path=
 *   POST /api/agents/:agentId/private/upload?dir=&overwrite=true
 *
 * Every route authorizes through services/agent-private/access.ts (a person
 * with `agents:private-access` in the agent's squad, resolved from the agent
 * row) and answers one uniform 403 for an unknown agent, an agent of another
 * squad, an agent without a private box of its own, or a missing permission.
 * Paths are confined by services/agent-private/files.ts. Files land only in
 * the agent's private area, never in the shared squad workspace. Each read,
 * download, upload and start is logged with the acting person.
 */

import { Hono, type Context } from 'hono'
import { ConfinedFsError, type ConfinedFsErrorCode } from '@ficus/shared/confined-fs'
import { createLogger } from '../lib/infra/logger'
import { auditActor } from '../services/rbac/audit-actor'
import type { Identity } from '../services/rbac'
import {
  authorizeAgentPrivateArea,
  canAccessAgentPrivateArea,
  type AgentPrivateTarget,
} from '../services/agent-private/access'
import {
  AgentPrivateUnavailableError,
  agentVisiblePrivatePath,
  agentVisiblePrivateRoot,
  isAgentPrivateAreaLocal,
  listAgentPrivateDir,
  readAgentPrivateFile,
  writeAgentPrivateFile,
} from '../services/agent-private/files'
import { getAgentSandboxState, startAgentSandbox } from '../services/agent-private/sandbox'
import { downloadDisposition, readBoundedMultipart } from '../services/attachments/http'
import { getSandboxProvisionErrorResponse } from './sandbox-provision-error'

const log = createLogger('agent-private')

/** Largest file shown inline in the viewer (same as the squad workspace viewer). */
const VIEW_MAX_BYTES = 1024 * 1024
/** Largest file served by download. */
const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024
/** Largest upload request (all files together). */
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024

const CONFINED_STATUS: Record<ConfinedFsErrorCode, 400 | 404> = {
  'invalid-path': 400,
  'not-found': 404,
  'not-a-directory': 400,
  'not-a-file': 400,
  symlink: 400,
}

function forbidden(c: Context) {
  return c.json({ error: 'Forbidden' }, 403)
}

/** Authorize the caller for `:agentId`, or produce the uniform denial. */
async function authorize(c: Context): Promise<{ identity: Identity; target: AgentPrivateTarget } | Response> {
  const identity = c.get('identity') as Identity | undefined
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  const target = await authorizeAgentPrivateArea(identity, c.req.param('agentId') ?? '')
  if (!target) return forbidden(c)
  c.set('authzChecked', true)
  return { identity, target }
}

/** Path and box-state failures as responses; anything else is rethrown. */
function failure(c: Context, error: unknown): Response {
  if (error instanceof ConfinedFsError)
    return c.json({ error: error.message, code: error.code }, CONFINED_STATUS[error.code])
  if (error instanceof AgentPrivateUnavailableError) {
    return c.json({ error: error.message, code: 'unavailable', reason: error.reason }, 409)
  }
  throw error
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8192).includes(0)
}

export const agentPrivateRouter = new Hono()
  .get('/:agentId/private/status', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const { identity, target } = auth
    const [sandbox, terminal] = await Promise.all([
      getAgentSandboxState(target),
      canAccessAgentPrivateArea(identity, target, { terminal: true }),
    ])
    const local = isAgentPrivateAreaLocal()
    return c.json({
      agentId: target.agent.id,
      agentStatus: target.agent.status,
      live: target.live,
      sandboxId: target.sandboxId,
      privateRoot: agentVisiblePrivateRoot(target),
      sandbox,
      filesAvailable: local || (target.live && sandbox.status === 'running'),
      canStart: target.live,
      canUseTerminal: terminal && target.live,
    })
  })
  .post('/:agentId/private/start', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const { identity, target } = auth
    log.info(`Start agent sandbox ${target.sandboxId} requested by ${auditActor(identity)}`)
    try {
      const outcome = await startAgentSandbox(target)
      if (!outcome.ok) return c.json({ error: outcome.message, code: 'not-started', reason: outcome.reason }, 409)
      return c.json({ ok: true })
    } catch (error) {
      const provisioning = getSandboxProvisionErrorResponse(error)
      if (provisioning) {
        if (provisioning.retryAfter) c.header('Retry-After', provisioning.retryAfter)
        return c.json(provisioning.body, provisioning.status)
      }
      log.error(`Failed to start agent sandbox ${target.sandboxId}:`, error)
      return c.json({ error: 'Failed to start sandbox' }, 500)
    }
  })
  .get('/:agentId/private/tree', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const requested = c.req.query('path') ?? ''
    try {
      const children = await listAgentPrivateDir(auth.target, requested)
      const name = requested.split('/').filter(Boolean).pop() ?? 'private'
      return c.json({ name, type: 'directory', children })
    } catch (error) {
      return failure(c, error)
    }
  })
  .get('/:agentId/private/file', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const { identity, target } = auth
    const requested = c.req.query('path')
    if (!requested) return c.json({ error: 'Path query parameter is required' }, 400)
    try {
      const file = await readAgentPrivateFile(target, requested, VIEW_MAX_BYTES)
      log.info(`Private file viewed: agent=${target.agent.id} path=${file.path} by ${auditActor(identity)}`)
      const agentPath = agentVisiblePrivatePath(target, file.path)
      if (file.truncated) {
        return c.json({
          path: file.path,
          agentPath,
          content: '',
          size: file.size,
          binary: false,
          error: 'File too large',
        })
      }
      const binary = isBinary(file.content)
      return c.json({
        path: file.path,
        agentPath,
        content: binary ? '' : file.content.toString('utf-8'),
        size: file.size,
        binary,
      })
    } catch (error) {
      return failure(c, error)
    }
  })
  .get('/:agentId/private/download', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const { identity, target } = auth
    const requested = c.req.query('path')
    if (!requested) return c.json({ error: 'Path query parameter is required' }, 400)
    try {
      const file = await readAgentPrivateFile(target, requested, DOWNLOAD_MAX_BYTES)
      if (file.truncated) return c.json({ error: 'File too large to download' }, 413)
      log.info(`Private file downloaded: agent=${target.agent.id} path=${file.path} by ${auditActor(identity)}`)
      return new Response(new Uint8Array(file.content), {
        headers: {
          // Never rendered by the browser as a page: always a download of opaque bytes.
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': downloadDisposition(file.path.split('/').pop() ?? 'download'),
          'Content-Length': String(file.content.length),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      })
    } catch (error) {
      return failure(c, error)
    }
  })
  .post('/:agentId/private/upload', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const { identity, target } = auth
    let form: FormData
    try {
      form = await readBoundedMultipart(c.req.raw, UPLOAD_MAX_BYTES + 64 * 1024)
    } catch (error) {
      if (error instanceof Error && error.message === 'ATTACHMENT_TOO_LARGE') {
        return c.json({ error: 'Upload too large' }, 413)
      }
      return c.json({ error: 'Invalid multipart body' }, 400)
    }
    const files: { file: File; relativePath: string }[] = []
    for (const [key, value] of form.entries()) {
      if (value instanceof File) {
        const relativePath = form.get(`path_${key}`)
        files.push({
          file: value,
          relativePath: typeof relativePath === 'string' && relativePath ? relativePath : value.name,
        })
      }
    }
    if (files.length === 0) return c.json({ error: 'No files provided' }, 400)

    const dir = (c.req.query('dir') ?? '').replace(/^\/+/, '')
    const overwrite = c.req.query('overwrite') === 'true'
    const results: {
      path: string
      status: 'created' | 'overwritten' | 'skipped' | 'error'
      agentPath?: string
      error?: string
    }[] = []
    for (const { file, relativePath } of files) {
      const requested = dir ? `${dir}/${relativePath}` : relativePath
      try {
        const written = await writeAgentPrivateFile(target, requested, new Uint8Array(await file.arrayBuffer()), {
          overwrite,
        })
        results.push({
          path: written.path,
          status: written.status,
          agentPath: agentVisiblePrivatePath(target, written.path),
        })
        if (written.status !== 'skipped') {
          log.info(
            `Private file ${written.status}: agent=${target.agent.id} path=${written.path} by ${auditActor(identity)}`
          )
        }
      } catch (error) {
        if (error instanceof AgentPrivateUnavailableError) return failure(c, error)
        const message =
          error instanceof ConfinedFsError
            ? error.code === 'invalid-path'
              ? 'This path cannot be written here'
              : error.message
            : 'Upload failed'
        if (!(error instanceof ConfinedFsError)) log.error(`Private upload failed for agent ${target.agent.id}:`, error)
        results.push({ path: requested, status: 'error', error: message })
      }
    }
    return c.json({ uploaded: results.filter((result) => result.status !== 'error').length, results })
  })

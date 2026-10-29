import { loadReviewContexts } from '../services/workflows/review-context'
import { deliveryInstructionsForRun } from '../services/workflows/completion-prompt'
import { decisionStepWarnings, withWarnings } from '../services/workflows/decision-step-warnings'
import { listWorkflowReviewers } from '../services/workflows/reviewers'
import { outputDeliveryHistory, outputDeliveryHistoryPage } from '../services/integrations/outputs/runtime'
import { listOpenWaits, toWaitJson } from '../services/work-streams/waits'
import { getFlowUsage } from '../services/workflows/usage'
import { Hono } from 'hono'
import { zValidator } from '../lib/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { workflowPresetSchema, workflowSourceSchema, workflowCommandSchema } from '@ficus/shared'
import { advanceFlow, finishFlow, getFlow, activeOutcomeBindings, stackNotice } from '../services/workflows/execution'
import {
  assertCanAttach,
  listWorkflowAttachments,
  readWorkflowAttachment,
  uploadWorkflowAttachment,
  workflowAttachmentMaxBytes,
  WorkflowAttachmentUnavailableError,
} from '../services/workflows/attachments'
import { downloadDisposition, readBoundedMultipart } from '../services/attachments/http'
import { WorkStream } from '../entities/WorkStream'
import { db, squads, workflows } from '../db'
import {
  authorizeWorkflow,
  authorizeWorkflowSource,
  canAccessWorkflow,
  filterAccessibleWorkflows,
} from '../services/workflows/access'
import { hasPermission, type Identity } from '../services/rbac'
import { workflowSync } from '../services/config-sync'
import {
  createWorkflow,
  deleteWorkflow,
  replaceWorkflow,
  revertWorkflow,
  resolveStoredWorkflow,
  serializeWorkflow,
  setWorkflowDisabled,
  WorkflowError,
} from '../services/workflows/catalog'

const revisionSchema = z.strictObject({ revision: z.string().min(1).max(200) })
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Multipart framing and the `path` field on top of the file's own bytes. */
const MULTIPART_OVERHEAD = 64 * 1024

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/** A display filename: the last path segment, without control characters. */
function attachmentFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(new RegExp(CONTROL_CHARACTERS, 'g'), '').trim()
  return base || 'attachment'
}

export const workflowsRouter = new Hono()
  .use('*', async (c, next) => {
    c.set('authzChecked', true)
    if (!c.get('identity')) return c.json({ error: 'Unauthorized' }, 401)
    await next()
  })
  .onError((error, c) => {
    if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status)
    if (error instanceof z.ZodError) return c.json({ error: 'Invalid workflow', issues: error.issues }, 400)
    throw error
  })
  .get('/', async (c) => {
    const rows = await db.select().from(workflows).orderBy(workflows.id)
    const visible = await filterAccessibleWorkflows(c.get('identity')!, 'workflows:read', rows)
    if (!visible.length && !(await hasPermission(c.get('identity')!, 'workflows:read')))
      return c.json({ error: 'Forbidden' }, 403)
    return c.json(visible.map(serializeWorkflow))
  })
  .get('/reviewers', zValidator('query', z.object({ squadId: z.uuid() })), async (c) => {
    const { squadId } = c.req.valid('query')
    if (!(await hasPermission(c.get('identity')!, 'workstreams:read', squadId)))
      return c.json({ error: 'Forbidden' }, 403)
    return c.json(await listWorkflowReviewers(squadId))
  })
  // `?integrationDeliveries=0` omits the delivery history for callers that never show it.
  .get(
    '/runs/:streamId',
    zValidator('query', z.object({ integrationDeliveries: z.enum(['0', '1']).optional() })),
    async (c) => {
      c.set('authzChecked', true)
      const identity = c.get('identity')
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)
      const stream = await WorkStream.find(c.req.param('streamId'))
      if (!stream) return c.json({ error: 'Work stream not found' }, 404)
      if (!(await hasPermission(identity, 'workstreams:read', stream.squadId)))
        return c.json({ error: 'Forbidden' }, 403)
      const run = await getFlow(stream.id)
      if (!run?.activated) return c.json(null)
      const withDeliveries = c.req.valid('query').integrationDeliveries !== '0'
      // Independent reads; none of them calls a provider (the history uses stored proof only).
      const [notice, openWaits, integrationDeliveries, usage, attachments, reviewContexts] = await Promise.all([
        stackNotice(db, stream),
        listOpenWaits(db, stream.id),
        withDeliveries ? outputDeliveryHistory(stream.id) : undefined,
        getFlowUsage(stream.id, run.state),
        listWorkflowAttachments(stream.id),
        loadReviewContexts(db, stream.id, run.state, { attemptAgents: run.attemptAgents, createdAt: run.createdAt }),
      ])
      return c.json({
        workStreamId: run.workStreamId,
        source: run.source.source,
        state: run.state,
        version: run.version,
        workStreamStatus: stream.status,
        attemptAgents: run.attemptAgents,
        activeOutcomes: activeOutcomeBindings(run),
        deliveryInstructions: deliveryInstructionsForRun(stream, run.state, run.version, notice),
        openWaits: openWaits.map(toWaitJson),
        ...(integrationDeliveries ? { integrationDeliveries } : {}),
        usage,
        attachments,
        reviewContexts,
      })
    }
  )
  // Anyone who can open the run (and so its review) can read the files its attempts handed off.
  .get('/runs/:streamId/attachments/:attachmentId', async (c) => {
    const stream = await WorkStream.find(c.req.param('streamId'))
    if (!stream) return c.json({ error: 'Work stream not found' }, 404)
    if (!(await hasPermission(c.get('identity')!, 'workstreams:read', stream.squadId)))
      return c.json({ error: 'Forbidden' }, 403)
    const attachmentId = c.req.param('attachmentId')
    if (!UUID_RE.test(attachmentId)) return c.json({ error: 'Attachment not found' }, 404)
    let found: Awaited<ReturnType<typeof readWorkflowAttachment>>
    try {
      found = await readWorkflowAttachment(stream.id, attachmentId.toLowerCase())
    } catch (error) {
      // Missing or digest-mismatched bytes are never served; anything else is a server fault.
      if (error instanceof WorkflowAttachmentUnavailableError) return c.json({ error: error.message }, 409)
      throw error
    }
    if (!found) return c.json({ error: 'Attachment not found' }, 404)
    return new Response(new Uint8Array(found.bytes), {
      headers: {
        'Content-Type': found.attachment.contentType,
        'Content-Disposition': downloadDisposition(found.attachment.filename),
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })
  // Agents attach handoff files before completing the attempt, so the next gate opens with them.
  .post('/runs/:streamId/attempts/:attemptId/attachments', async (c) => {
    const identity = c.get('identity')!
    const attemptId = Number(c.req.param('attemptId'))
    if (!Number.isSafeInteger(attemptId) || attemptId < 1) return c.json({ error: 'Invalid attempt id' }, 400)
    const stream = await WorkStream.find(c.req.param('streamId'))
    if (!stream) return c.json({ error: 'Work stream not found' }, 404)
    // Refuse before buffering the body; the upload re-checks under the flow locks.
    assertCanAttach(stream, (await getFlow(stream.id)) ?? undefined, attemptId, identity)
    const maxBytes = workflowAttachmentMaxBytes()
    if (Number(c.req.header('content-length') ?? 0) > maxBytes + MULTIPART_OVERHEAD)
      return c.json({ error: 'ATTACHMENT_TOO_LARGE' }, 413)
    let form: FormData
    try {
      form = await readBoundedMultipart(c.req.raw, maxBytes + MULTIPART_OVERHEAD)
    } catch (error) {
      if (error instanceof Error && error.message === 'ATTACHMENT_TOO_LARGE')
        return c.json({ error: 'ATTACHMENT_TOO_LARGE' }, 413)
      return c.json({ error: 'Invalid multipart body' }, 400)
    }
    if ([...form.keys()].some((key) => key !== 'file' && key !== 'path'))
      return c.json({ error: 'Invalid multipart fields' }, 400)
    const files = form.getAll('file')
    const paths = form.getAll('path')
    const file = files[0]
    if (files.length !== 1 || !(file instanceof File) || paths.length > 1 || (paths[0] && typeof paths[0] !== 'string'))
      return c.json({ error: 'Exactly one file and at most one path are required' }, 400)
    const filename = attachmentFilename(file.name)
    const given = typeof paths[0] === 'string' ? paths[0] : ''
    // The path is shown to reviewers and keys retries, so it is kept as given rather than cleaned up.
    if (CONTROL_CHARACTERS.test(given)) return c.json({ error: 'Attachment path contains control characters' }, 400)
    const path = given.trim() || filename
    if (filename.length > 255 || path.length > 1024) return c.json({ error: 'Attachment name is too long' }, 400)
    const { attachment, created } = await uploadWorkflowAttachment({
      workStreamId: stream.id,
      squadId: stream.squadId,
      attemptId,
      identity,
      filename,
      path,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })
    return c.json(attachment, created ? 201 : 200)
  })
  .get(
    '/runs/:streamId/integration-deliveries',
    zValidator('query', z.object({ cursor: z.string().max(400).optional() })),
    async (c) => {
      const stream = await WorkStream.find(c.req.param('streamId'))
      if (!stream) return c.json({ error: 'Work stream not found' }, 404)
      if (!(await hasPermission(c.get('identity')!, 'workstreams:read', stream.squadId)))
        return c.json({ error: 'Forbidden' }, 403)
      try {
        // GitHub-only pages complement the compatibility preview in the run response.
        return c.json(await outputDeliveryHistoryPage(stream.id, c.req.valid('query')))
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_output_history_cursor')
          return c.json({ error: 'Invalid history cursor' }, 400)
        throw error
      }
    }
  )
  .post(
    '/runs/:streamId/advance',
    zValidator('json', z.strictObject({ requestId: z.uuid(), command: workflowCommandSchema })),
    async (c) => {
      c.set('authzChecked', true)
      const identity = c.get('identity')
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)
      const stream = await WorkStream.find(c.req.param('streamId'))
      if (!stream) return c.json({ error: 'Work stream not found' }, 404)
      const { command, requestId } = c.req.valid('json')
      const result = await advanceFlow(stream.id, command, requestId, identity)
      if (result.stateStatus === 'completion-ready') {
        const current = await getFlow(stream.id)
        const currentStream = await WorkStream.mustFind(stream.id)
        if (current && current.version === result.version) {
          const deliveryInstructions = deliveryInstructionsForRun(
            currentStream,
            current.state,
            current.version,
            await stackNotice(db, currentStream)
          )
          if (deliveryInstructions && current.state.definition.completion.mode === 'deliverable') {
            try {
              const finished = await finishFlow(stream.id, result.version, identity)
              return c.json({ ...result, workStreamStatus: finished.status })
            } catch (error) {
              if (error instanceof WorkflowError)
                return c.json({ ...result, completionPending: error.message, deliveryInstructions })
              throw error
            }
          }
          return c.json({ ...result, workStreamStatus: currentStream.status, deliveryInstructions })
        }
      }
      return c.json(result)
    }
  )
  .post('/runs/:streamId/finish', zValidator('json', z.strictObject({ version: z.int().nonnegative() })), async (c) => {
    c.set('authzChecked', true)
    const identity = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const stream = await WorkStream.find(c.req.param('streamId'))
    if (!stream) return c.json({ error: 'Work stream not found' }, 404)
    return c.json(await finishFlow(stream.id, c.req.valid('json').version, identity))
  })
  .post(
    '/parse',
    zValidator('json', z.strictObject({ squadId: z.uuid(), text: z.string().max(256000) })),
    async (c) => {
      c.set('authzChecked', true)
      const identity = c.get('identity')
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)
      const { squadId, text } = c.req.valid('json')
      if (
        !(await hasPermission(identity, 'workstreams:create', squadId)) &&
        !(await hasPermission(identity, 'squads:update', squadId))
      )
        return c.json({ error: 'Forbidden' }, 403)
      let definition: unknown
      try {
        definition = Bun.YAML.parse(text)
      } catch {
        return c.json({ error: 'Invalid YAML or JSON' }, 400)
      }
      return c.json((await resolveStoredWorkflow({ kind: 'inline', definition })).definition)
    }
  )
  .post(
    '/resolve',
    async (c, next) => {
      if (!c.get('identity')) return c.json({ error: 'Unauthorized' }, 401)
      return next()
    },
    zValidator('json', z.strictObject({ squadId: z.uuid(), source: workflowSourceSchema })),
    async (c) => {
      const identity: Identity | undefined = c.get('identity')
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)
      c.set('authzChecked', true)
      const { squadId, source } = c.req.valid('json')
      if (!(await hasPermission(identity, 'workstreams:create', squadId))) return c.json({ error: 'Forbidden' }, 403)
      await authorizeWorkflowSource(identity, source, squadId)
      const [squad] = await db.select({ id: squads.id }).from(squads).where(eq(squads.id, squadId))
      if (!squad) return c.json({ error: 'Squad not found' }, 404)
      // Preview only: no work stream, catalog record, or agent is created.
      const resolved = await resolveStoredWorkflow(source)
      return c.json({ ...resolved, ...withWarnings(decisionStepWarnings(resolved.definition)) })
    }
  )
  .get(
    '/:id',
    async (c, next) => {
      await authorizeWorkflow(c.get('identity')!, 'workflows:read', c.req.param('id'))
      await next()
    },
    async (c) => {
      const [row] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, c.req.param('id')))
      return row ? c.json(serializeWorkflow(row)) : c.json({ error: 'Workflow not found' }, 404)
    }
  )
  .post('/', zValidator('json', workflowPresetSchema), async (c) => {
    const preset = c.req.valid('json')
    if (!(await canAccessWorkflow(c.get('identity')!, 'workflows:create', preset.scope)))
      return c.json({ error: 'Forbidden' }, 403)
    return c.json(
      { ...serializeWorkflow(await createWorkflow(preset)), ...withWarnings(decisionStepWarnings(preset.definition)) },
      201
    )
  })
  .put(
    '/:id',
    async (c, next) => {
      await authorizeWorkflow(c.get('identity')!, 'workflows:update', c.req.param('id'))
      await next()
    },
    zValidator('json', z.strictObject({ revision: z.string().min(1).max(200), preset: workflowPresetSchema })),
    async (c) => {
      const { revision, preset } = c.req.valid('json')
      return c.json({
        ...serializeWorkflow(await replaceWorkflow(c.req.param('id'), revision, preset)),
        ...withWarnings(decisionStepWarnings(preset.definition)),
      })
    }
  )
  .delete(
    '/:id',
    async (c, next) => {
      await authorizeWorkflow(c.get('identity')!, 'workflows:delete', c.req.param('id'))
      await next()
    },
    zValidator('json', revisionSchema),
    async (c) => {
      await deleteWorkflow(c.req.param('id'), c.req.valid('json').revision)
      return c.json({ ok: true })
    }
  )
  .post(
    '/:id/disabled',
    async (c, next) => {
      await authorizeWorkflow(c.get('identity')!, 'workflows:update', c.req.param('id'))
      await next()
    },
    zValidator('json', z.strictObject({ revision: z.string().min(1).max(200), disabled: z.boolean() })),
    async (c) => {
      const { revision, disabled } = c.req.valid('json')
      return c.json(serializeWorkflow(await setWorkflowDisabled(c.req.param('id'), revision, disabled)))
    }
  )
  .get(
    '/:id/export',
    async (c, next) => {
      await authorizeWorkflow(c.get('identity')!, 'workflows:read', c.req.param('id'))
      await next()
    },
    async (c) => {
      const [row] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, c.req.param('id')))
      if (!row) return c.json({ error: 'Workflow not found' }, 404)
      return c.text(workflowSync.toYaml(row), 200, { 'Content-Type': 'text/yaml' })
    }
  )
  .post(
    '/:id/revert',
    async (c, next) => {
      await authorizeWorkflow(c.get('identity')!, 'workflows:update', c.req.param('id'))
      await next()
    },
    zValidator('json', revisionSchema),
    async (c) => c.json(serializeWorkflow(await revertWorkflow(c.req.param('id'), c.req.valid('json').revision)))
  )
  .get(
    '/:id/template-diff',
    async (c, next) => {
      await authorizeWorkflow(c.get('identity')!, 'workflows:read', c.req.param('id'))
      await next()
    },
    async (c) => {
      const [row] = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(eq(workflows.id, c.req.param('id')))
      if (!row) return c.json({ error: 'Workflow not found' }, 404)
      return c.json(await workflowSync.getTemplateDiff(row.id))
    }
  )

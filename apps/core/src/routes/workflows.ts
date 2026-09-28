import { deliveryInstructionsForRun } from '../services/workflows/completion-prompt'
import { listWorkflowReviewers } from '../services/workflows/reviewers'
import { outputDeliveryHistory } from '../services/integrations/outputs/runtime'
import { listOpenWaits, toWaitJson } from '../services/work-streams/waits'
import { getFlowUsage } from '../services/workflows/usage'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { workflowPresetSchema, workflowSourceSchema, workflowCommandSchema } from '@ficus/shared'
import { advanceFlow, finishFlow, getFlow } from '../services/workflows/execution'
import { WorkStream } from '../entities/WorkStream'
import { db, squads, workflows } from '../db'
import { authorizeWorkflow, authorizeWorkflowSource, canAccessWorkflow } from '../services/workflows/access'
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

const revisionSchema = z.object({ revision: z.string().min(1).max(200) }).strict()

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
    const visible = []
    for (const row of rows)
      if (await canAccessWorkflow(c.get('identity')!, 'workflows:read', row.scope)) visible.push(row)
    if (!visible.length && !(await hasPermission(c.get('identity')!, 'workflows:read')))
      return c.json({ error: 'Forbidden' }, 403)
    return c.json(visible.map(serializeWorkflow))
  })
  .get('/reviewers', zValidator('query', z.object({ squadId: z.string().uuid() })), async (c) => {
    const { squadId } = c.req.valid('query')
    if (!(await hasPermission(c.get('identity')!, 'workstreams:read', squadId)))
      return c.json({ error: 'Forbidden' }, 403)
    return c.json(await listWorkflowReviewers(squadId))
  })
  .get('/runs/:streamId', async (c) => {
    c.set('authzChecked', true)
    const identity = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const stream = await WorkStream.find(c.req.param('streamId'))
    if (!stream) return c.json({ error: 'Work stream not found' }, 404)
    if (!(await hasPermission(identity, 'workstreams:read', stream.squadId))) return c.json({ error: 'Forbidden' }, 403)
    const run = await getFlow(stream.id)
    return c.json(
      run?.activated
        ? {
            workStreamId: run.workStreamId,
            source: run.source.source,
            state: run.state,
            version: run.version,
            workStreamStatus: stream.status,
            attemptAgents: run.attemptAgents,
            deliveryInstructions: deliveryInstructionsForRun(stream, run.state, run.version),
            openWaits: (await listOpenWaits(db, stream.id)).map(toWaitJson),
            integrationDeliveries: await outputDeliveryHistory(stream.id),
            usage: await getFlowUsage(stream.id, run.state),
          }
        : null
    )
  })
  .post(
    '/runs/:streamId/advance',
    zValidator('json', z.object({ requestId: z.string().uuid(), command: workflowCommandSchema }).strict()),
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
          const deliveryInstructions = deliveryInstructionsForRun(currentStream, current.state, current.version)
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
  .post(
    '/runs/:streamId/finish',
    zValidator('json', z.object({ version: z.number().int().nonnegative() }).strict()),
    async (c) => {
      c.set('authzChecked', true)
      const identity = c.get('identity')
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)
      const stream = await WorkStream.find(c.req.param('streamId'))
      if (!stream) return c.json({ error: 'Work stream not found' }, 404)
      return c.json(await finishFlow(stream.id, c.req.valid('json').version, identity))
    }
  )
  .post(
    '/parse',
    zValidator('json', z.object({ squadId: z.string().uuid(), text: z.string().max(256000) }).strict()),
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
    zValidator('json', z.object({ squadId: z.string().uuid(), source: workflowSourceSchema }).strict()),
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
      return c.json(await resolveStoredWorkflow(source))
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
    return c.json(serializeWorkflow(await createWorkflow(preset)), 201)
  })
  .put(
    '/:id',
    async (c, next) => {
      await authorizeWorkflow(c.get('identity')!, 'workflows:update', c.req.param('id'))
      await next()
    },
    zValidator('json', z.object({ revision: z.string().min(1).max(200), preset: workflowPresetSchema }).strict()),
    async (c) => {
      const { revision, preset } = c.req.valid('json')
      return c.json(serializeWorkflow(await replaceWorkflow(c.req.param('id'), revision, preset)))
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
    zValidator('json', z.object({ revision: z.string().min(1).max(200), disabled: z.boolean() }).strict()),
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

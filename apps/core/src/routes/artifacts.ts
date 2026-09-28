import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import {
  artifactReferenceSchema,
  artifactRequestActionSchema,
  type ArtifactRequestAction,
  type ArtifactReference,
} from '@ficus/shared'
import { z } from 'zod'
import { artifactVoiceRequestService } from '../services/artifacts/artifactVoiceRequests'
import { Agent } from '../entities/Agent'
import { requirePermission, requireEntityPermission } from '../middleware'
import { getAccessibleSquadIds, hasPermission } from '../services/rbac'
import type { Identity } from '../services/rbac'
import type { Context } from 'hono'

type ArtifactVoiceRequestService = typeof artifactVoiceRequestService

const trimmedString = z.string().transform((value) => value.trim())
const nonEmptyTrimmedString = trimmedString.pipe(z.string().min(1))

const listArtifactsQuerySchema = z.object({
  query: trimmedString.optional(),
  includeArchived: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
})

const artifactFilePathSchema = nonEmptyTrimmedString

const readArtifactFileQuerySchema = z.object({
  path: artifactFilePathSchema,
  unit: z.enum(['lines', 'bytes']).optional(),
  offset: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
})

const artifactFileTextEditSchema = z.object({
  oldText: z.string().min(1),
  newText: z.string(),
})

const editArtifactFileSchema = z
  .object({
    path: artifactFilePathSchema,
    oldText: z.string().min(1).optional(),
    newText: z.string().optional(),
    edits: z.array(artifactFileTextEditSchema).min(1).max(20).optional(),
    changeSummary: nonEmptyTrimmedString,
  })
  .refine((input) => input.edits !== undefined || input.oldText !== undefined, {
    message: 'oldText or edits is required',
    path: ['oldText'],
  })
const requestArtifactSchema = z
  .object({
    action: artifactRequestActionSchema,
    title: nonEmptyTrimmedString.optional(),
    agentId: nonEmptyTrimmedString.optional(),
    artifactId: nonEmptyTrimmedString.optional(),
    brief: nonEmptyTrimmedString,
    references: z.array(artifactReferenceSchema).optional(),
    displayModeHint: nonEmptyTrimmedString.optional(),
    answers: z
      .array(
        z.object({
          questionId: nonEmptyTrimmedString,
          answer: nonEmptyTrimmedString,
        })
      )
      .optional(),
  })
  .refine((input) => input.action === 'continue' || input.answers === undefined, {
    message: 'answers are only supported for continue artifact requests',
    path: ['answers'],
  })

/**
 * Resolve the squadId for an artifact-builder agent by agentId.
 * Returns null when:
 * - The agent does not exist (fail closed: requireEntityPermission does unscoped check).
 * - The agent has no squad (system-level/artifact-builder agent with no squad).
 */
async function artifactAgentSquadId(c: Context): Promise<string | null> {
  const agentId = c.req.param('agentId')
  const agent = await Agent.find(agentId)
  return agent?.squadId ?? null
}

export function createArtifactsRouter(service: ArtifactVoiceRequestService = artifactVoiceRequestService) {
  return new Hono()
    .get('/', zValidator('query', listArtifactsQuerySchema), async (c) => {
      // filtered-list: check identity, then filter results to accessible squads
      const identity: Identity | undefined = c.get('identity')
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)

      // Check if the caller has any accessible squads at all.
      // Fail closed: no accessible squads → 403.
      const accessible = await getAccessibleSquadIds(identity)
      if (accessible !== 'all' && accessible.length === 0) {
        return c.json({ error: 'Forbidden' }, 403)
      }

      c.set('authzChecked', true)

      try {
        const query = c.req.valid('query')
        const artifacts = await service.listArtifacts(query)

        // Admin short-circuit: return all artifacts unfiltered.
        if (accessible === 'all') {
          return c.json(artifacts)
        }

        // Two-pass: resolve each unique agentId → squadId, then filter.
        const uniqueAgentIds = [...new Set(artifacts.map((a) => (a as { agentId: string }).agentId))]
        const agentSquadMap = new Map<string, string | null>()
        for (const agentId of uniqueAgentIds) {
          const agent = await Agent.find(agentId)
          agentSquadMap.set(agentId, agent?.squadId ?? null)
        }

        const accessibleSet = new Set(accessible)
        const filtered = artifacts.filter((a) => {
          const squadId = agentSquadMap.get((a as { agentId: string }).agentId)
          // Fail closed: exclude artifacts whose agent has no squad or unknown squad.
          return squadId !== null && squadId !== undefined && accessibleSet.has(squadId)
        })

        return c.json(filtered)
      } catch (error) {
        return routeError(c, error)
      }
    })
    .get(
      '/:agentId/:artifactId/context',
      requireEntityPermission('artifacts:read', artifactAgentSquadId),
      async (c) => {
        try {
          const context = await service.getArtifactContext(c.req.param('agentId'), c.req.param('artifactId'))
          return c.json(redactArtifactPath(context))
        } catch (error) {
          return routeError(c, error)
        }
      }
    )
    .get('/:agentId/:artifactId/files', requireEntityPermission('artifacts:read', artifactAgentSquadId), async (c) => {
      try {
        const result = await service.listArtifactFiles(c.req.param('agentId'), c.req.param('artifactId'))
        return c.json(result)
      } catch (error) {
        return routeError(c, error)
      }
    })
    .get(
      '/:agentId/:artifactId/file',
      requireEntityPermission('artifacts:read', artifactAgentSquadId),
      zValidator('query', readArtifactFileQuerySchema),
      async (c) => {
        try {
          const query = c.req.valid('query')
          const result = await service.readArtifactFile({
            agentId: c.req.param('agentId'),
            artifactId: c.req.param('artifactId'),
            path: query.path,
            unit: query.unit,
            offset: query.offset,
            limit: query.limit,
          })
          return c.json(result)
        } catch (error) {
          return routeError(c, error)
        }
      }
    )
    .patch(
      '/:agentId/:artifactId/file',
      requireEntityPermission('artifacts:write', artifactAgentSquadId),
      zValidator('json', editArtifactFileSchema),
      async (c) => {
        try {
          const input = c.req.valid('json')
          const result = await service.editArtifactFile({
            agentId: c.req.param('agentId'),
            artifactId: c.req.param('artifactId'),
            path: input.path,
            oldText: input.oldText,
            newText: input.newText,
            edits: input.edits,
            changeSummary: input.changeSummary,
          })
          return c.json(result)
        } catch (error) {
          return routeError(c, error)
        }
      }
    )
    .post('/prewarm', requirePermission('artifacts:write'), async (c) => {
      try {
        const result = await service.prewarmArtifactBuilder()
        return c.json(result)
      } catch (error) {
        return routeError(c, error)
      }
    })
    .post('/request', zValidator('json', requestArtifactSchema), async (c) => {
      const input = c.req.valid('json') as {
        action: ArtifactRequestAction
        title?: string
        agentId?: string
        artifactId?: string
        brief: string
        references?: ArtifactReference[]
        displayModeHint?: string
        answers?: Array<{ questionId: string; answer: string }>
      }

      // continue/fork target an existing builder agent — scope artifacts:write to
      // that agent's squad (ROOT gates agents to their accessible squads). A bare
      // create has no target agent yet, so it stays an unscoped capability check.
      const identity = c.get('identity') as Identity | undefined
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)
      c.set('authzChecked', true)
      let reqSquadId: string | null = null
      if (input.agentId) {
        const targetAgent = await Agent.find(input.agentId)
        reqSquadId = targetAgent?.squadId ?? null
      }
      const writeAllowed = reqSquadId
        ? await hasPermission(identity, 'artifacts:write', reqSquadId)
        : await hasPermission(identity, 'artifacts:write')
      if (!writeAllowed) return c.json({ error: 'Forbidden' }, 403)

      try {
        const result = await service.requestArtifact(input)
        return c.json(redactArtifactPath(result), input.action === 'create' ? 201 : 200)
      } catch (error) {
        if (input.action === 'fork' && error instanceof Error && error.message.includes('not implemented')) {
          return c.json({ error: error.message }, 501)
        }
        return routeError(c, error)
      }
    })
}

export const artifactsRouter = createArtifactsRouter()

function redactArtifactPath<T extends { artifactPath?: string }>(value: T): Omit<T, 'artifactPath'> {
  const { artifactPath: _artifactPath, ...rest } = value
  return rest
}

function routeError(
  c: { json: (body: { error: string }, status: 400 | 404 | 500) => Response },
  error: unknown
): Response {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Artifact question not found')) {
    return c.json({ error: message }, 400)
  }
  if (message.includes('not found') || message.includes('not an artifact builder')) {
    return c.json({ error: message }, 404)
  }
  if (
    message.includes('required') ||
    message.includes('Invalid') ||
    message.includes('Duplicate') ||
    message.includes('answers') ||
    message.includes('oldText') ||
    message.includes('path is required') ||
    message.includes('Artifact has no published entry') ||
    message.includes('metadata files') ||
    message.includes('exceeds')
  ) {
    return c.json({ error: message }, 400)
  }
  console.error('Artifact route failed', error)
  return c.json({ error: 'Internal server error' }, 500)
}

import { workStreamRef } from '@ficus/shared'
import { resolveVoiceSquadId } from '../squadReferences'
import { getActiveExecution, getAgent } from '../../api/agents'
import {
  getWorkStream,
  listActiveWorkStreams,
  listDoneWorkStreams,
  listSquadAgents,
  listSquads,
} from '../../api/squads'
import { selectWorkStreamPresentationState, type WorkStream } from '@ficus/shared'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

export function voiceWorkStreamStatus(workStream: WorkStream) {
  return selectWorkStreamPresentationState(workStream)
}

const FINISHED = new Set(['done', 'canceled'])

/** Finished work per page with includeFinished: newest completions first, paged by finishedCursor. */
export const VOICE_FINISHED_LIMIT = 50

function summarize(workStream: WorkStream) {
  return {
    id: workStreamRef(workStream),
    number: workStream.number,
    title: workStream.title,
    status: voiceWorkStreamStatus(workStream),
    squadId: workStream.squadId,
  }
}

export function createStatusTools(deps: {
  getAgent: typeof getAgent
  getActiveExecution: typeof getActiveExecution
  listSquads: typeof listSquads
  listActiveWorkStreams: typeof listActiveWorkStreams
  listDoneWorkStreams: typeof listDoneWorkStreams
  listSquadAgents: typeof listSquadAgents
  getWorkStream: typeof getWorkStream
}) {
  const getWorkTool: VoiceAssistantTool<VoiceToolExecutor> = {
    definition: {
      type: 'function',
      name: 'get_work',
      description:
        'Read live work. With no arguments: active work streams across every accessible squad. With squadId: that squad’s agents (with status) and its work streams. With workStreamId: one work stream in full (description, status, assignments, waits). The squads themselves are already listed in your instructions.',
      parameters: {
        type: 'object',
        properties: {
          squadId: { type: 'string', description: 'Full squad ID or URL slug. Not with workStreamId.' },
          workStreamId: {
            type: 'string',
            description: 'Work number (42 or #42), UUID, or unique UUID prefix. Not with squadId.',
          },
          includeFinished: {
            type: 'boolean',
            description: `Also list done and canceled work, ${VOICE_FINISHED_LIMIT} per page, newest first, with finished.totalCount. Default false.`,
          },
          finishedCursor: {
            type: 'string',
            description: 'A finished.nextCursor: the next finished page for the same squadId.',
          },
        },
      },
    },
    async execute(args) {
      const { squadId, workStreamId, finishedCursor } = args as {
        squadId?: string
        workStreamId?: string
        includeFinished?: boolean
        finishedCursor?: string
      }
      const includeFinished = Boolean((args as { includeFinished?: boolean }).includeFinished || finishedCursor)
      const keep = (workStream: WorkStream) => includeFinished || !FINISHED.has(voiceWorkStreamStatus(workStream))
      // Open work, plus finished work a page at a time on request: the unfiltered list is every
      // stream a squad ever had and is the heaviest read Core serves. A cursor asks for only the
      // next finished page; the open work came with the first one.
      const listWork = async (squad?: string) => {
        const [open, finished] = await Promise.all([
          finishedCursor ? [] : deps.listActiveWorkStreams(squad),
          includeFinished
            ? deps.listDoneWorkStreams({
                squadId: squad,
                limit: VOICE_FINISHED_LIMIT,
                omitDescription: true,
                cursor: finishedCursor,
              })
            : undefined,
        ])
        return {
          workStreams: [...open, ...(finished?.items ?? [])].filter(keep).map(summarize),
          ...(finished
            ? {
                finished: {
                  totalCount: finished.totalCount,
                  nextCursor: finished.hasMore ? finished.nextCursor : null,
                },
              }
            : {}),
        }
      }
      if (squadId && workStreamId) return { error: 'Pass squadId or workStreamId, not both' }
      if (finishedCursor && workStreamId) return { error: 'finishedCursor pages a list, not one work stream' }
      if (workStreamId) {
        const id = workStreamId.replace(/^work:/, '')
        return { workStream: await deps.getWorkStream(id) }
      }
      if (squadId) {
        const resolved = resolveVoiceSquadId(squadId, await deps.listSquads())
        if (!resolved)
          return {
            error: `Unknown or ambiguous squad reference: ${squadId}. Use a full squad ID from your instructions.`,
          }
        if (finishedCursor) return listWork(resolved)
        const [agents, work] = await Promise.all([deps.listSquadAgents(resolved), listWork(resolved)])
        return {
          agents: agents.map((agent) => ({
            id: agent.id,
            type: agent.agentTypeId,
            status: agent.status,
            name: agent.metadata?.name,
          })),
          ...work,
        }
      }
      return listWork()
    },
  }
  return { getWorkTool, statusTools: [getWorkTool] }
}

export const { getWorkTool, statusTools } = createStatusTools({
  getAgent,
  getActiveExecution,
  listSquads,
  listActiveWorkStreams,
  listDoneWorkStreams,
  listSquadAgents,
  getWorkStream,
})

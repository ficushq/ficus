import { workStreamRef } from '@ficus/shared'
import { resolveVoiceSquadId } from '../squadReferences'
import { getActiveExecution, getAgent } from '../../api/agents'
import { getWorkStream, listAllWorkStreams, listSquadAgents, listSquads, listWorkStreams } from '../../api/squads'
import { selectWorkStreamPresentationState, type WorkStream } from '@ficus/shared'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

export function voiceWorkStreamStatus(workStream: WorkStream) {
  return selectWorkStreamPresentationState(workStream)
}

const FINISHED = new Set(['done', 'canceled'])

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
  listAllWorkStreams: typeof listAllWorkStreams
  listSquadAgents: typeof listSquadAgents
  listWorkStreams: typeof listWorkStreams
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
            description: 'Include done and canceled work in list results. Default false.',
          },
        },
      },
    },
    async execute(args) {
      const { squadId, workStreamId, includeFinished } = args as {
        squadId?: string
        workStreamId?: string
        includeFinished?: boolean
      }
      const keep = (workStream: WorkStream) => includeFinished || !FINISHED.has(voiceWorkStreamStatus(workStream))
      if (squadId && workStreamId) return { error: 'Pass squadId or workStreamId, not both' }
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
        const [agents, streams] = await Promise.all([deps.listSquadAgents(resolved), deps.listWorkStreams(resolved)])
        return {
          agents: agents.map((agent) => ({
            id: agent.id,
            type: agent.agentTypeId,
            status: agent.status,
            name: agent.metadata?.name,
          })),
          workStreams: streams.filter(keep).map(summarize),
        }
      }
      const streams = await deps.listAllWorkStreams()
      return { workStreams: streams.filter(keep).map(summarize) }
    },
  }
  return { getWorkTool, statusTools: [getWorkTool] }
}

export const { getWorkTool, statusTools } = createStatusTools({
  getAgent,
  getActiveExecution,
  listSquads,
  listAllWorkStreams,
  listSquadAgents,
  listWorkStreams,
  getWorkStream,
})

import { resolveCreationWorkflow } from '../workflows/creation-source'
import type { ScheduleAction, ScheduleScopeType } from '@ficus/shared'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { ScheduleExecutionError } from './failure-classifier'

function permanent(
  code:
    | 'scope_not_found'
    | 'scope_invalid'
    | 'target_agent_not_found'
    | 'target_agent_terminated'
    | 'squad_manager_missing'
    | 'squad_manager_terminated'
    | 'invalid_action_reference',
  summary: string
): never {
  throw new ScheduleExecutionError(code, 'permanent', summary)
}

async function requireTargetAgent(agentId: string): Promise<Agent> {
  const agent = await Agent.find(agentId)
  if (!agent) permanent('target_agent_not_found', 'Target agent does not exist.')
  if (agent.status === 'terminated') permanent('target_agent_terminated', 'Target agent is terminated.')
  return agent
}

/** Resolve the live schedule scope and validate every reference used by its action. */
export async function validateScheduleReferences(input: {
  scopeType: ScheduleScopeType
  scopeId: string
  action: ScheduleAction
}): Promise<{ squadId: string }> {
  let squad: Squad
  if (input.scopeType === 'squad') {
    const found = await Squad.find(input.scopeId)
    if (!found) permanent('scope_not_found', 'Schedule scope does not exist.')
    if (found.archivedAt) permanent('scope_invalid', 'Schedule scope is archived.')
    squad = found
  } else if (input.scopeType === 'agent') {
    const agent = await Agent.find(input.scopeId)
    if (!agent) permanent('scope_not_found', 'Schedule scope does not exist.')
    if (agent.status === 'terminated' || !agent.squadId)
      permanent('scope_invalid', 'Schedule agent scope is not active.')
    const found = await Squad.find(agent.squadId)
    if (!found) permanent('scope_not_found', 'Schedule scope squad does not exist.')
    if (found.archivedAt) permanent('scope_invalid', 'Schedule scope squad is archived.')
    squad = found
  } else {
    permanent('scope_invalid', 'Schedule scope type is invalid.')
  }

  switch (input.action.type) {
    case 'inbox_message': {
      if (input.action.target.type === 'agent') {
        await requireTargetAgent(input.action.target.agentId)
      } else {
        if (!squad.managerAgentId) permanent('squad_manager_missing', 'Schedule scope has no manager.')
        const manager = await Agent.find(squad.managerAgentId)
        if (!manager) permanent('squad_manager_missing', 'Schedule scope manager does not exist.')
        if (manager.status === 'terminated')
          permanent('squad_manager_terminated', 'Schedule scope manager is terminated.')
      }
      break
    }
    case 'spawn_agent': {
      if (input.action.workStream)
        permanent(
          'invalid_action_reference',
          'Use create_work_stream with a workflow instead of spawn_agent.workStream.'
        )
      if (!(await AgentType.find(input.action.agentTypeId))) {
        permanent('invalid_action_reference', 'Scheduled action references an unknown agent type.')
      }
      break
    }
    case 'create_work_stream': {
      if (
        input.action.agentTypes !== undefined ||
        input.action.agentIds !== undefined ||
        input.action.assigneeAgentId !== undefined ||
        input.action.assigneeAgentIndex !== undefined ||
        input.action.completionMode !== undefined
      )
        permanent(
          'invalid_action_reference',
          'Legacy work-stream creation is no longer supported; configure a workflow.'
        )
      const source = await resolveCreationWorkflow(input.action.workflow, squad)
      const { workflowSourceSchema } = await import('@ficus/shared')
      const { checkWorkflowScope } = await import('../workflows/access')
      const { resolveStoredWorkflow } = await import('../workflows/catalog')
      try {
        const parsed = workflowSourceSchema.parse(source)
        await checkWorkflowScope(parsed, squad.id, null)
        await resolveStoredWorkflow(parsed)
      } catch {
        permanent('invalid_action_reference', 'Scheduled workflow is invalid, disabled, or outside the squad scope.')
      }
      break
    }
  }

  return { squadId: squad.id }
}

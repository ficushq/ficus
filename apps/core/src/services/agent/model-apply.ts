import type { AgentModelApplyResult } from '@ficus/shared'
import { setAgentSelectedModel, type Agent } from '../../entities/Agent'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { AgentModelResolutionError } from '../model-selection/agent-model-resolution'
import { ModelSelectionError } from '../model-selection/select-model'

/** A refusal with the HTTP status the route returns. */
export class AgentModelApplyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409
  ) {
    super(message)
    this.name = 'AgentModelApplyError'
  }
}

const BUSY_STATUSES = new Set(['compacting', 'resetting', 'terminated'])

/**
 * Make the agent's configured model take effect now instead of from its next turn.
 *
 * A running turn switches its live session in place, context preserved, through the owning
 * worker's failover coordinator: the turn uses the new model from its next model call, and Pi
 * compacts before that call when the context is over the new model's threshold. Without a running
 * turn, the agent's selected model is updated so its next session starts on it.
 */
export async function applyAgentModelNow(
  agent: Agent,
  options: { ackTimeoutMs?: number } = {}
): Promise<AgentModelApplyResult> {
  if (BUSY_STATUSES.has(agent.status))
    throw new AgentModelApplyError(`Agent is ${agent.status}; switch its model when it finishes`, 409)

  let chain: string
  try {
    chain = await agent.getEffectiveModelSpec()
  } catch (error) {
    if (error instanceof AgentModelResolutionError) throw new AgentModelApplyError(error.message, 400)
    throw error
  }

  const execution = await agent.getActiveExecution()
  if (execution?.status === 'stopping')
    throw new AgentModelApplyError('Agent is stopping; switch its model when it finishes', 409)
  if (execution?.status === 'running') return applyToRunningTurn(agent, execution.id, options.ackTimeoutMs ?? 10_000)
  return applyToNextSession(agent, chain)
}

async function applyToNextSession(agent: Agent, chain: string): Promise<AgentModelApplyResult> {
  const previous = agent.selectedModel ?? undefined
  if (!previous)
    return { code: 'pending', message: 'The agent has not selected a model yet; its next turn uses the new one.' }
  const { primeClaudeCodeStatus } = await import('./claude-code/availability')
  await primeClaudeCodeStatus()
  const { selectModelSpecForCurrentEnvWithSwitchBack } = await import('../model-selection')
  let selected: string
  try {
    ;({ selected } = selectModelSpecForCurrentEnvWithSwitchBack(chain, previous))
  } catch (error) {
    if (error instanceof ModelSelectionError) throw new AgentModelApplyError(error.message, 400)
    throw error
  }
  if (selected === previous)
    return { code: 'unchanged', selectedModel: selected, message: `The agent already uses ${selected}.` }
  await setAgentSelectedModel(agent.id, selected)
  eventEmitter.emit('agent.updated', { agentId: agent.id, squadId: agent.squadId })
  return {
    code: 'switched',
    selectedModel: selected,
    previousModel: previous,
    message: `Switched to ${selected}; the agent's next turn starts on it.`,
  }
}

async function applyToRunningTurn(
  agent: Agent,
  executionId: string,
  ackTimeoutMs: number
): Promise<AgentModelApplyResult> {
  const requestId = crypto.randomUUID()
  const expiresAt = Date.now() + ackTimeoutMs
  const pending: AgentModelApplyResult = {
    code: 'pending',
    message: "The running turn did not confirm the switch; the new model applies from the agent's next turn.",
  }
  let unsubscribe = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const ack = new Promise<AgentModelApplyResult>((resolve, reject) => {
    timer = setTimeout(() => resolve(pending), ackTimeoutMs)
    unsubscribe = eventEmitter.on('agent.model-applied', (data) => {
      if (data.agentId !== agent.id || data.requestId !== requestId || data.executionId !== executionId) return
      if (data.code === 'error') {
        reject(new AgentModelApplyError(data.error ?? 'Could not switch the running turn', 400))
        return
      }
      if (data.code === 'no_session') {
        resolve({ code: 'pending', message: "The agent's session is starting; it uses the new model." })
        return
      }
      resolve(
        data.code === 'switched'
          ? {
              code: 'switched',
              selectedModel: data.selectedModel,
              previousModel: data.previousModel,
              message: `Switched to ${data.selectedModel}; the running turn uses it from its next model call.`,
            }
          : {
              code: 'unchanged',
              selectedModel: data.selectedModel,
              message: `The agent already uses ${data.selectedModel}.`,
            }
      )
    })
  })
  try {
    eventEmitter.emit('agent.model-apply-requested', { agentId: agent.id, executionId, requestId, expiresAt })
    return await ack
  } finally {
    unsubscribe()
    clearTimeout(timer)
  }
}

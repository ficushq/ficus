import type { Agent, QuestionItem } from '@ficus/shared'
import { getAgent } from '../api/agents'
import type { PendingVoiceMessage, VoiceAssistantRuntime } from './useRealtimeVoiceAssistant'

type WaitingInputState = {
  spokenWaitingInputAgentIds?: string[] | Set<string>
}

function getAgentDisplayName(agent: Agent): string {
  const name = agent.metadata?.name
  if (typeof name === 'string' && name.trim()) return name.trim()
  return agent.agentTypeId || 'Agent'
}

function formatQuestion(question: QuestionItem, index: number): string {
  const options = question.options?.map((option) => option.label ?? option.value).filter(Boolean)
  const optionText = options?.length ? ` Options: ${options.join(', ')}.` : ''
  const optionalText = question.optional ? ' Optional.' : ''
  const contextText = question.context?.trim() ? ` Context: ${question.context.trim()}` : ''
  return `${index + 1}. ${question.question}${contextText}${optionText}${optionalText}`
}

export function buildAgentWaitingInputPrompt(agent: Agent): string {
  const displayName = getAgentDisplayName(agent)
  const questions = agent.questionData?.questions ?? []
  const questionText = questions.length
    ? questions.map(formatQuestion).join('\n')
    : 'The agent needs a human answer before it can continue, but did not provide structured question text.'

  return `Agent ${displayName} needs your input before it can continue. Ask the user for the answer in natural language.\n\nQuestions:\n${questionText}\n\nAfter the user answers, send their answer back to agent ${agent.id} with the message_agent tool. Use mode "steer" so the waiting agent can resume immediately.`
}

function hasSpokenWaitingInput(state: WaitingInputState, agentId: string): boolean {
  const spoken = state.spokenWaitingInputAgentIds
  if (spoken instanceof Set) return spoken.has(agentId)
  return Array.isArray(spoken) && spoken.includes(agentId)
}

function markSpokenWaitingInput<TState extends WaitingInputState>(
  runtime: VoiceAssistantRuntime<TState>,
  agentId: string
): void {
  const state = runtime.getState()
  const spoken = state.spokenWaitingInputAgentIds
  if (spoken instanceof Set) {
    const next = new Set(spoken)
    next.add(agentId)
    runtime.setState({ ...state, spokenWaitingInputAgentIds: next })
    return
  }

  const ids = Array.isArray(spoken) ? spoken : []
  if (ids.includes(agentId)) return
  runtime.setState({ ...state, spokenWaitingInputAgentIds: [...ids.slice(-49), agentId] })
}

export function createHandleAgentWaitingInputEvent(getAgentDependency: typeof getAgent) {
  return async function handleAgentWaitingInputEvent<TState extends WaitingInputState>(
    runtime: VoiceAssistantRuntime<TState>,
    agentId: string,
    isActive: () => boolean = () => true
  ): Promise<void> {
    if (!isActive()) return

    const agent = await getAgentDependency(agentId)
    if (!isActive()) return
    if (agent.status !== 'waiting-input' || !agent.questionData?.questions?.length) return
    if (hasSpokenWaitingInput(runtime.getState(), agentId)) return

    const message: PendingVoiceMessage<TState> = {
      id: `agent-waiting-input:${agent.id}`,
      dedupeKey: `agent-waiting-input:${agent.id}`,
      text: buildAgentWaitingInputPrompt(agent),
      onStart: (queuedRuntime) => {
        markSpokenWaitingInput(queuedRuntime, agent.id)
      },
    }
    runtime.enqueueMessage(message)
  }
}

export const handleAgentWaitingInputEvent = createHandleAgentWaitingInputEvent(getAgent)

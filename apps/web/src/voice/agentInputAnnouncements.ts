import { endsWithSentencePunctuation, recommendedQuestionOption, type Agent, type QuestionItem } from '@ficus/shared'
import { getAgent } from '../api/agents'
import { listAgentTypes } from '../api/agentTypes'
import { getAgentLabel, noAgentTypeNames, type AgentTypeName } from '../lib/agentDisplay'
import type { PendingVoiceMessage, VoiceAssistantRuntime } from './useRealtimeVoiceAssistant'

type WaitingInputState = {
  spokenWaitingInputAgentIds?: string[] | Set<string>
}

// Spoken the way the app names agents: type first (by its configured name), then the purpose.
function getAgentDisplayName(agent: Agent, typeNames: AgentTypeName): string {
  return getAgentLabel(agent, undefined, typeNames)
}

/** The configured agent type names; none when they cannot be read (offline, or no permission). */
async function loadAgentTypeNames(): Promise<AgentTypeName> {
  try {
    const names = new Map((await listAgentTypes()).map((type) => [type.id, type.name]))
    return (id) => names.get(id)
  } catch {
    return noAgentTypeNames
  }
}

function formatQuestion(question: QuestionItem, index: number): string {
  const options = question.options?.map((option) => option.label ?? option.value).filter(Boolean)
  const optionText = options?.length ? ` Options: ${options.join(', ')}.` : ''
  // Agents now give their recommendation as an option field rather than in the question text.
  const recommended = recommendedQuestionOption(question)
  const recommendedLabel = recommended ? (recommended.label ?? recommended.value) : ''
  // A label that already ends a sentence ("Ship it now?") gets no extra full stop when no reason follows it.
  const recommendedText = recommended
    ? recommended.reason
      ? ` Recommended: ${recommendedLabel} (${recommended.reason}).`
      : ` Recommended: ${recommendedLabel}${endsWithSentencePunctuation(recommendedLabel) ? '' : '.'}`
    : ''
  const optionalText = question.optional ? ' Optional.' : ''
  const contextText = question.context?.trim() ? ` Context: ${question.context.trim()}` : ''
  return `${index + 1}. ${question.question}${contextText}${optionText}${recommendedText}${optionalText}`
}

export function buildAgentWaitingInputPrompt(agent: Agent, typeNames: AgentTypeName = noAgentTypeNames): string {
  const displayName = getAgentDisplayName(agent, typeNames)
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

export function createHandleAgentWaitingInputEvent(
  getAgentDependency: typeof getAgent,
  loadTypeNames: () => Promise<AgentTypeName> = async () => noAgentTypeNames
) {
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
    const typeNames = await loadTypeNames()
    if (!isActive() || hasSpokenWaitingInput(runtime.getState(), agentId)) return

    const message: PendingVoiceMessage<TState> = {
      id: `agent-waiting-input:${agent.id}`,
      dedupeKey: `agent-waiting-input:${agent.id}`,
      text: buildAgentWaitingInputPrompt(agent, typeNames),
      onStart: (queuedRuntime) => {
        markSpokenWaitingInput(queuedRuntime, agent.id)
      },
    }
    runtime.enqueueMessage(message)
  }
}

export const handleAgentWaitingInputEvent = createHandleAgentWaitingInputEvent(getAgent, loadAgentTypeNames)

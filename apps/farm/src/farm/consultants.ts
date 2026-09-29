import { inferredConsultantOrigin, type Agent } from '@ficus/shared'

/**
 * A consultant chat someone started themselves (the seed shed, or "New
 * consultant" in the web app), as opposed to one Core made for a channel,
 * an integration event or an Assistant task. Core stamps `context.origin` on
 * new consultants; an older one is judged by the channel facts or Assistant
 * task name it still carries, and counts as user-started when it has neither.
 */
export function isUserStartedConsultant(agent: Agent): boolean {
  if (agent.agentTypeId !== 'consultant') return false
  const origin = inferredConsultantOrigin(agent)
  return origin === null || origin === 'user'
}

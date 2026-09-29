import { consultantOrigin, type Agent } from '@ficus/shared'

/**
 * A consultant chat someone started themselves (the seed shed, or "New
 * consultant" in the web app), as opposed to one Core made for a channel,
 * an integration event or an Assistant task. Core stamps `context.origin` on
 * new consultants; older ones have none and are treated as user-started.
 */
export function isUserStartedConsultant(agent: Agent): boolean {
  if (agent.agentTypeId !== 'consultant') return false
  const origin = consultantOrigin(agent.context)
  return origin === null || origin === 'user'
}

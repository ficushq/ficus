import type { AgentModelSource } from '@ficus/shared'

/** The model source line, named the way the agent's resolution reports it. */
export function modelSourceLabel(source: AgentModelSource): string {
  const tier = source.tierLabel ?? source.tier ?? ''
  switch (source.kind) {
    case 'agent-model-override':
      return 'Agent model override'
    case 'inherited-parent-chain':
      return 'Inherited parent chain'
    case 'agent-tier-override':
      return `Agent tier override: ${tier}`
    case 'workflow-tier':
      return `Workflow tier: ${tier}`
    case 'workflow-model':
      return 'Workflow model'
    case 'agent-type-model':
      return 'Agent type model'
    case 'agent-type-tier':
      return `Agent type tier: ${tier}`
    case 'instance-default':
      return 'Instance default'
  }
}

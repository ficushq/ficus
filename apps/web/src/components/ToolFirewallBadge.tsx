import type { ToolFirewallFlag } from '@ficus/shared'
import { Badge } from './Badge'
import { WarningIcon } from './icons'

/** Marks a tool call whose result the firewall found instructions aimed at the agent in. */
export function ToolFirewallBadge({ flag }: { flag: ToolFirewallFlag }) {
  const scores = [
    `${Math.round(flag.instructsAgent * 100)}% likely`,
    ...(flag.intent ? [`intent: ${flag.intent}`] : []),
  ].join(', ')
  const title = `Ficus firewall: this content likely contains instructions aimed at the agent (${scores}). The agent was warned to treat it as untrusted data.${flag.partial ? ' Only part of it was screened.' : ''}`
  return (
    <Badge color={flag.severity === 'high' ? 'danger' : 'attention'} className="shrink-0 gap-1" title={title}>
      <WarningIcon className="w-3 h-3" />
      Possible injection
    </Badge>
  )
}

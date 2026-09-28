import { AGENT_STATUS_ROLE, type Agent } from '@ficus/shared'
import { webStatus } from '../lib/statusPresentation'
import type { ThemeColors } from './tokenReader'

export const graphColor = (colors: ThemeColors, token: string) => colors[token] ?? 'transparent'

export function agentGraphColor(colors: ThemeColors, status: Agent['status']): string {
  return graphColor(colors, webStatus(AGENT_STATUS_ROLE[status]).markerToken)
}

export function squadGraphColor(colors: ThemeColors, status: string): string {
  const token = { active: '--graph-node-active', paused: '--graph-node-paused', archived: '--graph-node-archived' }[
    status
  ]
  return graphColor(colors, token ?? '--graph-node-active')
}

export function relationshipGraphColor(colors: ThemeColors, type: string): string {
  const token = { reports_to: '--graph-link-1', collaborates: '--graph-link-2', depends_on: '--graph-link-3' }[type]
  return graphColor(colors, token ?? '--graph-link-1')
}

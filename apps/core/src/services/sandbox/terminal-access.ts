/**
 * The one terminal permission check per sandbox kind, shared by the terminal
 * HTTP routes and the `/ws/terminal` upgrade:
 *
 * - `squad_<id>`: `terminal:access` in that squad (unchanged).
 * - `agent_<id>`: the agent private-area rule with a terminal
 *   (services/agent-private/access.ts) — a person with `agents:private-access`
 *   and `terminal:access` in the agent's squad, resolved from the agent row.
 *   Anything else starting with `agent_` is denied.
 * - Any other sandbox id: `null`; the caller applies its own rule.
 */

import { Permissions } from '@ficus/shared'
import { authorizeAgentPrivateArea, parseAgentSandboxId } from '../agent-private/access'
import { hasPermission, type Identity } from '../rbac'
import { getSquadIdFromSandbox } from './types'

export async function canAccessSandboxTerminal(identity: Identity, sandboxId: string): Promise<boolean | null> {
  if (sandboxId.startsWith('agent_')) {
    const agentId = parseAgentSandboxId(sandboxId)
    return agentId ? (await authorizeAgentPrivateArea(identity, agentId, { terminal: true })) !== null : false
  }
  const squadId = getSquadIdFromSandbox(sandboxId)
  if (squadId) return hasPermission(identity, Permissions.TERMINAL_ACCESS, squadId)
  return null
}

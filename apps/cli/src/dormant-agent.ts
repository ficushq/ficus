import { apiGet } from './client'
import { ApiRequestError } from './client-errors'

/** Server error code for a direct send refused because the recipient agent is dormant. */
export const AGENT_DORMANT_CODE = 'AGENT_DORMANT'

export const WAKE_OPTION_DESCRIPTION =
  'Send even if the agent is dormant (its work is finished): wakes it and restarts its sandbox'

/**
 * Turn the server's AGENT_DORMANT refusal into an actionable CLI message; any other error is
 * returned unchanged. The agent's name comes from a normal permission-checked read, so the
 * message shows nothing the caller could not already see; without access it shows the id only.
 */
export async function explainDormantRecipient(error: unknown, agentId: string): Promise<unknown> {
  if (!(error instanceof ApiRequestError) || error.code !== AGENT_DORMANT_CODE) return error
  const agent = await apiGet<{ id?: string; metadata?: { name?: string } | null }>(
    `/api/agents/${encodeURIComponent(agentId)}`
  ).catch(() => null)
  const shortId = (agent?.id ?? agentId).slice(0, 8)
  const name = agent?.metadata?.name
  return new Error(
    `Agent ${shortId}${name ? ` (${name})` : ''} is dormant. Its work is finished; sending will wake it and ` +
      'restart its sandbox. Re-run with --wake to send anyway.'
  )
}

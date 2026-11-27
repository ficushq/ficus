import type { Api, Model } from '@earendil-works/pi-ai'
import { supportsMidConversationToolAdditions, type ToolSearchCapability } from './plan'

/**
 * The capability a new session's plan is decided on.
 *
 * Claude Code: an Anthropic session goes through the Claude Code bridge whenever its Claude Code
 * account is enabled, because that account takes part in the provider's per-account failover
 * and is tried first by default. Such a session never registers pi's `tool_search`: a load would
 * change the bridge's tool set and restart the Claude Code process. Claude Code's own tool search
 * holds back the deferrable tools instead.
 *
 * Model failover to another provider is not checked: the plan is decided on the session's model
 * and stays fixed. On a failover model that cannot add tools mid-conversation, pi sends the
 * current tools in the top-level tool list, so `tool_search` keeps working and each load costs a
 * cache miss there (a provider switch starts a new cache anyway). Failing over from another
 * provider into a Claude Code account keeps working too, with a Claude Code restart per load.
 */
export function resolveToolSearchCapability(input: {
  model: Pick<Model<Api>, 'api' | 'compat' | 'provider'>
  /** Whether this instance can route the model's provider through Claude Code right now. */
  claudeCodeEnabledFor: (provider: string) => boolean
}): ToolSearchCapability {
  return {
    supportsToolAdditions: supportsMidConversationToolAdditions(input.model),
    claudeCode: input.claudeCodeEnabledFor(input.model.provider),
  }
}

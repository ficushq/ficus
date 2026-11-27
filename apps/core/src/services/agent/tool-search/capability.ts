import type { Api, Model } from '@earendil-works/pi-ai'
import { supportsMidConversationToolAdditions, type ToolSearchCapability } from './plan'

/**
 * The capability a new session's plan is decided on.
 *
 * Claude Code: whenever a Claude Code account is enabled on this instance, every session plans
 * `claude-code`, whatever its first model. The account takes part in per-account and model
 * failover, so a session on any provider can reach the Claude Code bridge mid-run. The bridge
 * starts a new Claude Code process only when everything new is a user message, so a tool that
 * pi's `tool_search` loaded mid-run would not be callable there until the next user message.
 * Such sessions never register `tool_search`; Claude Code's own tool search holds back the
 * deferrable tools when the bridge serves a turn, and every other turn declares every tool.
 * A Claude Code account enabled after a session started does not change that session's plan.
 *
 * Model failover to another provider is otherwise not checked: the plan is decided on the
 * session's model and stays fixed. On a failover model that cannot add tools mid-conversation,
 * pi sends the current tools in the top-level tool list, so `tool_search` keeps working and each
 * load costs a cache miss there (a provider switch starts a new cache anyway).
 */
export function resolveToolSearchCapability(input: {
  model: Pick<Model<Api>, 'api' | 'compat'>
  /** Whether a Claude Code account is enabled and usable on this instance right now. */
  claudeCodeEnabled: boolean
}): ToolSearchCapability {
  return {
    supportsToolAdditions: supportsMidConversationToolAdditions(input.model),
    claudeCode: input.claudeCodeEnabled,
  }
}

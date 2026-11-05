/*
 * Live typing in an agent's chat: who else is typing in the composer of a
 * conversation you are reading. People only (never agents or API tokens), and
 * only the fact of typing: the draft itself is never sent. The API process
 * keeps it in memory and never stores it (apps/core/src/services/ws/agent-chat-typing.ts).
 */

/** Client to server: this person is typing in an agent's chat composer, or stopped. */
export interface AgentChatTypingClientMessage {
  type: 'agentChat.typing'
  agentId: string
  typing: boolean
}

/**
 * Server to client, on `agents:<agentId>`: someone else is typing in that chat (with their name as
 * this recipient may see it), or stopped.
 */
export type AgentChatTypingEventData =
  { agentId: string; userId: string; typing: true; name: string } | { agentId: string; userId: string; typing: false }

/** A typer counts as stopped after this long without a change to their composer. */
export const AGENT_CHAT_TYPING_IDLE_MS = 5_000

/** While typing, the client says so again this often, so a lost "stopped" never leaves anyone stuck. */
export const AGENT_CHAT_TYPING_HEARTBEAT_MS = 2_500

/** Receivers drop a typer not heard from in this long (a few missed heartbeats). */
export const AGENT_CHAT_TYPER_STALE_MS = 7_000

export type ChatTarget =
  | { kind: 'agent'; agentId: string }
  | { kind: 'consultant'; squadId: string }
  | { kind: 'assistant'; conversationId?: string }

/** Placeholder until the chat module lands. */
export function ChatSlot(_props: { target: ChatTarget; onClose: () => void }) {
  return null
}

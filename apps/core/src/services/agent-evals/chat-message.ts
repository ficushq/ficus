import type { ScenarioText, VariantContext } from './define'

/** The module that turns a stored chat message into the text the model reads. */
export const MESSAGE_CONTEXT_PATH = 'apps/core/src/services/chat/message-context.ts'

/** The sender the server stamps on a human chat message (routes/agents.ts and routes/chat.ts). */
export interface ChatSender {
  userId: string
  name: string
}

/**
 * A human message in a direct chat with the agent, as the variant's runtime delivers it: the
 * variant's own `messageTextForModel` renders it with the metadata the server stores on a human
 * chat message. A ref whose renderer adds no sender note therefore gets the bare text, and a ref
 * that adds one gets exactly its note. Never borrows another variant's renderer.
 */
export function humanChat(content: string, sender: ChatSender): ScenarioText {
  return (variant) => humanChatText(variant, content, sender)
}

export async function humanChatText(variant: VariantContext, content: string, sender: ChatSender): Promise<string> {
  const module = await variant.import<Partial<typeof import('../chat/message-context')>>(MESSAGE_CONTEXT_PATH)
  if (typeof module.messageTextForModel !== 'function') {
    throw new Error(
      `${MESSAGE_CONTEXT_PATH} in this variant does not export messageTextForModel; chat scenarios require ` +
        "that ref's own chat renderer and need an explicit compatibility policy before comparison."
    )
  }
  return module.messageTextForModel({ content, metadata: { source: 'user_chat', sender } })
}

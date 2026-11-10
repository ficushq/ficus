import { createContext, type ReactNode } from 'react'
import type { ReviewConsultationSend } from '@ficus/client-core'

export interface ReviewConversationProps {
  agentId: string
  sendOptions: () => { reviewConsultation?: ReviewConsultationSend } | undefined
  placeholder: string
}

/**
 * Renders the conversation the review screen's chat shows. Unset, it is the agent's own conversation
 * (the same agent and session as its chat page); tests and the browser fixture provide a stand-in.
 * It is a render function rather than a component type, so the chat never renders a component whose
 * identity is chosen during render.
 */
export const ReviewConversationContext = createContext<((props: ReviewConversationProps) => ReactNode) | null>(null)

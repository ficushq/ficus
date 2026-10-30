import { createContext, type ComponentType } from 'react'
import type { ReviewConsultationSend } from '@ficus/client-core'

export interface ReviewConversationProps {
  agentId: string
  sendOptions: () => { reviewConsultation?: ReviewConsultationSend } | undefined
  placeholder: string
}

/**
 * The conversation the review screen's chat renders. Unset, it is the agent's own conversation
 * (the same agent and session as its chat page); tests and the browser fixture provide a stand-in.
 */
export const ReviewConversationContext = createContext<ComponentType<ReviewConversationProps> | null>(null)

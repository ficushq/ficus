import { createContext, useContext, type ReactNode } from 'react'
import {
  compactAgent,
  deleteAgent,
  getActiveExecution,
  getAgent,
  getDeliverySuggestion,
  listAgents,
  reportDeliveryCorrection,
  resetAgent,
  stopAgent,
} from './agents'
import { getAgentQuestions } from './agentQuestions'
import { mergeDefined } from './mergeDefined'

export const defaultChatApi = {
  listAgents,
  getAgent,
  getActiveExecution,
  getAgentQuestions,
  compactAgent,
  deleteAgent,
  resetAgent,
  stopAgent,
  getDeliverySuggestion,
  reportDeliveryCorrection,
}

export type ChatApi = typeof defaultChatApi

const ChatApiContext = createContext<ChatApi>(defaultChatApi)

export function ChatApiProvider({ overrides, children }: { overrides?: Partial<ChatApi>; children: ReactNode }) {
  return (
    <ChatApiContext.Provider value={mergeDefined(defaultChatApi, overrides ?? {})}>{children}</ChatApiContext.Provider>
  )
}

export function useChatApi() {
  return useContext(ChatApiContext)
}

// Thin shim over @ficus/client-core (see ./clientInstance).
import { client } from './clientInstance'

export type { ChatSSECallbacks } from '@ficus/client-core'

export const sendChatMessage = client.chat.sendChatMessage

// Thin shim over @ficus/client-core (see ./clientInstance).
import { client } from './clientInstance'

export type { SessionSummary } from '@ficus/client-core'

export const listSessions = client.sessions.listSessions
export const revokeSession = client.sessions.revokeSession
export const revokeAllSessions = client.sessions.revokeAllSessions

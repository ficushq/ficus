// Thin shim over @ficus/client-core (see ./clientInstance).
import { client } from './clientInstance'

/** The web renders delivery-gate actions, so it opts into them. */
export const listPendingActions = () => client.actions.listPendingActions({ include: ['workstream-delivery'] })

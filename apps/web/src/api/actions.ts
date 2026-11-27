// Thin shim over @ficus/client-core (see ./clientInstance).
import { client } from './clientInstance'

/** Every pending action type: the web renders each one, including view-only delivery gates. */
export const listPendingActions = () => client.actions.listPendingActions()

/**
 * Prefixes of the Core-minted credentials that are stored only as a hash. A resolver looks a
 * raw value up only in the table its prefix names, so a value minted as one kind can never
 * authenticate as another, and a value minted before the current prefixes (every earlier
 * product prefix) authenticates nowhere. Device tokens keep their prefix beside their own
 * mint/resolve code (`DEVICE_TOKEN_PREFIX`).
 */
export const SESSION_TOKEN_PREFIX = 'ficus_sess_'
export const AGENT_TOKEN_PREFIX = 'ficus_agent_'
export const WS_TICKET_PREFIX = 'ficus_wst_'
export const WEB_HANDOFF_PREFIX = 'ficus_wh_'
/** Every system token carries this prefix; resolveSystemToken rejects anything else before any lookup. */
export const SYSTEM_TOKEN_PREFIX = 'ficus_sys_'

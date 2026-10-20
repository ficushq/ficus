/** Vault states in which Ficus may hold and use read material. `degraded` keeps reading (the call
 * itself fails if upstream is unhealthy) so a transient degradation never fences the connection;
 * the synchronizer, the read client and the shared tools all apply this one rule. */
export const MANAGED_VAULT_READABLE_STATES: readonly string[] = ['ready', 'degraded']

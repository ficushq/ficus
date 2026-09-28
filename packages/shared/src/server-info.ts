/** API feature contracts, independent of permissions, provider setup, and UI flags. */
export interface ServerInfo {
  product: 'ficus'
  /** Package release version; diagnostic, not a feature gate. */
  version: string
  /** Deployed artifact/checkout revision, or null when unavailable. */
  revision: string | null
  /** Major API contract version. Additive fields do not increment this. */
  apiVersion: number
  /** A named capability's contract version. Missing names are not advertised. */
  capabilities: Record<string, number>
}

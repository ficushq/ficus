import { apiFetch } from './client'

/**
 * A remote host as returned by the API (`toPublicRemoteHost`): the full row
 * minus the internal `sshKeyId` secret-store handle. Private key material is
 * never modeled here — it never leaves the server. Dates arrive
 * JSON-serialized as ISO strings.
 */
export interface RemoteHost {
  id: string
  name: string
  description: string | null
  sshHost: string
  sshPort: number
  sshUser: string
  sshPublicKey: string
  createdAt: string
  updatedAt: string
  /** Whether agents can connect, by SSH host-key confirmation state (see {@link HostKeyState}). */
  hostKeyState: HostKeyState
  hostKeys: PublicHostKey[]
  hostKeyCheckedAt?: string | null
  /** Why the last host-key fetch failed, if it did. */
  hostKeyCheckError?: string | null
  /** Set on a create/scan response whose host-key fetch just failed. */
  fetchError?: string
}

/**
 * - `trusted`: a pinned key; connections are checked strictly against it.
 * - `adopting`: registered before keys were pinned; existing trust is being adopted.
 * - `changed`: the host presented a different key; connections are refused until a person decides.
 * - `pending`: fetched keys wait for a person; the host is blocked.
 * - `unverified`: no key to confirm (fetch failed or all rejected); the host is blocked.
 */
export type HostKeyState = 'adopting' | 'trusted' | 'changed' | 'pending' | 'unverified'

/** One SSH host key seen for a host (fingerprint only) and the decision on it. */
export interface PublicHostKey {
  id: string
  keyType: string
  fingerprint: string
  status: 'pending' | 'trusted' | 'rejected' | 'replaced'
  origin: 'scan' | 'adopted' | 'adoption-conflict' | 'provider-key' | 'platform'
  decisionNote: string | null
  decidedByUserId: string | null
  decidedAt: string | null
  firstSeenAt: string
  lastSeenAt: string
  /** For a pending key: the trusted keys of the same type it would replace (a key change). */
  replacesFingerprints: string[]
}

/** A squad box whose own known_hosts pins a different key than a Ficus-managed entry. */
export interface KnownHostsConflict {
  id: string
  squadId: string
  sandboxId: string
  host: string
  keyType: string
  boxFingerprint: string
  coreFingerprint: string
  boxLine: number
  /** The box line names the host through a wildcard; Ficus will not edit it. */
  wildcard: boolean
  status: 'open' | 'kept-box' | 'resolved-core'
  detectedAt: string
  lastSeenAt: string
  resolvedAt: string | null
  resolvedByUserId: string | null
}

/** A remote host plus the squad IDs currently granted access to it (admin/global surface only). */
export interface RemoteHostWithGrants extends RemoteHost {
  squadIds: string[]
}

/** Connectivity-probe result (`POST .../check`). Never throws on an unreachable host. */
export interface RemoteHostCheckResult {
  reachable: boolean
  error?: string
}

/**
 * Result of revoking a squad's grant. Revoking always rotates the host's minted
 * keypair (server `revokeAndRotate`), so the operator must install the new
 * public key on the host afterwards. `rotated:true` carries `sshPublicKey` +
 * install `message`; `rotated:false` carries a `warning` (rotation failed —
 * retry) or a `message` (nothing to rotate, e.g. the host was already deleted).
 */
export interface RevokeRotationResult {
  revoked: boolean
  rotated: boolean
  sshPublicKey?: string
  message?: string
  warning?: string
}

/** Fields shared by both the admin and squad-scoped create routes. */
export interface CreateRemoteHostInput {
  name: string
  sshHost: string
  sshPort?: number
  sshUser: string
  description?: string
}

/** Admin registration additionally accepts initial squad grants. */
export interface CreateRemoteHostAdminInput extends CreateRemoteHostInput {
  squadIds?: string[]
}

/** Result of a squad's ssh-artifact sync push (`POST .../sync`). */
export interface RemoteHostSyncResult {
  pushed: boolean
  reason?: string
}

// ── Global registry surface (admin) ─────────────────────────────────────────

export async function listRemoteHosts(): Promise<RemoteHostWithGrants[]> {
  return apiFetch<RemoteHostWithGrants[]>('/remote-hosts')
}

export async function getRemoteHost(id: string): Promise<RemoteHostWithGrants> {
  return apiFetch<RemoteHostWithGrants>(`/remote-hosts/${id}`)
}

export async function createRemoteHost(input: CreateRemoteHostAdminInput): Promise<RemoteHostWithGrants> {
  return apiFetch<RemoteHostWithGrants>('/remote-hosts', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function deleteRemoteHost(id: string): Promise<void> {
  await apiFetch(`/remote-hosts/${id}`, { method: 'DELETE' })
}

export async function grantRemoteHost(id: string, squadId: string): Promise<RemoteHostWithGrants> {
  return apiFetch<RemoteHostWithGrants>(`/remote-hosts/${id}/grants`, {
    method: 'POST',
    body: JSON.stringify({ squadId }),
  })
}

export async function revokeRemoteHostGrant(id: string, squadId: string): Promise<RevokeRotationResult> {
  return apiFetch<RevokeRotationResult>(`/remote-hosts/${id}/grants/${squadId}`, { method: 'DELETE' })
}

export async function checkRemoteHost(id: string): Promise<RemoteHostCheckResult> {
  return apiFetch<RemoteHostCheckResult>(`/remote-hosts/${id}/check`, { method: 'POST' })
}

/** Fetch the host's SSH host keys now (no login). New keys wait for a person. */
export async function scanRemoteHostKeys(id: string): Promise<RemoteHostWithGrants> {
  return apiFetch<RemoteHostWithGrants>(`/remote-hosts/${id}/host-keys/scan`, { method: 'POST' })
}

/** A person's decision on a fetched host key. */
export async function decideRemoteHostKey(
  id: string,
  keyId: string,
  decision: 'trust' | 'reject'
): Promise<RemoteHostWithGrants> {
  return apiFetch<RemoteHostWithGrants>(`/remote-hosts/${id}/host-keys/${keyId}/${decision}`, { method: 'POST' })
}

// ── Squad surface ────────────────────────────────────────────────────────────

export async function listSquadRemoteHosts(squadId: string): Promise<RemoteHost[]> {
  return apiFetch<RemoteHost[]>(`/remote-hosts/squad/${squadId}`)
}

/** Add-and-grant: registers a new host and grants it to `squadId` in one step. */
export async function addSquadRemoteHost(squadId: string, input: CreateRemoteHostInput): Promise<RemoteHostWithGrants> {
  return apiFetch<RemoteHostWithGrants>(`/remote-hosts/squad/${squadId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** Revoke this squad's own grant (never deletes the host row itself). Rotates the host key. */
export async function revokeSquadRemoteHost(squadId: string, hostId: string): Promise<RevokeRotationResult> {
  return apiFetch<RevokeRotationResult>(`/remote-hosts/squad/${squadId}/${hostId}`, { method: 'DELETE' })
}

/** Squad-scoped connectivity probe for a host granted to `squadId`. */
export async function checkSquadRemoteHost(squadId: string, hostId: string): Promise<RemoteHostCheckResult> {
  return apiFetch<RemoteHostCheckResult>(`/remote-hosts/squad/${squadId}/check/${hostId}`, { method: 'POST' })
}

/** Re-push ~/.ssh artifacts to the calling agent's box (agent identities only). */
export async function syncSquadRemoteHosts(squadId: string): Promise<RemoteHostSyncResult> {
  return apiFetch<RemoteHostSyncResult>(`/remote-hosts/squad/${squadId}/sync`, { method: 'POST' })
}

/** Squad-scoped host-key fetch for a host granted to `squadId`. */
export async function scanSquadRemoteHostKeys(squadId: string, hostId: string): Promise<RemoteHost> {
  return apiFetch<RemoteHost>(`/remote-hosts/squad/${squadId}/host-keys/${hostId}/scan`, { method: 'POST' })
}

/** Squad-scoped host-key decision (a host shared with other squads needs an administrator). */
export async function decideSquadRemoteHostKey(
  squadId: string,
  hostId: string,
  keyId: string,
  decision: 'trust' | 'reject'
): Promise<RemoteHost> {
  return apiFetch<RemoteHost>(`/remote-hosts/squad/${squadId}/host-keys/${hostId}/${keyId}/${decision}`, {
    method: 'POST',
  })
}

export async function listSquadKnownHostsConflicts(squadId: string): Promise<KnownHostsConflict[]> {
  return apiFetch<KnownHostsConflict[]>(`/remote-hosts/squad/${squadId}/known-hosts-conflicts`)
}

export async function resolveSquadKnownHostsConflict(
  squadId: string,
  conflictId: string,
  choice: 'keep-box' | 'use-core'
): Promise<KnownHostsConflict> {
  return apiFetch<KnownHostsConflict>(`/remote-hosts/squad/${squadId}/known-hosts-conflicts/${conflictId}/${choice}`, {
    method: 'POST',
  })
}

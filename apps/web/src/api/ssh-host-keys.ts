import { apiFetch } from './client'
import type { HostKeyState, PublicHostKey } from './remote-hosts'

/**
 * An SSH endpoint Ficus connects to itself — a machine, exe.dev, or a squad's
 * memory git remote — with its host-key state (server `toPublicTrustTargets`).
 * Fingerprints only; never key material.
 */
export interface SshTrustTarget {
  id: string
  scope: string
  kind: 'machine' | 'exe-machine' | 'exe-api' | 'memory-git'
  squadId: string | null
  label: string
  sshHost: string
  sshPort: number
  hostKeyState: HostKeyState
  hostKeys: PublicHostKey[]
  hostKeyCheckedAt: string | null
  hostKeyCheckError: string | null
  /** Set for machine endpoints on the instance list. */
  machineId?: string | null
  /** Set on a scan response whose fetch just failed. */
  fetchError?: string
}

/** Machines and exe.dev (instance surface, machines:read). */
export function listMachineSshHostKeys(): Promise<SshTrustTarget[]> {
  return apiFetch<SshTrustTarget[]>('/ssh-host-keys')
}

/** A squad's memory git remotes (memory:read). */
export function listSquadSshHostKeys(squadId: string): Promise<SshTrustTarget[]> {
  return apiFetch<SshTrustTarget[]>(`/ssh-host-keys/squad/${squadId}`)
}

/** Fetch an endpoint's keys (no login). New keys are pending; nothing is trusted. */
export function scanSshHostKeys(targetId: string): Promise<SshTrustTarget> {
  return apiFetch<SshTrustTarget>(`/ssh-host-keys/${targetId}/scan`, { method: 'POST' })
}

/** A person's decision on a fetched key (the server refuses agents and tokens). */
export function decideSshHostKey(
  targetId: string,
  keyId: string,
  decision: 'trust' | 'reject'
): Promise<SshTrustTarget> {
  return apiFetch<SshTrustTarget>(`/ssh-host-keys/${targetId}/keys/${keyId}/${decision}`, { method: 'POST' })
}

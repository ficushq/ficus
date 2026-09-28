import { apiFetch } from './client'

export type SecretValidation =
  | { status: 'valid'; login: string; tokenType: 'classic' | 'fine-grained'; scopes?: string[]; warnings: string[] }
  | { status: 'invalid'; message: string }
  | { status: 'unverified'; message: string }

export interface SetSecretResponse {
  key: string
  updated: boolean
  validation?: SecretValidation
}

export interface SecretMetadata {
  key: string
  isSet: boolean
  updatedAt: string | null
  updatedBy: string | null
}

export interface SecretsListResponse {
  /** Manageable secrets (values never included). Excludes platform-managed keys. */
  secrets: SecretMetadata[]
  /**
   * Names of secrets managed by the hosted platform on this instance. These are
   * never editable/readable here; the UI renders a "Managed by your platform"
   * placeholder for them. Empty on self-hosted installs.
   */
  managedKeys: string[]
  /**
   * True when the hosted platform runs this instance (FICUS_MANAGED=1). This is
   * instance-level, not per-key: some credentials the platform provides are not
   * delivered as managed env vars and so never appear in `managedKeys` (the
   * exe.dev account SSH key ships as a file the setup config points at). The UI
   * uses this to describe those honestly instead of showing them "not set".
   * Carries no value and no path. Absent from older servers, so treat undefined
   * as self-hosted.
   */
  managed?: boolean
  /**
   * True when this instance is exe-backed (do-machine-mode-part2 Task 7): a
   * configured exe.dev account key, or a registered exe-provider machine.
   * The Machines section hides the exe.dev SSH key row on a MANAGED
   * instance unless this is true — do_droplet (the platform default) never
   * has one. Absent from older servers, so treat undefined as "not exe-backed".
   */
  exeBacked?: boolean
}

export async function listSecrets(): Promise<SecretsListResponse> {
  return apiFetch<SecretsListResponse>('/secrets')
}

export async function getSecret(key: string): Promise<{ key: string; value: string }> {
  return apiFetch<{ key: string; value: string }>(`/secrets/${key}`)
}

export async function setSecret(
  key: string,
  value: string,
  options: { force?: boolean } = {}
): Promise<SetSecretResponse> {
  return apiFetch<SetSecretResponse>(`/secrets/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value, ...(options.force ? { force: true } : {}) }),
  })
}

export async function deleteSecret(key: string): Promise<void> {
  await apiFetch(`/secrets/${key}`, { method: 'DELETE' })
}

export async function restartSystem(): Promise<void> {
  await apiFetch('/system/restart', { method: 'POST' })
}

export function getGitAuthorDefaults(): Promise<{
  github: { gitUserName: string; gitUserEmail: string; login: string } | null
}> {
  return apiFetch('/secrets/git-author-defaults')
}

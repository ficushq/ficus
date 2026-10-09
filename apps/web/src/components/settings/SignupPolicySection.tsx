import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { updateAuthSettings, type AuthSettings } from '../../api/auth'
import { usePermissions } from '../../hooks/usePermissions'
import { isUserAssignableRole } from '../../api/roles'
import { parseDomains, policyModeOf, type SignupPolicyMode } from './signupPolicyUtils'

const MODES: { id: SignupPolicyMode; label: string; description: string }[] = [
  {
    id: 'invite',
    label: 'Invite only',
    description: 'Only people an admin has added under Users can register. Recommended.',
  },
  {
    id: 'domains',
    label: 'Anyone with an email at an allowed domain',
    description: 'Invited people, plus anyone whose email domain is on the list below.',
  },
  {
    id: 'open',
    label: 'Anyone can sign up',
    description: 'Any address that can receive a verification code gets an account.',
  },
]

export function SignupPolicySection() {
  const qc = useQueryClient()
  const { can } = usePermissions()
  const canWrite = can('settings:write')
  const { data: settings, isLoading } = useQuery(queries.auth.settings())

  // Null until the operator touches a control, so the form always shows the saved
  // policy without an effect to sync it (and re-shows it after a save).
  const [draftMode, setDraftMode] = useState<SignupPolicyMode | null>(null)
  const [draftDomains, setDraftDomains] = useState<string | null>(null)
  const [draftRoleId, setDraftRoleId] = useState<string | null | undefined>(undefined)
  const rolesQuery = useQuery({ ...queries.roles.list(), enabled: can('roles:read') })
  const [error, setError] = useState<string | null>(null)

  const savedMode = policyModeOf(settings)
  const mode = draftMode ?? savedMode
  const domainsText = draftDomains ?? (settings?.allowedDomains ?? []).join('\n')
  const domains = parseDomains(domainsText)
  const roleId = draftRoleId === undefined ? (settings?.defaultSignupRoleId ?? null) : draftRoleId
  const availableRoles = (rolesQuery.data ?? []).filter(isUserAssignableRole)
  const selectedRole = availableRoles.find((role) => role.id === roleId)
  const cannotGrantRole = !!selectedRole && !selectedRole.permissions.every(can)

  const save = useMutation({
    mutationFn: (): Promise<AuthSettings> => {
      if (mode === 'open')
        return updateAuthSettings({ requireInvite: false, allowedDomains: [], defaultSignupRoleId: roleId })
      if (mode === 'domains')
        return updateAuthSettings({ requireInvite: true, allowedDomains: domains, defaultSignupRoleId: roleId })
      return updateAuthSettings({ requireInvite: true, allowedDomains: [] })
    },
    onSuccess: (updated) => {
      setError(null)
      setDraftMode(null)
      setDraftDomains(null)
      setDraftRoleId(undefined)
      qc.setQueryData(queryKeys.auth.settings(), updated)
      // The login page's create-account affordance is driven by /auth/status.
      qc.invalidateQueries({ queryKey: queryKeys.auth.status() })
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to save sign-up policy'),
  })

  const domainsEmpty = mode === 'domains' && domains.length === 0
  const dirty = draftMode !== null || draftDomains !== null || draftRoleId !== undefined
  const canSave = canWrite && dirty && !domainsEmpty && !save.isPending && !(mode !== 'invite' && cannotGrantRole)

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">Sign-up</h3>
        <p className="mt-1 text-sm text-muted">Who is allowed to create an account on this instance.</p>
      </div>

      <div className="ficus-section py-5 space-y-4">
        {isLoading ? (
          <div className="h-24 animate-pulse rounded bg-surface-secondary" />
        ) : (
          <>
            <p className="text-sm text-secondary">
              Current policy: <span className="font-medium text-primary">{describePolicy(settings)}</span>
            </p>

            <fieldset className="space-y-3" disabled={!canWrite}>
              <legend className="sr-only">Sign-up policy</legend>
              {MODES.map((option) => (
                <label
                  key={option.id}
                  className={clsx(
                    'flex gap-3 rounded-md border p-3',
                    mode === option.id ? 'border-accent bg-surface-secondary/40' : 'border-th-border',
                    canWrite ? 'cursor-pointer' : 'cursor-default opacity-80'
                  )}
                >
                  <input
                    type="radio"
                    name="signup-policy"
                    value={option.id}
                    checked={mode === option.id}
                    disabled={!canWrite}
                    onChange={() => {
                      setError(null)
                      setDraftMode(option.id)
                    }}
                    className="mt-1 text-accent-light focus:ring-accent"
                  />
                  <span>
                    <span className="block text-sm font-medium text-primary">
                      {option.label}
                      {option.id === 'invite' && <span className="ml-2 text-xs text-muted">(default)</span>}
                    </span>
                    <span className="block text-xs text-muted">{option.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {mode === 'domains' && (
              <div className="space-y-2">
                <label
                  data-setting-target="allowed-domains-one-per-line"
                  htmlFor="signup-allowed-domains"
                  className="block text-xs font-medium text-secondary"
                >
                  Allowed domains (one per line)
                </label>
                <textarea
                  id="signup-allowed-domains"
                  rows={4}
                  value={domainsText}
                  disabled={!canWrite}
                  onChange={(e) => {
                    setError(null)
                    setDraftDomains(e.target.value)
                  }}
                  placeholder={'acme.com\npartner.example'}
                  className="ficus-field w-full rounded-md border border-input-border bg-input-bg px-3 py-2 font-mono text-sm text-primary placeholder:text-placeholder focus:border-accent focus:ring-accent disabled:opacity-60"
                />
                {domainsEmpty ? (
                  <p className="text-xs text-status-attention-600 dark:text-status-attention-400">
                    Add at least one domain — an empty list is the same as invite only.
                  </p>
                ) : (
                  <p className="text-xs text-muted">
                    Will allow: {domains.map((d) => `@${d}`).join(', ')}. Matching is exact, so add each subdomain you
                    use.
                  </p>
                )}
              </div>
            )}

            {mode !== 'invite' && (
              <div className="space-y-2">
                <label
                  data-setting-target="signup-default-role"
                  htmlFor="signup-default-role"
                  className="block text-sm font-medium text-primary"
                >
                  Default role for new accounts
                </label>
                <select
                  id="signup-default-role"
                  value={roleId ?? ''}
                  disabled={!canWrite}
                  onChange={(event) => setDraftRoleId(event.target.value || null)}
                  className="ficus-field w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-primary disabled:opacity-60"
                >
                  <option value="">No role</option>
                  {roleId && !selectedRole && <option value={roleId}>Configured role (details unavailable)</option>}
                  {availableRoles.map((role) => (
                    <option key={role.id} value={role.id} disabled={!role.permissions.every(can)}>
                      {role.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted">
                  Granted across this instance when someone creates a new account through this policy. No role means an
                  administrator must grant access later. Existing accounts and invited users keep their roles.
                </p>
                {!can('roles:read') && (
                  <p className="text-xs text-muted">You need roles:read permission to browse roles.</p>
                )}
                {rolesQuery.isError && (
                  <p role="alert" className="text-xs text-status-danger-500">
                    Could not load roles. Try again before choosing a role.
                  </p>
                )}
                {cannotGrantRole && (
                  <p role="alert" className="text-xs text-status-danger-500">
                    You cannot grant permissions you do not hold. Choose another role or No role.
                  </p>
                )}
              </div>
            )}

            {error && (
              <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
                {error}
              </p>
            )}

            {canWrite ? (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => save.mutate()}
                  disabled={!canSave}
                  className="ficus-button ficus-button-primary rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {save.isPending ? 'Saving…' : 'Save policy'}
                </button>
                {dirty && (
                  <button
                    type="button"
                    onClick={() => {
                      setError(null)
                      setDraftMode(null)
                      setDraftDomains(null)
                      setDraftRoleId(undefined)
                    }}
                    className="ficus-button ficus-button-secondary px-4 py-2 text-sm"
                  >
                    Cancel
                  </button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted">You need the settings:write permission to change this.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function describePolicy(settings: AuthSettings | undefined): string {
  switch (policyModeOf(settings)) {
    case 'open':
      return 'anyone can sign up'
    case 'domains':
      return `invited people, plus ${(settings?.allowedDomains ?? []).map((d) => `@${d}`).join(', ')}`
    default:
      return 'invite only'
  }
}

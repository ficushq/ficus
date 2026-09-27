import { CheckIcon, ClipboardIcon } from '../icons'
import { GitHubWebhookSettings } from './GitHubWebhookSettings'
import { GitHubRepositoryAccess } from './GitHubRepositoryAccess'
import { GitHubCommitSigning } from './GitHubCommitSigning'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { IntegrationAuthorizationStart } from '@ficus/shared'
import { FICUS_GITHUB_APP_CLIENT_ID } from '@ficus/shared/github-app'
import {
  setIntegrationDefault,
  setIntegrationEnabled,
  cancelIntegrationDeviceAuthorization,
  configureIntegrationOAuthApp,
  integrationAction,
  pollIntegrationDeviceAuthorization,
  removeIntegration,
  startIntegrationAuthorization,
} from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationAuthorizationReturnPath } from '../../lib/integrationReturnPath'
import { integrationErrorMessage, isFirstAdminIncomplete } from '../../lib/integrationErrorMessage'
import { useOptionalAuth } from '../../providers/AuthProvider'
import { integrationQueryKeys, onboardingQueryKeys } from '../../queryKeys'

type DeviceLogin = Extract<IntegrationAuthorizationStart, { kind: 'device' }>

/** Device login ended because it timed out or the user declined, not because something broke. */
const ENDED_DEVICE_CODES = new Set(['access_denied', 'expired_token', 'flow_expired', 'provider_denied'])

export function GitHubIntegrationSettings({
  canRead,
  canWrite,
  embedded = false,
  onboarding = false,
  onFinishAdminSetup,
}: {
  canRead: boolean
  canWrite: boolean
  embedded?: boolean
  onboarding?: boolean
  /** Opens the finish-admin-setup screen. Defaults to re-reading the session, which switches the app to it. */
  onFinishAdminSetup?: () => void
}) {
  const client = useQueryClient()
  const refreshSession = useOptionalAuth()?.refreshSession
  const finishAdminSetup = onFinishAdminSetup ?? (refreshSession ? () => void refreshSession() : undefined)
  const pool = useQuery({ ...integrationQueries.pool('github'), enabled: canRead })
  const catalog = useQuery({ ...integrationQueries.catalog(), enabled: canRead && onboarding })
  const githubEnabled = catalog.data?.integrations?.find((integration) => integration.key === 'github')?.enabled
  const app = useQuery({ ...integrationQueries.oauthApp('github'), enabled: canRead })
  // A connection may finish in another tab, or after the checklist's first request.
  // Re-read the checklist after fresh account/provider data, not only local mutations.
  useEffect(() => {
    if (onboarding && canRead && pool.isSuccess) void client.invalidateQueries({ queryKey: onboardingQueryKeys.all })
  }, [client, onboarding, canRead, pool.isSuccess, pool.data, pool.dataUpdatedAt, catalog.data, catalog.dataUpdatedAt])
  const [device, setDevice] = useState<DeviceLogin | null>(null)
  const deviceMinutesRemaining = device
    ? Math.max(0, Math.ceil((new Date(device.expiresAt).getTime() - Date.now()) / 60_000))
    : 0
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  // The failure came from the instance-password session before the first admin
  // has a passkey: offer to finish that setup instead of a Retry that can't work.
  const [adminSetupRequired, setAdminSetupRequired] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: integrationQueryKeys.all }),
      client.invalidateQueries({ queryKey: onboardingQueryKeys.all }),
    ])
  const defaultMutation = useMutation({
    mutationFn: (id: string) => setIntegrationDefault('github', id),
    onSuccess: refresh,
  })
  const authorize = useMutation({
    mutationFn: async (connectionId?: string) => {
      if (onboarding) await setIntegrationEnabled('github', true)
      return startIntegrationAuthorization('github', {
        returnTo: onboarding
          ? (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '') + '/onboarding'
          : integrationAuthorizationReturnPath(),
        ...(connectionId ? { connectionId } : {}),
      })
    },
    onMutate: () => {
      setError('')
      setAdminSetupRequired(false)
      setNotice('')
    },
    onSuccess: (result) => {
      if ('authorizationUrl' in result) window.location.assign(result.authorizationUrl)
      else setDevice(result)
    },
    onError: (failure) => {
      setError(integrationErrorMessage(failure, "Couldn't start GitHub login."))
      setAdminSetupRequired(isFirstAdminIncomplete(failure))
    },
  })
  // Each action replaces the previous failure, including a stale login failure and its Retry.
  const clearFailure = () => {
    setError('')
    setAdminSetupRequired(false)
    authorize.reset()
  }
  const reportFailure = (fallback: string) => (failure: unknown) => {
    setError(integrationErrorMessage(failure, fallback))
    setAdminSetupRequired(isFirstAdminIncomplete(failure))
  }
  const useConnected = useMutation({
    mutationFn: () => setIntegrationEnabled('github', true),
    onMutate: clearFailure,
    onSuccess: refresh,
    onError: reportFailure("Couldn't turn on GitHub."),
  })
  useEffect(() => {
    if (!device || !canWrite) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await pollIntegrationDeviceAuthorization(device.id)
        if (stopped) return
        setError('')
        if (result.status === 'complete') {
          setDevice(null)
          setNotice('GitHub account connected. Squads inherit the global default unless they choose another account.')
          await Promise.all([
            client.invalidateQueries({ queryKey: integrationQueryKeys.all }),
            client.invalidateQueries({ queryKey: onboardingQueryKeys.all }),
          ])
        } else if (result.status === 'failed') {
          setDevice(null)
          setError(
            ENDED_DEVICE_CODES.has(result.code)
              ? 'GitHub authorization expired or was declined. Connect again to start a new login.'
              : `GitHub authorization failed (${result.code}). Connect again to start a new login.`
          )
        } else timer = setTimeout(poll, Math.max(1, result.retryAfterSeconds) * 1000)
      } catch {
        if (stopped) return
        setError('Unable to check GitHub authorization. Retrying…')
        timer = setTimeout(poll, Math.max(5, device.intervalSeconds) * 1000)
      }
    }
    timer = setTimeout(poll, device.intervalSeconds * 1000)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [device, canWrite, client])
  useEffect(() => {
    if (!canWrite) {
      setClientSecret('')
      setAcknowledged(false)
      setDevice(null)
    }
  }, [canWrite])
  const cancel = useMutation({
    mutationFn: () => cancelIntegrationDeviceAuthorization(device!.id),
    onMutate: clearFailure,
    onSuccess: () => {
      setDevice(null)
      setError('')
    },
    onError: reportFailure("Couldn't cancel the GitHub login."),
  })
  const configure = useMutation({
    mutationFn: (useDefault: boolean) =>
      configureIntegrationOAuthApp(
        'github',
        useDefault
          ? { useDefault: true }
          : {
              clientId,
              ...(clientSecret ? { clientSecret } : {}),
              capabilitiesAcknowledged: true,
            }
      ),
    onMutate: clearFailure,
    onSuccess: async () => {
      setAcknowledged(false)
      await refresh()
    },
    onError: reportFailure("Couldn't save the GitHub App settings."),
    onSettled: () => setClientSecret(''),
  })
  const lifecycle = useMutation({
    mutationFn: async (input: { id: string; action: 'enable' | 'disable' | 'remove'; assigned: boolean }) => {
      if (input.action === 'remove') await removeIntegration(input.id, input.assigned)
      else await integrationAction(input.id, input.action, input.assigned)
    },
    onMutate: clearFailure,
    onError: reportFailure("Couldn't update the GitHub account."),
    onSuccess: async (_result, input) => {
      setConfirmation(null)
      if (input.action === 'remove')
        setNotice(
          'Account disconnected from Ficus. To revoke its GitHub authorization too, open GitHub settings → Applications → Authorized GitHub Apps.'
        )
      await refresh()
    },
  })
  const sortedAccounts = [...(pool.data ?? [])].sort(
    (left, right) => Number(right.isGlobalDefault) - Number(left.isGlobalDefault)
  )
  const hasAccounts = (pool.data?.length ?? 0) > 0
  const canConnect = canWrite && app.data?.configured && pool.isSuccess
  const usesFicusApp = app.data?.authority === 'platform_broker' || app.data?.clientId === FICUS_GITHUB_APP_CLIENT_ID
  const failure =
    error ||
    (app.isError && integrationErrorMessage(app.error, "Couldn't load the GitHub App settings.")) ||
    (pool.isError && integrationErrorMessage(pool.error, "Couldn't load GitHub accounts.")) ||
    ''
  if (!canRead) return null
  return (
    <section className={embedded ? undefined : 'border-b border-panel-border py-5'}>
      <div className="flex items-center justify-between gap-3">
        {!embedded && <h3 className="text-sm font-medium text-primary">GitHub</h3>}
        {canConnect && !hasAccounts && (
          <button
            type="button"
            className="ficus-button ficus-button-primary px-3 py-2 text-sm"
            disabled={authorize.isPending || !!device}
            onClick={() => authorize.mutate(undefined)}
          >
            Connect account
          </button>
        )}
      </div>
      {canConnect && !hasAccounts && usesFicusApp && (
        <p className="mt-2 text-xs text-muted">
          {app.data?.authority === 'local' && app.data.authorizationMode !== 'browser'
            ? "Uses Ficus's GitHub App, so no setup is needed. You'll get a code to enter on github.com."
            : "Uses Ficus's GitHub App, so no setup is needed. You'll sign in on github.com."}
        </p>
      )}
      <p className="mt-2 text-sm text-muted">
        {onboarding
          ? 'Connect your GitHub account, then grant repository access.'
          : 'The first connected account becomes the global default. Squads inherit it automatically and can choose other accounts.'}
      </p>
      <p className="mt-2 text-xs text-muted">
        Connecting an account does not grant repository access. Install{' '}
        {usesFicusApp ? 'Ficus Integration' : 'your GitHub App'} on your personal account or organization and choose its
        repositories. Organization access may require an owner's approval.
      </p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-accent-light">
        {usesFicusApp && (
          <a href="https://github.com/apps/ficus-integration/installations/new" target="_blank" rel="noreferrer">
            Grant repository access
          </a>
        )}
        <a href="https://github.com/settings/installations" target="_blank" rel="noreferrer">
          Manage GitHub App installations
        </a>
      </div>
      {(app.isPending || pool.isPending) && (
        <p role="status" className="mt-3 text-sm text-muted">
          Loading GitHub connections…
        </p>
      )}
      {device && (
        <div className="ficus-inset my-3 space-y-2 p-3" role="status">
          <p className="text-sm">Enter this code on GitHub:</p>
          <GitHubDeviceCode key={device.id} code={device.userCode} />
          <div className="flex gap-3">
            <a
              className="ficus-button ficus-button-primary px-3 py-2 text-sm"
              href={device.verificationUri}
              target="_blank"
              rel="noreferrer"
            >
              Open GitHub
            </a>
            <button
              type="button"
              className="ficus-button px-3 py-2 text-sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-muted">
            {deviceMinutesRemaining > 0
              ? `Waiting for authorization. This code expires in ${deviceMinutesRemaining} ${deviceMinutesRemaining === 1 ? 'minute' : 'minutes'}.`
              : 'This code has expired. Start a new login to continue.'}
          </p>
        </div>
      )}
      {defaultMutation.isError && (
        <p role="alert" className="text-sm text-status-danger-500">
          Could not change the global default. Please try again.
        </p>
      )}
      {sortedAccounts.map((connection) => (
        <div
          key={connection.id}
          className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-border py-3"
        >
          <div>
            <p className="text-sm font-medium">
              {connection.displayName}
              {connection.isGlobalDefault && <span className="ml-2 text-xs text-accent-light">Global default</span>}
            </p>
            <p className="text-xs text-muted">
              @{connection.configuration.login} ·{' '}
              {connection.enabled
                ? connection.authState === 'authenticated'
                  ? connection.healthState
                  : 'Reconnect required'
                : 'Disabled'}{' '}
              · Used by {connection.usage.squadCount} squads
            </p>
            {connection.enabled && connection.authState === 'authenticated' && (
              <>
                <GitHubRepositoryAccess
                  connectionId={connection.id}
                  login={connection.configuration.login ?? connection.displayName}
                  usesFicusApp={usesFicusApp}
                />
                <GitHubCommitSigning
                  connectionId={connection.id}
                  login={connection.configuration.login ?? connection.displayName}
                  canWrite={canWrite}
                  onReconnect={() => authorize.mutate(connection.id)}
                  reconnectPending={authorize.isPending || !!device}
                />
              </>
            )}
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              {!connection.isGlobalDefault && connection.enabled && (
                <button
                  type="button"
                  className="ficus-button text-xs"
                  disabled={defaultMutation.isPending}
                  onClick={() => defaultMutation.mutate(connection.id)}
                >
                  Make global default
                </button>
              )}
              <button
                type="button"
                className="ficus-button text-xs"
                disabled={authorize.isPending || !!device}
                onClick={() => authorize.mutate(connection.id)}
              >
                Reconnect
              </button>
              {(['toggle', 'remove'] as const).map((kind) => {
                const action = kind === 'toggle' ? (connection.enabled ? 'disable' : 'enable') : 'remove'
                const key = `${connection.id}:${action}`
                const assigned = action !== 'enable' && connection.usage.squadCount > 0
                return (
                  <button
                    key={kind}
                    type="button"
                    className="ficus-button text-xs"
                    disabled={lifecycle.isPending}
                    onClick={() => {
                      if (assigned && confirmation !== key) {
                        setConfirmation(key)
                        return
                      }
                      lifecycle.mutate({ id: connection.id, action, assigned })
                    }}
                  >
                    {confirmation === key
                      ? `Confirm for ${connection.usage.squadCount} squads`
                      : action === 'remove'
                        ? 'Disconnect'
                        : action === 'enable'
                          ? 'Enable'
                          : 'Disable'}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {onboarding &&
          canWrite &&
          githubEnabled === false &&
          pool.data?.some(
            (connection) =>
              connection.enabled && connection.authState === 'authenticated' && connection.healthState === 'healthy'
          ) && (
            <button
              type="button"
              onClick={() => useConnected.mutate()}
              disabled={useConnected.isPending}
              className="ficus-button ficus-button-primary mt-3 rounded-lg px-3 py-2 text-sm"
            >
              Use GitHub
            </button>
          )}
        {canConnect && hasAccounts && (
          <button
            type="button"
            className="ficus-button mt-3 text-sm text-accent-light hover:text-accent-hover disabled:opacity-50"
            disabled={authorize.isPending || !!device}
            onClick={() => authorize.mutate(undefined)}
          >
            Connect another account
          </button>
        )}
      </div>
      {app.data?.authority === 'local' && canWrite && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-muted">
            {onboarding ? 'Use your own GitHub App instead' : 'Use your own GitHub App'}
          </summary>
          <form
            className="mt-3 space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (acknowledged) configure.mutate(false)
            }}
          >
            <p className="text-xs text-muted">
              Enable expiring user tokens in the app's settings. With only a client ID, Ficus uses device login: enable
              device flow, and no public URL is needed. Adding a client secret switches to browser login, which
              redirects back to Ficus, so set the app's callback URL to{' '}
              <span className="break-all">{app.data.callbackUrl}</span>.
            </p>
            <label className="block text-sm text-primary">
              Client ID
              <input
                className="ficus-field mt-1 block h-10 w-full px-3 py-2 text-sm"
                aria-label="GitHub App client ID"
                placeholder="Iv23li…"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                required
              />
            </label>
            <label className="block text-sm text-primary">
              Client secret <span className="text-muted">(optional)</span>
              <input
                className="ficus-field mt-1 block h-10 w-full px-3 py-2 text-sm"
                aria-label="GitHub App client secret (optional)"
                placeholder="Enter a client secret for browser login"
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </label>
            <label className="flex gap-2 text-xs text-muted">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I
              enabled the required repository permissions: {app.data.requiredCapabilities.join(', ')}.
            </label>
            <div className="flex gap-3">
              <button
                className="ficus-button text-sm"
                disabled={!clientId.trim() || !acknowledged || configure.isPending || !!device}
              >
                Save app
              </button>
              <button
                type="button"
                className="ficus-button text-sm"
                disabled={configure.isPending || !!device}
                onClick={() => configure.mutate(true)}
              >
                Use Ficus app
              </button>
            </div>
          </form>
        </details>
      )}
      {!onboarding && <GitHubWebhookSettings canWrite={canWrite} managed={app.data?.authority === 'platform_broker'} />}
      {notice && (
        <p role="status" className="mt-3 text-sm text-muted">
          {notice}
        </p>
      )}
      {failure && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p role="alert" className="text-sm text-status-danger-600">
            {failure}
          </p>
          {adminSetupRequired && finishAdminSetup ? (
            <button
              type="button"
              className="ficus-button ficus-button-primary px-3 py-1.5 text-sm"
              onClick={finishAdminSetup}
            >
              Finish admin setup
            </button>
          ) : (
            authorize.isError &&
            canWrite && (
              <button
                type="button"
                className="ficus-button px-3 py-1.5 text-sm"
                disabled={authorize.isPending || !!device}
                onClick={() => authorize.mutate(authorize.variables)}
              >
                Retry
              </button>
            )
          )}
        </div>
      )}
    </section>
  )
}

function GitHubDeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="select-all font-mono text-xl tracking-widest">{code}</p>
      <button
        type="button"
        aria-label="Copy GitHub device code"
        title={copied ? 'Copied' : 'Copy code'}
        className="ficus-button rounded-md p-1.5 text-muted hover:text-primary"
        onClick={async () => {
          setCopyFailed(false)
          try {
            await navigator.clipboard.writeText(code)
            setCopied(true)
          } catch {
            setCopied(false)
            setCopyFailed(true)
          }
        }}
      >
        {copied ? <CheckIcon className="h-4 w-4" /> : <ClipboardIcon className="h-4 w-4" />}
      </button>
      {copied && <span className="text-xs text-muted">Copied</span>}
      {copyFailed && <span className="text-xs text-muted">Could not copy. Select the code to copy it manually.</span>}
    </div>
  )
}

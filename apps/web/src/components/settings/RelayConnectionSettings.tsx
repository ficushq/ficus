import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, getApiUrl } from '../../api/client'
import { usePermissions } from '../../hooks/usePermissions'
import { serverConnectionQueries } from '../../queryOptions'
import { serverConnectionQueryKeys, integrationQueryKeys } from '../../queryKeys'
import {
  disconnectServerConnection,
  pollServerConnection,
  startServerConnection,
  type ServerConnection,
  type ServerConnectionRequest,
} from '../../api/serverConnection'
import { Modal } from '../Modal'
import { OverflowMenu } from '../OverflowMenu'
import { ExternalLink, SETTINGS_BUTTON_SIZE, SETTINGS_HEADING, SettingsRow } from './SettingsRow'

const CONNECT_FORM_ID = 'ficus-account-connect'
const FIELD = 'ficus-field w-full rounded-lg border border-th-border bg-surface px-3 py-2 text-sm text-primary'

/** The connect form's default name: the name Ficus already knows, else this server's hostname. */
function defaultServerName(knownName: string | undefined, origin: string | null): string {
  if (knownName?.trim()) return knownName.trim()
  for (const candidate of [origin, typeof window === 'undefined' ? null : window.location.origin]) {
    try {
      if (candidate) return new URL(candidate).hostname
    } catch {
      // Fall through to the next address.
    }
  }
  return ''
}

/** "since Oct 6" (with the year when it isn't this year), the full date on hover. */
function ConnectedSince({ at }: { at: string }) {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return null
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const short = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return (
    <span className="font-normal text-muted">
      · since{' '}
      <time dateTime={at} title={date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}>
        {short}
      </time>
    </span>
  )
}

/** "Ficus account owner@example.com · connected by Noah", from whichever parts were recorded. */
function ConnectionDetails({ connection }: { connection: ServerConnection['connection'] }) {
  const email = connection?.accountEmail
  const by = connection?.connectedBy
  if (!email && !by) return null
  return (
    <span className="block">
      {email && (
        <>
          Ficus account <span className="break-all text-secondary">{email}</span>
        </>
      )}
      {email && by && ' · '}
      {by && `${email ? 'connected' : 'Connected'} by ${by}`}
    </span>
  )
}

export function RelayConnectionSettings() {
  const permissions = usePermissions()
  const canRead = permissions.identity?.type === 'user' && permissions.can('settings:read')
  const canWrite = canRead && permissions.can('settings:write')
  const client = useQueryClient()
  const connection = useQuery({ ...serverConnectionQueries.status(), enabled: canRead })
  const [name, setName] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'reconnect' | 'disconnect' | null>(null)
  const [request, setRequest] = useState<(ServerConnectionRequest & { expiresAt: number }) | null>(null)
  const [message, setMessage] = useState('')
  const [pollError, setPollError] = useState('')
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: serverConnectionQueryKeys.status() }),
      client.invalidateQueries({ queryKey: integrationQueryKeys.all }),
    ])
  const start = useMutation({
    mutationFn: startServerConnection,
    onSuccess: (value) => {
      setMessage('')
      setPollError('')
      setRequest({ ...value, expiresAt: Date.now() + value.expiresIn * 1000 })
    },
  })
  const disconnect = useMutation({
    mutationFn: disconnectServerConnection,
    onSuccess: async () => {
      setRequest(null)
      setDialog(null)
      setMessage('Disconnected. Your subscription is unchanged.')
      await refresh()
    },
  })
  useEffect(() => {
    if (!request || !canWrite) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (Date.now() >= request.expiresAt) {
        setPollError('This connection request expired. Connect again to continue.')
        setRequest(null)
        return
      }
      try {
        const result = await pollServerConnection(request.id, controller.signal)
        if (controller.signal.aborted) return
        setPollError('')
        if (result.status === 'pending') timer = setTimeout(poll, 3000)
        else {
          setRequest(null)
          setMessage(result.status === 'connected' ? 'Server connected.' : 'Connection declined. Nothing was changed.')
          if (result.status === 'connected') {
            void client.invalidateQueries({ queryKey: serverConnectionQueryKeys.status() })
            void client.invalidateQueries({ queryKey: integrationQueryKeys.all })
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (!(error instanceof ApiError) || error.status >= 500 || error.status === 429) {
          setPollError('Waiting for the server connection. Retrying automatically…')
          timer = setTimeout(poll, 5000)
        } else {
          setPollError(error.message)
          setRequest(null)
        }
      }
    }
    timer = setTimeout(poll, 3000)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [request, canWrite, client])
  if (!canRead) return null
  const data = connection.data
  const error = start.error ?? disconnect.error ?? connection.error
  const busy = start.isPending || disconnect.isPending || !!request
  const guide = (
    <ExternalLink href={getApiUrl('/docs/connect/mobile/')} className="inline-flex">
      Mobile setup guide
    </ExternalLink>
  )
  const feedback = (
    <>
      {(error || pollError) && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {pollError || (error instanceof Error ? error.message : 'Could not load the mobile connection.')}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      )}
    </>
  )

  if (connection.isPending || !data) {
    return (
      <div className="space-y-4">
        {connection.isPending && <p className="text-sm text-muted">Checking the Ficus account connection…</p>}
        {feedback}
        {guide}
      </div>
    )
  }

  if (data.managed) {
    return (
      <div className="space-y-6">
        <section data-setting-target="mobile-pro" tabIndex={-1} className="ficus-section scroll-mt-6 py-5">
          <SettingsRow
            label="Ficus Cloud manages this automatically. Nothing to set up."
            description="Push notifications, Live Activities and Pro are included for everyone on this server."
          />
        </section>
        {feedback}
        {guide}
      </div>
    )
  }

  const status = data.connected ? data.status : undefined
  const serverName = name ?? defaultServerName(status?.name, data.origin)
  const blocked = busy || !!data.setupError
  // Connected: the only actions are the rare Reconnect… and Disconnect…, behind a menu.
  // Otherwise connecting (or repairing) is the page's primary action.
  const showForm = canWrite && !request && !status
  const connect = (requested: string) => {
    const popup = window.open('about:blank', '_blank')
    if (popup) popup.opener = null
    start.mutate(requested.trim() || defaultServerName(undefined, data.origin), {
      onSuccess: (value) => {
        setDialog(null)
        if (popup) popup.location.href = value.approvalUrl
      },
      onError: () => popup?.close(),
    })
  }

  return (
    <div className="space-y-6">
      <section data-setting-target="mobile-pro" tabIndex={-1} className="ficus-section scroll-mt-6 py-5">
        <h4 className={SETTINGS_HEADING}>Ficus account</h4>
        <div className="space-y-4">
          {status ? (
            <SettingsRow
              label={
                <span className="flex flex-wrap items-center gap-x-2">
                  <span className="inline-flex items-center gap-1.5 text-status-success-700 dark:text-status-success-400">
                    <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />
                    Connected
                  </span>
                  <span className="font-normal text-secondary">as {status.name}</span>
                  {data.connection?.connectedAt && <ConnectedSince at={data.connection.connectedAt} />}
                </span>
              }
              description={
                <>
                  <ConnectionDetails connection={data.connection} />
                  <span className="block">Push notifications and Live Activities are on for phones with Pro.</span>
                </>
              }
              inlineControl
              control={
                canWrite && (
                  <OverflowMenu label="Ficus account actions" itemsMarker="data-ficus-account-actions">
                    <button type="button" disabled={busy} onClick={() => setDialog('reconnect')}>
                      Reconnect…
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="text-status-danger-600 dark:text-status-danger-400"
                      onClick={() => setDialog('disconnect')}
                    >
                      Disconnect…
                    </button>
                  </OverflowMenu>
                )
              }
            />
          ) : (
            <SettingsRow
              label={data.configured ? 'Connection needs attention' : 'Not connected'}
              description={
                data.configured
                  ? (data.error ?? 'Reconnect to restore push notifications and Live Activities.')
                  : 'Connect to turn on push notifications and Live Activities for phones with Pro.'
              }
              control={
                canWrite &&
                (showForm || data.configured) && (
                  <>
                    {showForm && (
                      <button
                        type="submit"
                        form={CONNECT_FORM_ID}
                        className={clsx('ficus-button ficus-button-primary', SETTINGS_BUTTON_SIZE)}
                        disabled={blocked}
                      >
                        {start.isPending
                          ? 'Starting connection…'
                          : data.configured
                            ? 'Reconnect Ficus account'
                            : 'Connect Ficus account'}
                      </button>
                    )}
                    {data.configured && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setDialog('disconnect')}
                        className={clsx('ficus-button ficus-button-secondary', SETTINGS_BUTTON_SIZE)}
                      >
                        Disconnect…
                      </button>
                    )}
                  </>
                )
              }
            />
          )}
          <div className="space-y-2 text-sm text-muted">
            <p>
              Connecting this server to a Ficus account lets it use the shared relays Ficus runs: push notifications and
              Live Activities for the Ficus app, and other shared relays, such as for integrations, as Ficus adds them.
              It doesn’t start a subscription.
            </p>
            <p>
              You don’t need Instance Pro to connect. People with their own Ficus Pro get push notifications and Live
              Activities from this server once it’s connected. Instance Pro only adds server-provided Pro slots for
              people who don’t have Pro.
            </p>
          </div>
          {data.setupError && (
            <p className="text-sm text-status-attention-600" role="status">
              {data.setupError}
            </p>
          )}
          {request && (
            <div className="ficus-inset space-y-2 p-4 text-sm" role="status">
              <p className="font-medium text-primary">Waiting for approval on ficus.sh…</p>
              <p className="text-muted">Check the server address and connection code match before approving.</p>
              <p className="font-mono text-primary">{request.id.slice(0, 8).toUpperCase()}</p>
              {data.origin && <p className="break-all text-muted">{data.origin}</p>}
              <ExternalLink href={request.approvalUrl} className="inline-flex">
                Open approval page
              </ExternalLink>
              <p className="text-xs text-muted">
                Keep this page open. The connection is saved here automatically after approval.
              </p>
            </div>
          )}
          {status ? (
            <SettingsRow label="Name" value={status.name} />
          ) : (
            showForm && (
              <form
                id={CONNECT_FORM_ID}
                onSubmit={(event) => {
                  event.preventDefault()
                  connect(serverName)
                }}
              >
                <SettingsRow
                  label={<label htmlFor={`${CONNECT_FORM_ID}-name`}>Server name</label>}
                  description="How this server appears in your Ficus account."
                  control={
                    <input
                      id={`${CONNECT_FORM_ID}-name`}
                      className={clsx(FIELD, 'sm:w-64')}
                      value={serverName}
                      maxLength={80}
                      disabled={blocked}
                      onChange={(event) => setName(event.target.value)}
                    />
                  }
                />
              </form>
            )
          )}
          <div data-setting-target="mobile-public-url" tabIndex={-1}>
            <SettingsRow
              label="Server address"
              description="Uses the public address from server setup, including any port or path."
              value={<span className="break-all font-mono text-xs">{data.origin || 'Not configured'}</span>}
            />
          </div>
        </div>
      </section>

      <section data-setting-target="instance-pro" tabIndex={-1} className="ficus-section scroll-mt-6 py-5">
        <h4 className={SETTINGS_HEADING}>Instance Pro</h4>
        {status ? (
          <div className="space-y-4">
            <SettingsRow
              label="Allowance"
              value={
                !status.instancePro
                  ? 'None'
                  : status.allowance === null
                    ? 'Unlimited'
                    : `${status.used} of ${status.allowance} slots used`
              }
            />
            <SettingsRow label="Devices using instance slots" value={String(status.used)} />
            <p className="text-xs text-muted">
              People with their own Ficus Pro get push notifications and Live Activities from this server without using
              a slot.
            </p>
            <ExternalLink href={data.manageUrl} className="inline-flex">
              Manage Pro and devices on ficus.sh
            </ExternalLink>
          </div>
        ) : (
          <div className="space-y-4">
            <SettingsRow
              label={
                data.configured
                  ? 'Reconnect the Ficus account to see this server’s Instance Pro allowance.'
                  : 'Connect a Ficus account to see this server’s Instance Pro allowance.'
              }
              description="Instance Pro gives people on this server Pro without their own subscription."
            />
            {data.configured && (
              <ExternalLink href={data.manageUrl} className="inline-flex">
                Manage Pro and devices on ficus.sh
              </ExternalLink>
            )}
          </div>
        )}
      </section>

      {feedback}
      {guide}

      <Modal
        isOpen={dialog === 'reconnect'}
        onClose={() => setDialog(null)}
        title="Reconnect Ficus account"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              className={clsx('ficus-button ficus-button-secondary', SETTINGS_BUTTON_SIZE)}
              onClick={() => setDialog(null)}
            >
              Cancel
            </button>
            <button
              type="submit"
              form={`${CONNECT_FORM_ID}-reconnect`}
              disabled={blocked}
              className={clsx('ficus-button ficus-button-primary', SETTINGS_BUTTON_SIZE)}
            >
              {start.isPending ? 'Starting…' : 'Reconnect'}
            </button>
          </div>
        }
      >
        <form
          id={`${CONNECT_FORM_ID}-reconnect`}
          className="space-y-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault()
            connect(serverName)
          }}
        >
          <p className="text-muted">
            Reconnecting replaces this server’s saved credential. Approve the same server in the same Ficus account to
            keep its devices and allowance.
          </p>
          <label className="block text-secondary">
            Server name
            <input
              className={clsx(FIELD, 'mt-1')}
              value={serverName}
              maxLength={80}
              disabled={blocked}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </form>
      </Modal>

      <Modal
        isOpen={dialog === 'disconnect'}
        onClose={() => setDialog(null)}
        title="Disconnect Ficus account?"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              className={clsx('ficus-button ficus-button-secondary', SETTINGS_BUTTON_SIZE)}
              onClick={() => setDialog(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
              className={clsx('ficus-button ficus-button-danger', SETTINGS_BUTTON_SIZE)}
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        }
      >
        <p className="text-sm text-muted">
          Push notifications and Live Activities from this server stop. Your subscription isn’t cancelled; manage
          billing and old servers on ficus.sh.
        </p>
      </Modal>
    </div>
  )
}

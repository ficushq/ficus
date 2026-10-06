import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, getApiUrl } from '../../api/client'
import { usePermissions } from '../../hooks/usePermissions'
import { serverConnectionQueries } from '../../queryOptions'
import { serverConnectionQueryKeys, integrationQueryKeys } from '../../queryKeys'
import {
  disconnectServerConnection,
  pollServerConnection,
  startServerConnection,
  type ServerConnectionRequest,
} from '../../api/serverConnection'
import { ConfirmButton } from '../ConfirmButton'

export function RelayConnectionSettings() {
  const permissions = usePermissions()
  const canRead = permissions.identity?.type === 'user' && permissions.can('settings:read')
  const canWrite = canRead && permissions.can('settings:write')
  const client = useQueryClient()
  const connection = useQuery({ ...serverConnectionQueries.status(), enabled: canRead })
  const [name, setName] = useState('')
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
  return (
    <section data-setting-target="mobile-pro" tabIndex={-1} className="ficus-section scroll-mt-6 space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-primary">Connection & Pro coverage</h4>
      </div>
      {connection.isPending ? (
        <p className="text-sm text-muted">Checking mobile connection…</p>
      ) : data?.managed ? (
        <div className="space-y-3 text-sm text-muted">
          <p>
            Mobile Pro features are included with paid Ficus Cloud access. Push delivery is managed automatically; no
            account connection or relay setup is needed here.
          </p>
          <p>Add this server in the Ficus mobile app and sign in to your instance account.</p>
          {data.origin && <p className="break-all text-xs">Server address: {data.origin}</p>}
        </div>
      ) : (
        data && (
          <>
            <p className="text-sm text-muted">
              Connect this self-hosted server to the Ficus push relay. Each device needs Ficus Pro on its personal
              account or a slot from this server’s Instance Pro allowance. Connecting does not start a subscription.
            </p>
            {data.connected && (
              <div className="space-y-1 text-sm">
                <p className="font-medium text-primary">
                  {data.status ? `Connected · ${data.status.name}` : 'Relay credential saved'}
                </p>
                {data.status && (
                  <p className="text-muted">
                    {data.status.instancePro
                      ? data.status.allowance === null
                        ? 'Instance Pro active · unlimited device allowance'
                        : `Instance Pro active · ${data.status.used} of ${data.status.allowance} device slots in use`
                      : 'No active Instance Pro allowance. Devices with personal Ficus Pro can still use the relay.'}
                  </p>
                )}
                {data.status && (
                  <p className="text-xs text-muted">
                    {data.status.registered} registered devices. Personal Ficus Pro devices do not use instance slots.
                  </p>
                )}
              </div>
            )}
            {data.setupError && (
              <p className="text-sm text-status-attention-600" role="status">
                {data.setupError}
              </p>
            )}
            {data.error && (
              <p className="text-sm text-status-attention-600" role="status">
                {data.error}
              </p>
            )}
            {canWrite && !request && (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  const popup = window.open('about:blank', '_blank')
                  if (popup) popup.opener = null
                  start.mutate(name.trim() || data.status?.name || 'My Ficus server', {
                    onSuccess: (value) => {
                      if (popup) popup.location.href = value.approvalUrl
                    },
                    onError: () => popup?.close(),
                  })
                }}
              >
                <label className="block max-w-sm text-sm text-secondary">
                  Server name
                  <input
                    className="ficus-field mt-1 w-full rounded-lg border border-th-border bg-surface px-3 py-2 text-primary"
                    value={name}
                    maxLength={80}
                    disabled={busy || !!data.setupError}
                    placeholder={data.status?.name ?? 'My Ficus server'}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                {data.origin && <p className="break-all text-xs text-muted">Server address: {data.origin}</p>}
                <button
                  type="submit"
                  className="ficus-button ficus-button-primary px-4 py-2 text-sm"
                  disabled={busy || !!data.setupError}
                >
                  {start.isPending
                    ? 'Starting connection…'
                    : data.configured
                      ? 'Reconnect Ficus account'
                      : 'Connect Ficus account'}
                </button>
                {data.configured && (
                  <p className="text-xs text-muted">
                    Reconnect to replace the saved credential. Approving the same server in the same account preserves
                    its devices and allowance.
                  </p>
                )}
              </form>
            )}
            {request && (
              <div className="ficus-inset space-y-2 p-4 text-sm" role="status">
                <p className="font-medium text-primary">Waiting for approval in Ficus Cloud…</p>
                <p className="text-muted">Check the server address and connection code match before approving.</p>
                <p className="font-mono text-primary">{request.id.slice(0, 8).toUpperCase()}</p>
                {data.origin && <p className="break-all text-muted">{data.origin}</p>}
                <a
                  href={request.approvalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex text-accent-light hover:underline"
                >
                  Open approval page →
                </a>
                <p className="text-xs text-muted">
                  Keep this page open. The connection is saved here automatically after approval.
                </p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <a
                href={data.manageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-light hover:underline"
              >
                Manage Pro and devices →
              </a>
              {canWrite && data.configured && (
                <ConfirmButton
                  onConfirm={() => disconnect.mutate()}
                  label={disconnect.isPending ? 'Disconnecting…' : 'Disconnect server'}
                  confirmLabel="Stop relay delivery?"
                  disabled={busy}
                  className="text-sm text-muted"
                  confirmClassName="text-sm text-status-danger-600"
                />
              )}
            </div>
            {canWrite && data.configured && (
              <p className="text-xs text-muted">
                Disconnecting stops this server’s relay delivery without cancelling billing. Revoke or archive its
                credential in Manage Pro to remove Cloud access as well.
              </p>
            )}
          </>
        )
      )}
      {(error || pollError) && (
        <p role="alert" className="text-sm text-status-danger-600">
          {pollError || (error instanceof Error ? error.message : 'Could not load the mobile connection.')}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      )}
      <a
        href={getApiUrl('/docs/connect/mobile/')}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex text-sm text-accent-light hover:underline"
      >
        Mobile setup guide →
      </a>
    </section>
  )
}

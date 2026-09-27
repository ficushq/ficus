import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import { approveDeviceAuthorization, revokeDevice, startPairing } from '../../api/devices'
import { queries } from '../../queryOptions'
import { getApiUrl } from '../../api/client'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'
import { DeviceAuthorizationApproval } from './DeviceAuthorizationApproval'
import { PairingCode } from './PairingCode'
import { renderPairing } from './pairingQr'
import {
  approveDeviceRequest,
  deviceApprovalErrorMessage,
  devicePlatformLabel,
  parseDeviceRequest,
} from './deviceAuthorizationApprovalLogic'

type PendingQr = Awaited<ReturnType<typeof renderPairing>> & { code: string }

function getDeviceRequest(): string {
  return typeof window === 'undefined' ? '' : parseDeviceRequest(window.location.hash)
}

export function DevicesSection() {
  const queryClient = useQueryClient()
  const [qr, setQr] = useState<PendingQr | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deviceRequest] = useState(getDeviceRequest)
  // Device ids present when the QR was generated, so we can detect a newly-paired one.
  const baselineIds = useRef<Set<string>>(new Set())

  const {
    data: devices = [],
    isLoading,
    isSuccess,
  } = useQuery({
    ...queries.devices.list(),
    // While a pairing QR is up, poll so the list reflects a successful pair within ~2.5s.
    refetchInterval: qr ? 2500 : false,
  })
  const authorization = useQuery(queries.devices.authorization(deviceRequest))
  const deviceSkeletonCount = useLoadingShapeCount('settings:paired-devices', isSuccess ? devices.length : undefined, {
    fallbackCount: 2,
    maxCount: 8,
  })

  const clearQr = useCallback(() => setQr(null), [])

  // When a new device appears while the QR is up, the phone paired → close the QR.
  useEffect(() => {
    if (!qr) return
    if (devices.some((d) => !baselineIds.current.has(d.id))) setQr(null)
  }, [qr, devices])

  const startMutation = useMutation({
    mutationFn: () => startPairing(),
    onSuccess: async (value) => {
      setError(null)
      baselineIds.current = new Set(devices.map((d) => d.id))
      setQr({ ...(await renderPairing(value)), code: value.code })
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Failed to start pairing'),
  })

  const approveMutation = useMutation({
    mutationFn: () =>
      approveDeviceRequest({
        verificationCode: deviceRequest,
        approve: approveDeviceAuthorization,
        clearFragment: () =>
          window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.devices.all }),
  })

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeDevice(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.devices.all }),
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-primary">Paired Devices</h2>
        <p className="text-sm text-muted mt-1">
          Connect the Ficus CLI or mobile app. Each paired client gets its own access token you can revoke here.
        </p>
      </div>

      {deviceRequest && (
        <DeviceAuthorizationApproval
          preview={authorization.data}
          isLoading={authorization.isLoading}
          invalid={authorization.isError}
          isPending={approveMutation.isPending}
          isSuccess={approveMutation.isSuccess}
          error={
            approveMutation.isError
              ? deviceApprovalErrorMessage(approveMutation.error, authorization.data?.platform)
              : null
          }
          onApprove={() => approveMutation.mutate()}
        />
      )}

      <div className="border-b border-panel-border last:border-b-0 p-4 space-y-2">
        <h3 data-setting-target="connect-the-tau-cli" className="text-sm font-medium text-primary">
          Connect the Ficus CLI
        </h3>
        <p className="text-sm text-muted">Run this command, then approve the request opened in your browser.</p>
        <code className="block rounded bg-surface-hover p-2 text-xs select-all">
          ficus auth login --api-url {getApiUrl()}
        </code>
      </div>

      {/* Pair */}
      <div className="border-b border-panel-border last:border-b-0 p-4 space-y-3">
        <h3 data-setting-target="pair-the-tau-mobile-app" className="text-sm font-medium text-primary">
          Pair the Ficus mobile app
        </h3>
        {qr ? (
          <PairingCode
            pairing={qr}
            onExpired={clearQr}
            onRegenerate={() => startMutation.mutate()}
            regenerating={startMutation.isPending}
          />
        ) : (
          <button
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending}
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm font-medium text-on-accent bg-accent rounded-md hover:bg-accent-hover disabled:opacity-50"
          >
            {startMutation.isPending ? 'Generating…' : 'Generate pairing QR'}
          </button>
        )}
        {error && <p className="text-sm text-status-danger-600 dark:text-status-danger-400">{error}</p>}
      </div>

      {/* List */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-primary">Paired devices</h3>
        {isLoading ? (
          <CollectionSkeleton label="Loading paired devices" count={deviceSkeletonCount} />
        ) : devices.length === 0 ? (
          <p className="text-sm text-muted italic">No paired devices.</p>
        ) : (
          <div className="space-y-1.5">
            {devices.map((d) => (
              <div
                key={d.id}
                className="border-b border-panel-border last:border-b-0 flex items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-primary">
                    {d.name}
                    <span className="ml-2 text-xs font-normal text-muted">({devicePlatformLabel(d.platform)})</span>
                  </p>
                  <p className="text-xs text-placeholder mt-0.5">
                    Paired {new Date(d.createdAt).toLocaleDateString()}
                    {d.lastUsedAt ? ` · last used ${new Date(d.lastUsedAt).toLocaleDateString()}` : ' · never used'}
                  </p>
                </div>
                <button
                  onClick={() => revokeMutation.mutate(d.id)}
                  disabled={revokeMutation.isPending}
                  className="ficus-button px-2 py-1 text-xs font-medium text-status-danger-600 dark:text-status-danger-400 border border-th-border rounded hover:bg-surface-hover disabled:opacity-50 shrink-0"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

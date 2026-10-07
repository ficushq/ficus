import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { startPairing } from '../../api/devices'
import { queries } from '../../queryOptions'
import { renderPairing, type RenderedPairing } from './pairingQr'

export type PendingPairing = RenderedPairing & { code: string }

/**
 * The one pairing flow behind Paired Devices and Mobile: mint a code, render
 * its QR and same-phone deep link, and close it once a new device appears.
 * While a code is up the device list polls, so a successful pair shows within
 * a few seconds.
 */
export function usePhonePairing() {
  const queryClient = useQueryClient()
  const [pairing, setPairing] = useState<PendingPairing | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Device ids present when the code was minted, so a newly paired one is detectable.
  const baselineIds = useRef<Set<string>>(new Set())

  const devicesQuery = useQuery({
    ...queries.devices.list(),
    refetchInterval: pairing ? 2500 : false,
  })
  const devices = devicesQuery.data

  useEffect(() => {
    if (!pairing || !devices) return
    if (devices.some((device) => !baselineIds.current.has(device.id))) setPairing(null)
  }, [pairing, devices])

  const start = useMutation({
    mutationFn: () => startPairing(),
    onSuccess: async (value) => {
      setError(null)
      // Take the baseline from a loaded list, so devices that were already paired
      // never read as new when the list arrives after the code.
      const current = await queryClient.ensureQueryData(queries.devices.list()).catch(() => devices ?? [])
      baselineIds.current = new Set(current.map((device) => device.id))
      setPairing({ ...(await renderPairing(value)), code: value.code })
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Failed to start pairing'),
  })

  const clear = useCallback(() => setPairing(null), [])
  const { mutate } = start
  const begin = useCallback(() => mutate(), [mutate])

  return {
    devicesQuery,
    pairing,
    error,
    start: begin,
    starting: start.isPending,
    clear,
  }
}

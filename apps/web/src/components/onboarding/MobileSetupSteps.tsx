import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import type { ServerAddressReach } from '../../api/publicUrl'
import { mobileAppInstall } from '../../lib/ficusMobileApp'
import { publicUrlQueries } from '../../queryOptions'
import { PairingCode } from '../settings/PairingCode'
import { ServerAddressSetup } from '../settings/ServerAddressSection'
import { ExternalLink, SETTINGS_BUTTON_SIZE } from '../settings/SettingsRow'
import { usePhonePairing } from '../settings/usePhonePairing'

const MOBILE_PLATFORMS = new Set(['ios', 'android'])

/** Optional setup: give the server an address a mobile device can open (Settings → Server address, inline). */
export function ServerAddressStep() {
  return <ServerAddressSetup />
}

/**
 * Optional setup: get the Ficus app and pair a mobile device. It follows the server address step: a pairing code
 * for an address the device cannot open only fails on the device, so pairing waits until the address is one a
 * mobile device can use.
 */
export function MobileAppStep() {
  const reach = useQuery(publicUrlQueries.reach())
  const { devicesQuery, pairing, error, start, starting, clear } = usePhonePairing()
  const paired = (devicesQuery.data ?? []).filter(
    (device) => MOBILE_PLATFORMS.has(device.platform) && !device.revokedAt
  ).length
  return (
    <MobileAppStepView
      reach={reach.data?.current.reach ?? null}
      paired={paired}
      pairing={pairing}
      starting={starting}
      error={error}
      onPair={start}
      onExpired={clear}
    />
  )
}

export function MobileAppStepView({
  reach,
  paired,
  pairing,
  starting,
  error,
  onPair,
  onExpired,
}: {
  /** Where the server's address can be opened from; null while that is loading. */
  reach: ServerAddressReach | null
  paired: number
  pairing: Parameters<typeof PairingCode>[0]['pairing'] | null
  starting: boolean
  error: string | null
  onPair: () => void
  onExpired?: () => void
}) {
  const install = mobileAppInstall()
  if (reach === null) return <p className="text-sm text-muted">Checking the server address…</p>
  if (reach === 'none' || reach === 'this-computer')
    return (
      <p className="text-sm text-secondary">
        First give this server an address a mobile device can open, in “Reach Ficus from a mobile device” above. The
        current address only works on this computer.
      </p>
    )
  return (
    <div className="space-y-3 text-sm text-secondary">
      <p>
        Your Feed, squads, chats and questions, on your mobile device.{' '}
        <ExternalLink href={install.url}>{install.label}</ExternalLink>
      </p>
      {reach === 'home-network' && (
        <p>This server’s address works only while the mobile device is on the same network.</p>
      )}
      {reach === 'tailscale' && <p>The mobile device needs the Tailscale app, signed in to the same account.</p>}
      {paired > 0 && (
        <p className="text-primary">
          {paired === 1 ? '1 mobile device is paired.' : `${paired} mobile devices are paired.`}
        </p>
      )}
      {pairing ? (
        <PairingCode
          pairing={pairing}
          onExpired={onExpired ?? (() => undefined)}
          onRegenerate={onPair}
          regenerating={starting}
          hint="Scan with the Ficus app, or open it on this device."
          getAppLink={false}
        />
      ) : (
        <button
          type="button"
          className={clsx('ficus-button ficus-button-primary', SETTINGS_BUTTON_SIZE)}
          disabled={starting}
          onClick={onPair}
        >
          {starting ? 'Generating…' : 'Pair a device'}
        </button>
      )}
      {error && (
        <p role="alert" className="text-status-danger-600 dark:text-status-danger-400">
          {error}
        </p>
      )}
    </div>
  )
}

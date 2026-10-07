import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getApiUrl } from '../../api/client'
import { usePermissions } from '../../hooks/usePermissions'
import { serverConnectionQueries } from '../../queryOptions'
import { devicePlatformLabel } from './deviceAuthorizationApprovalLogic'
import { PairingCode } from './PairingCode'
import { CopyButton, ExternalLink, QUIET_LINK, SETTINGS_BUTTON, SETTINGS_HEADING, SettingsRow } from './SettingsRow'
import { usePhonePairing } from './usePhonePairing'

const FICUS_MOBILE_URL = 'https://ficus.sh/mobile'
const MOBILE_PLATFORMS = new Set(['ios', 'android'])

/**
 * Personal Mobile: pair a mobile device, see your paired devices, and what Pro adds. Copy is
 * aware of the viewer and the server. Administrators see the Ficus account
 * status from the protected connection query; members only read the
 * member-safe relay availability and never fire the protected request.
 */
export function MobileSection() {
  const permissions = usePermissions()
  const isAdmin = permissions.identity?.type === 'user' && permissions.can('settings:read')
  const { devicesQuery, pairing, error, start, starting, clear } = usePhonePairing()
  const phones = (devicesQuery.data ?? []).filter(
    (device) => MOBILE_PLATFORMS.has(device.platform) && !device.revokedAt
  )

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h3 className="text-lg font-semibold text-primary">Mobile</h3>
        <p className="mt-1 text-sm text-muted">Use Ficus from your phone: your Feed, squads, chats and questions.</p>
        <ExternalLink href={FICUS_MOBILE_URL} className="mt-2 inline-flex">
          Learn more on ficus.sh
        </ExternalLink>
      </header>

      <section className="ficus-section py-5">
        {/* `pair-your-phone` keeps links from before the device-neutral copy working. */}
        <h4
          data-setting-target="pair-mobile-device"
          data-setting-fallback="pair-your-phone"
          tabIndex={-1}
          className={SETTINGS_HEADING}
        >
          Pair a mobile device
        </h4>
        <div className="space-y-4">
          <SettingsRow
            label="Pair with a QR code"
            description="Scan it with the Ficus app to sign in as you on this server."
            control={
              !pairing && (
                <button
                  type="button"
                  onClick={start}
                  disabled={starting}
                  className={clsx(SETTINGS_BUTTON, 'ficus-button-primary')}
                >
                  {starting ? 'Generating…' : 'Pair a device'}
                </button>
              )
            }
          />
          {pairing && (
            <div className="ficus-inset p-4">
              <PairingCode
                pairing={pairing}
                onExpired={clear}
                onRegenerate={start}
                regenerating={starting}
                hint="Scan with the Ficus app, or open it on this phone."
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
              {error}
            </p>
          )}
          {isAdmin ? <AdminServerAddressRow /> : <MemberServerAddressRow />}
          <p className="text-xs text-muted">
            Don’t have the app? <ExternalLink href={FICUS_MOBILE_URL}>Get it from ficus.sh</ExternalLink>
          </p>
        </div>
      </section>

      <section className="ficus-section py-5">
        <h4 className={SETTINGS_HEADING}>Your mobile devices</h4>
        <div className="space-y-3">
          {devicesQuery.isLoading ? (
            <p className="text-sm text-muted">Loading mobile devices…</p>
          ) : phones.length === 0 ? (
            <p className="text-sm text-muted">No mobile devices paired yet.</p>
          ) : (
            <ul aria-label="Your mobile devices" className="divide-y divide-panel-border">
              {phones.map((phone) => (
                <li key={phone.id} className="py-3 first:pt-0">
                  <p className="text-sm font-medium text-primary">{phone.name}</p>
                  <p className="text-xs text-muted">
                    {devicePlatformLabel(phone.platform)} · Paired {new Date(phone.createdAt).toLocaleDateString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <Link to="/settings?section=devices" className={clsx(QUIET_LINK, 'inline-flex')}>
            Manage all devices →
          </Link>
        </div>
      </section>

      <section className="ficus-section py-5">
        <h4 data-setting-target="mobile-free-and-pro" tabIndex={-1} className={SETTINGS_HEADING}>
          Free and Pro
        </h4>
        <div className="space-y-4">
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[3rem_1fr] sm:gap-y-2">
            <dt className="font-medium text-primary">Free</dt>
            <dd className="text-muted">Feed, squads, chats and answering questions.</dd>
            <dt className="mt-2 font-medium text-primary sm:mt-0">Pro</dt>
            <dd className="text-muted">
              Push notifications with filters and quiet hours, widgets and Live Activities.
            </dd>
          </dl>
          {isAdmin ? <AdminProStatus /> : <MemberProStatus />}
        </div>
      </section>
    </div>
  )
}

/**
 * Prefer the server's configured public address (APP_URL) over this browser's, which may be
 * localhost or a LAN IP a phone can't reach. Admins read it from the connection status they
 * already load; members from the member-safe relay availability, so neither fires the other's request.
 */
function AdminServerAddressRow() {
  const connection = useQuery(serverConnectionQueries.status())
  return <ServerAddressRow address={connection.data?.origin || getApiUrl()} />
}

function MemberServerAddressRow() {
  const availability = useQuery(serverConnectionQueries.availability())
  return <ServerAddressRow address={availability.data?.serverUrl || getApiUrl()} />
}

function ServerAddressRow({ address }: { address: string }) {
  return (
    <SettingsRow
      label="Server address"
      description={
        <>
          Or add this server in the app by its address:{' '}
          <span className="break-all font-mono text-xs text-secondary">{address}</span>
        </>
      }
      control={<CopyButton value={address} label="Copy address" />}
    />
  )
}

function HowToGetPro({ cloud }: { cloud: boolean }) {
  // Only a known Cloud server shows the Cloud line; an unknown server reads as self-hosted.
  return (
    <p className="text-sm text-muted">
      {cloud
        ? 'Paid Ficus Cloud includes Pro on this server automatically. Nothing to set up.'
        : 'Get Pro with your own Ficus Pro, or with a slot from this server’s Instance Pro allowance.'}
    </p>
  )
}

/** Members read only the member-safe relay availability, never the protected connection status. */
function MemberProStatus() {
  const availability = useQuery(serverConnectionQueries.availability())
  const cloud = availability.data?.delivery === 'direct'
  const needsConnection = !cloud && !availability.isPending && availability.data?.enabled !== true
  return (
    <>
      <HowToGetPro cloud={cloud} />
      {needsConnection && (
        <p className="text-sm text-muted">
          {availability.isError
            ? 'Push notifications and Live Activities need this server connected to a Ficus account. If they don’t arrive, ask your server administrator.'
            : 'Push notifications and Live Activities need this server connected to a Ficus account. Ask your server administrator.'}
        </p>
      )}
    </>
  )
}

/** Administrators see this server's Ficus account status, pointing to Mobile & Pro. */
function AdminProStatus() {
  const connection = useQuery(serverConnectionQueries.status())
  const data = connection.data
  if (data?.managed) return <HowToGetPro cloud />
  const name = data?.connected ? data.status?.name : undefined
  const connected = name !== undefined
  const status = connection.isPending
    ? 'Checking…'
    : connected
      ? `Connected as ${name}`
      : data?.configured
        ? 'Needs attention'
        : connection.isError
          ? 'Couldn’t check'
          : 'Not connected'
  return (
    <>
      <HowToGetPro cloud={false} />
      <div className="border-t border-th-border pt-4">
        <SettingsRow
          label={`Ficus account: ${status}`}
          description={
            connected
              ? 'Push notifications and Live Activities are on for phones with Pro.'
              : 'Connect this server to a Ficus account to turn on push notifications and Live Activities for phones with Pro.'
          }
          control={
            <Link to="/settings?section=mobile-pro" className={QUIET_LINK}>
              {connected ? 'Mobile & Pro →' : 'Set up in Mobile & Pro →'}
            </Link>
          }
        />
      </div>
    </>
  )
}

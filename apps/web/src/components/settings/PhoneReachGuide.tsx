import { type ReactNode } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  checkPublicAddress,
  type AddressCheckResult,
  type PhoneReachReport,
  type ServerAddressReach,
} from '../../api/publicUrl'
import { usePermissions } from '../../hooks/usePermissions'
import { desktopNetworkAccess } from '../../lib/desktop'
import { publicUrlQueryKeys } from '../../queryKeys'
import { publicUrlQueries } from '../../queryOptions'
import { CopyButton, ExternalLink, SETTINGS_BUTTON_SIZE, SETTINGS_HEADING } from './SettingsRow'

const DOCS = 'https://docs.ficus.sh/self-host/runtime-and-access/'

const CURRENT: Record<ServerAddressReach, string> = {
  none: 'No address is set yet, so a mobile device has nothing to connect to.',
  'this-computer': 'The current address only works on this computer. A mobile device needs one of the options below.',
  'home-network': 'The current address works for mobile devices on the same network as this server.',
  tailscale: 'The current address works for devices signed in to your Tailscale network.',
  public: 'The current address is a public one. Any mobile device can use it, as long as it leads to this server.',
}

const CHECKED: Record<Exclude<AddressCheckResult, { ok: true }>['reason'], string> = {
  invalid: 'That is not a web address.',
  unreachable: 'Nothing answered at that address.',
  timeout: 'That address did not answer in time.',
  certificate: 'That address answered with a certificate this server does not trust.',
  'not-this-server':
    'Something answered at that address, but it was not this server. Check the name, the port and the proxy.',
}

/**
 * Administration → Server address: how to give this server an address a mobile device can open. It reads what the
 * machine has (home-network addresses, Tailscale, what the server is listening on) and offers each as an
 * address to put in the field above. Nothing here changes the machine; commands are shown to copy. The one
 * exception is inside Ficus Desktop, which starts this server itself: there a switch asks Desktop to let the
 * network reach it, and Desktop confirms with the person before it restarts anything.
 */
export function PhoneReachGuide({ onUse }: { onUse: (url: string) => void }) {
  const permissions = usePermissions()
  const canRead = permissions.identity?.type === 'user' && permissions.can('settings:read')
  const canWrite = canRead && permissions.can('settings:write')
  const query = useQuery({ ...publicUrlQueries.reach(), enabled: canRead })
  const check = useMutation({ mutationFn: checkPublicAddress })
  const queryClient = useQueryClient()
  const setNetworkAccess = desktopNetworkAccess()
  const network = useMutation({
    mutationFn: (enabled: boolean) => setNetworkAccess!(enabled),
    // Declined, refused or done: show what the server is listening on now.
    onSettled: () => queryClient.invalidateQueries({ queryKey: publicUrlQueryKeys.reach() }),
  })
  const report = query.data
  if (!canRead || !report) return null
  return (
    <PhoneReachGuideView
      report={report}
      canWrite={canWrite}
      check={check.data ?? null}
      checking={check.isPending}
      onUse={onUse}
      onCheck={() => report.current.url && check.mutate(report.current.url)}
      networkSwitch={
        setNetworkAccess && canWrite
          ? {
              pending: network.isPending,
              error: network.isError
                ? network.error instanceof Error
                  ? network.error.message
                  : String(network.error)
                : null,
              set: (enabled) => network.mutate(enabled),
            }
          : undefined
      }
    />
  )
}

/** Ficus Desktop's own switch for what this server listens on; present only in its window of the local instance. */
export interface NetworkSwitch {
  pending: boolean
  error: string | null
  set: (enabled: boolean) => void
}

export function PhoneReachGuideView({
  report,
  canWrite,
  check,
  checking,
  onUse,
  onCheck,
  networkSwitch,
}: {
  report: PhoneReachReport
  canWrite: boolean
  check: AddressCheckResult | null
  checking: boolean
  onUse: (url: string) => void
  onCheck: () => void
  networkSwitch?: NetworkSwitch
}) {
  const { current, listening, homeNetwork, tailscale } = report
  const use = (url: string) =>
    canWrite && (
      <button
        type="button"
        className={clsx('ficus-button ficus-button-secondary', SETTINGS_BUTTON_SIZE)}
        onClick={() => onUse(url)}
      >
        Use this address
      </button>
    )
  return (
    <div data-setting-target="reach-from-a-mobile-device" tabIndex={-1} className="space-y-4">
      <div>
        <h4 className={SETTINGS_HEADING}>Reach this server from a mobile device</h4>
        <p className="text-sm text-secondary">{CURRENT[current.reach]}</p>
        {current.url && canWrite && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={clsx('ficus-button ficus-button-secondary', SETTINGS_BUTTON_SIZE)}
              disabled={checking}
              onClick={onCheck}
            >
              {checking ? 'Checking…' : 'Check this address'}
            </button>
          </div>
        )}
        {check && (
          <p role="status" className="mt-3 text-sm text-secondary">
            {check.ok
              ? 'This address leads back to this server. That was tried from the server itself, so a mobile device on another network can still be blocked by a router or firewall.'
              : CHECKED[check.reason]}
          </p>
        )}
      </div>

      <Option title="At home, on the same Wi-Fi">
        <p>
          Nothing to install. It works only while the mobile device is on this network, and the connection is not
          encrypted. Push notifications and other Pro features need an HTTPS address.
        </p>
        {networkSwitch && (
          <div className="space-y-2">
            <label className="flex items-center justify-between gap-4 text-sm font-medium text-primary">
              Let devices on this network connect
              <input
                type="checkbox"
                role="switch"
                checked={listening.beyondThisComputer}
                disabled={networkSwitch.pending}
                onChange={(event) => networkSwitch.set(event.target.checked)}
              />
            </label>
            <p>Ficus Desktop asks you to confirm, then restarts Ficus on this Mac. Agents that are working stop.</p>
            {networkSwitch.error && (
              <p role="alert" className="text-status-danger-600 dark:text-status-danger-400">
                {networkSwitch.error}
              </p>
            )}
          </div>
        )}
        {homeNetwork.addresses.length ? (
          <ul className="space-y-2">
            {homeNetwork.addresses.map((address) => (
              <li key={address} className="flex flex-wrap items-center gap-3">
                <code className="break-all font-mono text-xs text-primary">{address}</code>
                {use(address)}
              </li>
            ))}
          </ul>
        ) : (
          <p>No home-network address was found on this machine.</p>
        )}
        {!listening.beyondThisComputer &&
          !networkSwitch &&
          (listening.desktopManaged ? (
            <p>
              Ficus Desktop is listening on this computer only, so other devices cannot connect yet. In Ficus Desktop,
              choose File → Manage Instances… and turn on “Let devices on this network connect”. If that switch is
              missing, update Ficus Desktop.
            </p>
          ) : (
            <p>
              This server is listening on this computer only ({listening.host}), so other devices cannot connect yet.
              Set <code className="font-mono text-xs text-primary">HOST=0.0.0.0</code> in its environment and restart
              it.
            </p>
          ))}
      </Option>

      <Option title="Anywhere, with Tailscale">
        <p>
          A private network between your own devices; nothing is opened to the internet. The mobile device needs the
          Tailscale app, signed in to the same account. The address is HTTPS, so Pro features work.
        </p>
        {tailscale.state === 'not-installed' && <p>Tailscale was not found on this machine.</p>}
        {tailscale.state === 'stopped' && (
          <p>Tailscale is installed but not connected. Open it and sign in, then reload this page.</p>
        )}
        {tailscale.state !== 'not-installed' && (
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              <span className="block">
                Run this in a terminal on the server. HTTPS certificates must be on for your tailnet.
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-3">
                <code className="break-all font-mono text-xs text-primary">{tailscale.serveCommand}</code>
                <CopyButton value={tailscale.serveCommand} />
              </span>
              {tailscale.cli === 'app' && (
                <span className="mt-1 block">
                  Tailscale’s command-line tool is not installed on this machine, so this runs the copy inside the
                  Tailscale app.
                </span>
              )}
            </li>
            {tailscale.address && (
              <li>
                <span className="block">Then make this the public address.</span>
                <span className="mt-1 flex flex-wrap items-center gap-3">
                  <code className="break-all font-mono text-xs text-primary">{tailscale.address}</code>
                  {use(tailscale.address)}
                </span>
              </li>
            )}
          </ol>
        )}
        <p className="flex flex-wrap gap-x-5 gap-y-1">
          <ExternalLink href="https://tailscale.com/download">Get Tailscale</ExternalLink>
          <ExternalLink href="https://tailscale.com/docs/features/tailscale-serve">Tailscale Serve guide</ExternalLink>
        </p>
      </Option>

      <Option title="Anywhere, with your own domain">
        <p>
          A domain name pointed at this machine, and a reverse proxy that adds HTTPS. It works for any mobile device,
          and for integration webhooks. With Caddy:
        </p>
        <pre className="overflow-x-auto rounded bg-surface-hover p-3 font-mono text-xs text-primary">
          {`ficus.example.com {\n  reverse_proxy 127.0.0.1:${listening.port}\n}`}
        </pre>
        <p>
          <ExternalLink href={DOCS}>Reverse proxy guide</ExternalLink>
        </p>
      </Option>
    </div>
  )
}

function Option({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-lg border border-panel-border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-primary">{title}</summary>
      <div className="space-y-3 border-t border-panel-border px-4 py-3 text-sm text-secondary">{children}</div>
    </details>
  )
}

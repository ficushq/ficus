import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import {
  previewPublicAppUrl,
  savePublicAppUrl,
  type PublicAppUrlPreview,
  type PublicAppUrlStatus,
  type UrlChange,
} from '../../api/publicUrl'
import { usePermissions } from '../../hooks/usePermissions'
import { publicUrlQueries } from '../../queryOptions'
import { integrationQueryKeys, publicUrlQueryKeys, serverConnectionQueryKeys } from '../../queryKeys'
import { Modal } from '../Modal'
import { SETTINGS_BUTTON_SIZE, SettingsRow } from './SettingsRow'

const FORM_ID = 'public-address-form'
const FIELD = 'ficus-field w-full rounded-lg border border-th-border bg-surface px-3 py-2 text-sm text-primary'
const CONFLICT_MESSAGE = 'Someone else changed the public address. Review the current value and try again.'

/** What the Source line says about where the effective address comes from. */
function sourceDescription(status: PublicAppUrlStatus): ReactNode {
  if (status.lockedBy === 'managed') return 'Managed by Ficus Cloud.'
  if (status.source === 'environment') {
    if (status.environmentInvalid)
      return 'APP_URL in the server environment isn’t a valid address, so none is in use. Fix or remove it there.'
    return status.desktopManaged
      ? 'Set by the server environment. Update Ficus Desktop to change it here.'
      : 'Set by the server environment (APP_URL). Remove it there to change the address here.'
  }
  if (status.source === 'setting') return 'Configured here.'
  if (status.source === 'local-default')
    return 'Local only. Phones and other computers can’t reach this address. Set a public HTTPS address to connect them.'
  return 'Not set. Set the HTTPS address people and phones use to reach this server.'
}

function LastChange({ change }: { change: NonNullable<PublicAppUrlStatus['lastChange']> }) {
  const date = new Date(change.at)
  if (Number.isNaN(date.getTime())) return null
  const who = change.source === 'migration' ? 'Copied from APP_URL during an upgrade' : `Changed by ${change.actor}`
  return (
    <span className="block">
      {who} on{' '}
      <time dateTime={change.at}>{date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
    </span>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      className="ficus-button ficus-button-link shrink-0 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
        } catch {
          setCopied(false)
        }
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function UrlChanges({ title, changes }: { title: string; changes: UrlChange[] }) {
  const changed = changes.filter((change) => change.before !== change.after)
  if (!changed.length) return null
  return (
    <div className="space-y-2">
      <p className="font-medium text-primary">{title}</p>
      <ul className="space-y-2">
        {changed.map((change) => (
          <li key={change.label} className="ficus-inset space-y-1 p-3 text-xs">
            <p className="font-medium text-secondary">{change.label}</p>
            <p className="break-all font-mono text-muted">
              <span className="sr-only">Before: </span>
              {change.before ?? 'None'}
            </p>
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 break-all font-mono text-primary">
                <span aria-hidden="true">→ </span>
                <span className="sr-only">After: </span>
                {change.after ?? 'None'}
              </p>
              {change.after && <CopyButton value={change.after} label={`Copy new ${change.label}`} />}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The server's public address (Administration → Server address): the one address used for
 * links, sign-in, OAuth callbacks, webhooks and the Ficus app. Administrators change it
 * here unless the server environment (APP_URL) or Ficus Cloud sets it.
 */
export function PublicAddressSettings({ onSaved }: { onSaved?: (message: string) => void }) {
  const permissions = usePermissions()
  const canRead = permissions.identity?.type === 'user' && permissions.can('settings:read')
  const canWrite = canRead && permissions.can('settings:write')
  const client = useQueryClient()
  const query = useQuery({ ...publicUrlQueries.status(), enabled: canRead })
  const [draft, setDraft] = useState<string | null>(null)
  const [pending, setPending] = useState<{ url: string | null; version: string; preview: PublicAppUrlPreview } | null>(
    null
  )
  const [error, setError] = useState('')

  const preview = useMutation({
    mutationFn: async (input: { url: string | null; version: string }) => ({
      ...input,
      preview: await previewPublicAppUrl(input.url),
    }),
    onSuccess: (value) => {
      setError('')
      setPending(value)
    },
    onError: (value) => setError(value instanceof Error ? value.message : 'Could not check that address.'),
  })
  const save = useMutation({
    mutationFn: savePublicAppUrl,
    onSuccess: async (status, input) => {
      const reconnect = pending?.preview.impact.relayReconnectRequired ?? false
      setPending(null)
      setDraft(null)
      setError('')
      client.setQueryData(publicUrlQueryKeys.status(), status)
      await Promise.all([
        client.invalidateQueries({ queryKey: publicUrlQueryKeys.all }),
        client.invalidateQueries({ queryKey: serverConnectionQueryKeys.status() }),
        client.invalidateQueries({ queryKey: serverConnectionQueryKeys.availability() }),
        client.invalidateQueries({ queryKey: integrationQueryKeys.all }),
      ])
      const saved = input.url === null ? 'Public address cleared.' : 'Public address saved.'
      onSaved?.(reconnect ? `${saved} If this server was connected to a Ficus account, connect it again.` : saved)
    },
    onError: async (value) => {
      setPending(null)
      if (value instanceof ApiError && value.status === 409) {
        setError(CONFLICT_MESSAGE)
        await client.invalidateQueries({ queryKey: publicUrlQueryKeys.status() })
      } else setError(value instanceof Error ? value.message : 'Could not save the public address.')
    },
  })

  if (!canRead) return null
  const status = query.data
  if (!status) {
    return query.isPending ? <p className="text-sm text-muted">Checking the public address…</p> : null
  }
  const editable = canWrite && !status.locked
  const busy = preview.isPending || save.isPending
  const review = (url: string | null) => preview.mutate({ url, version: status.version })
  const impact = pending?.preview.impact
  const currentOrigin = typeof window === 'undefined' ? undefined : window.location.origin
  const originOf = (url: string | null | undefined) => {
    try {
      return url ? new URL(url).origin : undefined
    } catch {
      return undefined
    }
  }
  // Pinned FICUS_WEB_ORIGIN entries also stay allowed, but the UI can't see them; warn conservatively.
  const leavingCurrentOrigin =
    !!currentOrigin &&
    currentOrigin !== originOf(pending?.preview.effectiveUrl) &&
    currentOrigin !== originOf(status.localUrl)

  return (
    <div data-setting-target="server-address" tabIndex={-1} className="space-y-4">
      <SettingsRow
        label="Public address"
        description={
          <>
            <span className="block">{sourceDescription(status)}</span>
            <span className="block">
              Used for links, sign-in, integration callbacks, webhooks and the Ficus app. Include any port or path.
            </span>
            {status.lastChange && <LastChange change={status.lastChange} />}
          </>
        }
        value={<span className="break-all font-mono text-xs">{status.url ?? 'Not set'}</span>}
      />
      {status.localUrl && status.localUrl !== status.url && (
        <SettingsRow
          label="Local address"
          description="Where this computer reaches the server. It keeps working when a public address is set."
          value={<span className="break-all font-mono text-xs">{status.localUrl}</span>}
        />
      )}
      {editable && draft === null && (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={clsx('ficus-button ficus-button-secondary', SETTINGS_BUTTON_SIZE)}
            disabled={busy}
            onClick={() => {
              setError('')
              setDraft(status.storedUrl ?? '')
            }}
          >
            {status.storedUrl ? 'Change public address…' : 'Set public address…'}
          </button>
          {status.storedUrl && (
            <button
              type="button"
              className={clsx('ficus-button ficus-button-secondary', SETTINGS_BUTTON_SIZE)}
              disabled={busy}
              onClick={() => review(null)}
            >
              Clear…
            </button>
          )}
        </div>
      )}
      {editable && draft !== null && (
        <form
          id={FORM_ID}
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            review(draft.trim())
          }}
        >
          <label htmlFor={`${FORM_ID}-url`} className="block text-sm font-medium text-primary">
            New public address
          </label>
          <input
            id={`${FORM_ID}-url`}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={2048}
            placeholder="https://ficus.example.com"
            className={clsx(FIELD, 'font-mono')}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              className={clsx('ficus-button ficus-button-primary', SETTINGS_BUTTON_SIZE)}
              disabled={busy || !draft.trim()}
            >
              {preview.isPending ? 'Checking…' : 'Review change'}
            </button>
            <button
              type="button"
              className={clsx('ficus-button ficus-button-secondary', SETTINGS_BUTTON_SIZE)}
              disabled={busy}
              onClick={() => {
                setDraft(null)
                setError('')
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {error}
        </p>
      )}

      <Modal
        isOpen={!!pending}
        onClose={() => !save.isPending && setPending(null)}
        title={pending?.url === null ? 'Clear the public address?' : 'Change the public address?'}
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              className={clsx('ficus-button ficus-button-secondary', SETTINGS_BUTTON_SIZE)}
              disabled={save.isPending}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={clsx('ficus-button ficus-button-primary', SETTINGS_BUTTON_SIZE)}
              disabled={save.isPending}
              onClick={() => pending && save.mutate({ url: pending.url, expectedVersion: pending.version })}
            >
              {save.isPending ? 'Saving…' : pending?.url === null ? 'Clear address' : 'Save address'}
            </button>
          </div>
        }
      >
        {pending && impact && (
          <div className="space-y-4 text-sm text-secondary">
            <SettingsRow
              label="New address"
              value={
                <span className="break-all font-mono text-xs">
                  {pending.preview.effectiveUrl ?? 'None'}
                  {pending.url === null && pending.preview.effectiveUrl ? ' (local address)' : ''}
                </span>
              }
            />
            <ul className="list-disc space-y-2 pl-5">
              <li>Takes effect right away for links, sign-in, integrations and the Ficus app. No restart needed.</li>
              {impact.originChanged && (
                <>
                  {leavingCurrentOrigin && (
                    <li className="font-medium text-status-attention-600">
                      You’re using {currentOrigin}, which won’t be an allowed address after this change. You may be
                      signed out here and unable to sign in again at this address.
                    </li>
                  )}
                  <li>
                    Passkeys don’t carry over to a new hostname.{' '}
                    {status.localUrl
                      ? `Existing passkeys keep working at the local address (${status.localUrl}), and you can still pair phones from there.`
                      : 'Existing passkeys keep working only at the hostname they were made on.'}
                  </li>
                  <li>
                    To use a passkey at the new address, open Account → Passkeys → Add a passkey for another address. It
                    gives you a one-time code (valid 15 minutes) and never removes passkeys or signs anyone out. After
                    saving, do it from this tab or the local address and open the link it shows for the new address. A
                    code made before saving has no link for the new address: type it at{' '}
                    {pending.preview.effectiveUrl
                      ? `${pending.preview.effectiveUrl}/add-passkey`
                      : '<new address>/add-passkey'}
                    .
                  </li>
                  <li>
                    “Lost your passkey?” on the sign-in page is a last resort: it needs email delivery from this server,
                    and it replaces all of your existing passkeys and signs out every session.
                  </li>
                  <li>
                    If you lose access, set APP_URL in the server environment and restart Ficus. It overrides this
                    setting.
                  </li>
                </>
              )}
              {impact.relayReconnectRequired && (
                <li>
                  If this server is connected to a Ficus account, connect it again afterwards. Phones pair with the new
                  address again. Devices and Instance Pro slots stay with the old address in your Ficus account; they
                  don’t move to the new one.
                </li>
              )}
              {!impact.mobileReady && <li>The Ficus app and Mobile & Pro need an HTTPS address.</li>}
              {impact.basePathMismatch && (
                <li>
                  The path in this address doesn’t match the path the web app was built for (APP_BASE_PATH). Links may
                  not open until they match.
                </li>
              )}
              <li>Ficus checks the address format only. It doesn’t check that the address reaches this server.</li>
            </ul>
            <UrlChanges title="Update these in your OAuth apps" changes={impact.oauthCallbacks} />
            <UrlChanges title="Update these webhook URLs" changes={impact.webhooks} />
          </div>
        )}
      </Modal>
    </div>
  )
}

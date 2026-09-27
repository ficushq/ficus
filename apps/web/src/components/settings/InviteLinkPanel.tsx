import { useNavigate } from 'react-router-dom'
import { desktopBridge, desktopInstance } from '../../lib/desktop'
import { useOptionalAuth } from '../../providers/AuthProvider'

export interface IssuedInviteLink {
  url: string
  /** The invitee holds the system admin role. */
  forAdmin: boolean
}

function inviteToken(url: string): string | null {
  try {
    return new URL(url, window.location.origin).searchParams.get('token')
  } catch {
    return null
  }
}

/**
 * The one-time invite link a no-email instance hands to the admin.
 *
 * Normally it is copied and sent to the invitee. A pending ADMIN is different
 * inside Tau Desktop (or when the viewer is the instance-password session setting
 * up its own admin): the passkey belongs where that admin will sign in, and one
 * created in an external browser can't be used in the desktop app. There the
 * panel offers to open the link in this window, through the app's own route.
 */
export function InviteLinkPanel({ invite, onDone }: { invite: IssuedInviteLink; onDone: () => void }) {
  const navigate = useNavigate()
  const inDesktop = desktopBridge() !== undefined
  // A local or attached instance's passkey lives on this machine, so setting it up here is
  // correct. A remote instance's passkey would be created on the viewer's machine, not the
  // paired Mac, so the invite must be copied there instead. An older build that doesn't report
  // an instance kind is treated like local/attached (its known desktop behavior).
  const instance = desktopInstance()
  const desktopSupportsOpenHere = inDesktop && (instance === undefined || instance.kind !== 'remote')
  const viewerIsBootstrap = useOptionalAuth()?.session?.identityType === 'legacy'
  const token = inviteToken(invite.url)
  const openHere = invite.forAdmin && token !== null && (desktopSupportsOpenHere || viewerIsBootstrap)

  return (
    <div className="ficus-section py-4 space-y-2 border-status-success-300 dark:border-status-success-700">
      <p className="text-sm font-medium text-primary">Invite link created</p>
      <p className="text-xs text-muted">
        Email isn’t configured, so share this one-time link with the invitee. It takes them straight to passkey setup
        and works once (valid 7 days):
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 px-2 py-1.5 text-xs bg-surface-secondary rounded border border-th-border break-all">
          {invite.url}
        </code>
        <button
          onClick={() => navigator.clipboard?.writeText(invite.url)}
          className="ficus-button px-2 py-1.5 text-xs font-medium text-secondary bg-surface-secondary rounded hover:bg-surface-hover shrink-0"
        >
          Copy
        </button>
      </div>
      {openHere && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => navigate(`/register?token=${encodeURIComponent(token)}`)}
            className="ficus-button ficus-button-primary px-3 py-1.5 bg-accent text-on-accent rounded-md text-xs font-medium hover:bg-accent-hover shrink-0"
          >
            Open in Tau
          </button>
          <p className="text-xs text-muted">
            {inDesktop
              ? 'Sets up this admin’s passkey here and signs this window in as them. A passkey created in another browser can’t be used in Tau Desktop.'
              : 'Sets up this admin’s passkey here and signs this window in as them.'}
          </p>
        </div>
      )}
      <button onClick={onDone} className="ficus-button text-xs text-muted hover:text-primary">
        Done
      </button>
    </div>
  )
}

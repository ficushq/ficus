import clsx from 'clsx'
import { useMutation } from '@tanstack/react-query'
import type { HostKeyState, PublicHostKey, RemoteHost } from '../../api/remote-hosts'
import { ConfirmButton } from '../ConfirmButton'

const STATE_LABEL: Record<HostKeyState, string> = {
  trusted: 'Host key trusted',
  adopting: 'Adopting host key',
  changed: 'Host key changed',
  pending: 'Confirm host key',
  unverified: 'No host key',
}

const STATE_HELP: Record<HostKeyState, string> = {
  trusted: 'Agents connect with strict checking against the trusted key.',
  adopting:
    'This host was added before host keys were confirmed. Ficus is adopting the key your boxes already trust; connections stay strictly checked meanwhile.',
  changed:
    'The host presented a different key than the one you trusted. Connections are refused until you trust or reject the new key. If you did not expect a change, reject it and investigate.',
  pending:
    'Agents cannot connect until you confirm the host key. Compare the fingerprint with one you get from the host itself (for example: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub).',
  unverified: 'Agents cannot connect. Fetch the host key, then confirm it.',
}

export function HostKeyStateBadge({ state }: { state: HostKeyState | undefined }) {
  if (!state) return null
  return (
    <span
      className={clsx(
        'text-xs px-1.5 py-0.5 rounded',
        state === 'trusted' &&
          'bg-status-success-100 dark:bg-status-success-900/30 text-status-success-700 dark:text-status-success-400',
        state === 'adopting' && 'bg-surface-secondary border border-th-border text-secondary',
        (state === 'pending' || state === 'unverified') &&
          'bg-status-warning-100 dark:bg-status-warning-900/30 text-status-warning-700 dark:text-status-warning-400',
        state === 'changed' &&
          'bg-status-danger-100 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-400'
      )}
    >
      {STATE_LABEL[state]}
    </span>
  )
}

function decisionText(key: PublicHostKey): string | null {
  if (!key.decidedAt) return null
  const when = new Date(key.decidedAt).toLocaleString()
  return `${key.decisionNote ?? key.status} · ${when}`
}

interface Props {
  host: RemoteHost
  /** Whether the viewer may fetch keys and decide on them (the server still requires a signed-in person). */
  canAct: boolean
  scan: () => Promise<unknown>
  decide: (keyId: string, decision: 'trust' | 'reject') => Promise<unknown>
  onChanged: () => void
}

/**
 * The host-key screen for one remote host: its state, each key's type and
 * SHA256 fingerprint with Trust / Reject for pending keys (a key change shows
 * the trusted fingerprint it would replace), and a Fetch action.
 */
export function HostKeysPanel({ host, canAct, scan, decide, onChanged }: Props) {
  const state = host.hostKeyState
  const keys = host.hostKeys ?? []
  const scanMutation = useMutation({ mutationFn: scan, onSuccess: onChanged })
  const decideMutation = useMutation({
    mutationFn: ({ keyId, decision }: { keyId: string; decision: 'trust' | 'reject' }) => decide(keyId, decision),
    onSuccess: onChanged,
  })
  const error = scanMutation.error ?? decideMutation.error
  const fetchError = (scanMutation.data as RemoteHost | undefined)?.fetchError ?? host.hostKeyCheckError
  const busy = scanMutation.isPending || decideMutation.isPending
  const visible = keys.filter((k) => k.status !== 'replaced' || state === 'changed')

  return (
    <div className="space-y-2 text-xs" data-testid="host-keys-panel">
      <div className="flex items-center gap-2 flex-wrap">
        <HostKeyStateBadge state={state} />
        {canAct && (
          <button
            onClick={() => scanMutation.mutate()}
            disabled={busy}
            className="ficus-button ficus-button-link text-xs font-medium disabled:opacity-50"
          >
            {scanMutation.isPending ? 'Fetching…' : 'Fetch host key'}
          </button>
        )}
      </div>
      {state && <p className="text-muted">{STATE_HELP[state]}</p>}
      {fetchError && (
        <p className="text-status-danger-600 dark:text-status-danger-400">Last fetch failed: {fetchError}</p>
      )}
      {visible.length > 0 && (
        <ul className="space-y-1.5">
          {visible.map((key) => (
            <li key={key.id} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
              <span className="font-mono text-secondary break-all">
                {key.keyType} {key.fingerprint}
              </span>
              <span className="text-muted">
                {key.status}
                {decisionText(key) ? ` — ${decisionText(key)}` : ''}
              </span>
              {key.status === 'pending' && key.replacesFingerprints.length > 0 && (
                <span className="text-status-danger-600 dark:text-status-danger-400">
                  replaces trusted {key.replacesFingerprints.join(', ')}
                </span>
              )}
              {canAct && key.status === 'pending' && (
                <span className="flex items-center gap-2">
                  <ConfirmButton
                    variant="secondary"
                    className="px-2 py-0.5 text-xs rounded"
                    label="Trust"
                    confirmLabel="Confirm trust?"
                    ariaLabel={`Trust ${key.keyType} key ${key.fingerprint}`}
                    disabled={busy}
                    onConfirm={() => decideMutation.mutate({ keyId: key.id, decision: 'trust' })}
                  />
                  <ConfirmButton
                    className="px-2 py-0.5 text-xs rounded"
                    label="Reject"
                    confirmLabel="Confirm reject?"
                    ariaLabel={`Reject ${key.keyType} key ${key.fingerprint}`}
                    disabled={busy}
                    onConfirm={() => decideMutation.mutate({ keyId: key.id, decision: 'reject' })}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-status-danger-600 dark:text-status-danger-400">{(error as Error).message}</p>}
    </div>
  )
}

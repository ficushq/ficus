import { useLayoutEffect, useState, type ComponentProps } from 'react'
import { Link } from 'react-router'
import { useVoiceAccounts } from './voiceAccounts'
import { useStableRef } from '../../hooks/useStableRef'
import { DeriveVoiceCard } from './DeriveVoiceCard'
import { VoicePicker } from './VoicePicker'

/** The shared instance-level account picker. A new selection owns an entirely fresh draft. */
export function AccountVoiceDerivation({
  onTargetChange,
  ...cardProps
}: Omit<ComponentProps<typeof DeriveVoiceCard>, 'target' | 'linkedLogin'> & {
  onTargetChange?: () => void
}) {
  const { accounts, isPending, error } = useVoiceAccounts()
  const [chosen, setChosen] = useState('')
  const selected = accounts.find((c) => c.id === chosen) ?? (accounts.length === 1 ? accounts[0] : undefined)
  const onChangeRef = useStableRef(onTargetChange)
  const activeTarget = isPending || error ? undefined : selected?.id
  // Also discard an editor owned by the caller when the account disappears or becomes unusable.
  useLayoutEffect(() => () => onChangeRef.current?.(), [activeTarget, onChangeRef])
  if (isPending) return <p className="text-sm text-muted">Loading GitHub accounts…</p>
  if (error)
    return (
      <p role="alert" className="text-sm text-status-danger-500">
        Could not load GitHub accounts. Check access in <Link to="/settings?section=integrations">Integrations</Link>.
      </p>
    )
  if (!accounts.length)
    return (
      <Link to="/settings?section=integrations" className="text-sm text-accent-light hover:underline">
        Connect a GitHub account first
      </Link>
    )
  return (
    <div className="space-y-3">
      <span className="block text-xs text-muted">GitHub account to read through</span>
      <VoicePicker
        label="GitHub account to read through"
        className="min-h-11 w-full sm:min-h-0 sm:w-auto"
        value={selected?.id ?? ''}
        options={[
          { value: '', label: 'Choose a GitHub account' },
          ...accounts.map((c) => ({
            value: c.id,
            label: c.displayName ? `${c.login} (${c.displayName})` : c.login,
          })),
        ]}
        onChange={(id) => {
          setChosen(id)
        }}
      />
      {selected && (
        <DeriveVoiceCard
          key={selected.id}
          target={{ kind: 'connection', connectionId: selected.id }}
          linkedLogin={selected.login}
          {...cardProps}
        />
      )}
    </div>
  )
}

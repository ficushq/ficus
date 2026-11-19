import { useState } from 'react'
import { PUBLIC_VOICE_ID_PATTERN } from '@ficus/shared'
import { Modal } from '../Modal'
import { useAdjustOnChange } from '../../hooks/useAdjustOnChange'

/** Asks for a new voice profile's id and name. */
export function NewProfileDialog({
  isOpen,
  onClose,
  onSubmit,
  pending,
  error,
}: {
  isOpen: boolean
  onClose: () => void
  onSubmit: (profile: { id: string; name: string }) => void
  pending?: boolean
  error?: string | null
}) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  useAdjustOnChange([isOpen], () => {
    setId('')
    setName('')
  })
  const trimmedId = id.trim()
  const validId = PUBLIC_VOICE_ID_PATTERN.test(trimmedId) && trimmedId.length <= 100
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New voice profile"
      footer={
        <div className="flex justify-end gap-2">
          <button className="ficus-button ficus-button-ghost rounded-md px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="ficus-button ficus-button-primary rounded-md px-3 py-1.5 text-sm"
            disabled={!validId || pending}
            onClick={() => onSubmit({ id: trimmedId, name: name.trim() || trimmedId })}
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block text-xs text-muted">
          Profile id (lowercase words joined by hyphens, for example platform-team)
          <input
            aria-label="Profile id"
            className="ficus-field mt-1 w-full rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
        </label>
        {trimmedId && !validId && (
          <p className="text-xs text-status-danger-500">Use lowercase letters, digits and hyphens.</p>
        )}
        <label className="block text-xs text-muted">
          Name
          <input
            aria-label="Profile name"
            className="ficus-field mt-1 w-full rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && <p className="text-xs text-status-danger-500">{error}</p>}
      </div>
    </Modal>
  )
}

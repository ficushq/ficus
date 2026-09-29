import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Modal } from '../Modal'
import { deleteSquad } from '../../api/squads'
import { queryKeys } from '../../queryKeys'
import { usePermissions } from '../../hooks/usePermissions'

interface Props {
  isOpen: boolean
  onClose: () => void
  squadId: string
  squadName: string
}

export function DeleteSquadModal({ isOpen, onClose, squadId, squadName }: Props) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [confirmText, setConfirmText] = useState('')
  const [deleteWorkspace, setDeleteWorkspace] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canDeleteSquad = !permissionsLoading && can('squads:delete')

  const mutation = useMutation({
    mutationFn: () => deleteSquad(squadId, deleteWorkspace),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
      // Dismiss the modal and reset its state on success. Without this, archiving
      // from the /squads list left the modal open with no feedback: navigate('/squads')
      // is a no-op when you're already there, and it was the ONLY success action.
      setConfirmText('')
      setDeleteWorkspace(false)
      onClose()
      navigate('/squads')
    },
  })

  const isConfirmed = confirmText === squadName

  const handleClose = () => {
    setConfirmText('')
    setDeleteWorkspace(false)
    mutation.reset()
    onClose()
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Archive Squad"
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={handleClose} className="ficus-button ficus-button-secondary px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!isConfirmed || mutation.isPending || !canDeleteSquad}
            title={canDeleteSquad ? 'Archive squad' : 'You do not have permission to delete squads'}
            className="ficus-button px-4 py-2 text-sm font-medium text-on-strong bg-status-danger-600 hover:bg-status-danger-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors"
          >
            {mutation.isPending ? 'Archiving...' : 'Archive Squad'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          This will archive the squad <span className="font-semibold text-primary">{squadName}</span>. The squad will be
          hidden and made inactive, but its history is preserved for audit.
        </p>

        <label className="flex items-start gap-3 p-3 border border-th-border rounded-lg bg-surface-secondary">
          <input
            type="checkbox"
            checked={deleteWorkspace}
            onChange={(e) => setDeleteWorkspace(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-primary">Also delete workspace files — permanent</span>
            <span className="block text-xs text-muted">
              Permanently removes all workspace files on disk. This cannot be undone.
            </span>
          </span>
        </label>

        <div>
          <label className="block text-sm text-secondary mb-1.5">
            Type <span className="font-mono font-semibold text-primary">{squadName}</span> to confirm
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={squadName}
            className="ficus-field w-full px-3 py-2 text-sm rounded-md border border-th-border bg-surface text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
            autoFocus
          />
        </div>

        {mutation.isError && (
          <p className="text-sm text-status-danger-600 dark:text-status-danger-400">
            Failed to archive squad: {(mutation.error as Error).message}
          </p>
        )}
      </div>
    </Modal>
  )
}

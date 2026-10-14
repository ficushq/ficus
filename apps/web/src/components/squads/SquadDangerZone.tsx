import { useId, useState } from 'react'
import { usePermissions } from '../../hooks/usePermissions'
import { DeleteSquadModal } from './DeleteSquadModal'

interface Props {
  squadId: string
  squadName: string
}

/**
 * Rare, destructive squad actions, kept at the bottom of Squad Settings > General
 * instead of the squad header.
 *
 * Gated on `squads:delete` alone. `squads:update` gates editing the other General
 * fields and is neither required nor sufficient here. Fails closed while the
 * permission set is unresolved; the server remains authoritative.
 */
export function SquadDangerZone({ squadId, squadName }: Props) {
  const [showArchiveModal, setShowArchiveModal] = useState(false)
  const headingId = useId()
  const { can, isLoading, isError } = usePermissions(squadId)

  if (isLoading || isError || !can('squads:delete')) return null

  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h3 id={headingId} data-setting-target="archive-squad" className="text-sm font-medium text-primary mb-3">
        Danger zone
      </h3>
      <div className="flex flex-col gap-3 rounded-lg border border-status-danger-border p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <p className="min-w-0 text-sm text-secondary">
          Archiving hides this squad and makes it inactive; its history is preserved for audit.
        </p>
        <button
          type="button"
          onClick={() => setShowArchiveModal(true)}
          className="ficus-button ficus-button-danger shrink-0 self-start px-3 py-1.5 text-sm font-medium rounded-md transition-colors sm:self-auto"
        >
          Archive squad
        </button>
      </div>

      <DeleteSquadModal
        isOpen={showArchiveModal}
        onClose={() => setShowArchiveModal(false)}
        squadId={squadId}
        squadName={squadName}
      />
    </section>
  )
}

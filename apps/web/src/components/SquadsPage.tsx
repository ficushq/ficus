import { type ComponentProps, type ComponentType, useState } from 'react'
import { SquadList } from './squads/SquadList'
import { CreateSquadModal } from './squads/CreateSquadModal'
import { usePermissions } from '../hooks/usePermissions'

interface SquadsPageDependencies {
  SquadList: ComponentType<ComponentProps<typeof SquadList>>
  CreateSquadModal: ComponentType<ComponentProps<typeof CreateSquadModal>>
}

interface SquadsPageProps {
  dependencies?: Partial<SquadsPageDependencies>
}

export function SquadsPage({ dependencies = {} }: SquadsPageProps) {
  const { SquadList: SquadListComponent = SquadList, CreateSquadModal: CreateSquadModalComponent = CreateSquadModal } =
    dependencies
  const [showCreateModal, setShowCreateModal] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canCreateSquad = !permissionsLoading && can('squads:create')

  return (
    <>
      <div className="flex justify-between items-center gap-3 mb-4">
        {/* Title and New Squad button - always on same line */}
        <div className="flex items-center justify-between grow">
          <h2 className="text-lg font-semibold text-primary">Squads</h2>
        </div>

        {canCreateSquad && (
          <button
            onClick={() => setShowCreateModal(true)}
            className="ficus-button ficus-button-primary px-3 py-1.5 bg-accent text-on-accent rounded-md text-sm font-medium hover:bg-accent-hover"
          >
            New Squad
          </button>
        )}
      </div>

      <SquadListComponent />

      {canCreateSquad && (
        <CreateSquadModalComponent isOpen={showCreateModal} onClose={() => setShowCreateModal(false)} />
      )}
    </>
  )
}

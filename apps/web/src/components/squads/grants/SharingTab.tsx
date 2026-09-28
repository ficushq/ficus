import { type ComponentProps, type ComponentType, useState } from 'react'
import { usePermissions } from '../../../hooks/usePermissions'
import { CreateGrantForm } from './CreateGrantForm'
import { InboundGrantsList } from './InboundGrantsList'
import { OutboundGrantsList } from './OutboundGrantsList'

interface SharingTabComponents {
  CreateGrantForm: ComponentType<ComponentProps<typeof CreateGrantForm>>
  InboundGrantsList: ComponentType<ComponentProps<typeof InboundGrantsList>>
  OutboundGrantsList: ComponentType<ComponentProps<typeof OutboundGrantsList>>
}

interface Props {
  squadId: string
  components?: Partial<SharingTabComponents>
}

export function SharingTab({ squadId, components = {} }: Props) {
  const {
    CreateGrantForm: CreateForm = CreateGrantForm,
    InboundGrantsList: InboundList = InboundGrantsList,
    OutboundGrantsList: OutboundList = OutboundGrantsList,
  } = components
  const [showCreate, setShowCreate] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWriteGrants = !permissionsLoading && can('grants:write')

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-primary">Memory this squad shares</h3>
            <p className="text-xs text-muted mt-0.5">Outbound grants from this squad to other squads.</p>
          </div>
          {canWriteGrants && !showCreate && (
            <button
              onClick={() => setShowCreate(true)}
              className="ficus-button ficus-button-primary px-3 py-1.5 text-sm font-medium text-on-accent bg-accent rounded hover:bg-accent-hover"
            >
              Share memory
            </button>
          )}
        </div>
        {canWriteGrants && showCreate && <CreateForm sourceSquadId={squadId} onClose={() => setShowCreate(false)} />}
        <div className="mt-4">
          <OutboundList sourceSquadId={squadId} />
        </div>
      </section>

      <section>
        <div className="mb-4">
          <h3 className="font-semibold text-primary">Memory shared with this squad</h3>
          <p className="text-xs text-muted mt-0.5">
            Inbound grants. The squad&apos;s agents can search this memory by default and read/write within the granted
            scopes.
          </p>
        </div>
        <InboundList granteeSquadId={squadId} />
      </section>
    </div>
  )
}

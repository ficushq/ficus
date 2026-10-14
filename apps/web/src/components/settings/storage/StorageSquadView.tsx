import { useState, type ReactNode } from 'react'
import {
  isLiveAgentStatus,
  STORAGE_DORMANCY_EXEMPT_AGENT_TYPES,
  type StorageFolder,
  type StorageSquad,
} from '@ficus/shared'
import { usePermissions } from '../../../hooks/usePermissions'
import { removeDormantAgents } from '../../../api/system'
import { terminateSquadAgent } from '../../../api/squads'
import { ChevronRightIcon } from '../../icons'
import { ConfirmStorageAction } from './ConfirmStorageAction'
import { FolderRow } from './FolderRow'
import { IdleConsultantsDialog } from './IdleConsultantsDialog'
import { agentDetails, automaticRemovalDate, measuredSize, removalSummary, storageSize, sumBytes } from './format'

interface Props {
  squad: StorageSquad
  /** False for the copies of a squad on its second and later machines: squad-wide actions appear once. */
  showSquadActions?: boolean
  retentionDays: number
  onDone: (message: string) => void
}

type Dialog =
  | { kind: 'dormant'; folder: StorageFolder }
  | { kind: 'remove'; folders: StorageFolder[] }
  | { kind: 'idle' }

/** Snapshots saved before agent attribution have a bare "Agent files" home with no agent details. */
const isAgentFolder = (folder: StorageFolder) =>
  folder.kind === 'agent' || (!folder.kind && folder.name === 'Agent files')
const bySize = (a: StorageFolder, b: StorageFolder) => (b.bytes ?? -1) - (a.bytes ?? -1)

function AgentRow({ folder, action }: { folder: StorageFolder; action?: ReactNode }) {
  const agent = folder.agent
  const row = (
    <span className="inline-flex w-full min-w-0 items-center justify-between gap-4">
      <span className="min-w-0">
        <span className="block break-words text-primary" title={folder.path}>
          {agent ? agent.label : 'Agent'}
        </span>
        <span className="block text-xs text-secondary">
          {agent ? agentDetails(agent) : 'Details appear after the next scan'}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className="tabular-nums text-secondary">{measuredSize(folder)}</span>
        {action}
      </span>
    </span>
  )
  return (
    <div data-storage-agent={agent?.id} className="text-sm">
      {folder.children.length ? (
        <details className="[&[open]>summary>svg]:rotate-90">
          <summary className="flex cursor-pointer list-none items-center gap-1 py-2 [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-secondary" />
            {row}
          </summary>
          <div className="ml-4 border-l border-th-border pl-3">
            {folder.children.map((child) => (
              <FolderRow key={child.name} folder={child} />
            ))}
          </div>
        </details>
      ) : (
        <div className="py-2 pl-5">{row}</div>
      )}
    </div>
  )
}

function RowButton({ label, onClick, danger = false }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        // Inside a <summary>, a click would also toggle the row open.
        event.preventDefault()
        onClick()
      }}
      className={
        danger
          ? 'ficus-button ficus-button-danger px-2 py-1 text-xs'
          : 'ficus-button ficus-button-secondary px-2 py-1 text-xs'
      }
    >
      {label}
    </button>
  )
}

export function StorageSquadView({ squad, showSquadActions = true, retentionDays, onDone }: Props) {
  const { can } = usePermissions(squad.id)
  const { can: canGlobal } = usePermissions()
  const canTerminate = can('agents:terminate')
  const canCleanup = canGlobal('system:cleanup')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const close = () => setDialog(null)

  const workspace = squad.folders.filter((folder) => !isAgentFolder(folder))
  const agentFolders = squad.folders.filter(isAgentFolder)
  const dormant = agentFolders.filter((folder) => folder.agent?.status === 'dormant').sort(bySize)
  const others = agentFolders.filter((folder) => folder.agent?.status !== 'dormant').sort(bySize)
  const removalDate = automaticRemovalDate(
    dormant.map((folder) => folder.agent!.dormantAt),
    retentionDays
  )
  const dormantSummary = `${dormant.length} dormant · ${storageSize(sumBytes(dormant))} · ${
    removalDate ? `removed automatically from ${removalDate}` : `removed automatically after ${retentionDays} days`
  }`

  const makeDormantAction = (folder: StorageFolder) => {
    const agent = folder.agent
    if (!canTerminate || !agent || !isLiveAgentStatus(agent.status)) return undefined
    if (STORAGE_DORMANCY_EXEMPT_AGENT_TYPES.includes(agent.agentTypeId)) return undefined
    return <RowButton label="Make dormant" onClick={() => setDialog({ kind: 'dormant', folder })} />
  }
  const removeAction = (folder: StorageFolder) =>
    folder.agent?.removalPending ? (
      <span className="text-xs text-secondary">Removing…</span>
    ) : canCleanup ? (
      <RowButton danger label="Remove now" onClick={() => setDialog({ kind: 'remove', folders: [folder] })} />
    ) : undefined
  const removable = dormant.filter((folder) => !folder.agent?.removalPending)

  const removing = dialog?.kind === 'remove' ? dialog.folders : []
  const removingBytes = storageSize(sumBytes(removing))
  const dormantFolder = dialog?.kind === 'dormant' ? dialog.folder : null

  return (
    <details className="[&[open]>summary>svg]:rotate-90">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-secondary" />
        <span className="inline-flex w-full min-w-0 justify-between gap-4 text-sm">
          <span className="min-w-0 break-words font-medium">{squad.name}</span>
          <span className="shrink-0 tabular-nums">{measuredSize(squad)}</span>
        </span>
      </summary>
      <div className="space-y-2 pb-3 pl-5">
        {canTerminate && showSquadActions && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setDialog({ kind: 'idle' })}
              className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs"
            >
              Make idle consultants dormant…
            </button>
          </div>
        )}
        {workspace.map((folder, index) => (
          <FolderRow key={`workspace-${index}`} folder={folder} />
        ))}
        {agentFolders.length > 0 && (
          <div>
            <h4 className="pt-2 text-xs font-medium uppercase tracking-wide text-secondary">Agents</h4>
            {others.map((folder, index) => (
              <AgentRow key={folder.agent?.id ?? `agent-${index}`} folder={folder} action={makeDormantAction(folder)} />
            ))}
            {dormant.length > 0 && (
              <details className="text-sm [&[open]>summary>svg]:rotate-90">
                <summary className="flex cursor-pointer list-none items-center gap-1 py-2 text-secondary [&::-webkit-details-marker]:hidden">
                  <ChevronRightIcon className="h-4 w-4 shrink-0" />
                  <span>{dormantSummary}</span>
                </summary>
                <div className="ml-4 border-l border-th-border pl-3">
                  {canCleanup && removable.length > 1 && (
                    <div className="flex justify-end py-1">
                      <RowButton
                        danger
                        label={`Remove all ${removable.length} now`}
                        onClick={() => setDialog({ kind: 'remove', folders: removable })}
                      />
                    </div>
                  )}
                  {dormant.map((folder) => (
                    <AgentRow key={folder.agent!.id} folder={folder} action={removeAction(folder)} />
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      <ConfirmStorageAction
        isOpen={dormantFolder !== null}
        onClose={close}
        title="Make agent dormant"
        confirmLabel="Make dormant"
        action={() => terminateSquadAgent(squad.id, dormantFolder!.agent!.id)}
        onDone={() => onDone(`${dormantFolder?.agent?.label ?? 'The agent'} is dormant.`)}
      >
        <p>
          <span className="font-medium text-primary">{dormantFolder?.agent?.label}</span> stops and releases its
          compute. A new message to it wakes it again.
        </p>
        <p>
          No space is freed now: its files ({measuredSize(dormantFolder ?? { bytes: null })}) stay on disk while it is
          dormant. It is removed automatically {retentionDays} days after it becomes dormant, which frees that space.
        </p>
      </ConfirmStorageAction>

      <ConfirmStorageAction
        isOpen={removing.length > 0}
        onClose={close}
        danger
        title={removing.length === 1 ? 'Remove dormant agent now' : `Remove ${removing.length} dormant agents now`}
        confirmLabel={removing.length === 1 ? 'Remove now' : `Remove ${removing.length} now`}
        action={() => removeDormantAgents(removing.map((folder) => folder.agent!.id))}
        onDone={(result) => onDone(removalSummary(result))}
      >
        <p>
          Permanently removes{' '}
          <span className="font-medium text-primary">
            {removing.length === 1 ? removing[0]!.agent!.label : `${removing.length} dormant agents`}
          </span>{' '}
          now instead of after the {retentionDays}-day retention period.
        </p>
        <p>
          The agent&apos;s home is archived and removed from the machine, and the agent can no longer be woken or
          reused. This frees up to {removingBytes}.
        </p>
        <p>
          Removal runs in the background over the next few minutes; until then the agent shows as Removing…. Sizes
          update after the next scan.
        </p>
      </ConfirmStorageAction>

      {dialog?.kind === 'idle' && (
        <IdleConsultantsDialog squad={squad} retentionDays={retentionDays} onClose={close} onDone={onDone} />
      )}
    </details>
  )
}

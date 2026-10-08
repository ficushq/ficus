import { ActionPopup, type PopupAction } from '../ThemedPopup'
import { MoreIcon, PlusIcon } from '../icons'

interface SquadChatActionsProps {
  canCreateConsultant: boolean
  canSpawnAgent: boolean
  canManageChats: boolean
  managingChats: boolean
  onManageChats: () => void
  onNewChat: () => void
  onSpawnAgent: () => void
}

export function SquadChatActions({
  canCreateConsultant,
  canSpawnAgent,
  canManageChats,
  managingChats,
  onManageChats,
  onNewChat,
  onSpawnAgent,
}: SquadChatActionsProps) {
  const actions: PopupAction[] = []
  if (canManageChats)
    actions.push({
      id: 'manage',
      label: managingChats ? 'Done managing chats' : 'Manage chats',
      onSelect: onManageChats,
    })
  if (canSpawnAgent)
    actions.push({
      id: 'spawn',
      label: 'Spawn agent…',
      onSelect: onSpawnAgent,
      opensDialog: true,
      icon: <PlusIcon className="h-3.5 w-3.5" />,
    })
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {canCreateConsultant && (
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New consultant chat"
          title="New consultant chat"
          className="ficus-button ficus-button-primary flex h-[26px] items-center gap-1 rounded-md px-2 text-xs font-medium"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          New chat
        </button>
      )}
      {actions.length > 0 && (
        <ActionPopup
          label="Chat options"
          items={actions}
          className="ficus-button ficus-button-ghost flex h-[26px] w-[26px] items-center justify-center rounded-md"
        >
          <MoreIcon className="h-4 w-4" />
        </ActionPopup>
      )}
    </div>
  )
}

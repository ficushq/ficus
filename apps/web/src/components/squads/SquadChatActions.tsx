import { Presence } from '../Presence'
import { useEffect, useRef, useState } from 'react'
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
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelector<HTMLButtonElement>('.squad-chat-options button')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setMenuOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menuOpen])

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {canCreateConsultant && (
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New consultant chat"
          title="New consultant chat"
          className="ficus-button ficus-button-primary flex h-[26px] items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-on-accent hover:bg-accent-hover"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          New chat
        </button>
      )}
      {(canSpawnAgent || canManageChats) && (
        <div
          ref={menuRef}
          className="relative"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false)
          }}
        >
          <button
            ref={triggerRef}
            type="button"
            aria-label="Chat options"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="ficus-button flex h-[26px] w-[26px] items-center justify-center rounded-md text-secondary hover:bg-surface-hover hover:text-primary"
          >
            <MoreIcon className="h-4 w-4" />
          </button>
          <Presence
            open={menuOpen}
            className="ficus-overlay squad-chat-options absolute right-0 top-full z-30 mt-1 w-40 rounded-lg border border-th-border bg-surface p-1 shadow-theme-lg"
          >
            {canManageChats && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onManageChats()
                  triggerRef.current?.focus()
                }}
                className="ficus-button flex w-full rounded-md px-2 py-2 text-left text-xs text-primary hover:bg-surface-hover"
              >
                {managingChats ? 'Done managing chats' : 'Manage chats'}
              </button>
            )}
            {canSpawnAgent && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onSpawnAgent()
                }}
                className="ficus-button flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-primary hover:bg-surface-hover"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Spawn agent…
              </button>
            )}
          </Presence>
        </div>
      )}
    </div>
  )
}

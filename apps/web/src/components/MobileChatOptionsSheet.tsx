import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useStableRef } from '../hooks/useStableRef'
import { CloseIcon } from './icons'
import { Presence } from './Presence'
import './ResponsiveChat.css'

/** Portal above app navigation and fullscreen chats, outside their stacking contexts. */
export function MobileChatOptionsSheet({
  open,
  onClose,
  triggerRef,
  children,
}: {
  open: boolean
  onClose: () => void
  triggerRef: RefObject<HTMLButtonElement | null>
  children: ReactNode
}) {
  const layerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useStableRef(onClose)

  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const panel = panelRef.current
    panel?.focus({ preventScroll: true })
    const viewport = window.visualViewport
    const resize = () => {
      layerRef.current?.style.setProperty('--chat-options-top', `${viewport?.offsetTop ?? 0}px`)
      layerRef.current?.style.setProperty('--chat-options-height', `${viewport?.height ?? window.innerHeight}px`)
    }
    resize()
    viewport?.addEventListener('resize', resize)
    viewport?.addEventListener('scroll', resize)
    window.addEventListener('resize', resize)
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCloseRef.current()
      } else if (event.key === 'Tab') {
        const buttons = Array.from(panel?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const first = buttons[0]
        const last = buttons.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    // Capture before fullscreen and command-bar Escape handlers.
    document.addEventListener('keydown', keydown, true)
    return () => {
      viewport?.removeEventListener('resize', resize)
      viewport?.removeEventListener('scroll', resize)
      window.removeEventListener('resize', resize)
      document.removeEventListener('keydown', keydown, true)
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [open, onCloseRef, triggerRef])

  if (typeof document === 'undefined') return null

  return createPortal(
    <Presence
      open={open}
      ref={layerRef}
      className="mobile-chat-options md:hidden fixed inset-x-0 z-[70] flex items-end bg-chrome-scrim/40"
      onClick={(event) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className="mobile-chat-options-panel ficus-overlay relative w-full max-h-full overflow-y-auto overscroll-contain rounded-t-2xl border border-th-border bg-surface p-3 outline-none"
        role="dialog"
        aria-modal="true"
        aria-label="Attach or change controls"
        tabIndex={-1}
      >
        <div className="flex items-center justify-between pl-3 pb-1">
          <span className="text-sm font-medium text-primary">Chat options</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat options"
            className="ficus-button flex items-center justify-center w-11 h-11 rounded-md text-muted hover:bg-surface-hover"
          >
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </Presence>,
    document.body
  )
}

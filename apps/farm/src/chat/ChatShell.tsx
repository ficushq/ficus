import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CloseIcon } from '../icons'
import { useStableRef } from '../hooks/useStableRef'

/**
 * The chat's wooden frame: a side panel on wide screens, a full-height sheet
 * under 640px. It takes focus when it opens (the conversation moves it on to
 * the composer), closes on Escape, and hands focus back to whatever opened it.
 */
export function ChatShell({
  title,
  subtitle,
  header,
  leading,
  onClose,
  children,
}: {
  title: string
  subtitle?: string
  header?: ReactNode
  /** Shown left of the title, e.g. the robot's portrait that opens its card. */
  leading?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const titleId = useId()
  const ref = useRef<HTMLElement>(null)
  const onCloseRef = useStableRef(onClose)
  // Captured on first render, before the conversation's effects move focus into the chat.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))

  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  }, [opener])

  return (
    <section
      ref={ref}
      className="g-chat"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          // Drafts are kept, so Escape can close from anywhere in the chat, composer included.
          e.stopPropagation()
          onCloseRef.current()
        }
      }}
    >
      <header className="g-chat-header">
        {leading && <div className="g-chat-leading">{leading}</div>}
        <div className="g-chat-heading">
          {subtitle && <p className="g-eyebrow g-chat-subtitle">{subtitle}</p>}
          <h2 id={titleId} className="g-chat-title">
            {title}
          </h2>
        </div>
        <button type="button" className="g-card-close g-chat-close" aria-label="Close chat" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {header && <div className="g-chat-header-extra">{header}</div>}
      {children}
    </section>
  )
}

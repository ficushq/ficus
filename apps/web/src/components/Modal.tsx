/* eslint-disable react-refresh/only-export-components -- layout constants are verified by the DOM harness. */
import clsx from 'clsx'
import { Presence } from './Presence'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'
import { CloseIcon } from './icons'
import './ResponsiveChat.css'

type ModalSize = 'default' | 'viewport' | 'editor'

export const VIEWPORT_MODAL_HEIGHT =
  'calc(var(--modal-viewport-height, 100dvh) - 2rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))'
export const MODAL_SIZE_STYLE: Record<ModalSize, CSSProperties | undefined> = {
  default: undefined,
  editor: undefined,
  viewport: {
    height: VIEWPORT_MODAL_HEIGHT,
    maxHeight: VIEWPORT_MODAL_HEIGHT,
    maxWidth: 'calc(100vw - 2rem)',
  },
}

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  titleContent?: ReactNode
  /** Fill the visual viewport at phone widths, including when the keyboard opens. */
  mobileFullscreen?: boolean
  children: ReactNode
  headerExtra?: ReactNode
  headerActions?: ReactNode
  footer?: ReactNode
  /**
   * The maximum width of the modal.
   * - 'default': max-w-lg tailwind class
   * - 'readable': 70ch (optimal reading width)
   * - 'chat': 90ch (chat width where messages are 80% of the width)
   */
  maxWidth?: 'default' | 'readable' | 'chat' | 'wide'
  /** Use a nearly full-viewport panel while retaining the shared dialog behavior. */
  size?: ModalSize
  overlayClassName?: string
  noChildPadding?: boolean
}

export function Modal({
  isOpen,
  onClose,
  title,
  titleContent,
  mobileFullscreen = false,
  children,
  headerExtra,
  headerActions,
  footer,
  maxWidth = 'default',
  size = 'default',
  overlayClassName,
  noChildPadding = false,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [hasOpened, setHasOpened] = useState(isOpen)
  if (isOpen && !hasOpened) setHasOpened(true)

  useEffect(() => {
    if (isOpen) overlayRef.current?.focus()
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const viewport = window.visualViewport
    const overlay = overlayRef.current
    let frame: number | undefined
    const revealFocusedInput = () => {
      frame = undefined
      const body = bodyRef.current
      const input = document.activeElement
      if (
        !body ||
        !(input instanceof HTMLElement) ||
        !body.contains(input) ||
        !input.matches('input, textarea, select, [contenteditable="true"]')
      )
        return
      const bounds = body.getBoundingClientRect()
      const field = input.getBoundingClientRect()
      // Scroll only this dialog's content. scrollIntoView can pan the fixed page on iOS,
      // fighting the app shell's keyboard correction and moving the dock/composer again.
      if (field.top < bounds.top + 12 || field.height > bounds.height - 24)
        body.scrollTop += field.top - bounds.top - 12
      else if (field.bottom > bounds.bottom - 12) body.scrollTop += field.bottom - bounds.bottom + 12
    }
    const scheduleReveal = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(revealFocusedInput)
    }
    const updateViewport = () => {
      overlay?.style.setProperty('--modal-viewport-height', `${viewport?.height ?? window.innerHeight}px`)
      overlay?.style.setProperty('--modal-viewport-top', `${viewport?.offsetTop ?? 0}px`)
      scheduleReveal()
    }
    updateViewport()
    viewport?.addEventListener('resize', updateViewport)
    viewport?.addEventListener('scroll', updateViewport)
    window.addEventListener('resize', updateViewport)
    overlay?.addEventListener('focusin', scheduleReveal)
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      viewport?.removeEventListener('resize', updateViewport)
      viewport?.removeEventListener('scroll', updateViewport)
      window.removeEventListener('resize', updateViewport)
      overlay?.removeEventListener('focusin', scheduleReveal)
    }
  }, [isOpen])

  if ((!isOpen && !hasOpened) || typeof document === 'undefined') return null

  return createPortal(
    <Presence
      open={isOpen}
      ref={overlayRef}
      tabIndex={-1}
      className={clsx(
        'ficus-modal-backdrop fixed inset-x-0 z-[60] bg-chrome-scrim/50 flex items-center justify-center outline-none',
        mobileFullscreen && 'mobile-chat-modal',
        overlayClassName
      )}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        data-modal-size={size}
        style={MODAL_SIZE_STYLE[size]}
        className={clsx(
          'ficus-overlay relative w-full mx-4 flex flex-col overflow-hidden min-h-0',
          size === 'editor' && 'max-w-[92vw]',
          size === 'default' && {
            'max-w-lg': maxWidth === 'default',
            'max-w-[70ch]': maxWidth === 'readable',
            'max-w-[90ch]': maxWidth === 'chat',
            'max-w-6xl': maxWidth === 'wide',
          }
        )}
      >
        {!!title && (
          <div className="flex items-start justify-between shrink-0 border-b border-panel-border px-4 py-3">
            <div className="modal-heading flex items-baseline gap-3 min-w-0 flex-1 flex-wrap">
              <h3 className="min-w-0 font-semibold text-primary break-words">{titleContent ?? title}</h3>
              {headerExtra}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {headerActions}
              <button
                onClick={onClose}
                className="ficus-button ficus-button-ghost p-1.5 rounded-md transition-colors shrink-0"
                aria-label="Close"
                title="Close (Escape)"
              >
                <CloseIcon className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
        <div
          ref={bodyRef}
          data-modal-body
          className={clsx('grow min-h-0 overflow-auto flex flex-col', !noChildPadding && 'p-4')}
        >
          {children}
        </div>
        {footer && <div className="shrink-0 border-t border-th-border bg-surface-hover px-4 py-3">{footer}</div>}
      </div>
    </Presence>,
    document.body
  )
}

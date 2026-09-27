import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { ChatWindowState, Rect } from './chatWindowState'

/**
 * A floating frame around one conversation. Drag by the chat's title bar,
 * resize from the bottom-right corner; pressing anywhere brings it to front.
 * The rect updates live while dragging and is committed (remembered) on release.
 */
export function ChatWindow({
  win,
  onFocus,
  onRect,
  onCommit,
  children,
}: {
  win: ChatWindowState
  onFocus: () => void
  onRect: (rect: Rect) => void
  onCommit: () => void
  children: ReactNode
}) {
  const gesture = useRef<{ kind: 'move' | 'resize'; x: number; y: number; start: Rect } | null>(null)

  const begin = (kind: 'move' | 'resize', e: ReactPointerEvent<HTMLElement>) => {
    gesture.current = { kind, x: e.clientX, y: e.clientY, start: { x: win.x, y: win.y, w: win.w, h: win.h } }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    onFocus()
    const target = e.target as HTMLElement
    // The title bar drags, except its buttons (close) and anything interactive.
    if (e.button === 0 && target.closest('.g-chat-header') && !target.closest('button, a, input, select, textarea'))
      begin('move', e)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g) return
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    onRect(
      g.kind === 'move'
        ? { ...g.start, x: g.start.x + dx, y: g.start.y + dy }
        : { ...g.start, w: g.start.w + dx, h: g.start.h + dy }
    )
  }

  const end = () => {
    if (!gesture.current) return
    gesture.current = null
    onCommit()
  }

  return (
    <div
      className="g-chat-window"
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: 40 + win.z }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onFocusCapture={onFocus}
    >
      {children}
      <div
        className="g-chat-resize"
        aria-hidden="true"
        onPointerDown={(e) => {
          e.stopPropagation()
          onFocus()
          begin('resize', e)
        }}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  )
}

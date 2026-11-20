import clsx from 'clsx'
import { createPortal } from 'react-dom'
import type { CSSProperties, HTMLAttributes, KeyboardEvent, MouseEvent, PointerEvent, ReactNode, Ref } from 'react'
import { RESIZE_EDGES, snapRect, snapZoneLayout, type ResizeEdge, type Snap } from '../lib/floatingWindow'
import type { DragSnap } from '../hooks/useFloatingWindowGesture'
import { currentViewport } from '../hooks/useAssistantPosition'
import { ResizeCornerIcon } from './icons'

/** Above every floating window, below popovers (90): the drag preview and zone picker. */
const DRAG_OVERLAY_Z = 61

const EDGE_CLASS: Record<ResizeEdge, string> = {
  n: 'top-0 inset-x-3 h-1.5 cursor-ns-resize',
  s: 'bottom-0 inset-x-3 h-1.5 cursor-ns-resize',
  e: 'right-0 inset-y-3 w-1.5 cursor-ew-resize',
  w: 'left-0 inset-y-3 w-1.5 cursor-ew-resize',
  ne: 'top-0 right-0 h-3 w-3 cursor-nesw-resize',
  nw: 'top-0 left-0 h-3 w-3 cursor-nwse-resize',
  se: 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize',
  sw: 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize',
}

export interface FloatingWindowGestureHandle {
  handlers: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void
    onPointerMove: (event: PointerEvent<HTMLElement>) => void
    onPointerUp: (event: PointerEvent<HTMLElement>) => void
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void
    onDoubleClick: (event: MouseEvent<HTMLElement>) => void
  }
  beginResize: (edge: ResizeEdge, event: PointerEvent<HTMLElement>) => void
  dragSnap: DragSnap
  dragging: boolean
}

interface FloatingWindowFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'children'> {
  frameRef: Ref<HTMLDivElement>
  /** Its key in the shared stack and keyboard-shortcut registry (`assistant` or an agent id). */
  windowKey: string
  gesture: FloatingWindowGestureHandle
  style: CSSProperties
  /** Its place in the shared stack; omitted, the class's own z-index applies. */
  zIndex?: number
  /** Any press or focus inside brings it to the front. */
  onActivate?: () => void
  /** Thin resize handles on every edge and corner (the bottom-right one is the visible corner button). */
  resizable?: boolean
  /** The visible, keyboard-operable bottom-right resize button. */
  corner?: {
    label: string
    title: string
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
    onDoubleClick?: () => void
  }
  /** Show the snap preview and zone picker while dragging. */
  snapOnDrag?: boolean
  children: ReactNode
}

/**
 * The frame every floating window shares, the assistant included: non-modal, dragged by whatever inside
 * it carries `data-window-drag-handle` (its title bar), resized from every edge and corner, brought to
 * the front by any press or focus inside it, and showing the snap preview and zone picker while dragged.
 */
export function FloatingWindowFrame({
  frameRef,
  windowKey,
  gesture,
  style,
  zIndex,
  onActivate,
  resizable = true,
  corner,
  snapOnDrag = true,
  className,
  children,
  ...rest
}: FloatingWindowFrameProps) {
  return (
    <div
      ref={frameRef}
      data-floating-window={windowKey}
      {...rest}
      {...gesture.handlers}
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
      style={zIndex === undefined ? style : { ...style, zIndex }}
      className={className}
    >
      {children}
      {resizable &&
        RESIZE_EDGES.filter((edge) => !(corner && edge === 'se')).map((edge) => (
          <div
            key={edge}
            aria-hidden="true"
            data-resize-edge={edge}
            className={clsx('absolute z-20 touch-none', EDGE_CLASS[edge])}
            onPointerDown={(event) => gesture.beginResize(edge, event)}
          />
        ))}
      {resizable && corner && (
        <button
          type="button"
          aria-label={corner.label}
          title={corner.title}
          onPointerDown={(event) => gesture.beginResize('se', event)}
          onKeyDown={corner.onKeyDown}
          onDoubleClick={corner.onDoubleClick}
          className="absolute bottom-0.5 right-0.5 z-20 flex h-5 w-5 cursor-nwse-resize touch-none items-center justify-center rounded text-muted opacity-60 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ResizeCornerIcon className="h-3.5 w-3.5" />
        </button>
      )}
      {snapOnDrag && gesture.dragging && <SnapDragOverlay target={gesture.dragSnap} />}
    </div>
  )
}

/**
 * While a window is dragged: a translucent preview of the region it would snap to, and a compact
 * picker near the top center (Windows 11 style) offering every region the layout menu does.
 */
export function SnapDragOverlay({ target }: { target: DragSnap }) {
  if (typeof document === 'undefined') return null
  const viewport = currentViewport()
  const layout = snapZoneLayout(viewport)
  const at = (rect: { x: number; y: number; w: number; h: number }): CSSProperties => ({
    left: viewport.left + rect.x,
    top: viewport.top + rect.y,
    width: rect.w,
    height: rect.h,
  })
  const preview = target ? snapRect(target.snap, viewport) : undefined
  return createPortal(
    <div
      data-snap-drag-overlay
      aria-hidden="true"
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: DRAG_OVERLAY_Z }}
    >
      {preview && (
        <div
          data-snap-preview={target!.snap}
          className="absolute rounded-2xl border-2 border-accent bg-accent/15 motion-safe:transition-[left,top,width,height] motion-safe:duration-150"
          style={at(preview)}
        />
      )}
      <div
        data-snap-zone-picker
        className="ficus-overlay absolute rounded-xl border border-th-border bg-surface shadow-theme-lg"
        style={at(layout.frame)}
      >
        {layout.groups.map((group) => (
          <div
            key={group.zones.map((zone) => zone.snap).join(' ')}
            className="absolute rounded-md border border-th-border"
            style={within(group.rect, layout.frame, 1)}
          >
            {group.zones.map((zone) => (
              <SnapZone
                key={zone.snap}
                snap={zone.snap}
                active={target?.source === 'zone' && target.snap === zone.snap}
                style={within(zone.rect, group.rect, 1)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body
  )
}

/** A rect placed inside its parent box (whose border is `border` px wide). */
function within(
  rect: { x: number; y: number; w: number; h: number },
  parent: { x: number; y: number },
  border: number
): CSSProperties {
  return { left: rect.x - parent.x - border, top: rect.y - parent.y - border, width: rect.w, height: rect.h }
}

function SnapZone({ snap, active, style }: { snap: Snap; active: boolean; style: CSSProperties }) {
  return (
    <div
      data-snap-zone={snap}
      data-active={active || undefined}
      className={clsx('absolute rounded-sm', active ? 'bg-accent' : 'bg-selection')}
      style={style}
    />
  )
}

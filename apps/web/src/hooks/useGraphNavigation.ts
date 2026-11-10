import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useStableRef } from './useStableRef'

type Point = { x: number; y: number }

/** Move the viewport independently of graph coordinates; zoom around the gesture's focal point. */
export function useGraphNavigation(
  viewport: RefObject<HTMLDivElement | null>,
  zoom: number,
  onZoom: (zoom: number) => void,
  onGestureStart: () => void
) {
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const currentRef = useStableRef({ zoom, offset, onZoom, onGestureStart })
  const suppressClick = useRef(false)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<{ point: Point; distance?: number } | undefined>(undefined)
  const apply = (nextZoom: number, nextOffset: Point) => {
    currentRef.current = { ...currentRef.current, zoom: nextZoom, offset: nextOffset }
    setOffset(nextOffset)
    currentRef.current.onZoom(nextZoom)
  }
  const focalZoom = (nextZoom: number, before: Point, after = before) => {
    const element = viewport.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const origin = {
      x: rect.left + element.clientLeft - element.scrollLeft,
      y: rect.top + element.clientTop - element.scrollTop,
    }
    const { zoom, offset } = currentRef.current
    const ratio = Math.min(1.6, Math.max(0.2, nextZoom)) / zoom
    apply(zoom * ratio, {
      x: after.x - origin.x - (before.x - origin.x - offset.x) * ratio,
      y: after.y - origin.y - (before.y - origin.y - offset.y) * ratio,
    })
  }
  const focalZoomRef = useStableRef(focalZoom)
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    let safariZoom: number | undefined
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return // Ordinary wheel/trackpad scrolling retains native scrolling.
      event.preventDefault()
      if (safariZoom !== undefined) return
      currentRef.current.onGestureStart()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1)
      focalZoomRef.current(currentRef.current.zoom * Math.exp(-delta * 0.01), { x: event.clientX, y: event.clientY })
    }
    // Safari exposes trackpad pinch as GestureEvents instead of ctrl+wheel.
    const safariStart = (event: Event) => {
      event.preventDefault()
      if (pointers.current.size >= 2) return
      safariZoom = currentRef.current.zoom
      currentRef.current.onGestureStart()
    }
    const safariChange = (event: Event) => {
      if (safariZoom === undefined) return
      event.preventDefault()
      const pinch = event as Event & { scale: number; clientX: number; clientY: number }
      if (!Number.isFinite(pinch.scale)) return
      focalZoomRef.current(safariZoom * pinch.scale, { x: pinch.clientX, y: pinch.clientY })
    }
    const safariEnd = () => {
      safariZoom = undefined
    }
    element.addEventListener('wheel', wheel, { passive: false })
    element.addEventListener('gesturestart', safariStart, { passive: false })
    element.addEventListener('gesturechange', safariChange, { passive: false })
    element.addEventListener('gestureend', safariEnd)
    return () => {
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('gesturestart', safariStart)
      element.removeEventListener('gesturechange', safariChange)
      element.removeEventListener('gestureend', safariEnd)
    }
  }, [viewport, currentRef, focalZoomRef])
  const measurement = () => {
    const [a, b] = [...pointers.current.values()]
    if (!a) return undefined
    return b
      ? { point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(b.x - a.x, b.y - a.y) }
      : { point: a }
  }
  const capture = (event: ReactPointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const end = (event: ReactPointerEvent) => {
    if (!pointers.current.delete(event.pointerId)) return
    if (gesture.current) {
      event.stopPropagation()
      gesture.current = measurement()
      setPanning(!!gesture.current)
    }
  }
  return {
    offset,
    panning,
    reset: () => {
      setOffset({ x: 0, y: 0 })
      currentRef.current.offset = { x: 0, y: 0 }
    },
    handlers: {
      onClickCapture: (event: ReactMouseEvent) => {
        if (!suppressClick.current) return
        event.preventDefault()
        event.stopPropagation()
        suppressClick.current = false
      },
      onPointerDownCapture: (event: ReactPointerEvent) => {
        if (event.button !== 0) return
        suppressClick.current = false
        const interactive = (event.target as Element).closest('button, a, input, textarea, select, [data-flow-edge]')
        if (event.pointerType !== 'touch' && interactive) return
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        if (interactive && pointers.current.size === 1) return
        currentRef.current.onGestureStart()
        viewport.current?.focus()
        gesture.current = measurement()
        setPanning(true)
        capture(event)
      },
      onPointerMoveCapture: (event: ReactPointerEvent) => {
        if (!pointers.current.has(event.pointerId)) return
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        const before = gesture.current
        const after = measurement()
        if (!before || !after) return
        capture(event)
        suppressClick.current = true
        focalZoom(
          currentRef.current.zoom * (before.distance && after.distance ? after.distance / before.distance : 1),
          before.point,
          after.point
        )
        gesture.current = after
      },
      onPointerUpCapture: end,
      onPointerCancelCapture: end,
      onLostPointerCapture: (event: ReactPointerEvent) => {
        // Transferring capture from a card to the viewport must not discard that finger.
        if (event.target === viewport.current) end(event)
      },
    },
  }
}

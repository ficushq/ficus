import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useStableRef } from '../hooks/useStableRef'

export interface Camera {
  /** World point shown at the viewport centre. */
  x: number
  y: number
  zoom: number
}

export interface WorldBox {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

const MIN_ZOOM = 0.35
const MAX_ZOOM = 2.2
/** Below this the robots' faces stop reading; pan instead of shrinking further. */
const FIT_MIN_ZOOM = 0.6
/** A small farm shouldn't be blown up to fill the screen. */
const FIT_MAX_ZOOM = 1.25
/** How long flyTo takes, ms. */
const FLY_MS = 650
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/** The zoom that fits a world box into a viewport, with a little padding. */
export function fitZoom(box: WorldBox, width: number, height: number, padding = 48): number {
  const w = Math.max(1, box.maxX - box.minX)
  const h = Math.max(1, box.maxY - box.minY)
  return clampZoom(Math.min((width - padding * 2) / w, (height - padding * 2) / h))
}

/** Keep the camera centre inside the world box so the farm can't be flung off screen. */
export function clampCamera(camera: Camera, box: WorldBox): Camera {
  return {
    zoom: clampZoom(camera.zoom),
    x: Math.min(box.maxX, Math.max(box.minX, camera.x)),
    y: Math.min(box.maxY, Math.max(box.minY, camera.y)),
  }
}

/** Zoom by `factor` keeping the world point under screen offset (dx, dy) from centre fixed. */
export function zoomAround(camera: Camera, factor: number, dx: number, dy: number): Camera {
  const zoom = clampZoom(camera.zoom * factor)
  const k = 1 / camera.zoom - 1 / zoom
  return { zoom, x: camera.x + dx * k, y: camera.y + dy * k }
}

/**
 * Pan (drag), wheel/pinch zoom and keyboard control for the farm viewport.
 * A drag that moves more than a few pixels suppresses the click that ends it,
 * so panning never selects a plant by accident.
 */
export function useCamera(viewport: RefObject<HTMLElement | null>, world: WorldBox, focusBox: WorldBox = world) {
  const [camera, setCamera] = useState<Camera>(() => ({
    x: (world.minX + world.maxX) / 2,
    y: (world.minY + world.maxY) / 2,
    zoom: 1,
  }))
  const worldRef = useStableRef(world)
  const focusRef = useStableRef(focusBox)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const dragDistance = useRef(0)
  const fitted = useRef(false)

  const update = useCallback(
    (fn: (c: Camera) => Camera) => setCamera((c) => clampCamera(fn(c), worldRef.current)),
    [worldRef]
  )

  const fit = useCallback(() => {
    const el = viewport.current
    if (!el) return
    // Fit the part of the farm that matters (yards and homestead), never so far out it's unreadable.
    const box = focusRef.current
    setCamera({
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
      zoom: Math.min(FIT_MAX_ZOOM, Math.max(FIT_MIN_ZOOM, fitZoom(box, el.clientWidth, el.clientHeight))),
    })
  }, [viewport, focusRef])

  // Fit once the farm first has a real size.
  useEffect(() => {
    if (fitted.current || world.maxX - world.minX < 1) return
    fitted.current = true
    fit()
  }, [fit, world.maxX, world.minX])

  const focus = useCallback(
    (x: number, y: number, zoom?: number) => update((c) => ({ x, y, zoom: zoom ?? Math.max(c.zoom, 1) })),
    [update]
  )

  /** Glides the camera to a point (and zoom) instead of jumping; any drag, pinch or wheel takes over. */
  const flight = useRef(0)
  const flyTo = useCallback(
    (x: number, y: number, zoom?: number) => {
      cancelAnimationFrame(flight.current)
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return focus(x, y, zoom)
      let from: Camera | null = null
      const start = performance.now()
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / FLY_MS)
        const ease = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
        update((c) => {
          from ??= c
          const to = { x, y, zoom: zoom ?? Math.max(from.zoom, 1) }
          return {
            x: from.x + (to.x - from.x) * ease,
            y: from.y + (to.y - from.y) * ease,
            zoom: from.zoom + (to.zoom - from.zoom) * ease,
          }
        })
        if (t < 1) flight.current = requestAnimationFrame(step)
      }
      flight.current = requestAnimationFrame(step)
    },
    [focus, update]
  )

  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const centreOffset = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect()
      return [clientX - r.left - r.width / 2, clientY - r.top - r.height / 2] as const
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      cancelAnimationFrame(flight.current)
      const [dx, dy] = centreOffset(e.clientX, e.clientY)
      // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels step.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))
      update((c) => zoomAround(c, factor, dx, dy))
    }
    const onDown = (e: PointerEvent) => {
      cancelAnimationFrame(flight.current)
      // Without this a mouse drag over the drawing can start the browser's own drag of the
      // SVG (Safari shows a ghost image of the scene) instead of panning. Clicks still fire.
      if (e.pointerType === 'mouse' && e.button === 0) e.preventDefault()
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.current.size === 1) dragDistance.current = 0
    }
    const onMove = (e: PointerEvent) => {
      const prev = pointers.current.get(e.pointerId)
      if (!prev) return
      const next = { x: e.clientX, y: e.clientY }
      if (pointers.current.size === 1) {
        const mx = next.x - prev.x
        const my = next.y - prev.y
        dragDistance.current += Math.abs(mx) + Math.abs(my)
        if (dragDistance.current > 6) el.setPointerCapture?.(e.pointerId)
        update((c) => ({ ...c, x: c.x - mx / c.zoom, y: c.y - my / c.zoom }))
      } else if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.entries()]
        const other = a[0] === e.pointerId ? b[1] : a[1]
        const before = Math.hypot(prev.x - other.x, prev.y - other.y)
        const after = Math.hypot(next.x - other.x, next.y - other.y)
        const [dx, dy] = centreOffset((next.x + other.x) / 2, (next.y + other.y) / 2)
        dragDistance.current += 10
        if (before > 0) update((c) => zoomAround(c, after / before, dx, dy))
      }
      pointers.current.set(e.pointerId, next)
    }
    const onUp = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId)
    }
    // Swallow the click that ends a drag so panning doesn't select things.
    const onClickCapture = (e: MouseEvent) => {
      if (dragDistance.current > 6) {
        e.stopPropagation()
        e.preventDefault()
      }
      dragDistance.current = 0
    }

    const onDragStart = (e: DragEvent) => e.preventDefault()
    el.addEventListener('dragstart', onDragStart)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('click', onClickCapture, true)
    return () => {
      el.removeEventListener('dragstart', onDragStart)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('click', onClickCapture, true)
    }
  }, [viewport, update])

  const zoomBy = useCallback((factor: number) => update((c) => zoomAround(c, factor, 0, 0)), [update])
  const panBy = useCallback(
    (dx: number, dy: number) => update((c) => ({ ...c, x: c.x + dx / c.zoom, y: c.y + dy / c.zoom })),
    [update]
  )

  return { camera, fit, focus, flyTo, zoomBy, panBy }
}

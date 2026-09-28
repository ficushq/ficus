import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSkin } from '../skins'
import { useStableRef } from '../hooks/useStableRef'
import { iso } from './iso'
import { along, newPlots, pathLength, plantingFor, type Planting, type TilePoint } from './plantingRoute'
import { NOTHING_HIDDEN, type SceneHidden } from './Scene'
import type { FarmLayout } from './types'

/** Walking speed, tiles per second, and how long the planting itself takes. */
const SPEED = 2.4
const PLANT_MS = 1300
/** How long a new plant pops. */
const POP_MS = 700

type Phase = 'out' | 'plant' | 'back'

export function usePrefersReducedMotion(): boolean {
  const query = typeof window === 'undefined' ? null : window.matchMedia?.('(prefers-reduced-motion: reduce)')
  const [reduce, setReduce] = useState(() => query?.matches ?? false)
  useEffect(() => {
    if (!query) return
    const onChange = (e: MediaQueryListEvent) => setReduce(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [query])
  return reduce
}

interface Plantings {
  /** One planting per robot at a time; each robot's others wait their turn. */
  active: Planting[]
  hidden: SceneHidden
  planted: (streamId: string) => void
  done: (streamId: string) => void
}

/**
 * Watches the farm for new work streams and has their robots plant them: the
 * new plant stays hidden until its robot arrives, the robot's usual spot is
 * empty while it's out, and a robot with several to plant does them in turn
 * (and not while it's walking somewhere else).
 * With reduced motion, new plants simply appear.
 */
export function usePlantings(layout: FarmLayout, busy: ReadonlySet<string> = new Set()): Plantings {
  const reduce = usePrefersReducedMotion()
  const previous = useRef<FarmLayout | null>(null)
  const [queue, setQueue] = useState<Planting[]>([])
  const [planted, setPlanted] = useState<ReadonlySet<string>>(new Set())
  const [popping, setPopping] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    const prev = previous.current
    previous.current = layout
    if (reduce) return
    const fresh = newPlots(prev, layout)
      .map(({ plot, yard }) => plantingFor(plot, yard))
      .filter((planting): planting is Planting => planting !== null)
    if (fresh.length)
      setQueue((queue) => [...queue, ...fresh.filter((f) => !queue.some((q) => q.streamId === f.streamId))])
  }, [layout, reduce])

  // A robot out walking somewhere (see RobotWalkers.tsx) plants once it's back.
  const active = useMemo(() => {
    const taken = new Set(busy)
    return queue.filter((planting) => {
      if (taken.has(planting.planter.agent.id)) return false
      taken.add(planting.planter.agent.id)
      return true
    })
  }, [queue, busy])

  const hidden = useMemo<SceneHidden>(() => {
    if (!queue.length && !popping.size) return NOTHING_HIDDEN
    return {
      plants: new Set(queue.filter((p) => !planted.has(p.streamId)).map((p) => p.streamId)),
      robots: new Set(active.map((p) => p.planter.agent.id)),
      popping,
    }
  }, [queue, active, planted, popping])

  const markPlanted = useCallback((streamId: string) => {
    setPlanted((set) => new Set(set).add(streamId))
    setPopping((set) => new Set(set).add(streamId))
    window.setTimeout(
      () =>
        setPopping((set) => {
          const next = new Set(set)
          next.delete(streamId)
          return next
        }),
      POP_MS
    )
  }, [])

  const done = useCallback((streamId: string) => {
    setQueue((queue) => queue.filter((p) => p.streamId !== streamId))
    setPlanted((set) => {
      const next = new Set(set)
      next.delete(streamId)
      return next
    })
  }, [])

  return { active, hidden, planted: markPlanted, done }
}

/** Which way a robot faces walking from a to b: toward the side of the screen it's heading. */
function facingFor(a: TilePoint, b: TilePoint): 'left' | 'right' {
  return b[0] - b[1] - (a[0] - a[1]) < 0 ? 'left' : 'right'
}

/** A robot out planting: walks to the plot, plants, and walks home. Drawn over the scene, never clickable. */
export function PlantingWalker({
  planting,
  onPlanted,
  onDone,
}: {
  planting: Planting
  onPlanted: (streamId: string) => void
  onDone: (streamId: string) => void
}) {
  const { skin } = useSkin()
  const ref = useRef<SVGGElement>(null)
  const [phase, setPhase] = useState<Phase>('out')
  const [facing, setFacing] = useState<'left' | 'right'>(() =>
    facingFor(planting.path[0]!, planting.path[1] ?? planting.path[0]!)
  )
  const onPlantedRef = useStableRef(onPlanted)
  const onDoneRef = useStableRef(onDone)

  useEffect(() => {
    const out = planting.path
    const back = [...out].reverse()
    const walkMs = (pathLength(out) / SPEED) * 1000
    const start = performance.now()
    let frame = 0
    let shown: Phase = 'out'
    let segment = -1
    let dir: 'left' | 'right' | null = null
    let didPlant = false
    const place = ([i, j]: TilePoint) => {
      const [x, y] = iso(i, j)
      ref.current?.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
    }
    const turn = (next: 'left' | 'right') => {
      if (next !== dir) setFacing((dir = next))
    }
    const tick = (now: number) => {
      const t = now - start
      const next: Phase = t < walkMs ? 'out' : t < walkMs + PLANT_MS ? 'plant' : 'back'
      if (next !== shown) setPhase((shown = next))
      if (next === 'out' || next === 'back') {
        const path = next === 'out' ? out : back
        const walked = ((next === 'out' ? t : t - walkMs - PLANT_MS) / 1000) * SPEED
        const spot = along(path, walked)
        place(spot.at)
        if (spot.segment !== segment) {
          segment = spot.segment
          turn(facingFor(path[segment]!, path[segment + 1] ?? path[segment]!))
        }
        if (next === 'back' && walked >= pathLength(back)) {
          onDoneRef.current(planting.streamId)
          return
        }
      } else {
        place(out[out.length - 1]!)
        // It stands just right of the plant, so it turns left to plant it.
        turn('left')
        segment = -1
        if (!didPlant && t > walkMs + PLANT_MS * 0.7) {
          didPlant = true
          onPlantedRef.current(planting.streamId)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    place(out[0]!)
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [planting, onPlantedRef, onDoneRef])

  // The plot's middle, relative to where the robot stands to plant it.
  const [px, py] = iso(-0.6, -0.2)
  return (
    <g ref={ref} className="g-planter" aria-hidden="true">
      <g className={phase === 'plant' ? 'g-planting' : 'g-walking'}>
        <skin.Robot placement={{ ...planting.planter, facing, face: 'happy' }} />
      </g>
      {phase === 'plant' && (
        <g transform={`translate(${px} ${py})`}>
          <g className="g-sow">
            {[
              [-10, -4],
              [9, -6],
              [0, -12],
              [-4, 4],
              [6, 3],
            ].map(([x, y]) => (
              <circle key={`${x}${y}`} cx={x} cy={y} r={2.4} />
            ))}
          </g>
        </g>
      )}
    </g>
  )
}

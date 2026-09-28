import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSkin } from '../skins'
import { useStableRef } from '../hooks/useStableRef'
import { iso } from './iso'
import { along, pathLength, type TilePoint } from './plantingRoute'
import { usePrefersReducedMotion } from './Planting'
import { robotMoves, walkSpeed, type RobotMove } from './robotMoves'
import type { FarmLayout } from './types'

interface Walk extends RobotMove {
  /** Bumped when a walk is replaced mid-way, so its walker starts over from where the robot is. */
  serial: number
}

export interface RobotWalks {
  walks: Walk[]
  /** Robots out walking: drawn by their walker, not at their spot. */
  walking: ReadonlySet<string>
  /** A walker reports where its robot is, so a new walk can start from there. */
  step: (agentId: string, at: TilePoint) => void
  done: (agentId: string, serial: number) => void
}

/**
 * Watches the farm for robots changing jobs and has them walk it: out of the
 * charging hut to a plant, between plants, back into the hut. With reduced
 * motion they simply appear where they're going.
 */
export function useRobotWalks(layout: FarmLayout): RobotWalks {
  const reduce = usePrefersReducedMotion()
  const previous = useRef<FarmLayout | null>(null)
  const positions = useRef(new Map<string, TilePoint>())
  const serial = useRef(0)
  const [walks, setWalks] = useState<Walk[]>([])

  useEffect(() => {
    const prev = previous.current
    previous.current = layout
    if (reduce) return
    const moves = robotMoves(prev, layout, positions.current)
    if (!moves.length) return
    setWalks((walks) => {
      const replaced = new Set(moves.map((move) => move.agentId))
      return [
        ...walks.filter((w) => !replaced.has(w.agentId)),
        ...moves.map((m) => ({ ...m, serial: ++serial.current })),
      ]
    })
  }, [layout, reduce])

  const step = useCallback((agentId: string, at: TilePoint) => {
    positions.current.set(agentId, at)
  }, [])

  const done = useCallback((agentId: string, finished: number) => {
    setWalks((walks) => {
      const walk = walks.find((w) => w.agentId === agentId)
      // A walk that was replaced mid-way isn't the one finishing.
      if (!walk || walk.serial !== finished) return walks
      positions.current.delete(agentId)
      return walks.filter((w) => w !== walk)
    })
  }, [])

  const walking = useMemo(() => new Set(walks.map((w) => w.agentId)), [walks])
  return { walks, walking, step, done }
}

const facingFor = (a: TilePoint, b: TilePoint): 'left' | 'right' => (b[0] - b[1] - (a[0] - a[1]) < 0 ? 'left' : 'right')

/** A robot walking to a new job, or home to rest (it fades as it goes in). Drawn over the scene, never clickable. */
export function RobotWalker({
  walk,
  onStep,
  onDone,
}: {
  walk: Walk
  onStep: (agentId: string, at: TilePoint) => void
  onDone: (agentId: string, serial: number) => void
}) {
  const { skin } = useSkin()
  const ref = useRef<SVGGElement>(null)
  const [facing, setFacing] = useState<'left' | 'right'>(() => facingFor(walk.path[0]!, walk.path[1] ?? walk.path[0]!))
  const [fading, setFading] = useState(false)
  const onStepRef = useStableRef(onStep)
  const onDoneRef = useStableRef(onDone)

  useEffect(() => {
    const { path } = walk
    const length = pathLength(path)
    const speed = walkSpeed(length)
    const start = performance.now()
    let frame = 0
    let segment = -1
    const tick = (now: number) => {
      const walked = ((now - start) / 1000) * speed
      const spot = along(path, walked)
      const [x, y] = iso(spot.at[0], spot.at[1])
      ref.current?.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
      onStepRef.current(walk.agentId, spot.at)
      if (spot.segment !== segment) {
        segment = spot.segment
        setFacing(facingFor(path[segment]!, path[segment + 1] ?? path[segment]!))
      }
      // Going in to rest: fade out over the last stretch, into the hut.
      if (walk.kind === 'leave' && length - walked < 0.8) setFading(true)
      if (walked >= length) {
        onDoneRef.current(walk.agentId, walk.serial)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [walk, onStepRef, onDoneRef])

  const [x0, y0] = iso(walk.path[0]![0], walk.path[0]![1])
  return (
    <g
      ref={ref}
      transform={`translate(${x0} ${y0})`}
      className={fading ? 'g-robot-walker g-robot-walker-in' : 'g-robot-walker'}
      aria-hidden="true"
    >
      <g className="g-walking">
        <skin.Robot placement={{ ...walk.placement, facing }} />
      </g>
    </g>
  )
}

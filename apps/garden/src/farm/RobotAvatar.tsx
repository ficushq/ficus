import type { Agent, Squad } from '@ficus/shared'
import { Robot } from './sprites'
import { robotLookFor, roleFor, propFor } from './appearance'
import { faceFor } from './state'
import type { RobotRole } from './types'

/**
 * A robot's head-and-shoulders portrait for cards and lists. Gradients resolve
 * against the scene's <defs> in the same document.
 */
export function RobotAvatar({
  agent,
  squad,
  role,
  halted = false,
  size = 40,
}: {
  agent: Agent
  squad?: Squad
  role?: RobotRole
  halted?: boolean
  size?: number
}) {
  const r = role ?? roleFor(agent, squad)
  const face = faceFor(agent, halted)
  return (
    <svg className="g-avatar" width={size} height={size} viewBox="-26 -70 52 52" aria-hidden="true">
      <Robot look={robotLookFor(agent, r)} face={face} prop={propFor(r, face)} />
    </svg>
  )
}

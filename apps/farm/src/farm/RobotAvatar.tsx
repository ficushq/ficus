import type { Agent, Squad } from '@ficus/shared'
import { roleFor } from './appearance'
import { useSkin } from '../skins'
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
  const { skin } = useSkin()
  const r = role ?? roleFor(agent, squad)
  const face = faceFor(agent, halted)
  return (
    <svg className="g-avatar" width={size} height={size} viewBox={skin.avatarViewBox} aria-hidden="true">
      <skin.Avatar agent={agent} role={r} face={face} />
    </svg>
  )
}

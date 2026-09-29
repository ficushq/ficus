import type { Agent } from '@ficus/shared'
import { hash, pick } from '../../farm/appearance'
import type { RobotFace, RobotRole } from '../../farm/types'
import type { CropKind, RobotAntenna, RobotHat, RobotHead, RobotLook, RobotMove, RobotOutfit, RobotProp } from './types'

export const SHELLS = ['#fbf4e4', '#e9f3d6', '#f7e3cf', '#e6eef5', '#f3e6f4', '#fff1c7'] as const
/** Brand greens and rusts plus a few friends; used for panels, hats, aprons and scarves. */
export const PANELS = ['#3f6b4f', '#b0582f', '#8a9a5b', '#5f86b3', '#9a7ab8', '#e0a93b', '#c2412b', '#6b4426'] as const
export const GLOWS = ['#9ff0c8', '#ffd76a', '#9fe0ff', '#d9c2ff'] as const
export const DENIM = 'url(#g-denim)'

const CROPS: readonly CropKind[] = ['tomato', 'sunflower', 'pumpkin']
const HEADS: readonly RobotHead[] = ['round', 'box', 'dome']
const MOVES: readonly RobotMove[] = ['wheel', 'treads', 'hover', 'legs']
const ANTENNAS: readonly RobotAntenna[] = ['sprout', 'bulb', 'twin', 'none']
const WORKER_HATS: readonly (RobotHat | null)[] = ['cap', 'bandana', 'beanie', 'bucket', null]
const WORKER_OUTFITS: readonly (RobotOutfit | null)[] = ['overalls', 'apron', null]

export function cropFor(streamId: string): CropKind {
  return pick(CROPS, hash(`crop:${streamId}`))
}

/** How one robot looks. Deterministic from the agent id; role decides the costume. */
export function robotLookFor(agent: Agent, role: RobotRole): RobotLook {
  const seed = (part: string) => hash(`${agent.id}:${part}`)
  const base = {
    shell: pick(SHELLS, seed('shell')),
    panel: pick(PANELS, seed('panel')),
    glow: pick(GLOWS, seed('glow')),
    hatColor: pick(PANELS, seed('hat-color')),
  }

  switch (role) {
    case 'manager':
      return {
        ...base,
        head: 'box',
        move: 'treads',
        antenna: 'none',
        hat: 'straw',
        outfit: 'overalls',
        outfitColor: DENIM,
        scarf: '#c2412b',
      }
    case 'consultant':
      return {
        ...base,
        head: 'dome',
        move: 'hover',
        antenna: 'none',
        hat: 'sun',
        outfit: 'apron',
        outfitColor: '#9fb57f',
        scarf: null,
      }
    case 'assistant':
      return {
        ...base,
        glow: '#ffd76a',
        head: 'round',
        move: 'hover',
        antenna: 'bulb',
        hat: null,
        outfit: null,
        outfitColor: pick(PANELS, seed('outfit-color')),
        scarf: pick(PANELS, seed('scarf')),
      }
    case 'worker': {
      const outfit = pick(WORKER_OUTFITS, seed('outfit'))
      return {
        ...base,
        head: pick(HEADS, seed('head')),
        move: pick(MOVES, seed('move')),
        antenna: pick(ANTENNAS, seed('antenna')),
        hat: pick(WORKER_HATS, seed('hat')),
        outfit,
        outfitColor: outfit === 'overalls' ? DENIM : pick(PANELS, seed('outfit-color')),
        scarf: seed('has-scarf') % 100 < 30 ? pick(PANELS, seed('scarf')) : null,
      }
    }
  }
}

/** The tool in the robot's hand. Workers only carry the watering can while working. */
export function propFor(role: RobotRole, face: RobotFace): RobotProp | null {
  switch (role) {
    case 'manager':
      return 'hoe'
    case 'consultant':
      return 'clip'
    case 'worker':
      return face === 'happy' ? 'can' : null
    case 'assistant':
      return null
  }
}

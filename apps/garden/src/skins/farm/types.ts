/** The farm style's own vocabulary: crops, and what each robot wears. */

/** Crops vary by work stream (stable per id) so a yard isn't a field of clones. */
export type CropKind = 'tomato' | 'sunflower' | 'pumpkin'

export type RobotHead = 'round' | 'box' | 'dome'

export type RobotMove = 'wheel' | 'treads' | 'hover' | 'legs'

export type RobotAntenna = 'sprout' | 'bulb' | 'twin' | 'none'

export type RobotHat = 'straw' | 'sun' | 'cap' | 'bandana' | 'beanie' | 'bucket'

export type RobotOutfit = 'overalls' | 'apron'

export type RobotProp = 'can' | 'clip' | 'hoe'

/** Everything that makes one robot look like itself. Stable per agent id. */
export interface RobotLook {
  shell: string
  panel: string
  glow: string
  head: RobotHead
  move: RobotMove
  antenna: RobotAntenna
  hat: RobotHat | null
  hatColor: string
  outfit: RobotOutfit | null
  outfitColor: string
  scarf: string | null
}

import type { ComponentType, ReactNode } from 'react'
import type { Agent, FarmStyle } from '@ficus/shared'
import type {
  BadgeKind,
  DecorPlacement,
  FarmLayout,
  PlotLayout,
  RobotFace,
  RobotPlacement,
  RobotRole,
} from '../farm/types'

/** A tap area around a sprite's anchor: [left, top, width, height] in world pixels. */
export type HitBox = readonly [left: number, top: number, width: number, height: number]

export interface YardRect {
  i0: number
  j0: number
  w: number
  h: number
}

/** One stretch of fence, sorted on its own so a robot standing in front of it draws over it. */
export interface FencePiece {
  key: string
  depth: number
  node: ReactNode
}

/** A style's id: exactly the styles an account can save (@ficus/shared FARM_STYLES). */
export type SkinId = FarmStyle

/**
 * Everything that decides how the farm looks, and nothing about what's on it.
 * The engine (farm/Scene.tsx) lays the farm out, sorts it and makes every
 * thing a labelled button; a skin only draws. Sprites are anchored at the
 * ground point the engine gives them (tile coordinates → iso()), except the
 * area sprites (ground, yard back, plot ground), which draw in world
 * coordinates themselves.
 */
export interface FarmSkin {
  id: SkinId
  label: string
  /** Class on the farm screen's root; the interface (HUD, cards, chat) reads its CSS variables. */
  className: string
  /** Gradients, filters and patterns the sprites share. Rendered once per scene. */
  Defs: ComponentType
  Ground: ComponentType<{ bounds: FarmLayout['bounds'] }>
  /** A yard's inner ground and the fences behind everything in it. */
  YardBack: ComponentType<YardRect>
  /** The fences in front, as sortable pieces. */
  yardFront: (rect: YardRect) => FencePiece[]
  Sign: ComponentType<{ name: string; flag: boolean }>
  /** A plant's own patch of ground, highlighted when selected. */
  PlotGround: ComponentType<{ i: number; j: number; selected: boolean }>
  Plant: ComponentType<{ plot: PlotLayout }>
  Badge: ComponentType<{ kind: BadgeKind }>
  /** How far above a plant's anchor its badge's tip sits (negative is up). */
  badgeLift: (plot: PlotLayout) => number
  Robot: ComponentType<{ placement: RobotPlacement; extra?: number }>
  /** A robot's portrait for cards and chat headers, drawn inside the given viewBox. */
  Avatar: ComponentType<{ agent: Agent; role: RobotRole; face: RobotFace }>
  avatarViewBox: string
  Hut: ComponentType<{ count: number; peek?: RobotPlacement }>
  Stand: ComponentType<{ count: number; host?: RobotPlacement }>
  Farmhouse: ComponentType
  SeedShed: ComponentType
  Mailbox: ComponentType<{ count: number }>
  Crates: ComponentType<{ count: number }>
  Compost: ComponentType<{ count: number }>
  Decor: ComponentType<{ decor: DecorPlacement }>
  boxes: {
    robot: HitBox
    plant: HitBox
    sign: HitBox
    hut: HitBox
    stand: HitBox
    farmhouse: HitBox
    seedShed: HitBox
    mailbox: HitBox
    crates: HitBox
    compost: HitBox
  }
  /** How far art reaches past the tiles (trees, roofs), so the camera can show it all. */
  worldPad: { top: number; side: number; bottom: number }
}

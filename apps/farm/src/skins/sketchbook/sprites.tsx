import { memo, type ComponentType } from 'react'
import type { BadgeKind, FarmLayout } from '../../farm/types'
import { gridLines } from '../line/draw'
import { BlueprintDefs } from '../blueprint/sprites'
import { Circle, DraftingContext, Path, type Drafting } from '../blueprint/drafting'
import { pencil } from './pencil'

/*
 * The Sketchbook style draws Blueprint's farm again, by hand: every line
 * through the pencil, the right-hand walls hatched, the leaves washed in
 * green, on a page of graph paper. It reads the line kit's colours (--ln-*)
 * and a few of its own (--sk-*), set in its theme.
 */
const FG = 'var(--ln-fg)'
const BG = 'var(--ln-bg)'
const ACCENT = 'var(--ln-accent)'

export const SKETCH: Drafting = {
  pen: pencil,
  technical: false,
  shade: 'url(#sk-shade)',
  leafWash: 'var(--sk-leaf)',
  leafInk: 'var(--sk-leaf-ink)',
  fruitWash: 'var(--sk-fruit)',
  letterScale: 1.25,
}

/** A Blueprint sprite, drawn in pencil. */
export function inPencil<P extends object>(Sprite: ComponentType<P>): ComponentType<P> {
  function Sketched(props: P) {
    return (
      <DraftingContext.Provider value={SKETCH}>
        <Sprite {...props} />
      </DraftingContext.Provider>
    )
  }
  Sketched.displayName = `InPencil(${Sprite.displayName ?? Sprite.name})`
  return Sketched
}

export function SketchbookDefs() {
  return (
    <>
      <BlueprintDefs />
      <defs>
        <pattern id="sk-shade" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(60)">
          <path d="M0 0 V4" stroke={FG} strokeOpacity={0.28} strokeWidth={0.9} />
        </pattern>
      </defs>
    </>
  )
}

/** A page of graph paper: faint blue squares, a stronger line every fifth, running past the farm on every side. */
export const SketchbookGround = memo(function SketchbookGround({ bounds }: { bounds: FarmLayout['bounds'] }) {
  const { box } = gridLines(bounds, 16)
  const pad = 2000
  const minor = Array.from({ length: 4 }, (_, k) => `M${(k + 1) * 20} 0 V100 M0 ${(k + 1) * 20} H100`).join(' ')
  return (
    <g>
      <defs>
        <pattern id="sk-graph" width="100" height="100" patternUnits="userSpaceOnUse">
          <path d={minor} stroke="var(--sk-grid)" strokeOpacity={0.35} fill="none" />
          <path d="M0 0 H100 M0 0 V100" stroke="var(--sk-grid)" strokeOpacity={0.7} fill="none" />
        </pattern>
      </defs>
      <rect x={box.x - pad} y={box.y - pad} width={box.w + pad * 2} height={box.h + pad * 2} fill={BG} />
      <rect x={box.x - pad} y={box.y - pad} width={box.w + pad * 2} height={box.h + pad * 2} fill="url(#sk-graph)" />
    </g>
  )
})

/**
 * The glyphs in a badge, drawn as pencil strokes centred on the bubble (a handwriting font's "?" and "!"
 * sit off-centre and lean), each with an optional dot.
 */
const GLYPHS: Record<BadgeKind, { d: string; dot?: number }> = {
  question: {
    d: 'M-3 -21.2 Q-2.8 -24.2 0.2 -24.2 Q3.4 -24.2 3.4 -21.4 Q3.4 -19.3 1 -18.2 Q0.1 -17.7 0.1 -15.6',
    dot: -11.9,
  },
  blocked: { d: 'M0 -23.8 L0.1 -15.8', dot: -11.9 },
  harvest: { d: 'M-5 -17.4 L-1.4 -13.4 L5.4 -21.6' },
}

/** A pencilled bubble with a red glyph, anchored at the bottom of its tail. */
function Badge({ kind }: { kind: BadgeKind }) {
  const glyph = GLYPHS[kind]
  return (
    <g className="ln-float">
      <Path d="M-3 -7 L0 0 L3 -7" fill={BG} stroke={FG} strokeLinejoin="round" />
      <Circle cy={-17} r={11} fill={BG} stroke={FG} />
      <Path d={glyph.d} fill="none" stroke={ACCENT} strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round" />
      {glyph.dot !== undefined && <Circle cy={glyph.dot} r={1.35} fill={ACCENT} stroke="none" />}
    </g>
  )
}

export const SketchbookBadge = inPencil(Badge)

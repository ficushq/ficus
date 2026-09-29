import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeStream } from '../farm/testFixtures'
import type { PlantState, PlotLayout } from '../farm/types'
import { SKINS } from '.'

const STATES: PlantState[] = [
  'queued',
  'growing',
  'question',
  'review',
  'delivering',
  'blocked',
  'paused',
  'waiting',
  'idle',
  'failed',
]

function plot(state: PlantState): PlotLayout {
  return { stream: makeStream({ id: `ws-${state}` }), i: 0, j: 0, state, badge: null, tender: null, extraTenders: 0 }
}

const draw = (skin: (typeof SKINS)[number], state: PlantState) =>
  renderToStaticMarkup(<skin.Plant plot={plot(state)} />)

describe('plants', () => {
  for (const skin of SKINS) {
    it(`${skin.id} draws every plant state`, () => {
      for (const state of STATES) {
        // More than an empty wrapper: every state has a drawing.
        expect({ state, drawn: draw(skin, state).includes('<path') || draw(skin, state).includes('<circle') }).toEqual({
          state,
          drawn: true,
        })
      }
    })

    it(`${skin.id} draws a code-host wait apart from both growing and a harvest`, () => {
      const delivering = draw(skin, 'delivering')
      expect(delivering).not.toBe(draw(skin, 'growing'))
      expect(delivering).not.toBe(draw(skin, 'review'))
    })
  }
})

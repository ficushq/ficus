import { describe, expect, test } from 'bun:test'
import {
  COMPOSER_TEXT_MIN,
  COMPOSER_UNFOLD_MARGIN,
  composerNeeds,
  nextComposerLayout,
  type ComposerLayout,
  type ComposerRowWidths,
} from './useComposerFit'

// Roughly the real row in a floating agent window (measured in Chromium): eight actions, the context ring,
// and either Send alone or Stop beside the Interrupt / Follow up split button with its 45px Auto hint.
const SEND = 60
const BUSY = 224
const HINT = 45
const TRIGGER = 36
const widths = (overrides: Partial<ComposerRowWidths>): ComposerRowWidths => ({
  row: 500,
  actions: 296,
  trigger: null,
  status: 62,
  statusMin: 62,
  text: 0,
  send: SEND,
  hint: 0,
  rowGap: 8,
  leadGap: 4,
  ...overrides,
})
const busy = (overrides: Partial<ComposerRowWidths>) => widths({ send: BUSY, hint: HINT, ...overrides })
const inline: ComposerLayout = { level: 'inline', terse: false, wrap: false }
const folded: ComposerLayout = { level: 'folded', terse: false, wrap: false }
const compact: ComposerLayout = { level: 'compact', terse: false, wrap: false }
const terse: ComposerLayout = { level: 'compact', terse: true, wrap: false }
const wrapped: ComposerLayout = { level: 'compact', terse: false, wrap: true }

describe('composerNeeds', () => {
  test('adds each level of the row from its parts', () => {
    const needs = composerNeeds(busy({ trigger: TRIGGER, statusMin: 40 }))
    expect(needs.inline).toBe(296 + 4 + 62 + 8 + BUSY)
    expect(needs.folded).toBe(TRIGGER + 4 + 62 + 8 + BUSY)
    expect(needs.compact).toBe(TRIGGER + 4 + 62 + 8 + BUSY - HINT)
    expect(needs.minimum).toBe(TRIGGER + 4 + 40 + 8 + BUSY - HINT)
  })

  test('takes no gap for a status that is not shown', () => {
    expect(composerNeeds(widths({ status: null })).inline).toBe(296 + 8 + 60)
  })
})

describe('nextComposerLayout', () => {
  test('an idle composer keeps its actions inline where they fit beside Send', () => {
    // 430px needed.
    expect(nextComposerLayout(inline, widths({ row: 430 }))).toBe(inline)
    expect(nextComposerLayout(inline, widths({ row: 429 }))).toEqual(folded)
  })

  test('the same width folds while a turn runs, as Stop and the picker need more room than Send', () => {
    const row = 480
    expect(nextComposerLayout(inline, widths({ row }))).toBe(inline)
    expect(nextComposerLayout(inline, busy({ row }))).toEqual(folded)
    // And unfolds again when the turn ends.
    expect(nextComposerLayout(folded, widths({ row, trigger: TRIGGER }))).toEqual(inline)
  })

  test('Stop without the picker needs less room than Stop with it', () => {
    const row = 430
    expect(nextComposerLayout(inline, widths({ row, send: 50 }))).toBe(inline)
    expect(nextComposerLayout(inline, busy({ row }))).toEqual(folded)
  })

  test('a state word beside the ring folds a row that fit without it', () => {
    expect(nextComposerLayout(inline, widths({ row: 440 }))).toBe(inline)
    expect(nextComposerLayout(inline, widths({ row: 440, status: 62 + 120 }))).toEqual(folded)
  })

  test('while inline the trigger is unmeasured, so a row that no longer fits folds and is measured again', () => {
    // Even far too narrow for the folded row, the first step is folded; the hook measures again from there.
    expect(nextComposerLayout(inline, busy({ row: 200 }))).toEqual(folded)
    expect(nextComposerLayout(folded, busy({ row: 200, trigger: TRIGGER }))).toEqual(wrapped)
  })

  test('the narrowest floating window drops the Auto hint while a turn runs, and stays on one line', () => {
    // A 340px window's composer is 306px: the folded busy row needs 334px, without the hint 289px.
    const row = 306
    expect(composerNeeds(busy({ trigger: TRIGGER })).folded).toBeGreaterThan(row)
    expect(nextComposerLayout(folded, busy({ row, trigger: TRIGGER }))).toEqual(compact)
    // Idle, the same window folds only the actions.
    expect(nextComposerLayout(folded, widths({ row, trigger: TRIGGER }))).toBe(folded)
  })

  test('a long state word truncates, then goes once too little of it would show, before the row wraps', () => {
    const word = 110
    const waiting = { trigger: TRIGGER, status: 62 + 6 + word, statusMin: 62 + 6, text: word }
    const minimum = composerNeeds(busy(waiting)).minimum
    // Room for most of the word: it truncates.
    expect(nextComposerLayout(compact, busy({ ...waiting, row: minimum + 60 }))).toBe(compact)
    expect(nextComposerLayout(compact, busy({ ...waiting, row: minimum + COMPOSER_TEXT_MIN }))).toBe(compact)
    // Room for a letter or two: hidden, and back only with the margin to spare.
    expect(nextComposerLayout(compact, busy({ ...waiting, row: minimum + COMPOSER_TEXT_MIN - 1 }))).toEqual(terse)
    expect(
      nextComposerLayout(terse, busy({ ...waiting, row: minimum + COMPOSER_TEXT_MIN + COMPOSER_UNFOLD_MARGIN - 1 }))
    ).toBe(terse)
    expect(
      nextComposerLayout(terse, busy({ ...waiting, row: minimum + COMPOSER_TEXT_MIN + COMPOSER_UNFOLD_MARGIN }))
    ).toEqual(compact)
    // Wraps only once the ring alone beside the compact group cannot fit.
    expect(nextComposerLayout(terse, busy({ ...waiting, row: minimum }))).toBe(terse)
    expect(nextComposerLayout(terse, busy({ ...waiting, row: minimum - 1 }))).toEqual({ ...terse, wrap: true })
  })

  test('without status text nothing is ever terse', () => {
    expect(nextComposerLayout(compact, busy({ trigger: TRIGGER, row: 250 }))).toEqual(wrapped)
  })

  test('each level comes back only once it fits with the margin to spare', () => {
    const base = busy({ trigger: TRIGGER })
    const needs = composerNeeds(base)
    // Inside the margin it stays as it is, either way, so a width at the boundary does not flicker.
    for (const [from, to, needed] of [
      [folded, inline, needs.inline],
      [compact, folded, needs.folded],
      [wrapped, compact, needs.minimum],
    ] as const) {
      for (const row of [needed, needed + COMPOSER_UNFOLD_MARGIN - 1]) {
        expect(nextComposerLayout(from, { ...base, row })).toBe(from)
        expect(nextComposerLayout(to, { ...base, row })).toBe(to)
      }
      expect(nextComposerLayout(from, { ...base, row: needed + COMPOSER_UNFOLD_MARGIN })).toEqual(to)
      // Collapsing needs no margin: a row that does not fit collapses at once.
      expect(nextComposerLayout(to, { ...base, row: needed - 1 })).toEqual(from)
    }
  })

  test('a wide enough row expands from compact straight to inline', () => {
    const base = busy({ trigger: TRIGGER })
    expect(nextComposerLayout(wrapped, { ...base, row: composerNeeds(base).inline + COMPOSER_UNFOLD_MARGIN })).toEqual(
      inline
    )
  })

  test('ignores subpixel rounding at the boundary', () => {
    const needed = composerNeeds(widths({})).inline
    expect(nextComposerLayout(inline, widths({ row: needed - 0.4 }))).toBe(inline)
  })

  test("a phone's row stays folded however wide, and still drops the hint when tight", () => {
    expect(nextComposerLayout(folded, widths({ row: 2000, trigger: TRIGGER }), 'folded')).toBe(folded)
    expect(nextComposerLayout(inline, widths({ row: 2000 }), 'folded')).toEqual(folded)
    expect(nextComposerLayout(folded, busy({ row: 306, trigger: TRIGGER }), 'folded')).toEqual(compact)
  })

  test('a row with no width (not laid out, or in a hidden tab) keeps its layout', () => {
    expect(nextComposerLayout(inline, busy({ row: 0 }))).toBe(inline)
    expect(nextComposerLayout(compact, busy({ row: 0, trigger: TRIGGER }))).toBe(compact)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  COMPOSER_UNFOLD_MARGIN,
  inlineComposerWidth,
  nextComposerFolded,
  type ComposerRowWidths,
} from './useComposerFit'

// Roughly the real row in a floating agent window: eight actions, the context ring, and either Send alone
// or Stop beside the Interrupt / Follow up split button.
const SEND = 60
const STOP_AND_PICKER = 50 + 4 + 160
const widths = (overrides: Partial<ComposerRowWidths>): ComposerRowWidths => ({
  row: 500,
  actions: 296,
  status: 56,
  send: SEND,
  rowGap: 8,
  leadGap: 4,
  ...overrides,
})

describe('inlineComposerWidth', () => {
  test('adds the actions, the status with its gap, the row gap and the right-hand group', () => {
    expect(inlineComposerWidth(widths({}))).toBe(296 + 4 + 56 + 8 + 60)
  })

  test('takes no gap for a status that is not shown', () => {
    expect(inlineComposerWidth(widths({ status: null }))).toBe(296 + 8 + 60)
  })
})

describe('nextComposerFolded', () => {
  test('an idle composer keeps its actions inline where they fit beside Send', () => {
    // 424px needed.
    expect(nextComposerFolded(false, widths({ row: 424 }))).toBe(false)
    expect(nextComposerFolded(false, widths({ row: 423 }))).toBe(true)
  })

  test('the same width folds while a turn runs, as Stop and the picker need more room than Send', () => {
    const row = 480
    expect(nextComposerFolded(false, widths({ row, send: SEND }))).toBe(false)
    expect(nextComposerFolded(false, widths({ row, send: STOP_AND_PICKER }))).toBe(true)
    // And unfolds again when the turn ends.
    expect(nextComposerFolded(true, widths({ row, send: SEND }))).toBe(false)
  })

  test('Stop without the picker needs less room than Stop with it', () => {
    const row = 430
    expect(nextComposerFolded(false, widths({ row, send: 50 }))).toBe(false)
    expect(nextComposerFolded(false, widths({ row, send: STOP_AND_PICKER }))).toBe(true)
  })

  test('a wider status (a state word beside the ring) folds a row that fit without it', () => {
    expect(nextComposerFolded(false, widths({ row: 430 }))).toBe(false)
    expect(nextComposerFolded(false, widths({ row: 430, status: 56 + 120 }))).toBe(true)
  })

  test('folded actions come back only once the row fits with the margin to spare', () => {
    const needed = inlineComposerWidth(widths({}))
    // Inside the margin it stays as it is, either way, so a width at the boundary does not flicker.
    for (const row of [needed, needed + COMPOSER_UNFOLD_MARGIN - 1]) {
      expect(nextComposerFolded(true, widths({ row }))).toBe(true)
      expect(nextComposerFolded(false, widths({ row }))).toBe(false)
    }
    expect(nextComposerFolded(true, widths({ row: needed + COMPOSER_UNFOLD_MARGIN }))).toBe(false)
    // Folding needs no margin: a row that does not fit folds at once.
    expect(nextComposerFolded(false, widths({ row: needed - 1 }))).toBe(true)
  })

  test('ignores subpixel rounding at the boundary', () => {
    const needed = inlineComposerWidth(widths({}))
    expect(nextComposerFolded(false, widths({ row: needed - 0.4 }))).toBe(false)
  })

  test('a row with no width (not laid out, or in a hidden tab) keeps its state', () => {
    expect(nextComposerFolded(false, widths({ row: 0 }))).toBe(false)
    expect(nextComposerFolded(true, widths({ row: 0 }))).toBe(true)
  })
})

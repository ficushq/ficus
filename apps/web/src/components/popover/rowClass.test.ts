import { expect, test } from 'bun:test'
import { popoverRowClass } from './rowClass'

test('a selected row keeps its selected background and accent text when hovered or focused; other rows take the hover fill', () => {
  const selected = popoverRowClass(true).split(/\s+/)
  // The ghost variant's hover fill outranks a plain utility, so the selected look is repeated for hover.
  expect(selected).toEqual(
    expect.arrayContaining(['bg-selection', 'hover:bg-selection', 'text-accent-light', 'hover:text-accent-light'])
  )
  expect(selected.filter((name) => name.startsWith('focus-visible:'))).toEqual([])

  const other = popoverRowClass(false).split(/\s+/)
  expect(other).toEqual(expect.arrayContaining(['focus-visible:bg-surface-hover', 'focus-visible:text-primary']))
  expect(other).not.toContain('bg-selection')
})

import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SegmentedControl } from './SegmentedControl'

const options = [
  { value: 'list', label: 'List' },
  { value: 'kanban', label: 'Kanban', title: 'Columns by status' },
  {
    value: 'graph',
    label: 'Graph',
    ariaLabel: 'Graph, 2 blocked',
    badge: (selected: boolean) => <span data-selected={String(selected)}>2</span>,
  },
  { value: 'voice', label: 'Voice', disabled: true },
] as const

describe('SegmentedControl', () => {
  test('one radiogroup tray: the chosen option is checked and filled, the rest plain, with no borders', () => {
    const html = renderToStaticMarkup(
      <SegmentedControl ariaLabel="View" options={options} value="list" onChange={mock(() => {})} />
    )
    expect(html).toContain('role="radiogroup" aria-label="View"')
    expect(html).toMatch(/aria-checked="true"[^>]*class="[^"]*bg-accent text-on-accent[^"]*">List<\/button>/)
    expect(html).toMatch(/aria-checked="false"[^>]*>Kanban<\/button>/)
    expect(html).not.toContain('border')
  })

  test('options can carry a tooltip, an accessible name, a badge and their own disabled state', () => {
    const html = renderToStaticMarkup(
      <SegmentedControl ariaLabel="View" options={options} value="graph" onChange={mock(() => {})} />
    )
    expect(html).toContain('title="Columns by status"')
    expect(html).toContain('aria-label="Graph, 2 blocked"')
    expect(html).toContain('<span data-selected="true">2</span>')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Voice<\/button>/)
  })

  test('compact sizes to its options for toolbars; default fills its row', () => {
    const compact = renderToStaticMarkup(
      <SegmentedControl ariaLabel="View" size="compact" options={options} value="list" onChange={mock(() => {})} />
    )
    expect(compact).toContain('inline-flex')
    expect(compact).not.toContain('flex-1')
    const full = renderToStaticMarkup(
      <SegmentedControl ariaLabel="View" options={options} value="list" onChange={mock(() => {})} />
    )
    expect(full).toContain('flex-1')
  })
})

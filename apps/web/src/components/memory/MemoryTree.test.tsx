import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'

import { queries } from '../../queryOptions'
import { MemoryTree } from './MemoryTree'

const SQUAD = 'squad-1'

function renderRows(selectedPath?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queries.squadMemory.tree(SQUAD, '/memory', 1).queryKey, {
    name: 'memory',
    type: 'directory',
    children: [
      { name: 'decisions', type: 'directory' },
      { name: 'context.md', type: 'file', size: 10 },
      { name: 'map.md', type: 'file', size: 20 },
    ],
  })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryTree squadId={SQUAD} onSelectFile={() => {}} selectedPath={selectedPath} />
    </QueryClientProvider>
  )
  // Server markup is enough to read each row's classes; no DOM is needed. Tree rows are the
  // type="button" buttons, so each row's markup runs from its opening tag to the next row.
  const rows = html.split(/(?=<button type="button")/).slice(1)
  const row = (name: string) => {
    const markup = rows.find((chunk) => chunk.includes(`>${name}<`))!
    const tag = markup.slice(0, markup.indexOf('>') + 1)
    return {
      classes: new Set(tag.match(/class="([^"]*)"/)![1]!.split(' ')),
      selected: tag.includes('aria-current="true"'),
    }
  }
  return { row }
}

describe('MemoryTree row highlight', () => {
  test('a selected row keeps its selection background on hover instead of the grey hover', () => {
    const { row } = renderRows('/memory/context.md')
    const selected = row('context.md')
    expect(selected.selected).toBe(true)
    expect(selected.classes.has('bg-accent/10')).toBe(true)
    expect(selected.classes.has('text-accent-light')).toBe(true)
    // text-secondary is emitted after text-accent-light and would override the selected text color.
    expect(selected.classes.has('text-secondary')).toBe(false)
    expect(selected.classes.has('hover:bg-surface-hover')).toBe(false)
  })

  test('unselected files and folders keep the grey hover and no selection background', () => {
    const { row } = renderRows('/memory/context.md')
    for (const name of ['map.md', 'decisions']) {
      const unselected = row(name)
      expect(unselected.selected).toBe(false)
      expect(unselected.classes.has('hover:bg-surface-hover')).toBe(true)
      expect(unselected.classes.has('bg-accent/10')).toBe(false)
      expect(unselected.classes.has('text-secondary')).toBe(true)
      expect(unselected.classes.has('focus-visible:outline-accent')).toBe(true)
    }
  })
})

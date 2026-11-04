import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { Window } from 'happy-dom'

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
  const document = new Window().document
  document.body.innerHTML = html
  const row = (name: string) =>
    [...document.querySelectorAll('button[type="button"]')].find((button) => button.textContent?.includes(name))!
  return { row }
}

describe('MemoryTree row highlight', () => {
  test('a selected row keeps its selection background on hover instead of the grey hover', () => {
    const { row } = renderRows('/memory/context.md')
    const selected = row('context.md')
    expect(selected.getAttribute('aria-current')).toBe('true')
    expect(selected.classList.contains('bg-accent/10')).toBe(true)
    expect(selected.classList.contains('text-accent-light')).toBe(true)
    // text-secondary is emitted after text-accent-light and would override the selected text color.
    expect(selected.classList.contains('text-secondary')).toBe(false)
    expect(selected.classList.contains('hover:bg-surface-hover')).toBe(false)
  })

  test('unselected files and folders keep the grey hover and no selection background', () => {
    const { row } = renderRows('/memory/context.md')
    for (const name of ['map.md', 'decisions']) {
      const unselected = row(name)
      expect(unselected.getAttribute('aria-current')).toBeNull()
      expect(unselected.classList.contains('hover:bg-surface-hover')).toBe(true)
      expect(unselected.classList.contains('bg-accent/10')).toBe(false)
      expect(unselected.classList.contains('text-secondary')).toBe(true)
      expect(unselected.classList.contains('focus-visible:outline-accent')).toBe(true)
    }
  })
})

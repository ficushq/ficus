import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { Window } from 'happy-dom'

import type { TreeNode } from '../../api/workspace'
import { FileTree } from './FileTree'
import type { WorkspaceSource } from './workspaceSource'

const ROOT: TreeNode = {
  name: '',
  type: 'directory',
  children: [
    { name: 'src', type: 'directory' },
    { name: 'README.md', type: 'file', size: 10 },
    { name: 'notes.md', type: 'file', size: 20 },
  ],
}

const source: WorkspaceSource = {
  id: 'squad:squad-1',
  treeQuery: (path) => ({ queryKey: ['test-tree', path], queryFn: async () => ROOT }),
  treeQueryPrefix: ['test-tree'],
  fileQuery: (path) => ({ queryKey: ['test-file', path], queryFn: async () => ({}) as never }),
  downloadUrl: (path) => `/download/${path}`,
  upload: async () => ({}) as never,
  canWrite: false,
  directoryDownload: true,
  emptyTitle: 'Empty',
  description: 'Workspace',
  loadingLabel: 'Loading files',
}

function renderRows(selectedPath?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(['test-tree', ''], ROOT)
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <FileTree source={source} onSelectFile={() => {}} selectedPath={selectedPath} />
    </QueryClientProvider>
  )
  const document = new Window().document
  document.body.innerHTML = html
  const row = (name: string) =>
    [...document.querySelectorAll('[role="button"]')].find((element) => element.textContent?.includes(name))!
  return { row }
}

describe('FileTree row highlight', () => {
  test('a selected row keeps its selection background on hover instead of the grey hover', () => {
    const { row } = renderRows('README.md')
    const selected = row('README.md')
    expect(selected.classList.contains('bg-accent/10')).toBe(true)
    expect(selected.classList.contains('text-accent-light')).toBe(true)
    // text-secondary is emitted after text-accent-light and would override the selected text color.
    expect(selected.classList.contains('text-secondary')).toBe(false)
    expect(selected.classList.contains('hover:bg-surface-hover')).toBe(false)
    // Row actions still reveal on hover and keyboard focus of the selected row.
    expect(selected.classList.contains('group')).toBe(true)
    expect(selected.querySelector('button[title="Download"]')?.className).toContain('group-hover:opacity-100')
  })

  test('unselected files and folders keep the grey hover and no selection background', () => {
    const { row } = renderRows('README.md')
    for (const name of ['notes.md', 'src']) {
      const unselected = row(name)
      expect(unselected.classList.contains('hover:bg-surface-hover')).toBe(true)
      expect(unselected.classList.contains('bg-accent/10')).toBe(false)
      expect(unselected.classList.contains('text-secondary')).toBe(true)
      expect(unselected.classList.contains('group')).toBe(true)
    }
  })
})

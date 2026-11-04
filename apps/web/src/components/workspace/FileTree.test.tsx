import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'

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
  // Server markup is enough to read each row's classes; no DOM is needed. Tree rows are the
  // role="button" divs, so each row's markup (with its actions) runs to the next row.
  const rows = html.split(/(?=<div [^>]*role="button")/).slice(1)
  const row = (name: string) => {
    const markup = rows.find((chunk) => chunk.includes(`>${name}<`))!
    const tag = markup.slice(0, markup.indexOf('>') + 1)
    return { classes: new Set(tag.match(/class="([^"]*)"/)![1]!.split(' ')), markup }
  }
  return { row }
}

describe('FileTree row highlight', () => {
  test('a selected row keeps its selection background on hover instead of the grey hover', () => {
    const { row } = renderRows('README.md')
    const selected = row('README.md')
    expect(selected.classes.has('bg-accent/10')).toBe(true)
    expect(selected.classes.has('text-accent-light')).toBe(true)
    // text-secondary is emitted after text-accent-light and would override the selected text color.
    expect(selected.classes.has('text-secondary')).toBe(false)
    expect(selected.classes.has('hover:bg-surface-hover')).toBe(false)
    // Row actions still reveal on hover and keyboard focus of the selected row.
    expect(selected.classes.has('group')).toBe(true)
    expect(selected.markup).toMatch(/<button class="[^"]*group-hover:opacity-100[^"]*"[^>]*title="Download"/)
  })

  test('unselected files and folders keep the grey hover and no selection background', () => {
    const { row } = renderRows('README.md')
    for (const name of ['notes.md', 'src']) {
      const unselected = row(name)
      expect(unselected.classes.has('hover:bg-surface-hover')).toBe(true)
      expect(unselected.classes.has('bg-accent/10')).toBe(false)
      expect(unselected.classes.has('text-secondary')).toBe(true)
      expect(unselected.classes.has('group')).toBe(true)
    }
  })
})

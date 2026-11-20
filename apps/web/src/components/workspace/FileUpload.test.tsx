import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../../test/domHarness'
import type { UploadOptions, UploadResponse } from '../../api/workspace'
import type { WorkspaceSource } from './workspaceSource'
import { FileUpload } from './FileUpload'

type Upload = { paths: string[]; overwrite: boolean }

async function openConflict() {
  const dom = await acquireDomHarness({})
  const { root } = dom.createRoot()
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const uploads: Upload[] = []
  const events: string[] = []
  const source = {
    id: 'squad:s1',
    treeQueryPrefix: ['workspace', 's1'],
    canWrite: true,
    upload: async (files: { relativePath: string }[], options: UploadOptions): Promise<UploadResponse> => {
      uploads.push({ paths: files.map((file) => file.relativePath), overwrite: !!options.overwrite })
      // Like a real request, it finishes after React has rendered the files it was given.
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        results: files.map((file) => ({
          path: file.relativePath,
          status: options.overwrite || file.relativePath === 'new.md' ? 'uploaded' : 'skipped',
        })),
      } as UploadResponse
    },
  } as unknown as WorkspaceSource
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <div className="relative">
          <FileUpload source={source} onUploadComplete={() => events.push('complete')} />
        </div>
      </QueryClientProvider>
    )
  )
  const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([webkitdirectory])')!
  const files = Object.assign(Object.create(window.FileList.prototype), {
    0: new File(['a'], 'notes.md'),
    1: new File(['b'], 'new.md'),
    length: 2,
    *[Symbol.iterator]() {
      yield this[0]
      yield this[1]
    },
  }) as FileList
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await dom.act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const dialog = () =>
    document.querySelector<HTMLElement>('.ficus-modal-backdrop[role="dialog"][aria-label="Files already exist"]')
  const button = (label: string) =>
    [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
    )!
  const act = (run: () => void) =>
    dom.act(async () => {
      run()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  return {
    dom,
    uploads,
    events,
    dialog,
    button,
    act,
    cleanup: async () => {
      await dom.cleanup()
      cache.clear()
    },
  }
}

test('an upload conflict asks in the shared Modal, and Overwrite uploads only the conflicting files again', async () => {
  const t = await openConflict()
  try {
    const dialog = t.dialog()!
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.dataset.state).toBe('open')
    expect(dialog.className).toContain('z-60')
    expect(dialog.textContent).toContain('1 file(s) already exist at the destination:')
    expect(dialog.querySelector('li')!.textContent).toContain('notes.md')
    expect(t.uploads).toEqual([{ paths: ['notes.md', 'new.md'], overwrite: false }])

    await t.act(() => t.button('Overwrite').click())
    expect(t.uploads.at(-1)).toEqual({ paths: ['notes.md'], overwrite: true })
    expect(dialog.dataset.state).toBe('closed')
    expect(t.events).toEqual(['complete'])
  } finally {
    await t.cleanup()
  }
})

for (const [how, dismiss] of [
  ['Skip', (t: Awaited<ReturnType<typeof openConflict>>) => t.button('Skip').click()],
  ['the close button', (t: Awaited<ReturnType<typeof openConflict>>) => t.button('Close').click()],
  [
    'Escape',
    () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
  ],
  ['a backdrop click', (t: Awaited<ReturnType<typeof openConflict>>) => t.dialog()!.click()],
] as const)
  test(`dismissing an upload conflict with ${how} skips the conflicting files`, async () => {
    const t = await openConflict()
    try {
      await t.act(() => dismiss(t))
      expect(t.dialog()!.dataset.state).toBe('closed')
      expect(t.uploads).toHaveLength(1)
      expect(t.events).toEqual(['complete'])
    } finally {
      await t.cleanup()
    }
  })

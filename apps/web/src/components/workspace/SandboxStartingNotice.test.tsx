import { expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { FileContent, TreeNode } from '../../api/workspace'
import { ApiError } from '../../api/client'
import { createAppQueryClient } from '../../lib/appQueryClient'
import { acquireDomHarness } from '../../test/domHarness'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import type { WorkspaceSource } from './workspaceSource'

/** Core's answer to a workspace read while the sandbox's provisioning circuit is open, as apiFetch throws it. */
const provisioning = (retryAfterMs: number, code = 'SANDBOX_PROVISION_UNAVAILABLE') =>
  new ApiError(
    503,
    'API error: 503: Sandbox scheduling is temporarily unavailable.',
    { error: 'Sandbox scheduling is temporarily unavailable.', code, retryAfterMs },
    retryAfterMs
  )

const ROOT: TreeNode = { name: '', type: 'directory', children: [{ name: 'README.md', type: 'file', size: 10 }] }

function sourceOf(read: () => Promise<unknown>): WorkspaceSource {
  return {
    id: 'squad:squad-1',
    treeQuery: (path) => ({ queryKey: ['test-tree', path], queryFn: read as () => Promise<TreeNode> }),
    treeQueryPrefix: ['test-tree'],
    fileQuery: (path) => ({ queryKey: ['test-file', path], queryFn: read as () => Promise<FileContent> }),
    downloadUrl: (path) => `/download/${path}`,
    upload: async () => ({}) as never,
    canWrite: false,
    directoryDownload: true,
    emptyTitle: 'Empty',
    description: 'Workspace',
    loadingLabel: 'Loading files',
  }
}

/** Mounts `ui` with the app's own query client, so its real retry policy applies. */
async function mount(ui: ReactNode) {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const cache = createAppQueryClient()
  const root = dom.createRoot()
  const text = () => dom.window.document.body.textContent ?? ''
  const settle = async (done: () => boolean, attempts = 100) => {
    for (let attempt = 0; attempt < attempts && !done(); attempt++)
      await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  }
  await dom.act(async () => root.root.render(<QueryClientProvider client={cache}>{ui}</QueryClientProvider>))
  const cleanup = async () => {
    await cache.cancelQueries()
    cache.clear()
    await dom.cleanup()
  }
  return { text, settle, cleanup }
}

test('a file tree waits out a provisioning 503 longer than a minute instead of failing', async () => {
  let reads = 0
  const panel = await mount(
    <FileTree
      source={sourceOf(async () => {
        reads++
        throw provisioning(75_000)
      })}
      onSelectFile={() => {}}
    />
  )
  try {
    await panel.settle(() => panel.text().includes('The workspace is starting'))
    expect(panel.text()).toContain('The workspace is starting')
    expect(panel.text()).toContain('Files will load as soon as it is ready')
    expect(panel.text()).not.toContain('Failed to load files')
    // One read so far: the retry waits for the 75 seconds Core asked for.
    expect(reads).toBe(1)
  } finally {
    await panel.cleanup()
  }
})

test('a file tree loads once the sandbox is up after a provisioning 503', async () => {
  let reads = 0
  const panel = await mount(
    <FileTree
      source={sourceOf(async () => {
        reads++
        if (reads === 1) throw provisioning(1_000)
        return ROOT
      })}
      onSelectFile={() => {}}
    />
  )
  try {
    await panel.settle(() => panel.text().includes('README.md'), 150)
    expect(panel.text()).toContain('README.md')
    expect(panel.text()).not.toContain('The workspace is starting')
    expect(reads).toBe(2)
  } finally {
    await panel.cleanup()
  }
})

test('another 503 is not called a starting workspace', async () => {
  const panel = await mount(
    <FileTree
      source={sourceOf(async () => Promise.reject(provisioning(75_000, 'read_deadline_exceeded')))}
      onSelectFile={() => {}}
    />
  )
  try {
    // Over the general 60-second bound: no retry, the error shows at once.
    await panel.settle(() => panel.text().includes('Failed to load files'))
    expect(panel.text()).toContain('Failed to load files')
    expect(panel.text()).not.toContain('The workspace is starting')
  } finally {
    await panel.cleanup()
  }
})

test('a provisioning that failed shows its error, not a starting workspace', async () => {
  let reads = 0
  const panel = await mount(
    <FileTree
      source={sourceOf(async () => {
        reads++
        // Core's hard failure; over the general 60-second bound so the ordinary rule fails at once.
        throw provisioning(75_000, 'SANDBOX_PROVISION_FAILED')
      })}
      onSelectFile={() => {}}
    />
  )
  try {
    await panel.settle(() => panel.text().includes('Failed to load files'))
    expect(panel.text()).toContain('Failed to load files')
    expect(panel.text()).not.toContain('The workspace is starting')
    expect(reads).toBe(1)
  } finally {
    await panel.cleanup()
  }
})

test('a wait past the sandbox bound fails with Retry, as other errors do', async () => {
  const panel = await mount(
    <FileTree source={sourceOf(async () => Promise.reject(provisioning(10 * 60_000)))} onSelectFile={() => {}} />
  )
  try {
    await panel.settle(() => panel.text().includes('Failed to load files'))
    expect(panel.text()).toContain('Failed to load files')
    expect(panel.text()).toContain('Retry')
    expect(panel.text()).not.toContain('The workspace is starting')
  } finally {
    await panel.cleanup()
  }
})

test('the file viewer shows the same waiting state', async () => {
  const panel = await mount(
    <FileViewer source={sourceOf(async () => Promise.reject(provisioning(75_000)))} filePath="README.md" />
  )
  try {
    await panel.settle(() => panel.text().includes('The workspace is starting'))
    expect(panel.text()).toContain('This file will load as soon as it is ready')
    expect(panel.text()).not.toContain('Failed to load file')
  } finally {
    await panel.cleanup()
  }
})

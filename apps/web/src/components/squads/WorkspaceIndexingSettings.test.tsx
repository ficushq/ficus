import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MemoryConfig } from '../../api/squads'
import { queryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import { WorkspaceIndexingSettings } from './WorkspaceIndexingSettings'

for (const aggregated of [false, true]) {
  test(`scan status counts ${aggregated ? 'aggregated' : 'legacy per-path'} skipped files`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/squads/squad-one/settings' })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
    const skipped: NonNullable<MemoryConfig['workspaceScanStatus']>['skipped'] = aggregated
      ? [{ path: 'example.md', reason: 'max_files_exceeded', count: 1100, detail: 'Paths aggregated; example shown' }]
      : [
          { path: 'a.md', reason: 'max_files_exceeded' },
          { path: 'b.md', reason: 'max_files_exceeded' },
        ]
    client.setQueryData(queryKeys.squads.basic('squad-one'), {
      id: 'squad-one',
      metadata: {
        memory: {
          workspacePaths: { include: ['*.md'] },
          workspaceScanStatus: { lastScan: '2026-10-28T00:00:00Z', filesIndexed: 1000, skipped },
        },
      },
    })
    try {
      const { root } = dom.createRoot()
      await dom.act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <WorkspaceIndexingSettings squadId="squad-one" />
          </QueryClientProvider>
        )
      )
      const count = aggregated ? 1100 : 2
      const button = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === `${count} skipped`
      )
      expect(button).toBeDefined()
      await dom.act(async () => button!.click())
      expect(dom.window.document.body.textContent).toContain(`Pattern file limit (1000) (${count})`)
    } finally {
      client.clear()
      await dom.cleanup()
    }
  })
}

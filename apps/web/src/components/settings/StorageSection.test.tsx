import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { StorageSnapshot } from '@ficus/shared'
import { queryKeys } from '../../queryKeys'
import { StorageSection } from './StorageSection'

test('partial measurements and unvisited homes remain visible with scan diagnostics', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const data: StorageSnapshot = {
    supported: true,
    scanning: false,
    scannedAt: '2026-09-20T00:00:00Z',
    error: null,
    machines: [
      {
        id: 'machine',
        name: 'Worker',
        status: 'partial',
        usedBytes: 1000,
        totalBytes: 2000,
        unattributedBytes: null,
        squads: [
          {
            id: 'squad',
            name: 'Product',
            bytes: 500,
            status: 'partial',
            folders: [
              { name: 'Workspace', path: '/home/box_a', bytes: 500, status: 'partial', children: [] },
              { name: 'Agent files', path: '/home/box_b', bytes: null, status: 'unavailable', children: [] },
            ],
          },
        ],
        diagnostics: {
          exitCode: 124,
          reasons: ['scan_timeout', 'missing_home_totals'],
          expectedHomes: 2,
          measuredHomes: 0,
          missingHomes: ['/home/box_a', '/home/box_b'],
        },
      },
    ],
  }
  client.setQueryData(queryKeys.system.storage(), data)
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <StorageSection />
      </QueryClientProvider>
    )
    expect(html).toContain('Product')
    expect(html).toContain('Workspace')
    expect(html).toContain('500 B measured · Partial')
    expect(html).toContain('Not measured')
    expect(html).toContain('45-second time limit')
    expect(html).toContain('0 of 2 sandbox home totals returned')
    expect(html).not.toContain('>0 B<')
  } finally {
    client.clear()
  }
})

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
    expect(html).toContain('could not be measured in time, even in smaller parts')
    expect(html).toContain('0 of 2 sandbox homes have a')
    expect(html).not.toContain('>0 B<')
  } finally {
    client.clear()
  }
})

test('shows pass progress, per-home freshness, and growth for homes, squads and the host', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const GiB = 1024 ** 3
  const data: StorageSnapshot = {
    supported: true,
    scanning: true,
    scannedAt: minutesAgo(1),
    error: null,
    machines: [
      {
        id: 'machine',
        name: 'Worker',
        status: 'available',
        usedBytes: 600 * GiB,
        totalBytes: 1000 * GiB,
        diskMeasuredAt: minutesAgo(1),
        diskGrowth: { bytes: 29 * GiB, since: minutesAgo(24 * 60) },
        unattributedBytes: 0,
        scan: {
          state: 'running',
          generation: 14,
          passStartedAt: minutesAgo(12),
          lastCompletedAt: minutesAgo(15),
          measuredHomes: 180,
          totalHomes: 234,
        },
        squads: [
          {
            id: 'squad',
            name: 'Product',
            bytes: 40 * GiB,
            status: 'available',
            growth: { bytes: 12 * GiB, since: minutesAgo(24 * 60) },
            folders: [
              {
                name: 'Squad workspace',
                path: '/home/box_a',
                bytes: 30 * GiB,
                status: 'available',
                children: [],
                kind: 'squad-workspace',
                measuredAt: minutesAgo(3),
                freshness: 'current',
                growth: { bytes: 12 * GiB, since: minutesAgo(24 * 60) },
              },
              {
                name: 'Old workspace',
                path: '/home/box_c',
                bytes: 10 * GiB,
                status: 'available',
                children: [],
                kind: 'squad-workspace',
                measuredAt: minutesAgo(70),
                freshness: 'previous',
                growth: { bytes: -100 * 1024 ** 2, since: minutesAgo(25 * 60) },
              },
            ],
          },
        ],
        diagnostics: { exitCode: null, reasons: [], expectedHomes: 2, measuredHomes: 2, missingHomes: [] },
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
    expect(html).toContain('Pass 14: 180 of 234 homes measured, started 12m ago.')
    expect(html).toContain('+29.0 GiB in 24h')
    expect(html).toContain('+12.0 GiB in 24h')
    expect(html).toContain('measured 3m ago')
    expect(html).toContain('measured 1h ago · previous pass')
    expect(html).toContain('−100.0 MiB in 25h')
    expect(html).not.toContain('Not measured')
  } finally {
    client.clear()
  }
})

test('approximate home totals are marked, squads containing one show ≈, and the hard-link note is shown', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const GiB = 1024 ** 3
  const data: StorageSnapshot = {
    supported: true,
    scanning: false,
    scannedAt: '2026-09-20T00:00:00Z',
    error: null,
    machines: [
      {
        id: 'machine',
        name: 'Worker',
        status: 'available',
        usedBytes: 100 * GiB,
        totalBytes: 200 * GiB,
        unattributedBytes: 0,
        squads: [
          {
            id: 'squad',
            name: 'Product',
            bytes: 30 * GiB,
            status: 'available',
            totalExact: false,
            folders: [
              {
                name: 'Squad workspace',
                path: '/home/box_a',
                bytes: 27 * GiB,
                status: 'available',
                kind: 'squad-workspace',
                totalExact: false,
                children: [],
              },
              {
                name: 'Agent files',
                path: '/home/box_b',
                bytes: 3 * GiB,
                status: 'available',
                kind: 'agent',
                totalExact: false,
                children: [],
              },
            ],
          },
          {
            id: 'other',
            name: 'Research',
            bytes: 20 * GiB,
            status: 'available',
            totalExact: true,
            folders: [
              {
                name: 'Research workspace',
                path: '/home/box_c',
                bytes: 20 * GiB,
                status: 'available',
                kind: 'squad-workspace',
                totalExact: true,
                children: [],
              },
            ],
          },
        ],
        diagnostics: { exitCode: null, reasons: [], expectedHomes: 3, measuredHomes: 3, missingHomes: [] },
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
    // The workspace row and the agent row are each marked, with the explanation as a tooltip.
    expect(html.match(/data-storage-approximate/g)).toHaveLength(2)
    expect(html).toContain('title="Hard-linked files may be counted more than once')
    expect(html).toContain('>approximate<')
    expect(html).toContain(
      'title="Includes an approximate home total: hard-linked files may be counted more than once."'
    )
    expect(html).toContain('≈ 30.0 GiB')
    expect(html).not.toContain('≈ 20.0 GiB')
    expect(html).toContain(
      'Folder sizes can add up to more than the total: files hard-linked into several folders are counted in each.'
    )
  } finally {
    client.clear()
  }
})

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SquadStorageView, StorageAgent, StorageFolder } from '@ficus/shared'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { queryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import { squadScanLabel } from '../settings/storage/format'
import { SquadStorageSettings } from './SquadStorageSettings'
import { SquadSettingsTab } from './SquadSettingsTab'

const GiB = 1024 ** 3
const MiB = 1024 ** 2
const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()
const HOUR = 3_600_000

function agentFolder(id: string, bytes: number, agent: Omit<StorageAgent, 'id' | 'createdAt'>): StorageFolder {
  return {
    name: agent.label,
    path: `/home/box_${id}`,
    bytes,
    status: 'available',
    children: [],
    kind: 'agent',
    agent: { id, createdAt: ago(400 * 24 * HOUR), ...agent },
    measuredAt: ago(HOUR),
    freshness: 'current',
    totalExact: true,
  }
}

/** Synthetic storage for two squads on the same machine; each view holds only its own squad. */
function alphaView(): SquadStorageView {
  return {
    squad: { id: 'squad-alpha', name: 'Alpha' },
    supported: true,
    scanning: false,
    scannedAt: ago(HOUR),
    oldestMeasuredAt: ago(5 * HOUR),
    error: null,
    monitoring: { intervalHours: 1, nextScanAt: null },
    dormantRetentionDays: 7,
    bytes: 6 * GiB,
    machines: [
      {
        id: 'machine-1',
        name: 'Worker one',
        scan: {
          state: 'running',
          generation: 14,
          passStartedAt: ago(12 * 60_000),
          lastCompletedAt: ago(2 * HOUR),
        },
        storage: {
          id: 'squad-alpha',
          name: 'Alpha',
          bytes: 6 * GiB,
          status: 'available',
          totalExact: true,
          growth: { bytes: 2 * GiB, since: ago(24 * HOUR) },
          folders: [
            {
              name: 'Squad workspace',
              path: '/home/box_alpha_ws',
              bytes: 4 * GiB,
              status: 'available',
              kind: 'squad-workspace',
              measuredAt: ago(5 * HOUR),
              freshness: 'previous',
              totalExact: true,
              growth: { bytes: 2 * GiB, since: ago(24 * HOUR) },
              children: [
                {
                  name: 'workspace',
                  path: '/home/box_alpha_ws/workspace',
                  bytes: 3 * GiB,
                  status: 'available',
                  children: [],
                },
                {
                  name: 'memory',
                  path: '/home/box_alpha_ws/memory',
                  bytes: 200 * MiB,
                  status: 'available',
                  children: [],
                },
              ],
            },
            agentFolder('alpha-eng', GiB, {
              label: 'Build API · Ada',
              agentTypeId: 'engineer',
              status: 'active',
              lastMessageAt: ago(HOUR),
              dormantAt: null,
            }),
            agentFolder('alpha-old', GiB, {
              label: 'Old research · Bo',
              agentTypeId: 'consultant',
              status: 'dormant',
              lastMessageAt: ago(30 * 24 * HOUR),
              dormantAt: ago(2 * 24 * HOUR),
            }),
          ],
        },
      },
    ],
    storedFiles: {
      bytes: 3 * GiB + 2048,
      sources: [
        { key: 'agentFiles', label: 'Agent file attachments', countsTowardQuota: true, bytes: 3 * GiB },
        { key: 'inboxAttachments', label: 'Inbox attachments', countsTowardQuota: true, bytes: 0 },
        { key: 'images', label: 'Images', countsTowardQuota: false, bytes: 2048 },
      ],
    },
  }
}

function betaView(): SquadStorageView {
  return {
    squad: { id: 'squad-beta', name: 'Beta' },
    supported: true,
    scanning: false,
    scannedAt: ago(HOUR),
    oldestMeasuredAt: ago(HOUR),
    error: null,
    monitoring: { intervalHours: 1, nextScanAt: null },
    dormantRetentionDays: 7,
    bytes: 512 * MiB,
    machines: [
      {
        id: 'machine-1',
        name: 'Worker one',
        storage: {
          id: 'squad-beta',
          name: 'Beta',
          bytes: 512 * MiB,
          status: 'available',
          folders: [
            {
              name: 'Squad workspace',
              path: '/home/box_beta_ws',
              bytes: 500 * MiB,
              status: 'available',
              kind: 'squad-workspace',
              children: [],
            },
            agentFolder('beta-eng', 12 * MiB, {
              label: 'Ship docs · Cy',
              agentTypeId: 'engineer',
              status: 'idle',
              lastMessageAt: ago(HOUR),
              dormantAt: null,
            }),
          ],
        },
      },
    ],
    storedFiles: { bytes: 0, sources: [] },
  }
}

function seededClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.squads.storage('squad-alpha'), alphaView())
  client.setQueryData(queryKeys.squads.storage('squad-beta'), betaView())
  return client
}

const grant = (granted: string[]) => () => ({
  permissions: granted,
  can: (permission: string) => granted.includes(permission),
  isLoading: false,
  isError: false,
})

function renderSection(squadId: string, client = seededClient(), granted = ['storage:read']) {
  try {
    return renderToStaticMarkup(
      <PermissionsProvider usePermissions={grant(granted)}>
        <QueryClientProvider client={client}>
          <SquadStorageSettings squadId={squadId} />
        </QueryClientProvider>
      </PermissionsProvider>
    )
  } finally {
    client.clear()
  }
}

describe('SquadStorageSettings', () => {
  test('shows each squad only its own homes, folders and stored files', () => {
    const alpha = renderSection('squad-alpha')
    expect(alpha).toContain('Build API · Ada')
    expect(alpha).toContain('/home/box_alpha_ws/workspace')
    expect(alpha).toContain('Agent file attachments')
    for (const other of ['Beta', 'Ship docs · Cy', 'box_beta_ws']) expect(alpha).not.toContain(other)

    const beta = renderSection('squad-beta')
    expect(beta).toContain('Ship docs · Cy')
    expect(beta).toContain('512.0 MiB')
    expect(beta).toContain('No attachments or images are stored for this squad yet.')
    for (const other of ['Alpha', 'Build API · Ada', 'Old research', 'box_alpha_ws', 'Agent file attachments'])
      expect(beta).not.toContain(other)
  })

  test('renders the squad workspace with its workspace and memory folders, then agents, expanded', () => {
    const html = renderSection('squad-alpha')
    expect(html).toMatch(/<details open=""/)
    expect(html.indexOf('Squad workspace')).toBeLessThan(html.indexOf('>workspace<'))
    expect(html.indexOf('>workspace<')).toBeLessThan(html.indexOf('>memory<'))
    expect(html.indexOf('>memory<')).toBeLessThan(html.indexOf('Build API · Ada'))
    expect(html).toContain('engineer · active · last active today')
    // The dormant agent is folded into the shared dormant summary.
    expect(html).toContain('1 dormant · 1.0 GiB · removed automatically from')
  })

  test('shows growth, measurement age, freshness and scan state', () => {
    const html = renderSection('squad-alpha')
    expect(html).toContain('+2.0 GiB in 24h')
    expect(html).toContain('measured 5h ago · previous pass')
    expect(html).toContain('Last measured')
    expect(html).toContain('the oldest value is from')
    expect(html).toContain('Pass 14 is measuring, started 12m ago.')
  })

  test('summarizes stored files per source with the squad total, noting sources outside the quota', () => {
    const html = renderSection('squad-alpha')
    const files = html.slice(html.indexOf('Files stored by Ficus'))
    expect(files).toContain('Agent file attachments')
    expect(files).toContain('Images')
    expect(files).toContain('Does not count toward the attachment quota')
    // Sources with no bytes for this squad are left out.
    expect(files).not.toContain('Inbox attachments')
    expect(files).toContain('3.0 GiB')
    // No instance-wide quota bar or other squads' rows.
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain('Unattributed')
  })

  test('offers no Refresh, and cleanup actions only with their own permissions', () => {
    const readOnly = renderSection('squad-alpha')
    for (const label of ['Refresh', 'Make dormant', 'Remove now', 'Make idle consultants dormant'])
      expect(readOnly).not.toContain(label)

    const terminate = renderSection('squad-alpha', seededClient(), ['storage:read', 'agents:terminate'])
    expect(terminate).toContain('>Make dormant<')
    expect(terminate).not.toContain('Remove now')
  })

  test('a squad on several machines shows the total once and squad actions on the first machine only', () => {
    const client = seededClient()
    const data = alphaView()
    data.machines.push({ ...data.machines[0]!, id: 'machine-2', name: 'Worker two', scan: undefined })
    data.bytes = 12 * GiB
    client.setQueryData(queryKeys.squads.storage('squad-alpha'), data)
    const html = renderSection('squad-alpha', client, ['storage:read', 'agents:terminate'])
    expect(html).toContain('Total across 2 machines')
    expect(html).toContain('12.0 GiB')
    expect(html.split('Make idle consultants dormant').length - 1).toBe(1)
    expect(renderSection('squad-alpha')).not.toContain('Total across')
  })

  test('explains unsupported runtimes and errors, and keeps stored files', () => {
    const client = seededClient()
    client.setQueryData(queryKeys.squads.storage('squad-beta'), {
      ...betaView(),
      supported: false,
      machines: [],
      bytes: null,
      scannedAt: null,
      oldestMeasuredAt: null,
      error: 'The last storage scan step failed.',
    })
    const html = renderSection('squad-beta', client)
    expect(html).toContain('measured on Cloud and self-hosted instances using VM sandbox machines')
    expect(html).toContain('role="alert"')
    expect(html).toContain('The last storage scan step failed.')
    expect(html).toContain('Files stored by Ficus')
  })

  test('the squad scan label never claims instance-wide home counts', () => {
    const scan = alphaView().machines[0]!.scan!
    expect(squadScanLabel(scan, now)).toBe('Pass 14 is measuring, started 12m ago.')
    expect(squadScanLabel({ ...scan, state: 'idle' }, now)).toBe('Last full pass finished 2h ago.')
    expect(squadScanLabel({ ...scan, state: 'idle', lastCompletedAt: null }, now)).toBe('Pass 14 started 12m ago.')
  })

  test('the query is keyed per squad and polls faster while a pass runs or a removal is pending', () => {
    expect(queries.squads.storage('squad-alpha').queryKey).not.toEqual(queries.squads.storage('squad-beta').queryKey)
    const interval = queries.squads.storage('squad-alpha').refetchInterval as (query: {
      state: { data?: SquadStorageView }
    }) => number
    expect(interval({ state: { data: alphaView() } })).toBe(300000)
    expect(interval({ state: { data: { ...alphaView(), scanning: true } } })).toBe(30000)
    const pending = alphaView()
    pending.machines[0]!.storage.folders[2]!.agent!.removalPending = true
    expect(interval({ state: { data: pending } })).toBe(10000)
  })
})

function renderSettings(permissions: string[] | null, entry: string) {
  const client = seededClient()
  client.setQueryData(queryKeys.sandbox.status('squad-alpha'), { status: 'running', runtime: 'vm' })
  if (permissions)
    client.setQueryData(queryKeys.auth.permissions('squad-alpha'), {
      permissions,
      identity: { type: 'user', userId: 'user-1' },
    })
  try {
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={[entry]}>
        <QueryClientProvider client={client}>
          <SquadSettingsTab
            squadId="squad-alpha"
            name="Alpha"
            purpose="test"
            context={null}
            typeContext={null}
            globalCollaborationEnabled={false}
            maxConcurrentWorkStreams={null}
            blockedGraceMinutes={null}
            consultantIdleDormancyDays={null}
            hostWorkspacePath={null}
          />
        </QueryClientProvider>
      </MemoryRouter>
    )
  } finally {
    client.clear()
  }
}

describe('SquadSettingsTab Storage section', () => {
  // The nav item: a button whose label span reads Storage, marked current when open.
  const storageNavItem = /<button[^>]*aria-current="page"[^>]*>(?:(?!<\/button>).)*<span>Storage<\/span><\/button>/

  test('appears in the Workspace group and opens the squad view for storage:read holders', () => {
    const html = renderSettings(['storage:read', 'squads:read'], '/squads/squad-alpha/settings?section=storage')
    expect(html).toMatch(storageNavItem)
    expect(html.indexOf('<span>Workspace</span>')).toBeLessThan(html.indexOf('<span>Storage</span>'))
    expect(html.indexOf('<span>Storage</span>')).toBeLessThan(html.indexOf('<span>Memory</span>'))
    expect(html).toContain('id="squad-storage-heading"')
    expect(html).toContain('Build API · Ada')
    expect(html).not.toContain('Ship docs · Cy')
  })

  test('is hidden without storage:read, and its deep link falls back to General', () => {
    const html = renderSettings(['squads:read', 'squads:update'], '/squads/squad-alpha/settings?section=storage')
    expect(html).not.toContain('<span>Storage</span>')
    expect(html).toContain('<span>Workspace</span>')
    expect(html).not.toContain('squad-storage-heading')
    expect(html).not.toContain('Build API · Ada')
    expect(html).toContain('Global collaboration')
  })

  test('a deep link waits for permissions instead of flashing General', () => {
    const html = renderSettings(null, '/squads/squad-alpha/settings?section=storage')
    expect(html).not.toContain('squad-storage-heading')
    expect(html).not.toContain('Global collaboration')
  })
})

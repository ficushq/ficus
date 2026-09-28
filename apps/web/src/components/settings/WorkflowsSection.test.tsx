import { afterEach, beforeEach, expect, test } from 'bun:test'
import { fireEvent, getByLabelText, getByText, queryByText, waitFor } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { createBlankWorkflow } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { WorkflowsSection } from './WorkflowsSection'
import { SquadWorkflowSettings } from '../squads/SquadWorkflowSettings'
import { isSectionAllowed } from './settingsSections'
import { workflowDraftKey } from '../../lib/workflowDraftStorage'

let dom: Awaited<ReturnType<typeof acquireDomHarness>>
let cache: QueryClient
let originalFetch: typeof fetch
let requests: Array<{ url: string; method: string; body?: any }>
let catalog: any[]
let mounted: ReturnType<typeof dom.createRoot>
const identity = { type: 'user' as const, userId: 'workflow-user' }
let permissions: string[]
const squadId = 'squad-test'
let metadata: Record<string, unknown>

beforeEach(async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  originalFetch = globalThis.fetch
  requests = []
  permissions = ['workflows:read', 'workflows:create', 'workflows:update', 'workflows:delete']
  metadata = {}
  catalog = [
    {
      id: 'solo',
      description: 'Handle a task with one agent.',
      definition: { ...createBlankWorkflow(), name: 'Solo' },
      revision: 'revision-1',
      disabled: false,
      hasTemplate: true,
    },
  ]
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url, method, body })
    if (url.includes('/integrations/outputs')) return Response.json([])
    if (url.includes('/permissions')) return Response.json({ permissions, identity })
    if (url.endsWith('/agent-types')) return Response.json([])
    if (url.endsWith('/workflows') && method === 'GET') return Response.json(catalog)
    if (url.endsWith('/workflows') && method === 'POST') {
      const created = { ...body, revision: 'new-revision', disabled: false, hasTemplate: false }
      catalog.push(created)
      return Response.json(created)
    }
    if (url.endsWith('/workflows/solo') && method === 'PUT') {
      if (body.revision !== 'revision-1')
        return Response.json({ error: 'The workflow changed; reload it.' }, { status: 409 })
      catalog[0] = { ...catalog[0], ...body.preset, revision: 'revision-2' }
      return Response.json(catalog[0])
    }
    if (url.endsWith('/workflows/solo/disabled')) {
      catalog[0] = { ...catalog[0], disabled: body.disabled, revision: 'revision-3' }
      return Response.json(catalog[0])
    }
    if (url.endsWith('/workflows/solo') && method === 'DELETE') {
      catalog = catalog.filter((entry) => entry.id !== 'solo')
      return Response.json({ ok: true })
    }
    if (url.endsWith(`/squads/${squadId}`)) return Response.json({ id: squadId, metadata })
    return Response.json({})
  }) as typeof fetch
})

afterEach(async () => {
  await cache.cancelQueries()
  cache.clear()
  await dom.cleanup()
  globalThis.fetch = originalFetch
})

function Location() {
  return <output aria-label="Current URL">{useLocation().search}</output>
}
async function render(node = <WorkflowsSection />, url = '/', seedCatalog = true) {
  cache.setQueryData(queryKeys.auth.permissions(undefined), { permissions, identity })
  if (seedCatalog) cache.setQueryData(queryKeys.workflows.list(), structuredClone(catalog))
  cache.setQueryData(queryKeys.squads.detail(squadId), { id: squadId, metadata })
  const root = dom.createRoot()
  mounted = root
  await dom.act(async () =>
    root.root.render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={[url]}>
          <Location />
          {node}
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
  return dom.window.document.body
}

const click = async (button: HTMLElement) => dom.act(async () => fireEvent.click(button))
const change = async (field: HTMLElement, value: string) =>
  dom.act(async () => fireEvent.change(field, { target: { value } }))

test('global catalog permissions gate navigation and editing; readers can search and preview', async () => {
  expect(isSectionAllowed('workflows', () => false, false)).toBe(false)
  expect(isSectionAllowed('workflows', (permission) => permission === 'workflows:read', false)).toBe(true)
  permissions = ['workflows:read']
  const body = await render()
  expect(queryByText(body, 'New workflow')).toBeNull()
  expect(queryByText(body, 'Edit')).toBeNull()
  expect(queryByText(body, 'Duplicate')).toBeNull()
  expect(queryByText(body, 'Delete')).toBeNull()
  await click(getByText(body, 'Preview flow'))
  expect(body.querySelector('[aria-label="Solo flow diagram"]')).not.toBeNull()
  await change(getByLabelText(body, 'Search workflows'), 'not found')
  expect(body.textContent).toContain('No workflows match your search.')
})

test('creates and edits presets using the catalog revision, without a squad default selector', async () => {
  const body = await render()
  await click(getByText(body, 'New workflow'))
  const panel = body.querySelector('[data-modal-size="editor"]')!
  const actions = panel.querySelector('[data-workflow-actions]')!
  // Actions occupy the Modal footer, outside the scrolling editor body.
  expect(actions.parentElement!.parentElement).toBe(panel)
  const scrollBody = actions.parentElement!.previousElementSibling!
  expect(scrollBody.classList.contains('overflow-auto')).toBe(true)
  expect(scrollBody.querySelector('[aria-label="Live flow preview"]')).not.toBeNull()
  expect(scrollBody.contains(actions)).toBe(false)
  expect(getByLabelText(body, 'Description').closest('details')).toBeNull()
  await change(getByLabelText(body, 'Description'), 'Use for focused tasks.')
  await click(getByLabelText(body, 'Flow settings'))
  await change(getByLabelText(body, 'Preset ID'), 'security')
  const name = getByLabelText(body, 'Name') as HTMLInputElement
  expect(name.closest('[aria-label="Preset details"]') !== null).toBe(true)
  await change(name, 'Security review')
  expect((getByText(body, 'Undo').closest('button') as HTMLButtonElement).disabled).toBe(true)
  await click(body.querySelector<HTMLElement>('[data-flow-kind="completion"]')!)
  await change(getByLabelText(body, 'Completion policy'), 'review-approval')
  await click(getByText(body, 'Undo'))
  await change(getByLabelText(body, 'Description'), 'Focused security tasks.')
  await change(name, 'Security review updated')
  expect((getByText(body, 'Redo').closest('button') as HTMLButtonElement).disabled).toBe(false)
  await click(getByText(body, 'Redo'))
  expect(name.value).toBe('Security review updated')
  expect((getByLabelText(body, 'Description') as HTMLTextAreaElement).value).toBe('Focused security tasks.')
  expect((getByLabelText(body, 'Completion policy') as HTMLSelectElement).value).toBe('review-approval')
  await click(getByText(body, 'Undo'))
  expect(name.value).toBe('Security review updated')
  await change(name, 'Security review')
  expect(body.textContent).not.toContain('Use squad default')
  await click(getByText(body, 'Save workflow'))
  await dom.act(async () => waitFor(() => expect(body.querySelector('[role="dialog"]')).toBeNull()))
  expect(
    requests.find((request) => request.method === 'POST' && request.url.endsWith('/workflows'))?.body
  ).toMatchObject({ id: 'security', scope: { kind: 'instance' }, definition: { name: 'Security review' } })
  const solo = [...body.querySelectorAll('article')].find((card) => card.textContent?.includes('solo ·'))!
  await click(getByText(solo, 'Edit'))
  await click(getByLabelText(body, 'Flow settings'))
  await change(getByLabelText(body, 'Name'), 'Solo updated')
  await click(getByText(body, 'Save workflow'))
  await dom.act(async () => waitFor(() => expect(body.querySelector('[role="dialog"]')).toBeNull()))
  expect(requests.find((request) => request.method === 'PUT')?.body).toMatchObject({
    revision: 'revision-1',
    preset: { id: 'solo', definition: { name: 'Solo updated' } },
  })
})

test('duplicates without changing the source and requires confirmation before deletion', async () => {
  const body = await render()
  await click(getByText(body, 'Duplicate'))
  expect((getByLabelText(body, 'Preset ID') as HTMLInputElement).value).toBe('solo-copy')
  await click(getByText(body, 'Save workflow'))
  await dom.act(async () => waitFor(() => expect(body.querySelector('[role="dialog"]')).toBeNull()))
  expect(catalog[0].definition.name).toBe('Solo')
  const solo = [...body.querySelectorAll('article')].find((card) => card.textContent?.includes('solo ·'))!
  await click(getByText(solo, 'Disable'))
  await dom.act(async () => waitFor(() => expect(queryByText(solo, 'Enable')).not.toBeNull()))
  await click(getByText(solo, 'Delete'))
  expect(requests.some((request) => request.method === 'DELETE')).toBe(false)
  await click(getByText(solo, 'Confirm?'))
  await dom.act(async () => waitFor(() => expect(requests.some((request) => request.method === 'DELETE')).toBe(true)))
  expect(requests.find((request) => request.method === 'DELETE')?.body).toEqual({ revision: 'revision-3' })
})

test('squad settings select presets and link to global management only with catalog access', async () => {
  const body = await render(<SquadWorkflowSettings squadId={squadId} canEdit />)
  expect(body.textContent).toContain('Choose a default workflow')
  expect(body.querySelector('a[href="/settings?section=workflows"]')).not.toBeNull()
  await click(getByText(body, 'Edit'))
  expect((getByLabelText(body, 'Workflow') as HTMLSelectElement).value).toBe('solo')
  expect(body.textContent).not.toContain('No default workflow')
  expect(body.querySelector('[aria-label="Solo flow diagram"]')).not.toBeNull()
  expect(body.textContent).not.toContain('Customize steps and participants')
  expect(body.textContent).not.toContain('Edit complete definition')
  expect(body.textContent).not.toContain('Use squad default / existing routing')
  permissions = []
  await dom.act(async () => cache.setQueryData(queryKeys.auth.permissions(undefined), { permissions }))
  await dom.act(async () =>
    waitFor(() => expect(body.querySelector('a[href="/settings?section=workflows"]') === null).toBe(true))
  )
})

test('generates a unique preset ID from the flow name without requiring technical setup', async () => {
  const body = await render()
  await click(getByText(body, 'New workflow'))
  expect(body.querySelector('[data-modal-size="editor"]')).not.toBeNull()
  expect(getByLabelText(body, 'Description').closest('details')).toBeNull()
  await change(getByLabelText(body, 'Description'), 'Use for focused tasks.')
  await click(getByLabelText(body, 'Flow settings'))
  await change(getByLabelText(body, 'Name'), 'Solo')
  expect((getByLabelText(body, 'Preset ID') as HTMLInputElement).value).toBe('solo-2')
  await click(getByText(body, 'Save workflow'))
  await dom.act(async () => waitFor(() => expect(body.querySelector('[role="dialog"]')).toBeNull()))
  expect(catalog.some((entry) => entry.id === 'solo-2')).toBe(true)
})

test('new workflow deep links restore drafts after remount, preserve URL state, and clear only after saving', async () => {
  let body = await render(undefined, '/settings?section=workflows&view=admin')
  await click(getByText(body, 'New workflow'))
  expect(getByLabelText(body, 'Current URL').textContent).toContain('newWorkflow=1')
  await change(getByLabelText(body, 'Preset ID'), 'marketing')
  await change(getByLabelText(body, 'Description'), 'Plan a campaign.')
  await click(getByLabelText(body, 'Flow settings'))
  await change(getByLabelText(body, 'Name'), 'Marketing')
  const key = workflowDraftKey(identity, '1')!
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
    id: 'marketing',
    description: 'Plan a campaign.',
    source: { definition: { name: 'Marketing' } },
  })
  await click(getByText(body, 'Close'))
  expect(getByLabelText(body, 'Current URL').textContent).toBe('?section=workflows&view=admin')
  expect(localStorage.getItem(key)).not.toBeNull()
  await dom.act(async () => mounted.root.render(null))
  body = await render(undefined, '/settings?section=workflows&view=admin&newWorkflow=1')
  expect((getByLabelText(body, 'Preset ID') as HTMLInputElement).value).toBe('marketing')
  expect((getByLabelText(body, 'Description') as HTMLTextAreaElement).value).toBe('Plan a campaign.')
  await click(getByText(body, 'Save workflow'))
  await dom.act(async () => waitFor(() => expect(body.querySelector('[role="dialog"]')).toBeNull()))
  expect(localStorage.getItem(key)).toBeNull()
  expect(getByLabelText(body, 'Current URL').textContent).toBe('?section=workflows&view=admin')
  await click(getByText(body, 'New workflow'))
  expect((getByLabelText(body, 'Description') as HTMLTextAreaElement).value).toBe('')
})

test('a new-workflow link cannot bypass create permission', async () => {
  permissions = ['workflows:read']
  const body = await render(undefined, '/settings?section=workflows&newWorkflow=1')
  expect(body.querySelector('[role="dialog"]')).toBeNull()
})

test('edit links open the specific workflow after remount and closing preserves other URL parameters', async () => {
  let body = await render(undefined, '/settings?section=workflows&view=admin')
  await click(getByText(body, 'Edit'))
  expect(getByLabelText(body, 'Current URL').textContent).toBe('?section=workflows&view=admin&editWorkflow=solo')
  await dom.act(async () => mounted.root.render(null))
  body = await render(undefined, '/settings?section=workflows&view=admin&editWorkflow=solo')
  expect(body.querySelector('[aria-label="Preset ID"]')).toBeNull()
  expect((getByLabelText(body, 'Name') as HTMLInputElement).value).toBe(catalog[0].definition.name)
  expect((getByLabelText(body, 'Description') as HTMLTextAreaElement).value).toBe(catalog[0].description)
  await click(getByText(body, 'Cancel'))
  expect(getByLabelText(body, 'Current URL').textContent).toBe('?section=workflows&view=admin')
})

test('saving an edit deep link clears the URL', async () => {
  const body = await render(undefined, '/settings?section=workflows&editWorkflow=solo')
  await change(getByLabelText(body, 'Description'), 'Updated description')
  await click(getByText(body, 'Save workflow'))
  await dom.act(async () => waitFor(() => expect(!!body.querySelector('[role="dialog"]')).toBe(false)))
  expect(getByLabelText(body, 'Current URL').textContent).toBe('?section=workflows')
  expect(requests.find((request) => request.method === 'PUT')?.body.preset.id).toBe('solo')
})

test('unknown workflow links do not open a blank creation modal', async () => {
  const body = await render(undefined, '/settings?section=workflows&editWorkflow=missing&newWorkflow=1')
  expect(!!body.querySelector('[role="dialog"]')).toBe(false)
  expect(body.textContent).toContain('Workflow not found.')
  await click(getByText(body, 'New workflow'))
  expect(getByLabelText(body, 'Current URL').textContent).toBe('?section=workflows&newWorkflow=1')
})

test('edit deep links cannot bypass update permission', async () => {
  permissions = ['workflows:read', 'workflows:create']
  const body = await render(undefined, '/settings?section=workflows&editWorkflow=solo')
  expect(!!body.querySelector('[role="dialog"]')).toBe(false)
})

test('edit deep links wait for the catalog before opening the editor', async () => {
  const fetchCatalog = globalThis.fetch
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith('/workflows')) await ready
    return fetchCatalog(input, init)
  }) as typeof fetch
  const body = await render(undefined, '/settings?section=workflows&editWorkflow=solo', false)
  expect(body.textContent).toContain('Loading workflows…')
  expect(!!body.querySelector('[role="dialog"]')).toBe(false)
  await dom.act(async () => {
    release()
    await waitFor(() => expect(!!body.querySelector('[role="dialog"]')).toBe(true))
  })
  expect(body.querySelector('[aria-label="Preset ID"]')).toBeNull()
  expect((getByLabelText(body, 'Name') as HTMLInputElement).value).toBe(catalog[0].definition.name)
})

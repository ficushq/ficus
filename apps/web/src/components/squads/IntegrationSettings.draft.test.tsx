import { fireEvent } from '@testing-library/dom'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { squadEventRuleSchema } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { integrationQueries, queries } from '../../queryOptions'
import { githubFeedbackQueryKeys } from '../../queryKeys'
import { IntegrationSettings } from './IntegrationSettings'

function makeSquad(id: string) {
  return {
    id,
    name: id,
    metadata: {
      github: [{ repo: `owner/${id}` }],
      linear: [{ teamId: `team-${id}` }],
      integrationRules: {
        github: [
          squadEventRuleSchema.parse({
            id: 'rule',
            source: { integration: 'github', output: 'issue.assigned', version: 1 },
            filters: {},
            action: { type: 'notify-manager', additionalContext: `Saved ${id}` },
          }),
        ],
        linear: [],
      },
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let dom: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let client: QueryClient
let server: ReturnType<typeof makeSquad>
let originalFetch: typeof fetch
let pendingSave: ReturnType<typeof deferred<Response>> | undefined
let pendingRead: ReturnType<typeof deferred<Response>> | undefined
let submitted: ReturnType<typeof makeSquad>['metadata'] | undefined
let readCount: number
let moderationRequests: string[]
let filterEnabled: boolean
function moderation(url: string, init?: RequestInit) {
  const path = new URL(url).pathname.replace('/api/squads/one/github-feedback', '')
  moderationRequests.push(`${init?.method ?? 'GET'} ${path}`)
  if (init?.method === 'PUT') {
    filterEnabled = JSON.parse(String(init.body)).enabled
    return Promise.resolve(response({ enabled: filterEnabled, released: 0 }))
  }
  if (path === '/trusted-authors') return Promise.resolve(response({ authors: [], canManage: true }))
  return Promise.resolve(
    response({ authorFilterEnabled: filterEnabled, pending: 0, releasing: 0, failing: 0, canModerate: true })
  )
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const flush = () =>
  dom.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
const repo = () => document.querySelector<HTMLInputElement>('input[placeholder="owner/repo or owner/*"]')!
const context = () => document.querySelector<HTMLTextAreaElement>('textarea')!
const button = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === text)
const click = async (text: string) => {
  await dom.act(async () => button(text)!.click())
  await flush()
}
const input = async (element: HTMLElement, value: string) =>
  dom.act(async () => fireEvent.input(element, { target: { value } }))
async function render(squadId = 'one') {
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PermissionsProvider
          usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
        >
          <MemoryRouter>
            <IntegrationSettings squadId={squadId} />
          </MemoryRouter>
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
}
async function refresh() {
  await dom.act(async () => {
    await client.invalidateQueries({ queryKey: queries.squads.basic('one').queryKey })
  })
  await flush()
}
beforeEach(async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/squads/one/settings' })
  ;({ root } = dom.createRoot())
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  server = makeSquad('one')
  pendingSave = undefined
  pendingRead = undefined
  submitted = undefined
  readCount = 0
  moderationRequests = []
  filterEnabled = true
  for (const id of ['one', 'two']) {
    client.setQueryData(queries.squads.basic(id).queryKey, makeSquad(id))
    for (const provider of ['github', 'linear']) {
      client.setQueryData(integrationQueries.squad(id, provider).queryKey, {
        scope: { enabled: true },
        assignment: null,
        connections: [],
        attached: [],
      })
      client.setQueryData(integrationQueries.pool(provider).queryKey, [])
    }
  }
  client.setQueryData(integrationQueries.catalog().queryKey, {
    integrations: ['github', 'linear'].map((key) => ({
      key,
      label: key,
      description: key,
      enabled: true,
      assignable: true,
    })),
  })
  client.setQueryData(integrationQueries.outputs().queryKey, [
    { integration: 'github', output: 'issue.assigned', version: 1, title: 'Issue assigned', fields: {} },
  ])
  client.setQueryData(queries.workflows.list().queryKey, [])
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toContain('/api/squads/one')
    // The separately composed GitHub moderation section has its own endpoints; they are not
    // squad reads and must never consume this suite's controlled squad responses.
    if (String(url).includes('/github-feedback/')) return moderation(String(url), init)
    if (init?.method === 'PATCH') {
      submitted = JSON.parse(String(init.body)).metadata
      return pendingSave!.promise
    }
    readCount++
    const read = pendingRead
    pendingRead = undefined
    return read ? read.promise : response(server)
  }) as typeof fetch
  await render()
  await click('Settings')
})
afterEach(async () => {
  client.clear()
  globalThis.fetch = originalFetch
  await dom.cleanup()
})

test('dirty rules and shared scope survive invalidation, refetch, and unrelated parent updates', async () => {
  const originalInput = context()
  await input(context(), 'Unsaved rule')
  await input(repo(), 'owner/draft')
  server = { ...server, name: 'Background update' }
  await refresh()
  expect(readCount).toBe(1)
  expect(context()).toBe(originalInput) // The bug is state synchronization, not a remount.
  expect(context().value).toBe('Unsaved rule')
  expect(repo().value).toBe('owner/draft')
  server.metadata = makeSquad('external').metadata
  await refresh()
  await render()
  expect(context().value).toBe('Unsaved rule')
  expect(repo().value).toBe('owner/draft')
  expect(button('Save settings')).toBeDefined()
})

test('clean forms follow refreshed data; closing and switching squads initialize fresh drafts', async () => {
  server.metadata = makeSquad('external').metadata
  await refresh()
  expect(context().value).toBe('Saved external')
  expect(repo().value).toBe('owner/external')
  await input(context(), 'Discard on close')
  await click('Settings')
  await click('Settings')
  expect(context().value).toBe('Saved external')
  await input(context(), 'Old squad draft')
  await render('two')
  expect(context().value).toBe('Saved two')
  expect(repo().value).toBe('owner/two')
  expect(button('Save settings')).toBeUndefined()
})

test('failed saves retain the draft through subsequent refreshes', async () => {
  await input(context(), 'Retry me')
  pendingSave = deferred<Response>()
  await click('Save settings')
  await dom.act(async () => pendingSave!.resolve(response({ error: 'Save rejected' }, 500)))
  await flush()
  expect(document.body.textContent).toContain('Failed to save')
  server = { ...server, name: 'After failure' }
  await refresh()
  expect(context().value).toBe('Retry me')
  expect(button('Save settings')?.disabled).toBe(false)
})

test('successful saves use the response as baseline and ignore an older in-flight refetch', async () => {
  await input(context(), 'Saved rule')
  await input(repo(), ' owner/normalized ')
  pendingSave = deferred<Response>()
  await click('Save settings')
  const stale = makeSquad('one')
  const read = deferred<Response>()
  pendingRead = read
  let refetch!: Promise<void>
  await dom.act(async () => {
    refetch = client.invalidateQueries({ queryKey: queries.squads.basic('one').queryKey })
  })
  expect(readCount).toBe(1)
  server = { ...server, metadata: submitted! }
  const afterSave = deferred<Response>()
  pendingRead = afterSave
  await dom.act(async () => pendingSave!.resolve(response(server)))
  await flush()
  expect(context().value).toBe('Saved rule')
  expect(repo().value).toBe('owner/normalized')
  expect(button('Save settings')).toBeUndefined()
  await dom.act(async () => {
    read.resolve(response(stale))
    await refetch
  })
  await flush()
  expect(context().value).toBe('Saved rule')
  expect(client.getQueryData(queries.squads.basic('one').queryKey)).toEqual(server)
  await dom.act(async () => afterSave.resolve(response(server)))
  await flush()
  server.metadata = makeSquad('later').metadata
  await refresh()
  expect(context().value).toBe('Saved later')
})

test('edits to shared scope during a pending save stay dirty after success and can be saved again', async () => {
  await input(context(), 'First save')
  pendingSave = deferred<Response>()
  await click('Save settings')
  await input(repo(), 'owner/second-draft')
  server = { ...server, name: 'While saving' }
  await refresh()
  expect(repo().value).toBe('owner/second-draft')
  server = { ...server, metadata: submitted! }
  await dom.act(async () => pendingSave!.resolve(response(server)))
  await flush()
  expect(repo().value).toBe('owner/second-draft')
  expect(context().value).toBe('First save')
  expect(button('Save settings')?.disabled).toBe(false)
  pendingSave = deferred<Response>()
  await click('Save settings')
  expect(submitted?.github).toEqual([{ repo: 'owner/second-draft' }])
  server = { ...server, metadata: submitted! }
  await dom.act(async () => pendingSave!.resolve(response(server)))
  await flush()
  expect(button('Save settings')).toBeUndefined()
})

test('a save completing after a squad switch cannot clear the new squad draft', async () => {
  await input(context(), 'Squad one save')
  pendingSave = deferred<Response>()
  await click('Save settings')
  await render('two')
  expect(context().value).toBe('Saved two')
  await input(context(), 'Squad two draft')
  server = { ...server, metadata: submitted! }
  await dom.act(async () => pendingSave!.resolve(response(server)))
  await flush()
  expect(context().value).toBe('Squad two draft')
  expect(button('Save settings')?.disabled).toBe(false)
  expect(client.getQueryData(queries.squads.basic('one').queryKey)).toEqual(server)
})

test('providers keep independent drafts and save against the latest unrelated metadata', async () => {
  await input(context(), 'GitHub draft')
  const linearCard = document.querySelectorAll('article')[1]!
  const linearSettings = [...linearCard.querySelectorAll('button')].find((item) => item.textContent === 'Settings')!
  await dom.act(async () => linearSettings.click())
  const team = () => linearCard.querySelector<HTMLInputElement>('input[placeholder="team-uuid"]')!
  expect(team().value).toBe('team-one')
  await input(team(), 'team-draft')
  server.metadata.linear = [{ teamId: 'team-external' }]
  await refresh()
  expect(team().value).toBe('team-draft')
  expect(context().value).toBe('GitHub draft')
  pendingSave = deferred<Response>()
  await click('Save settings') // First card: GitHub
  expect(submitted?.linear).toEqual([{ teamId: 'team-external' }])
  expect(submitted?.integrationRules.linear).toEqual([])
  server = { ...server, metadata: submitted! }
  await dom.act(async () => pendingSave!.resolve(response(server)))
  await flush()
  expect(team().value).toBe('team-draft')
  expect([...linearCard.querySelectorAll('button')].find((item) => item.textContent === 'Save settings')).toBeDefined()
})

test('a failed post-save refetch keeps the acknowledged saved baseline', async () => {
  await input(context(), 'Acknowledged')
  pendingSave = deferred<Response>()
  await click('Save settings')
  const afterSave = deferred<Response>()
  pendingRead = afterSave
  server = { ...server, metadata: submitted! }
  await dom.act(async () => pendingSave!.resolve(response(server)))
  await flush()
  await dom.act(async () => afterSave.resolve(response({ error: 'Read failed' }, 500)))
  await flush()
  expect(context().value).toBe('Acknowledged')
  expect(button('Save settings')).toBeUndefined()
  expect(document.body.textContent).toContain('✓ Saved.')
})

test('moderation refreshes and the author-filter switch never touch unsaved rule drafts', async () => {
  const originalInput = context()
  await input(context(), 'Unsaved rule')
  await input(repo(), 'owner/draft')
  await flush()
  // Incoming moderation events (githubFeedback.updated) refresh only the moderation namespace.
  await dom.act(async () => {
    await client.invalidateQueries({ queryKey: githubFeedbackQueryKeys.squad('one') })
  })
  await flush()
  const toggle = document.querySelector<HTMLInputElement>('input[role="switch"]')!
  await dom.act(async () => toggle.click())
  await click('Turn off author filtering')
  expect(moderationRequests).toContain('PUT /author-filter')
  expect(readCount).toBe(0)
  expect(context()).toBe(originalInput)
  expect(context().value).toBe('Unsaved rule')
  expect(repo().value).toBe('owner/draft')
  expect(button('Save settings')).toBeDefined()
})

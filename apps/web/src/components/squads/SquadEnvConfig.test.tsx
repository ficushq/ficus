import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'
import { SquadEnvConfig } from './SquadEnvConfig'

test('Workspace renders only custom environment settings and explains agent/terminal visibility', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['squads', 's1', 'workspace-env'], { content: 'CUSTOM=keep' })
  queryClient.setQueryData(queryKeys.auth.permissions('s1'), { permissions: ['env:read', 'env:write'] })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SquadEnvConfig squadId="s1" />
    </QueryClientProvider>
  )
  expect(html).toContain('Environment Variables')
  expect(html).toContain('visible to agents and terminals')
  expect(html).not.toContain('Secret Store')
  expect(html).not.toContain('exposed secrets')
  expect(html).toContain('<textarea')
})

test('Environment settings show the nonsecret detection notice for an untrusted disk edit', () => {
  const queryClient = new QueryClient()
  const detectionNotice =
    'This environment was edited outside Settings; save it in Settings to register changed values for output redaction.'
  queryClient.setQueryData(['squads', 's1', 'workspace-env'], { content: 'CUSTOM=keep', detectionNotice })
  queryClient.setQueryData(queryKeys.auth.permissions('s1'), { permissions: ['env:read', 'env:write'] })
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SquadEnvConfig squadId="s1" />
      </QueryClientProvider>
    )
    expect(html).toContain(detectionNotice)
    expect(html).toContain('role="status"')
    expect(html).not.toContain('contentHash')
  } finally {
    queryClient.clear()
  }
})

async function mountedFixture({ readOnly = false, failFirst = false, oversized = false, cached = true } = {}) {
  const { acquireDomHarness } = await import('../../test/domHarness')
  const { PermissionsProvider } = await import('../../hooks/usePermissions')
  const originalFetch = globalThis.fetch
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/s1/settings' })
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } },
  })
  const content = 'APP_TOKEN=synthetic-untrusted-settings-token'
  const queryKey = ['squads', 's1', 'workspace-env']
  if (cached)
    client.setQueryData(queryKey, { content, detectionNotice: 'Save this environment in Settings to register it.' })
  const requests: unknown[] = []
  let registered = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === 'PUT') {
      requests.push(JSON.parse(String(init.body)))
      await gate
      if (failFirst && requests.length === 1)
        return Response.json({ error: 'synthetic retry failure' }, { status: 500 })
      registered = true
      return Response.json({ success: true })
    }
    if (oversized) {
      await gate
      return Response.json(
        { code: 'squad_env_too_large', error: 'Squad environment exceeds 256 KiB; existing file unchanged.' },
        { status: 413 }
      )
    }
    return Response.json({
      content,
      ...(!registered ? { detectionNotice: 'Save this environment in Settings to register it.' } : {}),
    })
  }) as typeof fetch
  const view = dom.createRoot()
  const cleanup = async () => {
    release()
    await dom.act(async () => {
      await gate
    })
    await dom.cleanup()
    client.clear()
    globalThis.fetch = originalFetch
  }
  try {
    await dom.act(async () =>
      view.root.render(
        <PermissionsProvider
          usePermissions={() => ({
            permissions: readOnly ? ['env:read'] : ['env:read', 'env:write'],
            can: (permission) => !readOnly || permission === 'env:read',
            isLoading: false,
            isError: false,
          })}
        >
          <QueryClientProvider client={client}>
            <SquadEnvConfig squadId="s1" />
          </QueryClientProvider>
        </PermissionsProvider>
      )
    )
  } catch (error) {
    await cleanup()
    throw error
  }
  return {
    dom,
    client,
    refetch: () => client.invalidateQueries({ queryKey }),
    fileReduced: () => {
      oversized = false
      return client.invalidateQueries({ queryKey })
    },
    requests,
    content,
    release,
    textarea: () => document.querySelector('textarea')!,
    button: () => document.querySelector('button')!,
    cleanup,
  }
}

for (const action of ['click', 'keyboard'] as const) {
  test(`unchanged detection recovery submits once via ${action}, guards pending state and clears its notice`, async () => {
    const { fireEvent, waitFor } = await import('@testing-library/dom')
    const f = await mountedFixture()
    try {
      expect(f.textarea().value).toBe(f.content)
      expect(f.button().disabled).toBe(false)
      await f.dom.act(async () => {
        if (action === 'click') fireEvent.click(f.button())
        else fireEvent.keyDown(f.textarea(), { key: 's', ctrlKey: true })
        // Also guard a second shortcut before the pending-state render.
        fireEvent.keyDown(f.textarea(), { key: 's', metaKey: true })
      })
      await waitFor(() => expect(f.requests).toHaveLength(1))
      expect(f.requests[0]).toEqual({ content: f.content })
      await waitFor(() => expect(f.button().disabled).toBe(true))
      await f.dom.act(async () => {
        fireEvent.keyDown(f.textarea(), { key: 's', metaKey: true })
        fireEvent.click(f.button())
      })
      expect(f.requests).toHaveLength(1)
      await f.dom.act(async () => f.release())
      await waitFor(() => expect(f.dom.window.document.querySelector('[role=status]')).toBeNull())
      await waitFor(() => expect(f.button().disabled).toBe(true))
      await f.dom.act(async () => fireEvent.keyDown(f.textarea(), { key: 's', ctrlKey: true }))
      expect(f.requests).toHaveLength(1)
    } finally {
      await f.cleanup()
    }
  })
}

test('read-only permissions never allow unchanged registration through button or keyboard', async () => {
  const { fireEvent } = await import('@testing-library/dom')
  const f = await mountedFixture({ readOnly: true })
  try {
    expect(f.button().disabled).toBe(true)
    expect(f.textarea().disabled).toBe(true)
    await f.dom.act(async () => {
      fireEvent.click(f.button())
      fireEvent.keyDown(f.textarea(), { key: 's', ctrlKey: true })
    })
    expect(f.requests).toHaveLength(0)
  } finally {
    await f.cleanup()
  }
})

test('failed unchanged registration can be retried without inventing a content edit', async () => {
  const { fireEvent, waitFor } = await import('@testing-library/dom')
  const f = await mountedFixture({ failFirst: true })
  try {
    await f.dom.act(async () => {
      fireEvent.click(f.button())
      f.release()
    })
    await waitFor(() => expect(f.dom.window.document.body.textContent).toContain('synthetic retry failure'))
    expect(f.button().disabled).toBe(false)
    expect(f.textarea().value).toBe(f.content)
    await f.dom.act(async () => fireEvent.click(f.button()))
    await waitFor(() => expect(f.dom.window.document.querySelector('[role=status]')).toBeNull())
    expect(f.requests).toEqual([{ content: f.content }, { content: f.content }])
  } finally {
    await f.cleanup()
  }
})

for (const cached of [true, false]) {
  test(`oversized GET is non-editable, does not replace cached content or send writes (cached=${cached})`, async () => {
    const { fireEvent, waitFor } = await import('@testing-library/dom')
    const f = await mountedFixture({ oversized: true, cached })
    try {
      if (cached) {
        await f.dom.act(async () => {
          void f.refetch()
        })
        await waitFor(() => expect(f.button().disabled).toBe(true))
      } else expect(document.querySelector('textarea')).toBeNull()
      f.release()
      await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('256 KiB'))
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('unchanged')
      expect(document.querySelector('textarea')).toBeNull()
      expect(document.querySelector('button')).toBeNull()
      fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
      fireEvent.keyDown(document.body, { key: 's', metaKey: true })
      expect(f.requests).toHaveLength(0)
      expect(f.client.getQueryData(['squads', 's1', 'workspace-env'])).toEqual(
        cached
          ? { content: f.content, detectionNotice: 'Save this environment in Settings to register it.' }
          : undefined
      )
    } finally {
      await f.cleanup()
    }
  })
}

test('a smaller file loaded after the oversized error becomes explicitly registerable without losing its content', async () => {
  const { fireEvent, waitFor } = await import('@testing-library/dom')
  const f = await mountedFixture({ oversized: true, cached: false })
  try {
    f.release()
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('256 KiB'))
    expect(f.requests).toHaveLength(0)
    await f.dom.act(async () => {
      await f.fileReduced()
    })
    await waitFor(() => expect(document.querySelector('textarea')?.value).toBe(f.content))
    expect(f.button().disabled).toBe(false)
    await f.dom.act(async () => {
      fireEvent.click(f.button())
    })
    await waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull())
    expect(f.requests).toEqual([{ content: f.content }])
    expect(f.textarea().value).toBe(f.content)
    expect(f.button().disabled).toBe(true)
  } finally {
    await f.cleanup()
  }
})

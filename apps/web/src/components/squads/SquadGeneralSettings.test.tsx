import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import {
  SquadGeneralSettings,
  blockedGraceMinutesError,
  buildSquadGeneralSettingsUpdate,
  hostWorkspacePathError,
  parseBlockedGraceMinutes,
} from './SquadGeneralSettings'

const usePermissionsMock = () => ({
  permissions: ['squads:update'],
  can: () => true,
  isLoading: false,
  isError: false,
})

type Props = Parameters<typeof SquadGeneralSettings>[0]

const baseProps: Props = {
  section: 'workflows',
  squadId: 'squad-1',
  name: 'Ficus',
  purpose: 'Build Ficus',
  globalCollaborationEnabled: false,
  maxConcurrentWorkStreams: null,
  blockedGraceMinutes: null,
  hostWorkspacePath: null,
}

function settingsElement(queryClient: QueryClient, props: Partial<Props> = {}) {
  return (
    <PermissionsProvider usePermissions={usePermissionsMock}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SquadGeneralSettings {...baseProps} {...props} />
        </MemoryRouter>
      </QueryClientProvider>
    </PermissionsProvider>
  )
}

function renderSettings(props: Partial<Props> = {}) {
  const queryClient = new QueryClient()
  return renderToStaticMarkup(settingsElement(queryClient, props))
}

async function exerciseGraceInput(rawValue: string) {
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/squad-1/settings' })
  const rendered = dom.createRoot()
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const calls: Array<{ url: string; method?: string; body?: string }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, body: init?.body as string | undefined })
    return new dom.window.Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response
  }) as typeof fetch
  try {
    await dom.act(async () =>
      rendered.root.render(settingsElement(queryClient, { maxConcurrentWorkStreams: 2, blockedGraceMinutes: 12 }))
    )
    const input = dom.window.document.querySelector('#squad-blocked-grace-minutes') as HTMLInputElement
    await dom.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, rawValue)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    const save = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!
    return {
      dom,
      rendered,
      input,
      save,
      calls,
      restore: async () => {
        globalThis.fetch = originalFetch
        await dom.cleanup()
      },
    }
  } catch (error) {
    globalThis.fetch = originalFetch
    await dom.cleanup()
    throw error
  }
}

describe('SquadGeneralSettings', () => {
  test('renders the max concurrent work streams field with an Unlimited placeholder when null', () => {
    const html = renderSettings({ maxConcurrentWorkStreams: null })

    expect(html).toContain('Max concurrent work streams')
    expect(html).toContain('placeholder="Unlimited"')
    expect(html).toContain('Streams beyond this limit queue until a slot frees. Empty = unlimited.')
  })

  test('renders the max concurrent work streams field pre-filled with the current cap', () => {
    const html = renderSettings({ maxConcurrentWorkStreams: 3 })

    expect(html).toContain('value="3"')
  })

  test('renders the current auto-park grace and exact live-effect helper copy', () => {
    const html = renderSettings({ blockedGraceMinutes: 17 })

    expect(html).toContain('Auto-park grace (minutes)')
    expect(html).toContain('id="squad-blocked-grace-minutes"')
    expect(html).toContain('value="17"')
    expect(html).toContain('Blocked streams release their slot after this long; empty = 30. Changes take effect live.')
  })

  test('the shared save payload preserves empty as null and accepts zero', () => {
    const common = {
      name: ' Ficus ',
      purpose: ' Build Ficus ',
      globalCollaborationEnabled: false,
      maxConcurrentWorkStreams: 2,
    }

    expect(parseBlockedGraceMinutes('')).toBeNull()
    expect(parseBlockedGraceMinutes('0')).toBe(0)
    expect(buildSquadGeneralSettingsUpdate({ ...common, blockedGraceMinutes: null })).toMatchObject({
      name: 'Ficus',
      purpose: 'Build Ficus',
      maxConcurrentWorkStreams: 2,
      blockedGraceMinutes: null,
    })
    expect(buildSquadGeneralSettingsUpdate({ ...common, blockedGraceMinutes: 0 })).toMatchObject({
      maxConcurrentWorkStreams: 2,
      blockedGraceMinutes: 0,
    })
  })

  test('real saves send empty as null and zero beside the concurrency cap', async () => {
    for (const [rawValue, expectedGrace] of [
      ['', null],
      ['0', 0],
    ] as const) {
      const harness = await exerciseGraceInput(rawValue)
      try {
        expect(harness.save.disabled).toBe(false)
        await harness.dom.act(async () => harness.save.click())
        await harness.dom.act(async () => Bun.sleep(10))
        const updates = harness.calls.filter((call) => call.url.includes('/squads/squad-1') && call.method === 'PATCH')
        expect(updates).toHaveLength(1)
        expect(updates[0]?.method).toBe('PATCH')
        expect(JSON.parse(updates[0]!.body!)).toEqual({
          maxConcurrentWorkStreams: 2,
          blockedGraceMinutes: expectedGrace,
        })
      } finally {
        await harness.restore()
      }
    }
  })

  test('a user-entered negative grace shows zod feedback, disables Save, and sends no request', async () => {
    const harness = await exerciseGraceInput('-1')
    try {
      expect(harness.input.getAttribute('aria-invalid')).toBe('true')
      expect(harness.dom.window.document.body.textContent).toContain(blockedGraceMinutesError(-1)!.split(':')[0]!)
      expect(harness.save.disabled).toBe(true)
      await harness.dom.act(async () => harness.save.click())
      expect(
        harness.calls.filter((call) => call.url.includes('/squads/squad-1') && call.method === 'PATCH')
      ).toHaveLength(0)
    } finally {
      await harness.restore()
    }
  })

  test('negative grace uses the shared zod validation and renders its error UI', () => {
    expect(blockedGraceMinutesError(-1)).not.toBeNull()
    expect(blockedGraceMinutesError(0)).toBeNull()
    expect(blockedGraceMinutesError(null)).toBeNull()

    const html = renderSettings({ blockedGraceMinutes: -1 })
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain(blockedGraceMinutesError(-1)!.split(':')[0]!)
  })

  test('buildSquadGeneralSettingsUpdate carries hostWorkspacePath (null clears)', () => {
    expect(buildSquadGeneralSettingsUpdate({ ...baseProps, hostWorkspacePath: '/srv/repo' }).hostWorkspacePath).toBe(
      '/srv/repo'
    )
    expect(buildSquadGeneralSettingsUpdate({ ...baseProps, hostWorkspacePath: null }).hostWorkspacePath).toBeNull()
  })

  test('hostWorkspacePathError rejects relative paths and accepts absolute/null', () => {
    expect(hostWorkspacePathError(null)).toBeNull()
    expect(hostWorkspacePathError('/srv/repo')).toBeNull()
    expect(hostWorkspacePathError('repo')).toContain('absolute')
  })

  // The browser cannot know the Ficus host's home directory, so `~` reaches the
  // server verbatim — say that, instead of the generic "must be absolute".
  test('hostWorkspacePathError explains that ~ is not expanded in the browser', () => {
    expect(hostWorkspacePathError('~/repo')).toBe('Enter the full absolute path; `~` is not expanded here.')
    expect(hostWorkspacePathError('~')).toBe('Enter the full absolute path; `~` is not expanded here.')
  })

  test('renders the host workspace field only when the sandbox runtime is host', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.sandbox.status('squad-1'), { status: 'running', runtime: 'host' })
    const html = renderToStaticMarkup(
      settingsElement(queryClient, { section: 'workspace', hostWorkspacePath: '/srv/repo' })
    )
    expect(html).toContain('squad-host-workspace-path')
    expect(html).toContain('/srv/repo')

    const dockerClient = new QueryClient()
    dockerClient.setQueryData(queryKeys.sandbox.status('squad-1'), { status: 'running', runtime: 'docker' })
    expect(renderToStaticMarkup(settingsElement(dockerClient, { section: 'workspace' }))).not.toContain(
      'squad-host-workspace-path'
    )
  })

  // The server resolves the directory agents are ACTUALLY using; show that
  // rather than a hand-written "~/.tau/..." guess that may be wrong.
  function renderHostField(props: Partial<Props>, workspacePath?: string) {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.sandbox.status('squad-1'), {
      status: 'running',
      runtime: 'host',
      ...(workspacePath ? { workspacePath } : {}),
    })
    return renderToStaticMarkup(settingsElement(queryClient, { section: 'workspace', ...props }))
  }

  test('an empty field placeholders the server-resolved workspace path', () => {
    const html = renderHostField({ hostWorkspacePath: null }, '/srv/x')
    expect(html).toContain('placeholder="/srv/x"')
    expect(html).not.toContain('~/.tau/workspaces')
  })

  // The note describes what is LIVE, so it must read the SAVED prop, never the
  // half-typed edit value — and the field only appears once something is saved,
  // since an empty field already previews the active path as its placeholder.
  async function renderHostSettingsDom(props: Partial<Props>, status: Record<string, unknown>) {
    const dom = await acquireDomHarness({ url: 'http://localhost/squads/squad-1/settings' })
    const rendered = dom.createRoot()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } },
    })
    queryClient.setQueryData(queryKeys.sandbox.status('squad-1'), status)
    const invalidated: unknown[] = []
    const realInvalidate = queryClient.invalidateQueries.bind(queryClient)
    queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
      invalidated.push(filters?.queryKey)
      return realInvalidate(filters as never)
    }) as typeof queryClient.invalidateQueries
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new dom.window.Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response) as typeof fetch
    try {
      await dom.act(async () => rendered.root.render(settingsElement(queryClient, { section: 'workspace', ...props })))
      const doc = dom.window.document
      const noteText = () =>
        [...doc.querySelectorAll('p')].map((el) => el.textContent ?? '').find((text) => text.startsWith('Active: '))
      const type = async (value: string) => {
        const input = doc.querySelector('#squad-host-workspace-path') as HTMLInputElement
        await dom.act(async () => {
          const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
          setter.call(input, value)
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
      }
      const save = async () => {
        const button = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Save')!
        await dom.act(async () => {
          button.dispatchEvent(new dom.window.Event('click', { bubbles: true }))
        })
      }
      return {
        noteText,
        type,
        save,
        invalidated,
        restore: async () => {
          globalThis.fetch = originalFetch
          await dom.cleanup()
        },
      }
    } catch (error) {
      globalThis.fetch = originalFetch
      await dom.cleanup()
      throw error
    }
  }

  test('the active-path note tracks the saved value, not what is being typed', async () => {
    const applied = await renderHostSettingsDom(
      { hostWorkspacePath: '/srv/applied' },
      { status: 'running', runtime: 'host', workspacePath: '/srv/applied', workspacePathApplied: true }
    )
    try {
      expect(applied.noteText()).toBe('Active: /srv/applied')
      await applied.type('/srv/typed-but-unsaved')
      expect(applied.noteText()).toBe('Active: /srv/applied')
    } finally {
      await applied.restore()
    }

    const unsaved = await renderHostSettingsDom(
      { hostWorkspacePath: null },
      { status: 'running', runtime: 'host', workspacePath: '/srv/default', workspacePathApplied: true }
    )
    try {
      expect(unsaved.noteText()).toBeUndefined()
      await unsaved.type('/srv/typed-but-unsaved')
      expect(unsaved.noteText()).toBeUndefined()
    } finally {
      await unsaved.restore()
    }
  })

  // Saving a new path changes which directory the NEXT sandbox start uses, so
  // the sandbox status (which reports the applied one) must be refetched —
  // otherwise the note keeps describing a stale answer.
  test('saving refetches the sandbox status alongside the squad', async () => {
    const harness = await renderHostSettingsDom(
      { hostWorkspacePath: '/srv/applied' },
      { status: 'running', runtime: 'host', workspacePath: '/srv/applied', workspacePathApplied: true }
    )
    try {
      await harness.type('/srv/next')
      await harness.save()
      expect(harness.invalidated).toContainEqual(queryKeys.sandbox.status('squad-1'))
      expect(harness.invalidated).toContainEqual(queryKeys.squads.detail('squad-1'))
    } finally {
      await harness.restore()
    }
  })

  test('a saved value shows the active path, flagged when it has not been applied yet', () => {
    const pending = renderHostField({ hostWorkspacePath: '/srv/repo' }, '/srv/x')
    expect(pending).toContain('Active: /srv/x')
    expect(pending).toContain('applies at next sandbox start')

    const applied = renderHostField({ hostWorkspacePath: '/srv/repo' }, '/srv/repo')
    expect(applied).toContain('Active: /srv/repo')
    expect(applied).not.toContain('applies at next sandbox start')
  })
})

test('General keeps identity fields while workflows owns flow and capacity controls', () => {
  const general = renderSettings({ section: 'general' })
  expect(general).toContain('squad-name')
  expect(general).toContain('Global collaboration')
  expect(general).not.toContain('squad-max-concurrent-work-streams')
  expect(general).not.toContain('Default workflow')
  const work = renderSettings({ section: 'workflows' })
  expect(work).toContain('squad-max-concurrent-work-streams')
  expect(work).not.toContain('id="squad-name"')
  expect(work).not.toContain('Global collaboration')
})

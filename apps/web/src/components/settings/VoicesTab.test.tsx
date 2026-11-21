import { untilRendered } from '../../test/untilRendered'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PublicVoiceProfileJson } from '@ficus/shared'
import { VoiceProfileList } from './VoicesTab'

const profile = (over: Partial<PublicVoiceProfileJson>): PublicVoiceProfileJson => ({
  id: 'team',
  name: 'Team',
  description: null,
  base: 'Team voice.',
  surfaces: {},
  disabled: false,
  hasTemplate: false,
  yamlFieldOverrides: [],
  bytes: 30,
  assignedSquadCount: 2,
  createdAt: '2026-11-18T00:00:00Z',
  updatedAt: '2026-11-18T00:00:00Z',
  ...over,
})

const noop = () => {}

describe('VoiceProfileList', () => {
  test('lists profiles with size and assigned squads; the default cannot be deleted', () => {
    const html = renderToStaticMarkup(
      <VoiceProfileList
        profiles={[
          profile({
            id: 'default',
            name: 'Default',
            hasTemplate: true,
            yamlFieldOverrides: ['base'],
            assignedSquadCount: 0,
          }),
          profile({}),
        ]}
        canWrite
        onEdit={noop}
        onToggle={noop}
        onDelete={noop}
      />
    )
    // Older servers send no isInstanceDefault: the shipped profile is the default.
    expect(
      html.slice(html.indexOf('data-voice-profile="default"'), html.indexOf('data-voice-profile="team"'))
    ).toContain('data-instance-default')
    expect(html).toContain('Modified from template')
    expect(html).toContain('30 / 2,000 bytes')
    expect(html).toContain('2 assigned squads')
    const defaultCard = html.slice(
      html.indexOf('data-voice-profile="default"'),
      html.indexOf('data-voice-profile="team"')
    )
    expect(defaultCard).not.toContain('Delete')
    expect(html.slice(html.indexOf('data-voice-profile="team"'))).toContain('Delete')
  })

  test('read-only viewers can view but not change profiles', () => {
    const html = renderToStaticMarkup(
      <VoiceProfileList profiles={[profile({})]} canWrite={false} onEdit={noop} onToggle={noop} onDelete={noop} />
    )
    expect(html).toContain('View')
    expect(html).not.toContain('Disable')
    expect(html).not.toContain('Delete')
  })
})

test('the chosen default gets the badge; other enabled profiles offer Set as default', () => {
  const html = renderToStaticMarkup(
    <VoiceProfileList
      profiles={[
        profile({ id: 'default', name: 'Default', hasTemplate: true, isInstanceDefault: false }),
        profile({ id: 'mine', name: 'Mine', isInstanceDefault: true }),
        profile({ id: 'off', name: 'Off', disabled: true, isInstanceDefault: false }),
      ]}
      canWrite
      onEdit={noop}
      onToggle={noop}
      onDelete={noop}
      onSetDefault={noop}
    />
  )
  const card = (id: string) => {
    const start = html.indexOf(`data-voice-profile="${id}"`)
    const next = html.indexOf('data-voice-profile=', start + 1)
    return html.slice(start, next === -1 ? undefined : next)
  }
  expect(card('mine')).toContain('data-instance-default')
  expect(card('mine')).toContain('Every squad without an assigned profile or its own voice uses this profile.')
  expect(card('mine')).not.toContain('Set as default')
  expect(card('default')).not.toContain('data-instance-default')
  expect(card('default')).toContain('Set Default as default')
  // A disabled profile cannot be chosen.
  expect(card('off')).not.toContain('Set as default')
  // Read-only viewers see the badge but no control.
  const readOnly = renderToStaticMarkup(
    <VoiceProfileList
      profiles={[
        profile({ id: 'default', isInstanceDefault: false }),
        profile({ id: 'mine', isInstanceDefault: true }),
      ]}
      canWrite={false}
      onEdit={noop}
      onToggle={noop}
      onDelete={noop}
      onSetDefault={noop}
    />
  )
  expect(readOnly).toContain('data-instance-default')
  expect(readOnly).not.toContain('Set as default')
})

test('a disabled chosen default says the shipped default applies and marks it', () => {
  const html = renderToStaticMarkup(
    <VoiceProfileList
      profiles={[
        profile({ id: 'default', name: 'Default', hasTemplate: true, isInstanceDefault: false }),
        profile({ id: 'mine', name: 'Mine', disabled: true, isInstanceDefault: true }),
      ]}
      canWrite
      onEdit={noop}
      onToggle={noop}
      onDelete={noop}
      onSetDefault={noop}
    />
  )
  expect(html).toContain('squads without an assignment use the shipped default profile')
  expect(html).toContain('In use as the fallback default')
})

test('disabling or deleting the current default asks for confirmation first', async () => {
  const { acquireDomHarness } = await import('../../test/domHarness')
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  try {
    const { root, container } = dom.createRoot()
    const toggled: string[] = []
    const removed: string[] = []
    const chosen: string[] = []
    await dom.act(async () =>
      root.render(
        <VoiceProfileList
          profiles={[
            profile({ id: 'default', name: 'Default', hasTemplate: true, isInstanceDefault: false }),
            profile({ id: 'mine', name: 'Mine', isInstanceDefault: true, assignedSquadCount: 1 }),
          ]}
          canWrite
          onEdit={noop}
          onToggle={(p) => toggled.push(p.id)}
          onDelete={(p) => removed.push(p.id)}
          onSetDefault={(p) => chosen.push(p.id)}
        />
      )
    )
    const disable = container.querySelector<HTMLButtonElement>('[aria-label="Disable Mine"]')!
    await dom.act(async () => disable.click())
    expect(toggled).toEqual([])
    expect(disable.textContent).toContain('Unassigned squads use the shipped default')
    await dom.act(async () => disable.click())
    expect(toggled).toEqual(['mine'])

    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Delete Mine"]')!
    await dom.act(async () => remove.click())
    expect(removed).toEqual([])
    expect(remove.textContent).toContain('Delete the default?')
    await dom.act(async () => remove.click())
    expect(removed).toEqual(['mine'])

    // Disabling a profile that is not the default needs no confirmation; choosing a default is one click.
    const shippedDisable = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-voice-profile="default"] button'),
    ].find((b) => b.textContent === 'Disable')!
    await dom.act(async () => shippedDisable.click())
    expect(toggled).toEqual(['mine', 'default'])
    await dom.act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Set Default as default"]')!.click()
    )
    expect(chosen).toEqual(['default'])
  } finally {
    await dom.cleanup()
  }
})

test('Set as default calls the instance default API and reports the change', async () => {
  const { acquireDomHarness } = await import('../../test/domHarness')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { MemoryRouter } = await import('react-router')
  const { queries } = await import('../../queryOptions')
  const { PermissionsProvider } = await import('../../hooks/usePermissions')
  const { VoicesTab } = await import('./VoicesTab')
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  client.setQueryData(queries.publicVoices.list().queryKey, [
    profile({ id: 'default', name: 'Default', hasTemplate: true, isInstanceDefault: true }),
    profile({ id: 'mine', name: 'Mine', isInstanceDefault: false }),
  ])
  client.setQueryData(queries.squads.list().queryKey, [])
  client.setQueryData(queries.publicVoices.githubAccounts().queryKey, [])
  const original = globalThis.fetch
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  globalThis.fetch = (async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (init?.method === 'PUT')
      return Response.json({
        voiceId: 'mine',
        name: 'Mine',
        effectiveVoiceId: 'mine',
        effectiveName: 'Mine',
        fallback: null,
        overCapSquadCount: 1,
      })
    return Response.json([])
  }) as typeof fetch
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <PermissionsProvider
            usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
          >
            <MemoryRouter>
              <VoicesTab />
            </MemoryRouter>
          </PermissionsProvider>
        </QueryClientProvider>
      )
    )
    await dom.act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Set Mine as default"]')!.click())
    await untilRendered(dom, () =>
      expect(container.textContent).toContain('Mine is now the default voice for every squad without an assignment.')
    )
    expect(container.textContent).toContain('1 of those squad(s) are over the cap')
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      url: 'http://localhost/api/public-voices/settings/instance-default',
      method: 'PUT',
      body: { voiceId: 'mine' },
    })
  } finally {
    globalThis.fetch = original
    client.clear()
    await dom.cleanup()
  }
})

test('deleting an unshipped profile requires a second click and uses the danger variant', async () => {
  const { acquireDomHarness } = await import('../../test/domHarness')
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  try {
    const { root, container } = dom.createRoot()
    const removed: string[] = []
    await dom.act(async () =>
      root.render(
        <VoiceProfileList
          profiles={[profile({})]}
          canWrite
          onEdit={noop}
          onToggle={noop}
          onDelete={(p) => removed.push(p.id)}
        />
      )
    )
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Delete Team"]')!
    expect(remove.className).toContain('ficus-button-danger')
    await dom.act(async () => remove.click())
    expect(removed).toEqual([])
    expect(remove.textContent).toContain('2 squad(s) return to the default')
    await dom.act(async () => remove.click())
    expect(removed).toEqual(['team'])
  } finally {
    await dom.cleanup()
  }
})

test('Voices derives through accounts instead of squads and still opens Save as new profile', async () => {
  const { acquireDomHarness } = await import('../../test/domHarness')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { MemoryRouter } = await import('react-router')
  const { queries } = await import('../../queryOptions')
  const { PermissionsProvider } = await import('../../hooks/usePermissions')
  const { VoicesTab } = await import('./VoicesTab')
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  client.setQueryData(queries.publicVoices.list().queryKey, [profile({})])
  client.setQueryData(queries.squads.list().queryKey, [{ id: 'squad', name: 'Squad name', publicVoiceId: 'team' }])

  client.setQueryData(queries.publicVoices.githubAccounts().queryKey, [
    {
      id: 'account',
      displayName: 'Display account',
      login: 'octo',
    },
  ])
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    Response.json({
      login: 'octo',
      draft: { base: 'A derived draft.', surfaces: {} },
      observations: [],
      exemplars: [],
      sampling: {
        filters: {},
        counts: {
          collected: 20,
          kept: 20,
          droppedByFilter: { date: 0, repository: 0 },
          droppedAsToolAuthored: 0,
          droppedAsTemplate: 0,
        },
        dateRange: {},
        publicRepositories: [],
        privateRepositories: [],
        pagingCapped: false,
      },
      bytes: 20,
      maxBytes: 2000,
    })) as typeof fetch
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <PermissionsProvider
            usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
          >
            <MemoryRouter>
              <VoicesTab />
            </MemoryRouter>
          </PermissionsProvider>
        </QueryClientProvider>
      )
    )
    expect(container.textContent).toContain('GitHub account to read through')
    expect(container.textContent).toContain('octo (Display account)')
    expect(container.textContent).not.toContain('Squad whose GitHub connection to use')
    expect(container.textContent).toContain('Assigned squads: Squad name')
    await dom.act(async () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Derive')!.click()
    )
    await untilRendered(dom, () =>
      expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Save as new profile')).toBe(true)
    )
    await dom.act(async () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save as new profile')!.click()
    )
    expect(dom.window.document.querySelector('[aria-label="Profile id"]')).not.toBeNull()
    expect(dom.window.document.querySelector('[aria-label="Profile name"]')).not.toBeNull()
  } finally {
    globalThis.fetch = original
    await dom.cleanup()
    client.clear()
  }
})

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
    expect(html).toContain('Instance default')
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
  const { integrationQueries, queries } = await import('../../queryOptions')
  const { PermissionsProvider } = await import('../../hooks/usePermissions')
  const { VoicesTab } = await import('./VoicesTab')
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  client.setQueryData(queries.publicVoices.list().queryKey, [profile({})])
  client.setQueryData(queries.squads.list().queryKey, [{ id: 'squad', name: 'Squad name', publicVoiceId: 'team' }])
  client.setQueryData(integrationQueries.catalog().queryKey, { integrations: [{ key: 'github', enabled: true }] })
  client.setQueryData(integrationQueries.pool('github').queryKey, [
    {
      id: 'account',
      providerKey: 'github',
      displayName: 'Display account',
      enabled: true,
      adapterVersion: 1,
      configuration: { login: 'octo' },
      credentialConfigured: true,
      authState: 'authenticated',
      healthState: 'healthy',
      validationExpiresAt: '2999-01-01',
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
    await dom.act(async () => {
      ;[...container.querySelectorAll('button')].find((b) => b.textContent === 'Derive')!.click()
      await new Promise((r) => setTimeout(r, 15))
    })
    await dom.act(async () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save as new profile')!.click()
    )
    expect(dom.window.document.querySelector('[aria-label="Profile id"]')).not.toBeNull()
    expect(dom.window.document.querySelector('[aria-label="Profile name"]')).not.toBeNull()
  } finally {
    globalThis.fetch = original
    client.clear()
    await dom.cleanup()
  }
})

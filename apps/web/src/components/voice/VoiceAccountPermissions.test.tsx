import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { acquireDomHarness } from '../../test/domHarness'
import { onboardingQueryKeys, queryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import { usePermissions } from '../../hooks/usePermissions'
import { VoicesTab } from '../settings/VoicesTab'
import { SettingsPage } from '../SettingsPage'
import { OnboardingPage } from '../onboarding/OnboardingPage'
import { fireEvent } from '@testing-library/dom'
import { PublicVoiceStep } from '../onboarding/PublicVoiceStep'

const selectedId = 'a1111111-1111-4111-8111-111111111111'
const result = {
  login: 'octo',
  draft: { base: 'A complete synthetic draft.', surfaces: {} },
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
  bytes: 26,
  maxBytes: 2000,
}
for (const surface of ['Settings', 'Onboarding', 'Settings page', 'Onboarding page'])
  test(`${surface} can select and derive with ${surface.endsWith(' page') ? 'normal page access plus update/use' : 'exactly the two grants'} and no read grants`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost' })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const fullPage = surface.endsWith(' page')
    const settingsSurface = surface.startsWith('Settings')
    client.setQueryData(onboardingQueryKeys.status(), {
      ready: true,
      items: [
        { id: 'ai_provider', required: true, state: 'done' },
        { id: 'github', required: false, state: 'done' },
        { id: 'first_squad', required: true, state: 'done' },
      ],
    })
    client.setQueryData(queryKeys.auth.permissions(undefined), {
      permissions: ['agent-types:update', 'integrations:use', ...(fullPage ? ['settings:read'] : [])],
      identity: { type: 'user', userId: 'person' },
    })
    // A cached response from an earlier authorized view must not make protected profile data visible.
    client.setQueryData(queries.publicVoices.list().queryKey, [
      {
        id: 'private-profile',
        name: 'Reader-only profile',
        description: null,
        base: 'Reader-only profile instructions.',
        surfaces: {},
        disabled: false,
        hasTemplate: false,
        yamlFieldOverrides: [],
        bytes: 40,
        assignedSquadCount: 0,
        createdAt: '2026-11-19',
        updatedAt: '2026-11-19',
      },
    ])
    let permissions!: ReturnType<typeof usePermissions>
    function Probe() {
      permissions = usePermissions()
      return null
    }
    const original = globalThis.fetch
    const requests: Array<{ path: string; method: string; body?: unknown }> = []
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname
      requests.push({
        path,
        method: init?.method ?? 'GET',
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      })
      if (path === '/api/public-voices/github-accounts')
        return Response.json([{ id: selectedId, login: 'octo', displayName: 'My account' }])
      if (path === '/api/public-voices/derive') return Response.json(result)
      if (path === '/api/public-voices' && init?.method === 'POST')
        return Response.json(JSON.parse(String(init.body)), { status: 201 })
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }) as typeof fetch
    try {
      const { root, container } = dom.createRoot()
      await dom.act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[settingsSurface ? '/settings?section=voices' : '/onboarding']}>
              <Probe />
              {surface === 'Settings page' ? (
                <SettingsPage />
              ) : surface === 'Onboarding page' ? (
                <OnboardingPage />
              ) : settingsSurface ? (
                <VoicesTab />
              ) : (
                <PublicVoiceStep
                  githubDone
                  createdSquad={null}
                  onConnectGitHub={() => {
                    throw new Error('Already connected')
                  }}
                />
              )}
            </MemoryRouter>
          </QueryClientProvider>
        )
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
      await dom.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      if (surface === 'Onboarding page')
        await dom.act(async () => {
          container.querySelector<HTMLButtonElement>('[aria-controls="setup-step-public_voice"]')!.click()
          await new Promise((resolve) => setTimeout(resolve, 20))
        })
      expect(permissions.can('integrations:read:github')).toBe(false)
      expect(permissions.can('agent-types:read')).toBe(false)
      expect(container.textContent).not.toContain('Reader-only profile')
      expect(container.textContent).not.toContain('Reader-only profile instructions.')
      expect(permissions.can('agent-types:update')).toBe(true)
      expect(permissions.can('integrations:use')).toBe(true)
      expect(container.querySelector<HTMLInputElement>('[aria-label="GitHub login"]')?.value).toBe('octo')
      expect(container.textContent).toContain('octo (My account)')
      await dom.act(async () => {
        ;[...container.querySelectorAll('button')].find((button) => button.textContent === 'Derive')!.click()
        await new Promise((resolve) => setTimeout(resolve, 15))
      })
      expect(container.textContent).toContain(result.draft.base)
      expect(requests).toContainEqual({ path: '/api/public-voices/github-accounts', method: 'GET' })
      expect(requests).toContainEqual({
        path: '/api/public-voices/derive',
        method: 'POST',
        body: { connectionId: selectedId, login: 'octo', filters: {} },
      })
      expect(requests.some((request) => request.path.startsWith('/api/integrations/connections'))).toBe(false)
      if (!fullPage) expect(requests.some((request) => request.path.startsWith('/api/integrations'))).toBe(false)
      if (settingsSurface)
        expect(requests.some((request) => request.path === '/api/public-voices' && request.method === 'GET')).toBe(
          false
        )
      if (fullPage) {
        const click = async (label: string) =>
          dom.act(async () => {
            ;[...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === label)!.click()
            await new Promise((resolve) => setTimeout(resolve, 15))
          })
        if (settingsSurface) {
          await click('Save as new profile')
          await dom.act(async () => {
            fireEvent.input(dom.window.document.querySelector('[aria-label="Profile id"]')!, {
              target: { value: 'team-style' },
            })
            fireEvent.input(dom.window.document.querySelector('[aria-label="Profile name"]')!, {
              target: { value: 'Team style' },
            })
          })
          await click('Create')
          await click('Save')
        } else {
          await click('Use this draft')
          await click('Save profile')
          expect(container.textContent).toContain('Profile From GitHub saved.')
        }
        expect(requests).toContainEqual({
          path: '/api/public-voices',
          method: 'POST',
          body: {
            id: settingsSurface ? 'team-style' : 'from-github',
            name: settingsSurface ? 'Team style' : 'From GitHub',
            description: null,
            base: result.draft.base,
            surfaces: {},
          },
        })
      }
    } finally {
      globalThis.fetch = original
      client.clear()
      await dom.cleanup()
    }
  })

import { untilRendered } from '../../test/untilRendered'
import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { fireEvent, isInaccessible } from '@testing-library/dom'
import type { Squad } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { queries } from '../../queryOptions'
import { PublicVoiceStep } from './PublicVoiceStep'

const result = {
  login: 'octo',
  draft: { base: 'Use complete sentences.', surfaces: {} },
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
  bytes: 23,
  maxBytes: 2000,
}
for (const scenario of ['saved', 'none', 'collision', 'default-failure'] as const)
  test(`onboarding voice save: ${scenario}`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost' })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

    client.setQueryData(queries.publicVoices.githubAccounts().queryKey, [{ id: 'account', login: 'octo' }])
    const squads =
      scenario === 'none'
        ? []
        : [
            { id: 'plain', name: 'Plain', createdAt: '2025-01-01', publicVoiceId: null },
            { id: 'assigned', name: 'Assigned', createdAt: '2025-06-01', publicVoiceId: 'team' },
            {
              id: 'custom',
              name: 'Custom',
              createdAt: '2026-01-01',
              publicVoiceId: null,
              publicVoice: { base: 'Our own voice.', surfaces: {} },
            },
          ]
    client.setQueryData(queries.squads.list().queryKey, squads)
    const original = globalThis.fetch
    const calls: Array<{ url: string; method: string; body: any }> = []
    let defaultFailed = false
    globalThis.fetch = (async (url, init) => {
      const request = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      }
      calls.push(request)
      if (request.method === 'GET')
        return Response.json(
          request.url.endsWith('/derive/github-accounts') ? [{ id: 'account', login: 'octo' }] : squads
        )
      if (request.url.endsWith('/derive')) return Response.json(result)
      if (request.url.endsWith('/public-voices'))
        return scenario === 'collision'
          ? Response.json({ error: 'Voice profile "from-github" already exists' }, { status: 409 })
          : Response.json({ id: 'from-github', name: 'From GitHub' }, { status: 201 })
      if (scenario === 'default-failure' && !defaultFailed) {
        defaultFailed = true
        return Response.json({ error: 'Forbidden' }, { status: 403 })
      }
      return Response.json({
        voiceId: 'from-github',
        name: 'From GitHub',
        effectiveVoiceId: 'from-github',
        effectiveName: 'From GitHub',
        fallback: null,
        overCapSquadCount: 0,
      })
    }) as typeof fetch
    try {
      const { root, container } = dom.createRoot()
      await dom.act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <MemoryRouter>
              <PublicVoiceStep
                githubDone
                createdSquad={scenario === 'saved' ? ({ id: 'plain', name: 'Plain' } as Squad) : null}
                onConnectGitHub={() => {}}
              />
            </MemoryRouter>
          </QueryClientProvider>
        )
      )
      const click = async (text: string) =>
        dom.act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === text)!.click())
      const hasButton = (text: string) => [...container.querySelectorAll('button')].some((b) => b.textContent === text)
      await click('Derive')
      await untilRendered(dom, () => expect(hasButton('Use this draft')).toBe(true))
      await click('Use this draft')
      expect(isInaccessible(container.querySelector('[aria-label="GitHub login"]')!)).toBe(true)
      expect(isInaccessible(container.querySelector('[aria-label="Voice"]')!)).toBe(false)
      if (scenario === 'none') {
        await click('Back to derivation')
        expect(isInaccessible(container.querySelector('[aria-label="GitHub login"]')!)).toBe(false)
        await click('Use this draft')
      }
      expect(container.querySelector<HTMLInputElement>('[aria-label="Profile name"]')!.value).toBe('From GitHub')
      expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Voice"]')!.value).toBe(result.draft.base)
      expect(container.textContent).toContain('Saving makes this profile the default voice')
      if (scenario === 'none') expect(container.textContent).not.toContain('own voice setting')
      else expect(container.textContent).toContain('Assigned, Custom keep their own voice setting.')
      // One wording whatever the squads: the voice becomes the instance default, never one squad's.
      expect(hasButton('Save profile')).toBe(false)
      await click('Save and use as default voice')
      // Wait for the terminal state of each save path, never for elapsed time.
      await untilRendered(dom, () =>
        expect(container.textContent).toContain(
          {
            collision: 'already exists',
            none: 'From GitHub is now the default voice',
            saved: 'From GitHub is now the default voice',
            'default-failure': 'Profile saved; could not make it the default voice: Forbidden',
          }[scenario]
        )
      )
      const saves = calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/derive'))
      expect(saves[0]).toEqual({
        url: 'http://localhost/api/public-voices',
        method: 'POST',
        body: { id: 'from-github', name: 'From GitHub', description: null, base: result.draft.base, surfaces: {} },
      })
      // No squad is ever changed, and the shipped default profile is never edited.
      expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
      expect(calls.some((c) => c.url.endsWith('/public-voices/default'))).toBe(false)
      const setDefault = {
        url: 'http://localhost/api/public-voices/settings/instance-default',
        method: 'PUT',
        body: { voiceId: 'from-github' },
      }
      if (scenario === 'collision') {
        expect(saves.length).toBe(1)
        await dom.act(async () =>
          fireEvent.input(container.querySelector('[aria-label="Profile name"]')!, {
            target: { value: 'Another voice' },
          })
        )
        expect(container.textContent).toContain('another-voice')
        return
      }
      expect(saves[1]).toEqual(setDefault)
      if (scenario === 'default-failure') {
        expect(container.textContent).not.toContain('is now the default voice')
        await click('Retry setting as default')
        await untilRendered(dom, () => expect(container.textContent).toContain('From GitHub is now the default voice'))
        // The retry sets the default again without recreating the profile.
        expect(saves.length).toBe(2)
        const after = calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/derive'))
        expect(after.filter((c) => c.method === 'POST').length).toBe(1)
        expect(after.at(-1)).toEqual(setDefault)
      } else {
        expect(saves.length).toBe(2)
      }
    } finally {
      globalThis.fetch = original
      await dom.cleanup()
      client.clear()
    }
  })

test('gated step opens GitHub setup and never shows the derivation form', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  let opened = 0
  client.setQueryData(queries.squads.list().queryKey, [])

  client.setQueryData(queries.publicVoices.githubAccounts().queryKey, [])
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <PublicVoiceStep githubDone={false} createdSquad={null} onConnectGitHub={() => opened++} />
        </QueryClientProvider>
      )
    )
    expect(container.textContent).toContain('Connect GitHub first.')
    expect(container.querySelector('[aria-label="GitHub login"]')).toBeNull()
    await dom.act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(opened).toBe(1)
  } finally {
    await dom.cleanup()
    client.clear()
  }
})
